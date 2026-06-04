// ============================================================
// 用户命令集 — 统一 API
//
// 核心逻辑定义一次，pi 扩展和 HTTP 服务器各通过薄适配器调用。
// ============================================================

import { cardManager } from "../card-manager.js"
import { contextPipeline as deprecatedPipeline } from "../context/pipeline.js"
import type { ContextPipeline } from "../context/pipeline.js"
import { stateStore } from "../state-store.js"
import type { StateStore } from "../state-store.js"
import type { CardManager } from "../card-manager.js"
import { CommandRegistry, type ExtensionContext } from "../registry.js"

// ---- 核心命令处理（返回字符串，输出格式无关） ----

type CoreCommandDeps = { st: StateStore; cm: CardManager; cp: ContextPipeline }
type CoreCommandFn = (args: string, sessionId: string, deps: CoreCommandDeps) => Promise<string>

interface CoreCommand {
  name: string
  description: string
  handler: CoreCommandFn
}

function notify(
  ctx: unknown,
  text: string,
  level: "info" | "error" | "warning" | "success" = "info",
) {
  const c = ctx as ExtensionContext | null
  if (c?.ui?.notify) {
    c.ui.notify(text, level)
  } else {
    console.log(text)
  }
}

// ========== 命令核心实现 ==========

async function cardCmd(args: string, sessionId: string, deps: CoreCommandDeps): Promise<string> {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const sub = parts[0] || "list"

  switch (sub) {
    case "list": {
      const all = deps.cm.getAllRegistered()
      const lines = [
        `角色卡列表 (${all.length} 张)`,
        ...all.map(
          (c) =>
            `  ${c.activatedAt ? "🟢" : "⚪"} ${c.id}: ${c.name}${c.activatedAt ? " (激活)" : ""}`,
        ),
      ]
      return lines.join("\n")
    }
    case "activate": {
      const cardId = parts[1]
      if (!cardId) return "用法: /card activate <cardId>"
      try {
        deps.cm.activate(cardId, sessionId)
        return `已激活: ${cardId}`
      } catch (err) {
        return `错误: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    case "deactivate": {
      const cardId = parts[1]
      if (!cardId) return "用法: /card deactivate <cardId>"
      deps.cm.deactivate(cardId)
      return `已停用: ${cardId}`
    }
    default:
      return "用法: /card list | activate <id> | deactivate <id>"
  }
}

async function statusCmd(_args: string, sessionId: string, deps: CoreCommandDeps): Promise<string> {
  const session = deps.st.getSession(sessionId)
  if (!session) return "无活跃 Session"

  const s = session.runtimeStatus
  return [
    "引擎状态",
    `Session: ${session.sessionId}`,
    `Phase: ${s.phase}`,
    `Budget: ${s.currentBudget.target}/${s.currentBudget.hard}`,
    `Bytes: ${s.totalBytesUsed}`,
    `Nodes: ${s.nodeCount}`,
    `Degradation: ${s.degradationApplied ? "YES" : "NO"}`,
    `Active cards: ${session.activatedCards.size}`,
    `History: ${session.history.length} entries`,
  ].join("\n")
}

async function resetCmd(_args: string, sessionId: string, deps: CoreCommandDeps): Promise<string> {
  const session = deps.st.getSession(sessionId)
  if (session) {
    session.history = []
    session.runtimeStatus.phase = "idle"
  }
  return "Session 已重置"
}

async function diagCmd(_args: string, sessionId: string, deps: CoreCommandDeps): Promise<string> {
  const result = await deps.cp.assemble(sessionId)
  if (result.phase !== "ready") return `管线失败: ${result.phase}`
  const lines = [
    "=== Context Assembly Trace ===",
    `节点数: ${result.status.nodeCount}`,
    `降级: ${result.status.degradationApplied}`,
    "",
  ]
  for (const entry of result.status.trace ?? []) {
    lines.push(`  [${entry.action}] ${entry.nodeId}: ${entry.reason}`)
  }
  lines.push(
    "",
    `Prompt: ${result.prompt.length} chars`,
    `Display: ${result.displayPrompt.length} chars`,
  )
  return lines.join("\n")
}

async function historyCmd(_args: string, sessionId: string, deps: CoreCommandDeps): Promise<string> {
  const session = deps.st.getSession(sessionId)
  if (!session) return "无活跃 Session"
  return session.history.map((h, i) => `[${i}] ${h}`).join("\n")
}

const coreCommands: CoreCommand[] = [
  {
    name: "card",
    description: "管理角色卡片: /card list | activate <id> | deactivate <id>",
    handler: cardCmd,
  },
  { name: "status", description: "查看引擎状态", handler: statusCmd },
  { name: "reset", description: "重置当前 session", handler: resetCmd },
  { name: "diag", description: "诊断: /diag prompt", handler: diagCmd },
  { name: "history", description: "查看对话历史", handler: historyCmd },
]

// ============================================================
// Pi 适配器（供 pi 扩展使用）
// ============================================================

/**
 * 创建适配 pi 的命令注册表（DI 版本）。
 * sessionIdRef 必须是 mutable ref ({ current: string })。
 */
export function createPiCommandRegistry(
  sessionIdRef: { current: string },
  deps: { stateStore: StateStore; cardManager: CardManager; contextPipeline: ContextPipeline },
): CommandRegistry {
  const registry = new CommandRegistry()
  const sid = () => sessionIdRef.current
  const { stateStore: st, cardManager: cm, contextPipeline: cp } = deps

  for (const cmd of coreCommands) {
    registry.register({
      name: cmd.name,
      description: cmd.description,
      handler: async (args, ctx) => {
        const text = await cmd.handler(args, sid(), { st, cm, cp })
        const level = text.startsWith("错误") ? "error" : text.startsWith("已激活") ? "success" : "info"
        notify(ctx, text, level)
      },
    })
  }

  return registry
}

// ============================================================
// HTTP 适配器（旧 API，供 HTTP server / CLI 使用）
// ============================================================

export interface CommandHandler {
  match(input: string): boolean
  execute(input: string, sessionId: string): Promise<string>
}

const commands: CommandHandler[] = []

/** @deprecated 使用 CommandRegistry 替代 */
export function registerCommand(handler: CommandHandler): void {
  commands.push(handler)
}

export async function handleCommand(input: string, sessionId: string): Promise<string> {
  // 先检查注册的旧式命令
  for (const cmd of commands) {
    if (cmd.match(input)) return cmd.execute(input, sessionId)
  }

  // 再匹配核心命令（按名称前缀派发）
  const cmdName = input.startsWith("/") ? input.slice(1).split(/\s+/)[0] : input.split(/\s+/)[0]
  const core = coreCommands.find((c) => c.name === cmdName)
  if (core) {
    const args = input.startsWith("/") ? input.slice(cmdName.length + 1).trim() : input
    const deps = { st: stateStore, cm: cardManager, cp: deprecatedPipeline }
    try {
      return await core.handler(args, sessionId, deps)
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return `Unknown command: ${input}`
}
