// ============================================================
// Session 路由: POST /session, GET /session/:id, GET /sessions, GET /cards
// ============================================================

import type * as http from "node:http"
import type { RouteContext } from "./route-context.js"
import { hasCardSkills, generateCardSkills } from "../../../cards/skill-writer.js"
import { isKnowledgeEntry } from "../../../skill-generator.js"

export function register(
  ctx: RouteContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  body: string,
): boolean {
  // POST /session — 创建 session（一对一：绑定 cardId）
  if (pathname === "/session" && method === "POST") {
    const parsed = ctx.parseJson(body)
    const cardId = (parsed?.cardId as string) || ""
    const sessionId = (parsed?.sessionId as string) || `session-${Date.now()}`

    if (ctx.app.stateStore.getSession(sessionId)) {
      return (ctx.json(res, 201, { ok: true, sessionId }), true)
    }

    // 一对一：必须指定 cardId
    if (!cardId) {
      return (ctx.json(res, 400, { error: "cardId required" }), true)
    }

    const cardName = ctx.app.cardManager.getCardName(cardId)
    // 检查卡片是否存在（文件 registry + 内存）
    const reg = ctx.app.cardManager.getRegistry()
    const cardEntry = reg.cards[cardId]
    const isMemoryOnly = !cardEntry && ctx.app.cardManager.getAllRegistered().some((c) => c.id === cardId)
    if (!cardEntry && !isMemoryOnly) {
      return (ctx.json(res, 404, { error: `Card not found: ${cardId}` }), true)
    }

    // 激活卡片（一对一模型：独占激活）
    ctx.app.cardManager.setActiveCard(cardId)

    // 注册卡专属世界书到全局 Worldbook 实例
    if (cardEntry) {
      const worldbookDir = ctx.app.cardManager.getCardWorldbookDir(cardId)
      if (worldbookDir) {
        // 注册卡的世界书（幂等：同一目录只加载一次）
        ctx.app.worldbook.loadFromFiles([worldbookDir])
        // 原地重分类：知识条目 constant → false，使 TF-IDF 触发检索可命中
        ctx.app.worldbook.reclassifyKnowledge(isKnowledgeEntry)
        // 首次激活 → 生成卡专属 Skills
        if (!hasCardSkills(cardEntry.dir)) {
          generateCardSkills(cardEntry.dir, worldbookDir)
        }
      }
    }

    // 创建 session 并关联 cardId（双写：中心 StateStore + 卡目录）
    const session = ctx.app.stateStore.createSession(sessionId)
    session.cardId = cardId
    ctx.app.stateStore.persist(sessionId)
    if (cardEntry) {
      ctx.app.cardSessionStore.createSession(cardEntry.dir, sessionId)
      // 同步 cardId 到卡级 session
      const cardSession = ctx.app.cardSessionStore.getSession(cardEntry.dir, sessionId)
      if (cardSession) {
        cardSession.cardId = cardId
        ctx.app.cardSessionStore.persist(cardEntry.dir, cardSession)
      }
    }

    return (ctx.json(res, 201, { ok: true, sessionId, cardId, cardName }), true)
  }

  // GET /session/:id
  if (pathname.startsWith("/session/") && method === "GET") {
    const sid = pathname.split("/")[2]
    const session = ctx.app.stateStore.getSession(sid)
    if (!session) return (ctx.json(res, 404, { error: "Session not found" }), true)
    return (
      ctx.json(res, 200, {
        sessionId: session.sessionId,
        cardId: session.cardId || "",
        cardName: session.cardId ? ctx.app.cardManager.getCardName(session.cardId) : "",
        history: session.history,
        historyCount: session.history.length,
        activeCards: session.activatedCards.size,
        phase: session.runtimeStatus.phase,
        budget: session.runtimeStatus.currentBudget,
        nodeCount: session.runtimeStatus.nodeCount,
        degradationApplied: session.runtimeStatus.degradationApplied,
      }),
      true
    )
  }

  // DELETE /session/:id
  if (pathname.startsWith("/session/") && method === "DELETE") {
    const sid = pathname.split("/")[2]
    const session = ctx.app.stateStore.getSession(sid)
    if (!session) return (ctx.json(res, 404, { error: "Session not found" }), true)
    ctx.app.stateStore.deleteSession(sid)
    return (ctx.json(res, 200, { ok: true, sessionId: sid }), true)
  }
  // GET /sessions
  if (pathname === "/sessions" && method === "GET") {
    return (ctx.json(res, 200, ctx.app.stateStore.listSessions()), true)
  }

  // GET /cards — 列出所有注册卡片
  if (pathname === "/cards" && method === "GET") {
    const cards = ctx.app.cardManager.getAllRegistered()
    const result = cards.map((c) => ({
      id: c.id,
      name: c.name,
      tags: c.tags,
      version: c.version,
      hasSkills: hasCardSkills(ctx.app.cardManager.getRegistry().cards[c.id]?.dir ?? ""),
    }))
    return (ctx.json(res, 200, result), true)
  }

  return false
}
