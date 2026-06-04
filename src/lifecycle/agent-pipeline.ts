// ============================================================
// Agent 管线（turn_end 入口）— 中间件模式
// 支持注册自定义规则钩子，替代固定硬编码逻辑
// 注意：不自动注册到 lifecycleBus，由调用方显式控制执行时机
// ============================================================

import { StateStore, stateStore as _defaultStateStore } from "../state-store.js"

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
  private _stateStore: StateStore

  constructor(stateStore?: StateStore) {
    this._stateStore = stateStore ?? _defaultStateStore
  }

  private get stateStore(): StateStore {
    return this._stateStore
  }

  /** 获取内部 StateStore（供中间件使用） */
  getStateStore(): StateStore {
    return this._stateStore
  }

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

/** @deprecated 使用组合根 `createApp()` 或 `new AgentPipeline(stateStore)` 替代 */
export const agentPipeline = new AgentPipeline()
