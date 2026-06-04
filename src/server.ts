// ============================================================
// server.ts — PI RP Engine HTTP 入口
// 启动：npx tsx src/server.ts  |  访问：http://localhost:3001
// ============================================================

import * as http from "node:http"
import { createApp } from "./composition-root.js"
import type { App } from "./composition-root.js"
import { serveStaticFile } from "./presentation/http/static-files.js"
import { register as registerSessionRoutes } from "./presentation/http/routes/session-routes.js"
import { register as registerTurnRoutes } from "./presentation/http/routes/turn-routes.js"
import { register as registerToolRoutes } from "./presentation/http/routes/tool-routes.js"
import type { RouteContext } from "./presentation/http/routes/route-context.js"
import { MAX_BODY } from "./presentation/http/routes/route-context.js"

const PORT = 3001

const app: App = createApp({
  budget: { target: 102400, hard: 163840 },
  sessionsRoot: ".pi/sessions",
})

function safeJsonParse(body: string): Record<string, unknown> | null {
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
}

const routeCtx: RouteContext = {
  app,
  readBody(req) {
    return new Promise<string>((resolve) => {
      let data = ""
      req.on("data", (chunk: string) => {
        data += chunk
        if (data.length > MAX_BODY) req.destroy()
      })
      req.on("end", () => resolve(data))
    })
  },
  json(res, code, data) {
    res.writeHead(code)
    res.end(JSON.stringify(data, null, 2))
    return undefined
  },
  parseJson: safeJsonParse,
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  // 静态文件
  if (serveStaticFile(req, res)) return

  res.setHeader("Content-Type", "application/json; charset=utf-8")
  res.setHeader("Access-Control-Allow-Origin", "*")

  const parsedUrl = new URL(req.url ?? "", "http://localhost")
  const pathname = parsedUrl.pathname.replace(/\/$/, "") || ""
  const method = req.method ?? "GET"
  const body = await routeCtx.readBody(req)

  try {
    if (registerSessionRoutes(routeCtx, req, res, pathname, method, body)) return
    if (await registerTurnRoutes(routeCtx, req, res, pathname, method, body)) return
    if (await registerToolRoutes(routeCtx, req, res, pathname, method, body)) return

    routeCtx.json(res, 404, {
      error: "Not found",
      available: [
        "GET /",
        "GET /cards",
        "GET /sessions",
        "POST /session",
        "GET /session/:id",
        "POST /session/:id/turn",
        "POST /session/:id/tool",
        "GET /tools",
      ],
    })
  } catch (err) {
    routeCtx.json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

const server = http.createServer(handleRequest)
server.listen(PORT, () => {
  console.log(`PI RP Engine 启动 -> http://localhost:${PORT}`)
  console.log(`  前端页面  http://localhost:${PORT}/`)
  console.log(
    `  API: POST /session, GET /session/:id, POST /session/:id/turn, POST /session/:id/tool`,
  )
})
