// ============================================================
// 生命周期事件系统
// 7种事件：session_start / session_tick / session_shutdown /
// turn_start / turn_end / before_agent_start / message_end /
// input / tool_call / tool_result
// ============================================================

import type { LifecycleEvent, LifecyclePhase, LifecycleHandler } from "../types.js"

export class LifecycleBus {
  private handlers = new Map<LifecyclePhase, LifecycleHandler[]>()

  /** 注册事件处理器 */
  on(phase: LifecyclePhase, handler: LifecycleHandler): void {
    const existing = this.handlers.get(phase) ?? []
    existing.push(handler)
    this.handlers.set(phase, existing)
  }

  /** 触发事件 */
  async emit(phase: LifecyclePhase, sessionId: string, payload?: unknown): Promise<void> {
    const event: LifecycleEvent = { phase, timestamp: Date.now(), sessionId, payload }
    const handlers = this.handlers.get(phase) ?? []
    await Promise.allSettled(handlers.map((h) => h(event)))
  }

  /** 移除处理器 */
  off(phase: LifecyclePhase, handler: LifecycleHandler): void {
    const existing = this.handlers.get(phase)
    if (!existing) return
    this.handlers.set(
      phase,
      existing.filter((h) => h !== handler),
    )
  }

  /** 清空所有处理器 */
  clear(): void {
    this.handlers.clear()
  }
}

export const lifecycleBus = new LifecycleBus()
