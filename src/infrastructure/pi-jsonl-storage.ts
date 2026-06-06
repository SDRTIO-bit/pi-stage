// ============================================================
// PiJsonlStorage — 项目级 .jsonl session 存储
//
// 存储目录: ${projectRoot}/.pi/sessions/<encoded-cwd>/
// 格式: append-only .jsonl，每行一个 JSON 事件，通过 id/parentId 构成对话树。
// 实现 StorageProvider 接口，直接注入到 StateStore。
// ============================================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join } from "node:path"
import type { StorageProvider } from "./storage-provider.js"

/** 将绝对路径编码为 Pi 目录名：F:/zhao/pi rp → --F-zhao-pi rp-- */
function encodePath(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const noDrive = normalized.replace(/^([A-Za-z]):/, "$1")
  return "--" + noDrive.replace(/\//g, "-") + "--"
}

function uuid(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function nowISO(): string {
  return new Date().toISOString()
}

// ---- Pi .jsonl 事件类型 ----

interface PiSessionEvent {
  type: "session"
  version: number
  id: string
  timestamp: string
  cwd: string
  rpSessionId?: string
  cardId?: string
}

interface PiMessageEvent {
  type: "message"
  id: string
  parentId: string | null
  timestamp: string
  message: {
    role: "user" | "assistant" | "system"
    content: Array<{ type: "text"; text: string }>
  }
}

interface PiLeafEvent {
  type: "leaf"
  id: string
  parentId: string
  timestamp: string
}

type PiEvent = PiSessionEvent | PiMessageEvent | PiLeafEvent

// ============================================================
// 会话扫描结果类型
// ============================================================

export interface SessionMeta {
  file: string
  size: number
  mtime: number
  preview: string
  sessionId: string
  cardId: string
}

export interface LoadedSession {
  entries: Array<{ type: string; message: { role: string; content: string } }>
  history: string[]
  cardId: string
  sessionId: string
}

// ============================================================
// PiJsonlStorage — 实现 StorageProvider 接口
// ============================================================

export class PiJsonlStorage implements StorageProvider {
  private sessionsRoot: string
  private encodedCwd: string
  private cwdSessionDir: string

  constructor(projectRoot?: string, cwd?: string) {
    const root = projectRoot ?? process.cwd()
    const workDir = cwd ?? process.cwd()
    this.sessionsRoot = join(root, ".pi", "sessions")
    this.encodedCwd = encodePath(workDir)
    this.cwdSessionDir = join(this.sessionsRoot, this.encodedCwd)
    mkdirSync(this.cwdSessionDir, { recursive: true })
  }

  /** 获取存储目录路径 */
  getDirectory(): string {
    return this.cwdSessionDir
  }

  /** 获取 sessions 根目录 */
  getSessionsRoot(): string {
    return this.sessionsRoot
  }

  // ---- 文件查找 ----

  private newFileName(): string {
    const ts = nowISO().replace(/[:]/g, "-").replace(/\./g, "-")
    return `${ts}_${uuid()}.jsonl`
  }

  /** 按 key（sessionId）查找已有 .jsonl 文件 */
  findFile(key: string): string | null {
    if (!existsSync(this.cwdSessionDir)) return null
    const files = readdirSync(this.cwdSessionDir).filter((f) => f.endsWith(".jsonl"))
    for (const f of files) {
      try {
        const content = readFileSync(join(this.cwdSessionDir, f), "utf-8")
        if (content.includes(`"rpSessionId":"${key}"`)) {
          return join(this.cwdSessionDir, f)
        }
        const firstLine = content.split("\n")[0]
        if (firstLine && firstLine.includes(key)) {
          return join(this.cwdSessionDir, f)
        }
      } catch {
        continue
      }
    }
    return null
  }

  /** 获取或创建 session 对应的文件路径 */
  getOrCreateFile(key: string): string {
    const existing = this.findFile(key)
    if (existing) return existing
    return join(this.cwdSessionDir, this.newFileName())
  }

  // ======== StorageProvider 接口 ========

  read(key: string): string | null {
    const fp = this.findFile(key)
    if (!fp) return null
    try {
      return this.reconstructJson(fp, key)
    } catch {
      return null
    }
  }

  write(key: string, data: string): void {
    const existing = this.findFile(key)
    if (existing) {
      // 文件已存在，仅追加历史中不存在的消息（增量同步）
      this.syncIncremental(existing, key, data)
      return
    }
    // 新文件：完整写入
    mkdirSync(this.cwdSessionDir, { recursive: true })
    const fp = join(this.cwdSessionDir, this.newFileName())
    this.writeFull(fp, key, data)
  }

  delete(key: string): void {
    const fp = this.findFile(key)
    if (fp && existsSync(fp)) {
      appendFileSync(
        fp,
        JSON.stringify({
          type: "deleted",
          id: uuid(),
          parentId: null,
          timestamp: nowISO(),
          rpSessionId: key,
        }) + "\n",
        "utf-8",
      )
    }
  }

  list(): string[] {
    if (!existsSync(this.cwdSessionDir)) return []
    const files = readdirSync(this.cwdSessionDir).filter((f) => f.endsWith(".jsonl"))
    const ids: string[] = []

    for (const f of files) {
      try {
        const content = readFileSync(join(this.cwdSessionDir, f), "utf-8")
        let isDeleted = false
        for (const line of content.split("\n")) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === "deleted") { isDeleted = true; break }
            if (event.rpSessionId) {
              ids.push(event.rpSessionId)
              break
            }
          } catch { continue }
        }
        if (!isDeleted) {
          // 文件存在但没 rpSessionId，用文件名作为 key
          if (!ids.includes(f)) {
            // 尝试从 session 事件提取
            for (const line of content.split("\n")) {
              try {
                const event = JSON.parse(line)
                if (event.type === "session" && event.rpSessionId) {
                  ids.push(event.rpSessionId)
                  break
                }
              } catch { continue }
            }
          }
        }
      } catch { continue }
    }
    return ids
  }

  // ======== JSONL 解析 / 重建 ========

  /** 从 JSONL 文件重建 StateStore 兼容的 JSON 快照 */
  private reconstructJson(fp: string, key: string): string {
    const content = readFileSync(fp, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    const history: string[] = []
    let sessionId = key
    let cardId = ""
    let startedAt = 0

    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === "deleted") break
        if (event.type === "session") {
          cardId = event.cardId || ""
          sessionId = event.rpSessionId || event.id || key
          startedAt = event.timestamp ? new Date(event.timestamp).getTime() : Date.now()
        } else if (event.type === "message") {
          const role = event.message?.role
          const content = event.message?.content
          if (role && content) {
            if (typeof content === "string") {
              history.push(`${role}: ${content}`)
            } else if (Array.isArray(content)) {
              const text = content
                .filter((b: any) => b?.type === "text")
                .map((b: any) => b.text ?? "")
                .join("\n")
              if (text) history.push(`${role}: ${text}`)
            } else if (content?.[0]?.text) {
              history.push(`${role}: ${content[0].text}`)
            }
          }
        }
      } catch { continue }
    }

    return JSON.stringify({
      sessionId,
      cardId,
      startedAt: startedAt || Date.now(),
      history,
      runtimeStatus: {
        phase: "idle",
        currentBudget: { target: 8192, hard: 12288 },
        totalBytesUsed: 0,
        nodeCount: 0,
        trace: [],
        degradationApplied: false,
      },
      activatedCards: cardId
        ? [{ id: cardId, state: { cardId, variables: {}, lastUpdated: Date.now() } }]
        : [],
    })
  }

  /** 完整写入新文件（覆盖或创建） */
  private writeFull(fp: string, key: string, data: string): void {
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }

    const sessionId = parsed.sessionId || key
    const cardId = parsed.cardId || ""
    const history: string[] = parsed.history || []

    const lines: string[] = []
    const rootId = uuid()

    // Session 头
    lines.push(
      JSON.stringify({
        type: "session",
        version: 3,
        id: rootId,
        timestamp: nowISO(),
        cwd: process.cwd(),
        rpSessionId: sessionId,
        cardId,
      }),
    )

    // 消息
    let prevId: string | null = rootId
    for (const entry of history) {
      const msgId = uuid()
      let role: "user" | "assistant" | "system" = "system"
      let text = entry

      if (entry.startsWith("user: ")) {
        role = "user"
        text = entry.slice(6)
      } else if (entry.startsWith("assistant: ")) {
        role = "assistant"
        text = entry.slice(11)
      } else if (entry.startsWith("system: ")) {
        role = "system"
        text = entry.slice(8)
      }

      lines.push(
        JSON.stringify({
          type: "message",
          id: msgId,
          parentId: prevId,
          timestamp: nowISO(),
          message: { role, content: [{ type: "text", text }] },
        }),
      )
      prevId = msgId
    }

    // Leaf
    if (prevId && prevId !== rootId) {
      lines.push(
        JSON.stringify({
          type: "leaf",
          id: uuid(),
          parentId: prevId,
          timestamp: nowISO(),
        }),
      )
    }

    writeFileSync(fp, lines.join("\n") + "\n", "utf-8")
  }

  /** 增量同步：仅追加 JSONL 中不存在的新消息 */
  private syncIncremental(fp: string, key: string, data: string): void {
    let parsed: any
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }

    const newHistory: string[] = parsed.history || []

    // 读取现有 JSONL 中的消息
    const existing = new Set<string>()
    try {
      const content = readFileSync(fp, "utf-8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (event.type === "message") {
            const role = event.message?.role
            const text = event.message?.content?.[0]?.text
            if (role && text) {
              existing.add(`${role}: ${text}`)
            }
          }
        } catch { continue }
      }
    } catch { /* ignore */ }

    // 追加新消息
    for (const entry of newHistory) {
      const colonIdx = entry.indexOf(": ")
      if (colonIdx === -1) continue
      const role = entry.slice(0, colonIdx) as "user" | "assistant" | "system"
      const text = entry.slice(colonIdx + 2)
      if (existing.has(entry)) continue

      this.appendToFile(fp, role, text)
      existing.add(entry)
    }
  }

  // ======== 追加操作（供 turn-routes 实时写入） ========

  /** 初始化 session .jsonl 文件（仅 header） */
  initSession(key: string, cardId: string): string {
    const fp = join(this.cwdSessionDir, this.newFileName())
    mkdirSync(this.cwdSessionDir, { recursive: true })
    writeFileSync(
      fp,
      JSON.stringify({
        type: "session",
        version: 3,
        id: uuid(),
        timestamp: nowISO(),
        cwd: process.cwd(),
        rpSessionId: key,
        cardId,
      }) + "\n",
      "utf-8",
    )
    return fp
  }

  /** 追加一条消息到 .jsonl */
  appendMessage(key: string, role: "user" | "assistant" | "system", text: string): void {
    const fp = this.findFile(key) || this.initSession(key, "")
    this.appendToFile(fp, role, text)
  }

  private appendToFile(fp: string, role: "user" | "assistant" | "system", text: string): void {
    // 找 parentId（最近一条 message 或 session 的 id）
    let parentId: string | null = null
    try {
      const content = readFileSync(fp, "utf-8")
      const lines = content.trim().split("\n").filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i])
          // 找到非 leaf 事件的最近一个 id
          if (e.id && e.type !== "leaf" && e.type !== "deleted") {
            parentId = e.id
            break
          }
        } catch { continue }
      }
    } catch { /* ignore */ }

    const msgId = uuid()
    appendFileSync(
      fp,
      JSON.stringify({
        type: "message",
        id: msgId,
        parentId,
        timestamp: nowISO(),
        message: { role, content: [{ type: "text", text }] },
      }) + "\n",
      "utf-8",
    )

    // 更新 leaf
    appendFileSync(
      fp,
      JSON.stringify({
        type: "leaf",
        id: uuid(),
        parentId: msgId,
        timestamp: nowISO(),
      }) + "\n",
      "utf-8",
    )
  }

  // ======== 扫描与加载（供 rp-web-server / WebSocket 使用） ========

  /** 扫描当前工作目录下的所有会话 */
  scanSessions(): SessionMeta[] {
    if (!existsSync(this.cwdSessionDir)) return []

    const files = readdirSync(this.cwdSessionDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, path: join(this.cwdSessionDir, f) }))
      .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)

    const results: SessionMeta[] = []
    for (const { name, path } of files.slice(0, 30)) {
      const st = statSync(path)
      let preview = ""
      let sessionId = ""
      let cardId = ""
      let isDeleted = false

      try {
        const content = readFileSync(path, "utf-8")
        for (const line of content.split("\n")) {
          if (!line.trim()) continue
          try {
            const event = JSON.parse(line)
            if (event.type === "deleted") { isDeleted = true; break }
            if (event.type === "session") {
              sessionId = event.rpSessionId || event.id
              cardId = event.cardId || ""
            }
            if (event.type === "message" && event.message?.role === "user" && !preview) {
              const text = event.message?.content?.[0]?.text
              if (text) preview = text.slice(0, 80)
            }
          } catch { continue }
        }
      } catch { /* skip */ }

      if (!isDeleted) {
        results.push({ file: name, size: st.size, mtime: st.mtimeMs, preview, sessionId, cardId })
      }
    }
    return results
  }

  /** 加载指定文件的会话内容 */
  loadSessionEntries(fileName: string): LoadedSession | null {
    const fp = join(this.cwdSessionDir, fileName)
    if (!existsSync(fp)) return null

    try {
      const entries: LoadedSession["entries"] = []
      const history: string[] = []
      let cardId = ""
      let sessionId = ""

      const content = readFileSync(fp, "utf-8")
      for (const line of content.split("\n")) {
        if (!line.trim()) continue
        let event: any
        try { event = JSON.parse(line) } catch { continue }

        if (event.type === "deleted") break

        if (event.type === "session") {
          cardId = event.cardId || ""
          sessionId = event.rpSessionId || event.id
        }

        if (event.type !== "message") continue
        const msg = event.message
        if (!msg) continue
        const role = msg.role
        if (role !== "user" && role !== "assistant") continue

        let text = ""
        if (Array.isArray(msg.content)) {
          text = msg.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
        } else if (typeof msg.content === "string") {
          text = msg.content
        }
        if (!text.trim()) continue

        entries.push({ type: "message", message: { role, content: text } })
        history.push(`${role}: ${text}`)
      }

      return { entries, history, cardId, sessionId }
    } catch {
      return null
    }
  }
}
