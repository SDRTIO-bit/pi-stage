/**
 * RP Engine - RP Web 服务器
 *
 * HTTP 静态文件服务 + WebSocket 消息转发 + 卡片/会话数据 + 命令执行。
 */

import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from "node:fs"
import { join, extname, basename } from "node:path"
import { createInterface } from "node:readline"
import { exec } from "node:child_process"
import type { CardManager } from "./card-manager.js"
import type { StateStore } from "./state-store.js"

/** 最小 pi API 类型声明 */
interface PiAPI {
  on(event: string, handler: (event: unknown, ctx?: unknown) => void): void
  sendUserMessage(text: string, opts?: { deliverAs?: string; streamingBehavior?: "steer" | "followUp" }): void
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
}

export function createRPWebServer(
  pi: PiAPI,
  getStateDir: () => string,
  cardManager: CardManager,
  stateStore: StateStore,
  getSessionId: () => string,
  resetSessionId?: () => void,
  projectRoot?: string,
  setPreferredCard?: (cardId: string) => void,
) {
  const RP_PORT = parseInt(process.env.RP_WEB_PORT || "3012")

  let rpServer: ReturnType<typeof import("node:http").createServer> | null = null
  let rpWss: any = null
  const rpClients = new Set<any>()
  let latestCtx: any = null

  function setLatestCtx(ctx: any) {
    latestCtx = ctx
  }

  function getRpWebDir(): string {
    return join(getStateDir(), "extensions", "rp-web")
  }

  function broadcastToRP(data: any) {
    const json = JSON.stringify(data)
    for (const client of rpClients) {
      if (client.readyState === 1) {
        try { client.send(json) } catch { /* ignore */ }
      }
    }
  }

  function sendToRP(ws: any, data: any) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)) } catch { /* ignore */ }
    }
  }

  function serveFile(urlPath: string, res: any, rpToken?: string) {
    let cleanPath = urlPath.split("?")[0]
    if (cleanPath === "/") cleanPath = "rp-web.html"
    if (cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1)
    if (cleanPath === "favicon.ico") {
      res.writeHead(204)
      res.end()
      return
    }

    const rpWebDir = getRpWebDir()
    const filePath = join(rpWebDir, cleanPath)
    if (!filePath.startsWith(rpWebDir)) {
      res.writeHead(403)
      res.end("Forbidden")
      return
    }
    if (!existsSync(filePath)) {
      res.writeHead(404)
      res.end("Not Found")
      return
    }

    const ext = extname(filePath).toLowerCase()
    let content = readFileSync(filePath)
    if (ext === ".html" && rpToken) {
      content = Buffer.from(
        content.toString().replace(
          "</head>",
          `<script>window.RP_TOKEN="${rpToken}";</script></head>`,
        ),
      )
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    })
    res.end(content)
  }

  function registerEventForwarding() {
    const rpEventTypes = [
      "agent_start", "agent_end", "turn_end",
      "message_start", "message_update", "message_end",
    ] as const
    const STEER_PREFIXES = [
      "[系统", "[工具流程检查]", "[叙事校准]",
      "[当前状态同步]", "[扮演边界确认]",
    ]

    for (const eventType of rpEventTypes) {
      pi.on(eventType as string, (event: any) => {
        const msg = event?.message
        if (msg?.role === "user") {
          const content = typeof msg.content === "string" ? msg.content : ""
          if (STEER_PREFIXES.some((p) => content.startsWith(p))) return
        }
        broadcastToRP({ type: "event", event: { type: eventType, ...event } })
      })
    }
  }

  // ========== 项目级会话目录 ==========

  /** 将 cwd 编码为 PI session 目录名（与 pi-jsonl-storage 统一） */
  function encodeCwd(cwd: string): string {
    const normalized = cwd.replace(/\\/g, "/")
    const noDrive = normalized.replace(/^([A-Za-z]):/, "$1")
    return "--" + noDrive.replace(/\//g, "-") + "--"
  }

  function getPiSessionsDir(): string {
    const root = projectRoot ?? process.cwd()
    return join(root, ".pi", "sessions", encodeCwd(process.cwd()))
  }

  // ========== 会话扫描与加载 ==========

  /** 从 JSONL 行解析消息文本 */
  function extractMessageText(entry: any): string | null {
    if (entry.type !== "message") return null
    const msg = entry.message
    if (!msg || msg.role !== "user") return null
    const content = msg.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) return block.text.trim()
      }
    } else if (typeof content === "string") {
      return content.trim()
    }
    return null
  }

  /** 扫描 PI 原生 JSONL session 文件（只读首条 user 消息做预览） */
  async function scanSessions(_stateDir: string) {
    const sessions: { file: string; size: number; mtime: number; preview: string }[] = []
    const sessionsDir = getPiSessionsDir()
    if (!existsSync(sessionsDir)) return sessions

    const files = readdirSync(sessionsDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, path: join(sessionsDir, f) }))
      .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)

    for (const { name, path } of files.slice(0, 30)) {
      const st = statSync(path)
      let preview = ""
      try {
        const rl = createInterface({
          input: createReadStream(path, { encoding: "utf-8" }),
          crlfDelay: Infinity,
        })
        for await (const line of rl) {
          if (!line.trim()) continue
          try {
            const text = extractMessageText(JSON.parse(line))
            if (text) { preview = text.slice(0, 80); break }
          } catch { /* skip malformed line */ }
        }
        rl.close()
      } catch { /* skip */ }
      sessions.push({ file: name, size: st.size, mtime: st.mtimeMs, preview })
    }
    return sessions
  }

  /**
   * 从 PI 原生 JSONL 文件流式加载会话，提取 user/assistant 消息。
   * JSONL 每行一个 Entry，树形结构（id/parentId），逐行解析不全部加载到内存。
   */
  async function loadSessionEntries(fileName: string) {
    const filePath = join(getPiSessionsDir(), fileName)
    if (!existsSync(filePath)) return null

    try {
      const entries: any[] = []
      const history: string[] = []
      let sessionCardId = ""
      const rl = createInterface({
        input: createReadStream(filePath, { encoding: "utf-8" }),
        crlfDelay: Infinity,
      })

      for await (const line of rl) {
        if (!line.trim()) continue
        let entry: any
        try { entry = JSON.parse(line) } catch { continue }

        // Extract cardId from tool calls in assistant messages
        if (!sessionCardId) {
          const msg = entry.message
          if (entry.type === "message" && msg?.role === "assistant" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === "toolCall" && block.name === "update_state" && block.arguments?.cardId) {
                sessionCardId = block.arguments.cardId
              }
            }
          }
        }

        if (entry.type !== "message") continue

        const msg = entry.message
        if (!msg) continue
        const role = msg.role
        if (role !== "user" && role !== "assistant") continue

        let text = ""
        const content = msg.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text) text += block.text
          }
        } else if (typeof content === "string") {
          text = content
        }
        if (!text.trim()) continue

        entries.push({
          type: "message",
          message: { role, content: text },
        })
        history.push(`${role}: ${text}`)
      }
      rl.close()
      return { entries, history, cardId: sessionCardId }
    } catch {
      return null
    }
  }  // ========== 命令处理 ==========

  function execRPCommand(code: string): string | null {
    const parts = code.startsWith("/") ? code.slice(1).split(/\s+/) : code.split(/\s+/)
    const cmd = parts[0]
    const args = parts.slice(1).join(" ")
    const sid = getSessionId()

    if (!sid) return "无活跃 Session"

    const session = stateStore.getSession(sid)
    if (!session) return "无活跃 Session"

    switch (cmd) {
      case "reset": {
        session.history = []
        session.runtimeStatus.phase = "idle"
        if (resetSessionId) resetSessionId()
        return "Session 已重置"
      }
      case "history": {
        if (session.history.length === 0) return "(暂无对话历史)"
        return session.history
          .map((h, i) => `[${i}] ${h}`)
          .join("\n")
      }
      case "status": {
        const s = session.runtimeStatus
        return [
          "引擎状态",
          `Session: ${sid}`,
          `Card: ${session.cardId || "(未选择)"}`,
          `Phase: ${s.phase}`,
          `Budget: ${s.currentBudget.target}/${s.currentBudget.hard}`,
          `Bytes: ${s.totalBytesUsed}`,
          `Nodes: ${s.nodeCount}`,
          `Degradation: ${s.degradationApplied ? "YES" : "NO"}`,
          `History: ${session.history.length} 条`,
        ].join("\n")
      }
      case "card": {
        if (args === "list" || !args) {
          const all = cardManager.getAllRegistered()
          return [
            `角色卡 (${all.length} 张)`,
            ...all.map((c) => `  ${c.id}: ${c.name}`),
          ].join("\n")
        }
        return `子命令: /card list`
      }
      case "rp-cards": {
        const all = cardManager.getAllRegistered()
        return [
          `角色卡 (${all.length} 张)`,
          ...all.map((c) => `  ${c.id}: ${c.name}`),
        ].join("\n")
      }
      // 以下命令转发给 PI 引擎（memory 系统等）
      case "memory_stats":
      case "memory_search":
      case "memory_remember":
      case "memory_lessons":
      case "knowledge_search":
      case "rp-mode":
      case "rp":
        pi.sendUserMessage(code)
        return null // 结果通过 PI 事件返回
      default:
        return `未知命令: /${cmd}`
    }
  }

  // ========== WebSocket 消息路由 ==========

  async function handleRPCommand(ws: any, command: any) {
    const ok = (cmd: string, data?: unknown) => ({
      type: "response", command: cmd, success: true, id: command.id, data,
    })
    const err = (cmd: string, msg: string) => ({
      type: "response", command: cmd, success: false, error: msg, id: command.id,
    })

    try {
      switch (command.type) {
        case "prompt": {
          pi.sendUserMessage(command.message)
          sendToRP(ws, ok("prompt"))
          break
        }
        case "abort": {
          if (latestCtx) latestCtx.abort()
          sendToRP(ws, ok("abort"))
          break
        }

        // ---- 卡片管理 ----
        case "list_cards": {
          // 强制刷新 registry 缓存，确保导入的新卡可见
          cardManager.invalidateCache()
          const reg = cardManager.getRegistry()
          const activeIds = cardManager.getActiveCardIds()
          const cards = Object.entries(reg.cards).map(([id, entry]) => ({
            id,
            name: cardManager.getCardName(id),
            active: activeIds.includes(id),
            importedAt: entry.imported_at || "",
            dir: entry.dir || "",
          }))
          sendToRP(ws, { type: "card_list", cards, activeIds })
          break
        }
        case "activate_cards": {
          const cardIds: string[] = command.cardIds || []
          if (cardIds.length === 0) {
            sendToRP(ws, err("activate_cards", "no card ids"))
            break
          }
          // RP 是一对一模式，用 setActiveCard 替换而非追加
          const targetId = cardIds[0]
          if (!cardManager.setActiveCard(targetId)) {
            sendToRP(ws, err("activate_cards", "card not found: " + targetId))
            break
          }
          const names = [cardManager.getCardName(targetId)]

          // 同步 _preferredCardId（确保 resolveCardId 返回新卡）
          if (setPreferredCard) setPreferredCard(targetId)

          // 重置 PI 会话引用 → 下次消息时 ensureSession 用新卡完整初始化（世界书/skills/状态变量）
          if (resetSessionId) resetSessionId()

          sendToRP(ws, { type: "cards_activated", cardIds: [targetId], names, needRestart: true })
          break
        }

        // ---- 会话管理 ----
        case "list_sessions": {
          const sessions = await scanSessions(getStateDir())
          sendToRP(ws, { type: "sessions_list", sessions })
          break
        }
        case "load_session": {
          const file = command.file || ""
          if (!file) {
            sendToRP(ws, err("load_session", "no file specified"))
            break
          }
          const result = await loadSessionEntries(file)
          if (!result || !result.entries) {
            sendToRP(ws, err("load_session", "session not found: " + file))
            break
          }

          // Rebuild stateStore session with loaded PI history
          const sid = getSessionId()
          const newSid = sid || `pi-session-${Date.now()}`
          const session = sid ? stateStore.getSession(sid) : undefined
          if (session) {
            // Reset existing session history with loaded data
            session.history = [...result.history]
            if (result.cardId && !session.cardId) session.cardId = result.cardId
            stateStore.persist(sid)
          } else {
            // No active session, create a new one with loaded history
            const newSession = stateStore.createSession(newSid, {
              history: [...result.history],
            })
            if (result.cardId) newSession.cardId = result.cardId
            stateStore.persist(newSid)
          }

          // 重置 session 引用，下次用户消息时用加载的历史重新初始化
          if (resetSessionId) resetSessionId()
          
          // 注入最后几轮历史对话作为 PI 引擎的上下文
          const recentHistory = result.history.slice(-8) // 最后 4 轮 (8 条消息)
          if (recentHistory.length > 0) {
            const historyText = recentHistory.map((h: string) => {
              const colonIdx = h.indexOf(": ")
              if (colonIdx === -1) return h
              const role = h.slice(0, colonIdx)
              const text = h.slice(colonIdx + 2)
              const speaker = role === "user" ? "[用户]" : "[AI]"
              return `${speaker} ${text}`
            }).join("\n\n")
            
            // 用系统消息格式注入上下文
            pi.sendUserMessage(
              `[历史记录恢复] 已加载历史会话。以下最近 ${recentHistory.length / 2} 轮对话记录，请基于此上下文继续角色扮演：\n\n${historyText}`,
            )
          }

          sendToRP(ws, {
            type: "load_session_entries",
            entries: result.entries,
            sessionId: newSid,
            cardId: result.cardId || "",
          })
          break
        }
        case "new_session": {
          // 清空 session 引用，下次用户消息时 ensureSession 会重新初始化
          if (resetSessionId) resetSessionId()
          sendToRP(ws, { type: "new_session_started" })
          break
        }

        // ---- 命令执行 ----
        case "exec": {
          const code: string = command.code || ""
          if (!code) {
            sendToRP(ws, err("exec", "no command"))
            break
          }
          const result = execRPCommand(code)
          if (result !== null) {
            // RP 引擎直接处理的命令 → 立即返回结果
            sendToRP(ws, {
              type: "exec_result",
              success: true,
              message: result,
              command: code,
              id: command.id,
            })
          } else {
            // 转发给 PI 的命令 → 结果通过 PI 事件返回，这里先返回 ok
            sendToRP(ws, ok("exec"))
          }
          break
        }

        // ---- 状态查询 ----
        case "get_rp_state": {
          const sid = getSessionId()
          const session = sid ? stateStore.getSession(sid) : undefined
          const cardState = session?.cardId
            ? session.activatedCards.get(session.cardId)
            : undefined

          const data: any = {
            sessionId: sid || "",
            cardId: session?.cardId || "",
            cardName: session?.cardId ? cardManager.getCardName(session.cardId) : "",
            variables: cardState?.variables ?? {},
            historyLength: session?.history.length ?? 0,
            phase: session?.runtimeStatus.phase ?? "idle",
          }
          sendToRP(ws, { type: "rp_state", data })
          break
        }
        case "get_append_system": {
          // 读取卡目录下的 APPEND_SYSTEM.md
          const sid = getSessionId()
          const session = sid ? stateStore.getSession(sid) : undefined
          let content = ""
          if (session?.cardId) {
            const reg = cardManager.getRegistry()
            const cardDir = reg.cards[session.cardId]?.dir
            if (cardDir) {
              const mdPath = join(cardDir, "APPEND_SYSTEM.md")
              if (existsSync(mdPath)) {
                try { content = readFileSync(mdPath, "utf-8") } catch { /* ignore */ }
              }
            }
          }
          sendToRP(ws, { type: "append_system_content", content })
          break
        }
        case "mirror_sync_request":
          sendToRP(ws, { type: "mirror_sync", entries: [], model: null, isStreaming: false })
          break
        case "compact":
          sendToRP(ws, ok("compact"))
          break
        default:
          sendToRP(ws, err(command.type, "Unknown command: " + command.type))
      }
    } catch (e: any) {
      sendToRP(ws, err(command.type || "unknown", e.message))
    }
  }

  // ========== HTTP 服务器 ==========

  async function start(ctx: any) {
    const http = await import("node:http")
    const crypto = await import("node:crypto")
    const { WebSocketServer } = await import("ws")

    const rpToken = crypto.randomBytes(16).toString("hex")
    console.log(`[RP-Web] Token: ${rpToken}`)

    rpServer = http.createServer((req: any, res: any) => {
      if (req.url === "/ws" || req.url?.startsWith("/ws?")) return
      serveFile(req.url || "/", res, rpToken)
    })

    rpWss = new WebSocketServer({ noServer: true })

    rpServer.on("upgrade", (request: any, socket: any, head: any) => {
      const urlPath = request.url?.split("?")[0]
      if (urlPath !== "/ws") { socket.destroy(); return }
      const urlParams = new URLSearchParams(request.url?.split("?")[1] || "")
      if (urlParams.get("token") !== rpToken) { socket.destroy(); return }
      rpWss.handleUpgrade(request, socket, head, (ws: any) =>
        rpWss.emit("connection", ws, request))
    })

    rpWss.on("connection", (ws: any) => {
      rpClients.add(ws)
      ws.on("message", (data: any) => {
        try { handleRPCommand(ws, JSON.parse(data.toString())) } catch { /* ignore */ }
      })
      ws.on("close", () => rpClients.delete(ws))
      ws.on("error", () => rpClients.delete(ws))
    })

    const host = process.env.RP_WEB_HOST || "0.0.0.0"
    const tryListen = (port: number, max = 10) => {
      rpServer!.listen(port, host, () => {
        const displayHost = host === "0.0.0.0" ? "localhost" : host
        const url = `http://${displayHost}:${port}`
        console.log(`[RP-Web] ${url}`)
        try { ctx.ui.notify(`RP Web: ${url}`, "info") } catch { /* ignore */ }

        if (!process.env.RP_NO_BROWSER) {
          const cmd = process.platform === "win32"
            ? `start "" "${url}"`
            : process.platform === "darwin"
              ? `open "${url}"`
              : `xdg-open "${url}"`
          exec(cmd, (err) => {
            if (err) console.warn("[RP-Web] 自动打开浏览器失败:", err.message)
          })
        }
      })
      rpServer!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < RP_PORT + max) {
          rpServer!.removeAllListeners("error")
          tryListen(port + 1, max)
        } else console.error("[RP-Web] 启动失败:", err.message)
      })
    }
    tryListen(RP_PORT)
  }

  async function shutdown() {
    if (rpWss) {
      for (const c of rpClients) { try { c.close() } catch { /* ignore */ } }
      rpClients.clear()
      rpWss.close()
      rpWss = null
    }
    if (rpServer) { rpServer.close(); rpServer = null }
  }

  return { broadcastToRP, setLatestCtx, start, shutdown, registerEventForwarding }
}
