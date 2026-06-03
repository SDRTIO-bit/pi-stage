// ============================================================
// Agent 管线（turn_end 入口）— 中间件模式
// 支持注册自定义规则钩子，替代固定硬编码逻辑
// 注意：不自动注册到 lifecycleBus，由调用方显式控制执行时机
// ============================================================

export interface AgentAction {
  type: "state_update" | "world_shift" | "runtime_flush" | "noop"
  description: string
  payload?: unknown
}

export interface AgentContext {
  sessionId: string
  actions: AgentAction[]
}

export type AgentMiddleware = (ctx: AgentContext, next: () => Promise<void>) => Promise<void>

export class AgentPipeline {
  private middlewares: AgentMiddleware[] = []

  /** 注册中间件，按注册顺序执行 */
  use(middleware: AgentMiddleware): void {
    this.middlewares.push(middleware)
  }

  /** 运行管线 */
  async run(sessionId: string): Promise<AgentAction[]> {
    const ctx: AgentContext = { sessionId, actions: [] }
    let index = -1

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) return
      index = i
      if (i >= this.middlewares.length) return
      await this.middlewares[i](ctx, () => dispatch(i + 1))
    }

    await dispatch(0)
    return ctx.actions
  }

  /** 清空中间件 */
  clear(): void {
    this.middlewares.length = 0
  }
}

export const agentPipeline = new AgentPipeline()

// ---- 内置中间件 ----
// 注意：持久化统一由调用方（server.ts）负责，中间件不自动持久化

// 状态变更摘要
agentPipeline.use(async (ctx, next) => {
  const dirtyCards = (await import("../state-store.js")).stateStore.getDirtyCards()
  if (dirtyCards.length > 0) {
    ctx.actions.push({
      type: "state_update",
      description: `${dirtyCards.length} dirty card(s) detected`,
      payload: dirtyCards,
    })
    ;(await import("../state-store.js")).stateStore.clearDirtyCards()
  }
  await next()
})
