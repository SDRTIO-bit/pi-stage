/**
 * RP Engine - RP Web 服务器（简化版）
 *
 * HTTP 静态文件服务 + WebSocket 消息转发 + 卡片/会话数据。
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, extname } from "node:path"
import { initCardManager, getRegistry, getActiveCardIds, getCardName, activateCards } from "./card-manager.js"

/** 最小 pi API 类型声明 */
interface PiAPI {
  on(event: string, handler: (event: unknown, ctx?: unknown) => void): void
  sendUserMessage(text: string, opts?: { deliverAs?: string }): void
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
}

export function createRPWebServer(pi: PiAPI, getStateDir: () => string) {
  const RP_PORT = parseInt(process.env.RP_WEB_PORT || "3012")

  let rpServer: ReturnType<typeof import("node:http").createServer> | null = null
  let rpWss: any = null
  const rpClients = new Set<any>()
  let latestCtx: any = null

  function setLatestCtx(ctx: any) { latestCtx = ctx }

  function getRpWebDir(): string {
    return join(getStateDir(), "extensions", "rp-web")
  }

  function broadcastToRP(data: any) {
    const json = JSON.stringify(data)
    for (const client of rpClients) {
      if (client.readyState === 1) { try { client.send(json) } catch { /* ignore */ } }
    }
  }

  function sendToRP(ws: any, data: any) {
    if (ws.readyState === 1) { try { ws.send(JSON.stringify(data)) } catch { /* ignore */ } }
  }

  function serveFile(urlPath: string, res: any, rpToken?: string) {
    let cleanPath = urlPath.split("?")[0]
    if (cleanPath === "/") cleanPath = "rp-web.html"
    if (cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1)
    if (cleanPath === "favicon.ico") { res.writeHead(204); res.end(); return }

    const rpWebDir = getRpWebDir()
    const filePath = join(rpWebDir, cleanPath)
    if (!filePath.startsWith(rpWebDir)) { res.writeHead(403); res.end("Forbidden"); return }
    if (!existsSync(filePath)) { res.writeHead(404); res.end("Not Found"); return }

    const ext = extname(filePath).toLowerCase()
    let content = readFileSync(filePath)
    if (ext === ".html" && rpToken) {
      content = Buffer.from(content.toString().replace("</head>", `<script>window.RP_TOKEN="${rpToken}";</script></head>`))
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" })
    res.end(content)
  }

  function registerEventForwarding() {
    const rpEventTypes = ["agent_start", "agent_end", "turn_end", "message_start", "message_update", "message_end"] as const
    const STEER_PREFIXES = ["[系统", "[工具流程检查]", "[叙事校准]", "[当前状态同步]", "[扮演边界确认]"]

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

  /** 扫描 sessions 目录下的 .jsonl 文件 */
  function scanSessions(stateDir: string) {
    const sessions: { file: string; size: number; mtime: number; preview: string }[] = []
    const sessionsDir = join(stateDir, "sessions")
    if (!existsSync(sessionsDir)) return sessions

    const allFiles: { name: string; path: string }[] = []
    function scanDir(dir: string, prefix: string) {
      for (const f of readdirSync(dir)) {
        const fp = join(dir, f)
        const st = statSync(fp)
        if (st.isDirectory()) scanDir(fp, prefix ? prefix + "/" + f : f)
        else if (f.endsWith(".jsonl")) allFiles.push({ name: prefix ? prefix + "/" + f : f, path: fp })
      }
    }
    scanDir(sessionsDir, "")
    allFiles.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)

    for (const { name, path } of allFiles.slice(0, 30)) {
      const st = statSync(path)
      let preview = ""
      try {
        const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean)
        for (const line of lines) {
          try {
            const entry = JSON.parse(line)
            const msg = entry.message
            if (msg?.role === "user") {
              preview = typeof msg.content === "string" ? msg.content.slice(0, 80) : ""
              break
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      sessions.push({ file: name, size: st.size, mtime: st.mtimeMs, preview })
    }
    return sessions
  }

  async function handleRPCommand(ws: any, command: any) {
    const ok = (cmd: string, data?: unknown) => ({ type: "response", command: cmd, success: true, id: command.id, data })
    const err = (cmd: string, msg: string) => ({ type: "response", command: cmd, success: false, error: msg, id: command.id })

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
          const reg = getRegistry()
          const activeIds = getActiveCardIds()
          const cards = Object.entries(reg.cards).map(([id, entry]) => ({
            id, name: getCardName(id), active: activeIds.includes(id),
            importedAt: entry.imported_at || "", dir: entry.dir || "",
          }))
          sendToRP(ws, { type: "card_list", cards, activeIds })
          break
        }
        case "activate_cards": {
          const cardIds: string[] = command.cardIds || []
          if (cardIds.length === 0) { sendToRP(ws, err("activate_cards", "no card ids")); break }
          const activated = activateCards(cardIds)
          const names = activated.map((id) => getCardName(id))
          sendToRP(ws, { type: "cards_activated", cardIds: activated, names, needRestart: true })
          break
        }
        // ---- 会话列表 ----
        case "list_sessions": {
          const sessions = scanSessions(getStateDir())
          sendToRP(ws, { type: "sessions_list", sessions })
          break
        }
        // ---- 空响应（前端兼容） ----
        case "get_rp_state":
          sendToRP(ws, { type: "rp_state", data: {} })
          break
        case "get_append_system":
          sendToRP(ws, { type: "append_system_content", content: "" })
          break
        case "mirror_sync_request":
          sendToRP(ws, { type: "mirror_sync", entries: [], model: null, isStreaming: false })
          break
        case "load_session":
        case "new_session":
        case "compact":
        case "exec":
          sendToRP(ws, ok(command.type))
          break
        default:
          sendToRP(ws, err(command.type, "Unknown command: " + command.type))
      }
    } catch (e: any) {
      sendToRP(ws, err(command.type || "unknown", e.message))
    }
  }

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
      rpWss.handleUpgrade(request, socket, head, (ws: any) => rpWss.emit("connection", ws, request))
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
        console.log(`[RP-Web] http://${host}:${port}`)
        try { ctx.ui.notify(`RP Web: http://${host}:${port}`, "info") } catch { /* ignore */ }
      })
      rpServer!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < RP_PORT + max) { rpServer!.removeAllListeners("error"); tryListen(port + 1, max) }
        else console.error("[RP-Web] 启动失败:", err.message)
      })
    }
    tryListen(RP_PORT)
  }

  async function shutdown() {
    if (rpWss) {
      for (const c of rpClients) { try { c.close() } catch { /* ignore */ } }
      rpClients.clear(); rpWss.close(); rpWss = null
    }
    if (rpServer) { rpServer.close(); rpServer = null }
  }

  return { broadcastToRP, setLatestCtx, start, shutdown, registerEventForwarding }
}
