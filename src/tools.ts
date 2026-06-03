// ============================================================
// AI 工具集 — 双 API 版本
//
//   createPiTools(sessionIdRef) → PiToolDef[]  (供 pi 扩展)
//   registerTool / callTool           (旧 API, 供 HTTP server)
// ============================================================

import { stateStore } from "./state-store.js"
import { lifecycleBus } from "./lifecycle/events.js"

// ---- 新 API: pi 扩展用 ----

export interface PiToolDef {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  execute: (
    callId: string,
    params: Record<string, unknown>,
    signal: unknown,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>
}

/** 创建适配 pi 扩展的工具列表 */
export function createPiTools(sessionIdRef: { current: string }): PiToolDef[] {
  const sid = () => sessionIdRef.current

  function ok(text: string, details?: unknown) {
    return { content: [{ type: "text", text }], details }
  }
  function err(text: string) {
    return { content: [{ type: "text", text: `❌ ${text}` }], details: { error: text } }
  }

  const withLifecycle =
    (name: string, fn: PiToolDef["execute"]): PiToolDef["execute"] =>
    async (callId, params, signal, onUpdate, ctx) => {
      await lifecycleBus.emit("tool_call", sid(), { tool: name, args: params })
      try {
        const result = await fn(callId, params, signal, onUpdate, ctx)
        await lifecycleBus.emit("tool_result", sid(), { tool: name, result })
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        const res = err(msg)
        await lifecycleBus.emit("tool_result", sid(), { tool: name, error: msg })
        return res
      }
    }

  const tools: PiToolDef[] = [
    {
      name: "read_state",
      label: "读取状态",
      description: "读取当前激活角色的状态变量。keys 为空则返回全部。",
      parameters: {
        type: "object",
        properties: {
          keys: { type: "array", items: { type: "string" }, description: "要读取的变量名列表" },
        },
      },
      execute: withLifecycle("read_state", async (_c, params: Record<string, unknown>) => {
        const session = stateStore.getSession(sid())
        if (!session) return err("无活跃 Session")
        const keys = params.keys as string[] | undefined
        const result: Record<string, unknown> = {}
        for (const [cardId, cardState] of session.activatedCards) {
          if (!keys || keys.length === 0) {
            result[cardId] = { variables: cardState.variables }
          } else {
            const filtered: Record<string, unknown> = {}
            for (const key of keys) {
              if (key in cardState.variables) filtered[key] = cardState.variables[key]
            }
            result[cardId] = { variables: filtered }
          }
        }
        const text =
          Object.keys(result).length > 0
            ? JSON.stringify(result, null, 2)
            : "（无激活卡片或无状态变量）"
        return ok(text, result)
      }),
    },
    {
      name: "update_state",
      label: "更新状态",
      description: "更新角色状态变量。cardId 为目标卡片 ID，updates 为键值对。",
      parameters: {
        type: "object",
        properties: {
          cardId: { type: "string", description: "目标卡片 ID" },
          updates: { type: "object", description: "要更新的键值对" },
        },
        required: ["cardId", "updates"],
      },
      execute: withLifecycle("update_state", async (_c, params: Record<string, unknown>) => {
        const session = stateStore.getSession(sid())
        if (!session) return err("无活跃 Session")
        const cardId = params.cardId as string
        const updates = params.updates as Record<string, unknown>
        const cardState = session.activatedCards.get(cardId)
        if (!cardState) return err(`卡片 "${cardId}" 未激活`)
        for (const [key, value] of Object.entries(updates)) {
          cardState.variables[key] = value
        }
        cardState.lastUpdated = Date.now()
        stateStore.markCardDirty(cardId)
        return ok(`✅ 已更新 ${cardId}: ${Object.keys(updates).join(", ")}`, {
          updated: Object.keys(updates),
        })
      }),
    },
    {
      name: "advance_time",
      label: "推进时间",
      description: "推进游戏内时间，触发生理结算和周期事件",
      parameters: {
        type: "object",
        properties: {
          amount: { type: "number", description: "推进的时间量" },
          unit: { type: "string", enum: ["minutes", "hours", "days"], description: "时间单位" },
        },
        required: ["amount", "unit"],
      },
      execute: withLifecycle("advance_time", async (_c, params: Record<string, unknown>) => {
        const amount = params.amount as number
        const unit = params.unit as string
        return ok(`⏰ 时间已推进 ${amount} ${unit}`, { advanced: `${amount} ${unit}` })
      }),
    },
    {
      name: "search_worldbook",
      label: "搜索世界书",
      description: "按关键词搜索世界书触发词条，返回匹配内容",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词" },
          maxResults: { type: "number", description: "最多返回条数，默认5" },
        },
        required: ["query"],
      },
      execute: withLifecycle("search_worldbook", async (_c, params: Record<string, unknown>) => {
        const { worldbook } = await import("./worldbook/index.js")
        const query = params.query as string
        const maxResults = (params.maxResults as number) ?? 5
        const results = worldbook.searchByKeywords(query).slice(0, maxResults)
        const text =
          results.length > 0
            ? results.map((r) => `📖 **${r.name}**\n${r.content.slice(0, 500)}`).join("\n\n")
            : `未找到与 "${query}" 相关的世界书条目`
        return ok(text, results)
      }),
    },
  ]

  return tools
}

// ---- 旧 API: HTTP server 和 CLI 示例用 ----

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolHandler {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, sessionId: string) => Promise<string>
}

const toolRegistry = new Map<string, ToolHandler>()

export function registerTool(handler: ToolHandler): void {
  toolRegistry.set(handler.definition.name, handler)
}

export function getTool(name: string): ToolHandler | undefined {
  return toolRegistry.get(name)
}

export function listTools(): ToolHandler[] {
  return [...toolRegistry.values()]
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  const tool = getTool(name)
  if (!tool) return JSON.stringify({ error: `Tool "${name}" not found` })
  await lifecycleBus.emit("tool_call", sessionId, { tool: name, args })
  const result = await tool.execute(args, sessionId)
  await lifecycleBus.emit("tool_result", sessionId, { tool: name, result })
  return result
}

// 注册旧式内置工具
registerTool({
  definition: {
    name: "read_state",
    description: "读取当前角色的状态变量值",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" }, description: "要读取的变量名" },
      },
    },
  },
  execute: async (args, sessionId) => {
    const session = stateStore.getSession(sessionId)
    if (!session) return JSON.stringify({ error: "Session not found" })
    const keys = args.keys as string[] | undefined
    const result: Record<string, unknown> = {}
    for (const [cardId, cardState] of session.activatedCards) {
      if (!keys || keys.length === 0) {
        result[cardId] = { variables: cardState.variables }
      } else {
        const filtered: Record<string, unknown> = {}
        for (const key of keys) {
          if (key in cardState.variables) filtered[key] = cardState.variables[key]
        }
        result[cardId] = { variables: filtered }
      }
    }
    return JSON.stringify(result, null, 2)
  },
})

registerTool({
  definition: {
    name: "update_state",
    description: "更新角色状态变量",
    parameters: {
      type: "object",
      properties: {
        cardId: { type: "string", description: "目标卡片 ID" },
        updates: { type: "object", description: "要更新的键值对" },
      },
      required: ["cardId", "updates"],
    },
  },
  execute: async (args, sessionId) => {
    const session = stateStore.getSession(sessionId)
    if (!session) return JSON.stringify({ error: "Session not found" })
    const cardId = args.cardId as string
    const updates = args.updates as Record<string, unknown>
    const cardState = session.activatedCards.get(cardId)
    if (!cardState) return JSON.stringify({ error: `Card ${cardId} not active` })
    for (const [key, value] of Object.entries(updates)) {
      cardState.variables[key] = value
    }
    cardState.lastUpdated = Date.now()
    stateStore.markCardDirty(cardId)
    return JSON.stringify({ ok: true, updated: Object.keys(updates) })
  },
})

registerTool({
  definition: {
    name: "advance_time",
    description: "推进游戏内时间",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "推进量" },
        unit: { type: "string", enum: ["minutes", "hours", "days"], description: "单位" },
      },
      required: ["amount", "unit"],
    },
  },
  execute: async (args) => {
    const amount = args.amount as number
    const unit = args.unit as string
    return JSON.stringify({ ok: true, advanced: `${amount} ${unit}` })
  },
})

registerTool({
  definition: {
    name: "search_worldbook",
    description: "按关键词搜索世界书触发词条",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        maxResults: { type: "number", description: "最多返回条数，默认5" },
      },
      required: ["query"],
    },
  },
  execute: async (args) => {
    const { worldbook } = await import("./worldbook/index.js")
    const query = args.query as string
    const maxResults = (args.maxResults as number) ?? 5
    const results = worldbook.searchByKeywords(query).slice(0, maxResults)
    return JSON.stringify(results, null, 2)
  },
})
