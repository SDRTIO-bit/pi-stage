// ============================================================
// PiJsonlWriter — rp-engine session → Pi .jsonl 同步（项目级目录）
//
// 存储目录: ${projectRoot}/.pi/sessions/<encoded-cwd>/
//
// 在 turn 结束时调用，将 user/assistant 消息追加到 .jsonl 文件。
// rp-engine 前端可通过读取 .jsonl 文件恢复完整对话树。
// ============================================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"

/** 将路径编码为 Pi 目录名格式 */
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

/** 获取项目级 session 目录 */
function getSessionDir(projectRoot?: string, cwd?: string): string {
  const root = projectRoot ?? process.cwd()
  const wd = cwd ?? process.cwd()
  return join(root, ".pi", "sessions", encodePath(wd))
}

function fileName(): string {
  const ts = nowISO().replace(/[:]/g, "-").replace(/\./g, "-")
  return `${ts}_${uuid()}.jsonl`
}

// ---- 公开 API ----

/** 确保目录存在并返回路径 */
export function ensureSessionDir(projectRoot?: string): string {
  const dir = getSessionDir(projectRoot)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 根据 rpSessionId 查找已有的 .jsonl 文件路径 */
export function findJsonlFile(rpSessionId: string, projectRoot?: string): string | null {
  const dir = getSessionDir(projectRoot)
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
  for (const f of files) {
    try {
      const content = readFileSync(join(dir, f), "utf-8")
      const firstLine = content.split("\n")[0]
      if (firstLine && firstLine.includes(`"rpSessionId":"${rpSessionId}"`)) {
        return join(dir, f)
      }
    } catch {
      continue
    }
  }
  return null
}

/** 从 .jsonl 文件重建 history 数组（仅提取 message 事件） */
export function rebuildHistoryFromJsonl(rpSessionId: string, projectRoot?: string): string[] | null {
  const fp = findJsonlFile(rpSessionId, projectRoot)
  if (!fp) return null
  try {
    const content = readFileSync(fp, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    const history: string[] = []

    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === "deleted") break
        if (event.type === "message") {
          const role = event.message?.role
          const text = event.message?.content?.[0]?.text
          if (role && text !== undefined) {
            if (role === "user") history.push(`user: ${text}`)
            else if (role === "assistant") history.push(`assistant: ${text}`)
            else history.push(`system: ${text}`)
          }
        }
      } catch {
        continue
      }
    }
    return history.length > 0 ? history : null
  } catch {
    return null
  }
}

/** 初始化一个新的 .jsonl 文件（写入 session 头事件） */
export function initJsonlFile(rpSessionId: string, cardId: string, projectRoot?: string): string {
  const dir = getSessionDir(projectRoot)
  mkdirSync(dir, { recursive: true })
  const fp = join(dir, fileName())

  writeFileSync(
    fp,
    JSON.stringify({
      type: "session",
      version: 3,
      id: uuid(),
      timestamp: nowISO(),
      cwd: process.cwd(),
      rpSessionId,
      cardId,
    }) + "\n",
    "utf-8",
  )
  return fp
}

/** 追加一条 message 事件到 .jsonl 文件 */
export function appendMessageToJsonl(
  rpSessionId: string,
  role: "user" | "assistant" | "system",
  text: string,
  parentId?: string,
  projectRoot?: string,
): void {
  let fp = findJsonlFile(rpSessionId, projectRoot)
  if (!fp) {
    fp = initJsonlFile(rpSessionId, "", projectRoot)
  }

  // 读取最后一条非 leaf 非 deleted 事件的 id 作为 parentId
  if (!parentId) {
    try {
      const content = readFileSync(fp, "utf-8")
      const lines = content.trim().split("\n").filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i])
          if (e.id && e.type !== "leaf" && e.type !== "deleted") {
            parentId = e.id
            break
          }
        } catch { continue }
      }
    } catch { /* ignore */ }
  }

  const msgId = uuid()
  appendFileSync(
    fp,
    JSON.stringify({
      type: "message",
      id: msgId,
      parentId: parentId ?? null,
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
