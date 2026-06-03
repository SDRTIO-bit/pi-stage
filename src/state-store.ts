// ============================================================
// Session-first 状态存储
// PI session 事件是权威源，文件是加速缓存。
// 每个 session 独立目录：sessions/<sessionId>/
// 不依赖文件系统一致性，branch 切换时从 session 重建状态。
// ============================================================

import type { CardState, SessionState } from "./types.js"
import * as fs from "node:fs"
import * as path from "node:path"

const SESSIONS_ROOT = "sessions"

export class StateStore {
  private sessions = new Map<string, SessionState>()
  private dirtyCards = new Set<string>()

  private sessionDir(sessionId: string): string {
    return path.join(SESSIONS_ROOT, sessionId)
  }

  private statePath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), "state.json")
  }

  /** 创建或恢复 session */
  createSession(sessionId: string, fromSnapshot?: Partial<SessionState>): SessionState {
    const now = Date.now()
    const session: SessionState = {
      sessionId,
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
    return this.sessions.get(sessionId)
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

  /** 持久化到磁盘 — 每个 session 独立目录 */
  persist(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const dir = this.sessionDir(sessionId)
    fs.mkdirSync(dir, { recursive: true })

    const data = {
      sessionId: session.sessionId,
      startedAt: session.startedAt,
      history: session.history,
      runtimeStatus: session.runtimeStatus,
      activatedCards: [...session.activatedCards.entries()].map(([id, state]) => ({
        id,
        state,
      })),
    }

    fs.writeFileSync(this.statePath(sessionId), JSON.stringify(data, null, 2), "utf-8")
  }

  /** 从磁盘恢复 */
  load(sessionId: string): SessionState | undefined {
    const sp = this.statePath(sessionId)
    if (!fs.existsSync(sp)) return undefined

    try {
      const raw = JSON.parse(fs.readFileSync(sp, "utf-8"))
      const activatedCards = new Map<string, CardState>(
        (raw.activatedCards ?? []).map((entry: { id: string; state: CardState }) => [
          entry.id,
          entry.state,
        ]),
      )

      return this.createSession(sessionId, {
        startedAt: raw.startedAt,
        history: raw.history ?? [],
        activatedCards,
        runtimeStatus: raw.runtimeStatus,
      })
    } catch {
      return undefined
    }
  }

  /** session 快照（用于加速缓存） */
  snapshot(sessionId: string): Readonly<SessionState> | undefined {
    return this.sessions.get(sessionId)
  }

  /** 列出所有 session 目录 */
  listSessions(): string[] {
    try {
      if (!fs.existsSync(SESSIONS_ROOT)) return []
      return fs.readdirSync(SESSIONS_ROOT).filter((name: string) => {
        const statPath = path.join(SESSIONS_ROOT, name, "state.json")
        return fs.existsSync(statPath)
      })
    } catch {
      return []
    }
  }
}

export const stateStore = new StateStore()
