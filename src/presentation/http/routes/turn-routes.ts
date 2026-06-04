// ============================================================
// Turn 路由: POST /session/:id/turn
// ============================================================

import type * as http from "node:http"
import type { RouteContext } from "./route-context.js"

export async function register(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  body: string,
): Promise<boolean> {
  if (!pathname.includes("/turn") || method !== "POST") return false

  const sid = pathname.split("/")[2]
  const parsed = ctx.parseJson(body)
  if (!parsed) return (ctx.json(res, 400, { error: "Invalid JSON body" }), true)
  const { message } = parsed
  if (!message || typeof message !== "string")
    return (ctx.json(res, 400, { error: "message required" }), true)

  // 一对一模型：session 必须已存在（由 POST /session 创建）
  const session = ctx.app.stateStore.getSession(sid)
  if (!session)
    return (ctx.json(res, 404, { error: "Session not found — create with POST /session first" }), true)

  ctx.app.stateStore.appendHistory(sid, `user: ${message}`)
  const wbResults = message ? ctx.app.worldbook.searchByKeywords(message) : []

  const pipelineResult = await ctx.app.contextPipeline.assemble(sid)
  if (pipelineResult.phase !== "ready")
    return (ctx.json(res, 500, { error: "Pipeline failed", phase: pipelineResult.phase }), true)

  await ctx.app.lifecycleBus.emit("turn_end", sid, { turn: session.history.length })
  const agentActions = await ctx.app.agentPipeline.run(sid)
  ctx.app.stateStore.persist(sid)

  // 同步到卡级存储
  const cardEntry = ctx.app.cardManager.getRegistry().cards[session.cardId]
  if (cardEntry) {
    const cardDir = cardEntry.dir
    try {
      ctx.app.cardSessionStore.appendHistory(cardDir, sid, `user: ${message}`)
    } catch {
      // 卡目录下可能尚无此 session，创建并追加
      ctx.app.cardSessionStore.createSession(cardDir, sid)
      ctx.app.cardSessionStore.appendHistory(cardDir, sid, `user: ${message}`)
    }
  }

  return (
    ctx.json(res, 200, {
      ok: true,
      turn: session.history.length,
      prompt: pipelineResult.prompt,
      display: pipelineResult.displayPrompt,
      worldbookTriggered: wbResults.map((w) => ({ id: w.id, name: w.name })),
      agentActions: agentActions.map((a) => ({ type: a.type, description: a.description })),
      trace: pipelineResult.status.trace,
      nodeCount: pipelineResult.status.nodeCount,
      degraded: pipelineResult.status.degradationApplied,
    }),
    true
  )
}
