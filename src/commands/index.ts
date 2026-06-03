// ============================================================
// 用户命令集
// /card list|activate|deactivate / /reset / /status / /history / /diag
//
// 提供两套 API:
//   1. createPiCommands(sessionIdRef) → 返回适配 pi 扩展的 CommandRegistry
//   2. handleCommand() / registerCommand() → 旧 API (供 HTTP server)
// ============================================================

import { cardManager } from "../card-manager.js"
import { contextPipeline } from "../context/pipeline.js"
import { stateStore } from "../state-store.js"
import { CommandRegistry, type ExtensionContext } from "../registry.js"

// ---- 新 API: 适配 pi 扩展 ----

/**
 * 创建适配 pi 的命令注册表。
 * sessionIdRef 必须是 mutable ref ({ current: string })。
 */
export function createPiCommandRegistry(sessionIdRef: { current: string }): CommandRegistry {
  const registry = new CommandRegistry()
  const sid = () => sessionIdRef.current

  // 辅助：通过 ctx.ui.notify 输出
  function notify(
    ctx: unknown,
    text: string,
    level: "info" | "error" | "warning" | "success" = "info",
  ) {
    const c = ctx as ExtensionContext | null
    if (c?.ui?.notify) {
      c.ui.notify(text, level)
    } else {
      // 兜底：非交互模式
      console.log(text)
    }
  }

  // ---- /card ----
  registry.register({
    name: "card",
    description: "管理角色卡片: /card list | activate <id> | deactivate <id>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] || "list"

      switch (sub) {
        case "list": {
          const all = cardManager.getAllRegistered()
          const lines = [
            `📇 角色卡列表 (${all.length} 张)`,
            ...all.map(
              (c) =>
                `  ${c.activatedAt ? "🟢" : "⚪"} ${c.id}: ${c.name}${c.activatedAt ? " (激活)" : ""}`,
            ),
          ]
          notify(ctx, lines.join("\n"), "info")
          return
        }
        case "activate": {
          const cardId = parts[1]
          if (!cardId) {
            notify(ctx, "用法: /card activate <cardId>", "error")
            return
          }
          try {
            cardManager.activate(cardId, sid())
            notify(ctx, `✅ 已激活: ${cardId}`, "success")
          } catch (err) {
            notify(ctx, `❌ ${err instanceof Error ? err.message : String(err)}`, "error")
          }
          return
        }
        case "deactivate": {
          const cardId = parts[1]
          if (!cardId) {
            notify(ctx, "用法: /card deactivate <cardId>", "error")
            return
          }
          cardManager.deactivate(cardId)
          notify(ctx, `💤 已停用: ${cardId}`, "info")
          return
        }
        default:
          notify(ctx, "用法: /card list | activate <id> | deactivate <id>", "error")
      }
    },
  })

  // ---- /status ----
  registry.register({
    name: "status",
    description: "查看引擎状态",
    handler: async (_args, ctx) => {
      const session = stateStore.getSession(sid())
      if (!session) {
        notify(ctx, "无活跃 Session", "error")
        return
      }

      const s = session.runtimeStatus
      const lines = [
        "🔧 引擎状态",
        `Session: ${session.sessionId}`,
        `Phase: ${s.phase}`,
        `Budget: ${s.currentBudget.target}/${s.currentBudget.hard}`,
        `Bytes: ${s.totalBytesUsed}`,
        `Nodes: ${s.nodeCount}`,
        `Degradation: ${s.degradationApplied ? "YES" : "NO"}`,
        `Active cards: ${session.activatedCards.size}`,
        `History: ${session.history.length} entries`,
      ]
      notify(ctx, lines.join("\n"), "info")
    },
  })

  // ---- /reset ----
  registry.register({
    name: "reset",
    description: "重置当前 session",
    handler: async (_args, ctx) => {
      const session = stateStore.getSession(sid())
      if (session) {
        session.history = []
        session.runtimeStatus.phase = "idle"
      }
      notify(ctx, "✅ Session 已重置", "success")
    },
  })

  // ---- /diag ----
  registry.register({
    name: "diag",
    description: "诊断: /diag prompt",
    handler: async (_args, ctx) => {
      const result = await contextPipeline.assemble(sid())
      if (result.phase !== "ready") {
        notify(ctx, `管线失败: ${result.phase}`, "error")
        return
      }
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
      notify(ctx, lines.join("\n"), "info")
    },
  })

  return registry
}

// ---- 旧 API: 供 HTTP server 和 CLI 示例使用 ----

export interface CommandHandler {
  match(input: string): boolean
  execute(input: string, sessionId: string): Promise<string>
}

const commands: CommandHandler[] = []

export function registerCommand(handler: CommandHandler): void {
  commands.push(handler)
}

export async function handleCommand(input: string, sessionId: string): Promise<string> {
  for (const cmd of commands) {
    if (cmd.match(input)) return cmd.execute(input, sessionId)
  }
  return `Unknown command: ${input}`
}

// 注册旧式命令（server.ts 使用）
registerCommand({
  match: (input) => input.startsWith("/card"),
  execute: async (input, sessionId) => {
    const parts = input.split(/\s+/)
    const sub = parts[1]
    switch (sub) {
      case "list": {
        const active = cardManager.getActiveCards()
        const all = cardManager.getAllRegistered()
        return [
          "=== Active Cards ===",
          ...active.map((c) => `  ${c.id}: ${c.name} (v${c.version})`),
          "=== Registered ===",
          ...all.map((c) => `  ${c.id}: ${c.name} ${c.activatedAt ? "(active)" : "(inactive)"}`),
        ].join("\n")
      }
      case "activate": {
        const cardId = parts[2]
        if (!cardId) return "Usage: /card activate <cardId>"
        try {
          cardManager.activate(cardId, sessionId)
          return `Card ${cardId} activated`
        } catch (err) {
          return `Failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      case "deactivate": {
        const cardId = parts[2]
        if (!cardId) return "Usage: /card deactivate <cardId>"
        cardManager.deactivate(cardId)
        return `Card ${cardId} deactivated`
      }
      default:
        return "Usage: /card list|activate|deactivate"
    }
  },
})

registerCommand({
  match: (input) => input === "/status",
  execute: async (_input, sessionId) => {
    const session = stateStore.getSession(sessionId)
    if (!session) return "No active session"
    const status = session.runtimeStatus
    return [
      `Phase: ${status.phase}`,
      `Budget: ${status.currentBudget.target}/${status.currentBudget.hard}`,
      `Bytes used: ${status.totalBytesUsed}`,
      `Nodes: ${status.nodeCount}`,
      `Degradation: ${status.degradationApplied ? "YES" : "NO"}`,
      `Active cards: ${session.activatedCards.size}`,
      `History entries: ${session.history.length}`,
    ].join("\n")
  },
})

registerCommand({
  match: (input) => input.startsWith("/diag"),
  execute: async (input, sessionId) => {
    const parts = input.split(/\s+/)
    if (parts[1] !== "prompt") return "Usage: /diag prompt"
    const result = await contextPipeline.assemble(sessionId)
    if (result.phase !== "ready") return `Pipeline failed: ${result.phase}`
    const lines = [
      "=== Context Assembly Trace ===",
      `Total nodes: ${result.status.nodeCount}`,
      `Degradation applied: ${result.status.degradationApplied}`,
      "---",
    ]
    for (const entry of result.status.trace ?? []) {
      lines.push(`  [${entry.action}] ${entry.nodeId}: ${entry.reason}`)
    }
    lines.push(
      "---",
      `Prompt length: ${result.prompt.length} chars`,
      `Display length: ${result.displayPrompt.length} chars`,
    )
    return lines.join("\n")
  },
})

registerCommand({
  match: (input) => input === "/reset",
  execute: async (_input, sessionId) => {
    const session = stateStore.getSession(sessionId)
    if (session) {
      session.history = []
      session.runtimeStatus.phase = "idle"
    }
    return "Session reset"
  },
})

registerCommand({
  match: (input) => input === "/history",
  execute: async (_input, sessionId) => {
    const session = stateStore.getSession(sessionId)
    if (!session) return "No active session"
    return session.history.map((h, i) => `[${i}] ${h}`).join("\n")
  },
})
