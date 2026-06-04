// ============================================================
// Tool 路由: GET /tools, POST /session/:id/tool
// ============================================================

import type * as http from "node:http"
import type { RouteContext } from "./route-context.js"
import { callTool, listTools } from "../../../tools.js"

export async function register(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  body: string,
): Promise<boolean> {
  // GET /tools
  if (pathname === "/tools" && method === "GET") {
    return (
      ctx.json(
        res,
        200,
        listTools().map((t) => t.definition),
      ),
      true
    )
  }

  // POST /session/:id/tool
  if (pathname.includes("/tool") && method === "POST") {
    const sid = pathname.split("/")[2]
    const parsed = ctx.parseJson(body)
    if (!parsed) return (ctx.json(res, 400, { error: "Invalid JSON body" }), true)
    const { name, args } = parsed
    if (!name || typeof name !== "string")
      return (ctx.json(res, 400, { error: "tool name required" }), true)
    const result = await callTool(name, (args as Record<string, unknown>) ?? {}, sid)
    return (ctx.json(res, 200, JSON.parse(result)), true)
  }

  return false
}
