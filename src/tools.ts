// ============================================================
// AI 工具集 — 统一 API
// ============================================================

import type { StateStore } from "./state-store.js"
import type { LifecycleBus } from "./lifecycle/events.js"
import type { Worldbook } from "./worldbook/index.js"

type CoreToolHandler = (args: Record<string, unknown>, sessionId: string) => Promise<unknown>

interface CoreToolDef {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
  handler: CoreToolHandler
}

// 模块级缓存 — 供 HTTP 适配器兼容
let _coreTools: Map<string, CoreToolDef> = new Map()
let _lifecycleBus: LifecycleBus | null = null

// ============================================================
// Pi 适配器（供 pi 扩展使用）
// ============================================================

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

/** 构建 4 个内置工具定义（纯函数，同时更新模块级缓存供 HTTP 适配器使用） */
function buildCoreTools(stateStore: StateStore, worldbook?: Worldbook): CoreToolDef[] {
  const tools: CoreToolDef[] = [
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
      handler: async (args, sessionId) => {
        const session = stateStore.getSession(sessionId)
        if (!session) throw new Error("Session not found")
        const keys = args.keys as string[] | undefined
        const result: Record<string, unknown> = {}
        for (const [cardId, cardState] of session.activatedCards) {
          if (!keys || keys.length === 0) {
            result[cardId] = { variables: { ...cardState.variables } }
          } else {
            const filtered: Record<string, unknown> = {}
            for (const key of keys) {
              if (key in cardState.variables) filtered[key] = cardState.variables[key]
            }
            result[cardId] = { variables: filtered }
          }
        }
        return result
      },
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
      handler: async (args, sessionId) => {
        const session = stateStore.getSession(sessionId)
        if (!session) throw new Error("Session not found")
        const cardId = args.cardId as string
        const updates = args.updates as Record<string, unknown>
        const cardState = session.activatedCards.get(cardId)
        if (!cardState) throw new Error(`Card "${cardId}" is not active`)
        for (const [key, value] of Object.entries(updates)) {
          cardState.variables[key] = value
        }
        cardState.lastUpdated = Date.now()
        stateStore.markCardDirty(cardId)
        return { cardId, updated: Object.keys(updates) }
      },
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
      handler: async (args) => {
        const amount = args.amount as number
        const unit = args.unit as string
        return { amount, unit }
      },
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
      handler: async (args) => {
        const query = args.query as string
        const maxResults = (args.maxResults as number) ?? 5
        if (worldbook) return worldbook.searchByKeywords(query).slice(0, maxResults)
        // fallback: deprecated singleton (kept for HTTP standalone mode)
        const { worldbook: wb } = await import("./worldbook/index.js")
        return wb.searchByKeywords(query).slice(0, maxResults)
      },
    },
  ]

  _coreTools = new Map(tools.map((t) => [t.name, t]))
  return tools
}

/** 创建适配 pi 扩展的工具列表（接受 DI 注入，不再使用模块单例） */
export function createPiTools(
  sessionIdRef: { current: string },
  stateStore: StateStore,
  lifecycleBus: LifecycleBus,
  worldbook?: Worldbook,
): PiToolDef[] {
  _lifecycleBus = lifecycleBus
  const sid = () => sessionIdRef.current

  function ok(text: string, details?: unknown) {
    return { content: [{ type: "text", text }], details }
  }
  function err(text: string) {
    return { content: [{ type: "text", text: `❌ ${text}` }], details: { error: text } }
  }

  const withLifecycle =
    (name: string, fn: CoreToolHandler): PiToolDef["execute"] =>
    async (callId, params, signal, onUpdate, ctx) => {
      try {
        await lifecycleBus?.emit("tool_call", sid(), { tool: name, args: params })
      } catch { /* lifecycle bus is optional */ }
      try {
        const data = await fn((params as Record<string, unknown>) ?? {}, sid())
        try {
          await lifecycleBus?.emit("tool_result", sid(), { tool: name, result: data })
        } catch { /* lifecycle bus is optional */ }
        return ok(formatPiResult(name, data), data)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        try {
          await lifecycleBus?.emit("tool_result", sid(), { tool: name, error: msg })
        } catch { /* lifecycle bus is optional */ }
        return err(msg)
      }
    }

  const tools = buildCoreTools(stateStore, worldbook)

  return tools.map((t) => ({
    name: t.name,
    label: t.label,
    description: t.description,
    parameters: t.parameters,
    execute: withLifecycle(t.name, t.handler),
  }))
}

/** pi 适配器：将核心结果格式化为可读文本 */
function formatPiResult(name: string, data: unknown): string {
  switch (name) {
    case "read_state": {
      const obj = data as Record<string, unknown>
      if (!obj || Object.keys(obj).length === 0) return "（无激活卡片或无状态变量）"
      return JSON.stringify(obj, null, 2)
    }
    case "update_state": {
      const u = data as { cardId: string; updated: string[] }
      return `✅ 已更新 ${u.cardId}: ${u.updated.join(", ")}`
    }
    case "advance_time": {
      const a = data as { amount: number; unit: string }
      return `⏰ 时间已推进 ${a.amount} ${a.unit}`
    }
    case "search_worldbook": {
      const results = data as Array<{ name: string; content: string }>
      if (!results || results.length === 0) return "未找到相关世界书条目"
      return results.map((r) => `📖 **${r.name}**\n${r.content.slice(0, 500)}`).join("\n\n")
    }
    default:
      return JSON.stringify(data, null, 2)
  }
}

// ============================================================
// HTTP 适配器（旧 API，供 HTTP server / CLI 使用）
// ============================================================

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolHandler {
  definition: ToolDefinition
  execute: (args: Record<string, unknown>, sessionId: string) => Promise<string>
}

export function getTool(name: string): ToolHandler | undefined {
  const core = _coreTools.get(name)
  if (!core) return undefined
  return {
    definition: {
      name: core.name,
      description: core.description,
      parameters: core.parameters,
    },
    execute: async (args, sessionId) => {
      try {
        const result = await core.handler(args, sessionId)
        return JSON.stringify(result, null, 2)
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
      }
    },
  }
}

export function listTools(): ToolHandler[] {
  return [..._coreTools.values()].map((t) => getTool(t.name)!)
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
): Promise<string> {
  const handler = getTool(name)
  if (!handler) return JSON.stringify({ error: `Tool "${name}" not found` })
  if (_lifecycleBus) {
    await _lifecycleBus.emit("tool_call", sessionId, { tool: name, args })
  }
  const result = await handler.execute(args, sessionId)
  if (_lifecycleBus) {
    await _lifecycleBus.emit("tool_result", sessionId, { tool: name, result })
  }
  return result
}

/** @deprecated 工具已统一注册到核心注册表，此函数为空操作，仅保留向后兼容 */
export function registerTool(_handler: ToolHandler): void {
  // no-op: 内置工具已通过 registerCore 注册，外部注册请使用 ToolRegistry
}
