// ============================================================
// server.ts — 引擎 HTTP 服务（含 Web 前端）
// 启动：npx tsx src/server.ts
// 访问：http://localhost:3001
// ============================================================

import * as http from "node:http"
import * as url from "node:url"
import * as fs from "node:fs"
import * as path from "node:path"
import { stateStore } from "./state-store.js"
import { cardManager } from "./card-manager.js"
import { contextPipeline, type Collector } from "./context/pipeline.js"
import { createNode } from "./context/prompt-node.js"
import { worldbook } from "./worldbook/index.js"
import { callTool, listTools } from "./tools.js"
import { lifecycleBus } from "./lifecycle/events.js"
import { agentPipeline } from "./lifecycle/agent-pipeline.js"
import { registerSkillHooks, skillCollector } from "./lifecycle/skill-hooks.js"
import { regexEngine, type RegexHook } from "./regex/hooks.js"

const PORT = 3001
const FRONTEND_DIR = path.resolve(import.meta.dirname!, "frontend")

// ---- 初始化默认数据（幂等） ----
function ensureDefaultSession(sessionId: string) {
  if (stateStore.getSession(sessionId)) return
  stateStore.createSession(sessionId)

  // 卡片注册幂等
  const cards = [
    { id: "hero", name: "勇者亚瑟", version: 1, tags: ["pc"] },
    { id: "npc-guide", name: "引路精灵", version: 1, tags: ["npc"] },
    { id: "npc-merchant", name: "旅行商人", version: 1, tags: ["npc"] },
  ]
  for (const c of cards) {
    try {
      cardManager.register(c)
    } catch {
      /* 幂等忽略 */
    }
  }
  cardManager.activate("hero", sessionId)
  cardManager.activate("npc-guide", sessionId)

  // 世界书加载幂等
  if (worldbook.getIndex().constantCount === 0) {
    worldbook.load([
      {
        id: "wb-setting",
        name: "世界观——奇幻大陆",
        keywords: ["剑", "魔法", "王国"],
        priority: 10,
        constant: true,
        enabled: true,
        content: "剑与魔法的世界，人类与精灵共存的艾尔多兰大陆。",
        category: "常开设定",
      },
      {
        id: "wb-tavern",
        name: "场景——十字路口的酒馆",
        keywords: ["酒馆", "旅店"],
        priority: 5,
        constant: true,
        enabled: true,
        content: "温暖的壁炉，橡木吧台，空气中飘着麦酒和烤肉的味道。",
        category: "常开设定",
      },
      {
        id: "wb-secret",
        name: "隐藏——地下密道",
        keywords: ["地下室", "密道", "暗门"],
        priority: 1,
        constant: false,
        enabled: true,
        content: "吧台下方的地板有一道暗门，通往旧时代的走私通道。",
        category: "触发词条",
      },
    ])
  }

  // Collector 注册幂等
  const demoCollector: Collector = {
    name: "card-base",
    collect: async () => [
      createNode({
        layer: "L0-survival",
        source: "系统提示",
        content: "你是角色扮演AI，严格按照设定互动。",
        priority: 0,
      }),
      createNode({
        layer: "L1-stable",
        source: "世界书常开",
        content: worldbook
          .getConstantEntries()
          .map((e) => e.content)
          .join("\n"),
        priority: 10,
      }),
    ],
  }
  contextPipeline.registerCollector(demoCollector)
  contextPipeline.registerCollector(skillCollector)

  // 注册 skill 生命周期钩子（幂等）
  registerSkillHooks()

  // 正则引擎幂等
  if (regexEngine.getHooks().length === 0) {
    regexEngine.load([
      {
        id: "rx-thought",
        name: "剥离思考块",
        pattern: "\\{thought\\}[\\s\\S]*?\\{\\/thought\\}",
        replacement: "",
        phase: "prompt",
        enabled: true,
      },
      {
        id: "rx-image",
        name: "图片标签",
        pattern: "\\[img:(.+?)\\]",
        replacement: "![\\](\\1)",
        phase: "display",
        enabled: true,
      },
    ] as RegexHook[])
  }
}

// ---- 安全 JSON 解析 ----
const MAX_BODY = 256 * 1024
function safeJsonParse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---- MIME 类型映射 ----
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
}

// ---- HTTP 路由 ----
async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  const parsedUrl = url.parse(req.url ?? "", true)
  const pathname = parsedUrl.pathname?.replace(/\/$/, "") || ""
  const method = req.method ?? "GET"

  // ---- 静态文件 ----
  if (method === "GET" && (pathname === "" || pathname === "/" || pathname.startsWith("/"))) {
    const serveFile = (filePath: string) => {
      if (!fs.existsSync(filePath)) return false
      const ext = path.extname(filePath)
      res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" })
      res.end(fs.readFileSync(filePath))
      return true
    }

    if (pathname === "" || pathname === "/") {
      if (serveFile(path.join(FRONTEND_DIR, "index.html"))) return
    }
    // 如果请求的是已知静态文件
    if (serveFile(path.join(FRONTEND_DIR, pathname))) return
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Access-Control-Allow-Origin", "*")

  // 读 body
  const body = await new Promise<string>((resolve) => {
    let data = ""
    req.on("data", (chunk: string) => {
      data += chunk
      if (data.length > MAX_BODY) {
        req.destroy()
        return
      }
    })
    req.on("end", () => resolve(data))
  })

  const json = (code: number, data: unknown) => {
    res.writeHead(code)
    res.end(JSON.stringify(data, null, 2))
  }

  try {
    // POST /session
    if (pathname === "/session" && method === "POST") {
      const parsed = safeJsonParse(body)
      const sessionId = (parsed?.sessionId as string) || `session-${Date.now()}`
      ensureDefaultSession(sessionId)
      return json(201, { ok: true, sessionId })
    }

    // GET /session/:id
    if (pathname.startsWith("/session/") && method === "GET") {
      const sid = pathname.split("/")[2]
      const session = stateStore.getSession(sid)
      if (!session) return json(404, { error: "Session not found" })
      return json(200, {
        sessionId: session.sessionId,
        historyCount: session.history.length,
        activeCards: session.activatedCards.size,
        phase: session.runtimeStatus.phase,
        budget: session.runtimeStatus.currentBudget,
        nodeCount: session.runtimeStatus.nodeCount,
        degradationApplied: session.runtimeStatus.degradationApplied,
      })
    }

    // POST /session/:id/turn
    if (pathname.includes("/turn") && method === "POST") {
      const sid = pathname.split("/")[2]
      const parsed = safeJsonParse(body)
      if (!parsed) return json(400, { error: "Invalid JSON body" })
      const { message } = parsed
      if (!message || typeof message !== "string") return json(400, { error: "message required" })

      let session = stateStore.getSession(sid)
      if (!session) {
        ensureDefaultSession(sid)
        session = stateStore.getSession(sid)!
      }

      stateStore.appendHistory(sid, `user: ${message}`)
      const wbResults = message ? worldbook.searchByKeywords(message) : []

      const pipelineResult = await contextPipeline.assemble(sid)
      if (pipelineResult.phase !== "ready")
        return json(500, { error: "Pipeline failed", phase: pipelineResult.phase })

      await lifecycleBus.emit("turn_end", sid, { turn: session.history.length })
      const agentActions = await agentPipeline.run(sid)
      stateStore.persist(sid)

      return json(200, {
        ok: true,
        turn: session.history.length,
        prompt: pipelineResult.prompt,
        display: pipelineResult.displayPrompt,
        worldbookTriggered: wbResults.map((w) => ({ id: w.id, name: w.name })),
        agentActions: agentActions.map((a) => ({ type: a.type, description: a.description })),
        trace: pipelineResult.status.trace,
        nodeCount: pipelineResult.status.nodeCount,
        degraded: pipelineResult.status.degradationApplied,
      })
    }

    // GET /tools
    if (pathname === "/tools" && method === "GET") {
      return json(
        200,
        listTools().map((t) => t.definition),
      )
    }

    // POST /session/:id/tool
    if (pathname.includes("/tool") && method === "POST") {
      const sid = pathname.split("/")[2]
      const parsed = safeJsonParse(body)
      if (!parsed) return json(400, { error: "Invalid JSON body" })
      const { name, args } = parsed
      if (!name || typeof name !== "string") return json(400, { error: "tool name required" })
      const result = await callTool(name, (args as Record<string, unknown>) ?? {}, sid)
      return json(200, JSON.parse(result))
    }

    // GET /sessions
    if (pathname === "/sessions" && method === "GET") {
      return json(200, stateStore.listSessions())
    }

    json(404, {
      error: "Not found",
      available: [
        "GET /",
        "GET /sessions",
        "POST /session",
        "GET /session/:id",
        "POST /session/:id/turn",
        "POST /session/:id/tool",
        "GET /tools",
      ],
    })
  } catch (err) {
    json(500, { error: err instanceof Error ? err.message : String(err) })
  }
}

const server = http.createServer(handleRequest)
server.listen(PORT, () => {
  console.log(`PI RP Engine 启动 → http://localhost:${PORT}`)
  console.log(`  前端页面  http://localhost:${PORT}/`)
  console.log(
    `  API: POST /session, GET /session/:id, POST /session/:id/turn, POST /session/:id/tool`,
  )
})
