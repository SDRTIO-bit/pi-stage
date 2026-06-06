// ============================================================
// Session-first 状态存储
// PI session 事件是权威源，文件是加速缓存。
// 持久化抽象通过 StorageProvider 接口实现，支持文件系统/内存切换。
// ============================================================

import type { CardState, SessionState } from "./types.js"
import { type StorageProvider, FileSystemStorage } from "./infrastructure/storage-provider.js"

export class StateStore {
  private sessions = new Map<string, SessionState>()
  private dirtyCards = new Set<string>()
  private _storage: StorageProvider

  constructor(storage?: string | StorageProvider) {
    if (typeof storage === "string") {
      this._storage = new FileSystemStorage(storage)
    } else if (storage) {
      this._storage = storage
    } else {
      this._storage = new FileSystemStorage("sessions")
    }
  }

  /** 获取底层 StorageProvider */
  get storage(): StorageProvider {
    return this._storage
  }

  /** 创建或恢复 session */
  createSession(sessionId: string, fromSnapshot?: Partial<SessionState>): SessionState {
    const now = Date.now()
    const session: SessionState = {
      sessionId,
      cardId: fromSnapshot?.cardId ?? "",
      startedAt: fromSnapshot?.startedAt ?? now,
      activatedCards: fromSnapshot?.activatedCards ?? new Map(),
      history: fromSnapshot?.history ?? [],
      runtimeStatus: fromSnapshot?.runtimeStatus ?? {
        phase: "idle",
        currentBudget: { target: 8192, hard: 12288 },
        totalBytesUsed: 0,
        nodeCount: 0,
        trace: [],
        degradationApplied: false,
      },
    }
    this.sessions.set(sessionId, session)
    return session
  }

  getSession(sessionId: string): SessionState | undefined {
    const cached = this.sessions.get(sessionId)
    if (cached) return cached
    // 服务重启后从磁盘恢复
    return this.load(sessionId)
  }

  /** 记录事件（权威源） */
  appendHistory(sessionId: string, entry: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)
    session.history.push(entry)
  }

  /** 标记卡片脏（需持久化） */
  markCardDirty(cardId: string): void {
    this.dirtyCards.add(cardId)
  }

  getDirtyCards(): string[] {
    return [...this.dirtyCards]
  }

  clearDirtyCards(): void {
    this.dirtyCards.clear()
  }

  /** 重建 session（branch 切换时用） */
  rebuildFromHistory(sessionId: string, history: string[]): SessionState {
    const session = this.createSession(sessionId)
    session.history = [...history]
    session.runtimeStatus.phase = "idle"
    return session
  }

  /** 持久化到存储 */
  persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const data = {
      sessionId: session.sessionId,
      cardId: session.cardId,
      startedAt: session.startedAt,
      history: session.history,
      runtimeStatus: session.runtimeStatus,
      activatedCards: [...session.activatedCards.entries()].map(([id, state]) => ({
        id,
        state,
      })),
    }

    this._storage.write(sessionId, JSON.stringify(data, null, 2))
  }

  /** 从存储恢复 */
  load(sessionId: string): SessionState | undefined {
    const raw = this._storage.read(sessionId)
    if (!raw) return undefined

    try {
      const data = JSON.parse(raw)
      const activatedCards = new Map<string, CardState>(
        (data.activatedCards ?? []).map((entry: { id: string; state: CardState }) => [
          entry.id,
          entry.state,
        ]),
      )

      return this.createSession(sessionId, {
        cardId: data.cardId,
        startedAt: data.startedAt,
        history: data.history ?? [],
        activatedCards,
        runtimeStatus: data.runtimeStatus,
      })
    } catch {
      return undefined
    }
  }

  /** session 快照（用于加速缓存） */
  snapshot(sessionId: string): Readonly<SessionState> | undefined {
    return this.sessions.get(sessionId)
  }

  /** 列出所有 session */
  listSessions(): string[] {
    return this._storage.list()
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId)
    this._storage.delete(sessionId)
  }
}

/** @deprecated 使用组合根 `createApp()` 或 `new StateStore(storage)` 替代 */
export const stateStore = new StateStore()
