// ============================================================
// CardSessionStore — 卡级 Session 存储
// 每个卡的 session 独立存储在 cardDir/sessions/ 下
// 变量持久化到 cardDir/variables.json
// ============================================================

import type { SessionState } from "../types.js"
import { FileSystemStorage } from "../infrastructure/storage-provider.js"
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs"
import { join, basename } from "node:path"

export class CardSessionStore {
  private cache = new Map<string, SessionState>()

  /** 获取卡 sessions 目录路径 */
  private sessionsDir(cardDir: string): string {
    return join(cardDir, "sessions")
  }

  /** 确保 sessions 目录存在并返回 FileSystemStorage */
  private storage(cardDir: string): FileSystemStorage {
    const dir = this.sessionsDir(cardDir)
    mkdirSync(dir, { recursive: true })
    return new FileSystemStorage(dir)
  }

  /** 创建 session（内存 + 文件持久化） */
  createSession(cardDir: string, sessionId: string): SessionState {
    const now = Date.now()
    const session: SessionState = {
      sessionId,
      cardId: basename(cardDir),
      startedAt: now,
      activatedCards: new Map(),
      history: [],
      runtimeStatus: {
        phase: "idle",
        currentBudget: { target: 8192, hard: 12288 },
        totalBytesUsed: 0,
        nodeCount: 0,
        trace: [],
        degradationApplied: false,
      },
    }
    this.cache.set(this.cacheKey(cardDir, sessionId), session)
    this.persist(cardDir, session)
    return session
  }

  /** 加载 session（先查缓存，再从文件恢复） */
  loadSession(cardDir: string, sessionId: string): SessionState | undefined {
    const key = this.cacheKey(cardDir, sessionId)
    const cached = this.cache.get(key)
    if (cached) return cached

    const raw = this.storage(cardDir).read(sessionId)
    if (!raw) return undefined

    try {
      const data = JSON.parse(raw)
      const session: SessionState = {
        sessionId: data.sessionId,
        cardId: data.cardId ?? basename(cardDir),
        startedAt: data.startedAt,
        activatedCards: new Map(),
        history: data.history ?? [],
        runtimeStatus: data.runtimeStatus ?? {
          phase: "idle",
          currentBudget: { target: 8192, hard: 12288 },
          totalBytesUsed: 0,
          nodeCount: 0,
          trace: [],
          degradationApplied: false,
        },
      }
      this.cache.set(key, session)
      return session
    } catch {
      return undefined
    }
  }

  /** 列出卡下所有 session */
  listSessions(cardDir: string): string[] {
    return this.storage(cardDir).list()
  }

  /** 获取 session（先查缓存 → 磁盘回退） */
  getSession(cardDir: string, sessionId: string): SessionState | undefined {
    return this.loadSession(cardDir, sessionId)
  }

  /** 追加历史条目并持久化 */
  appendHistory(cardDir: string, sessionId: string, entry: string): void {
    const session = this.loadSession(cardDir, sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found in card ${cardDir}`)
    session.history.push(entry)
    this.persist(cardDir, session)
  }

  /** 持久化 session 到文件 */
  persist(cardDir: string, session: SessionState): void {
    const data = {
      sessionId: session.sessionId,
      cardId: session.cardId,
      startedAt: session.startedAt,
      history: session.history,
      runtimeStatus: session.runtimeStatus,
    }
    this.storage(cardDir).write(session.sessionId, JSON.stringify(data, null, 2))
  }

  /** 保存卡级变量 */
  saveVariables(cardDir: string, variables: Record<string, unknown>): void {
    writeFileSync(join(cardDir, "variables.json"), JSON.stringify(variables, null, 2), "utf-8")
  }

  /** 读取卡级变量 */
  loadVariables(cardDir: string): Record<string, unknown> {
    const p = join(cardDir, "variables.json")
    if (!existsSync(p)) return {}
    try {
      return JSON.parse(readFileSync(p, "utf-8"))
    } catch {
      return {}
    }
  }

  /** 删除 session */
  deleteSession(cardDir: string, sessionId: string): void {
    const key = this.cacheKey(cardDir, sessionId)
    this.cache.delete(key)
    const dir = this.sessionsDir(cardDir)
    const filePath = join(dir, `${sessionId}.json`)
    if (existsSync(filePath)) {
      try { unlinkSync(filePath) } catch { /* skip */ }
    }
  }

  private cacheKey(cardDir: string, sessionId: string): string {
    return `${cardDir}::${sessionId}`
  }
}
