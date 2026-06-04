// ============================================================
// Context Assembly Pipeline
// collect → prioritize → schedule → render → trace
// 每个节点带 try-catch + fallback
// render 阶段输出两个版本：rawPrompt（给 LLM）、display（给前端）
// ============================================================

import type { Budget, PromptNode, RuntimeStatus, TraceEntry } from "../types.js"
import { schedule } from "./scheduler.js"
import { RegexEngine, type RegexPhase, regexEngine as _defaultRegexEngine } from "../regex/hooks.js"
import { StateStore, stateStore as _defaultStateStore } from "../state-store.js"

/** 上下文收集器：各模块独立申报 Node */
export interface Collector {
  name: string
  collect(sessionId: string): Promise<PromptNode[]>
}

/** 优先级排序 */
function prioritize(nodes: PromptNode[]): PromptNode[] {
  return [...nodes].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return b.attentionWeight - a.attentionWeight
  })
}

/** 渲染为最终 prompt 字符串 */
function render(included: PromptNode[], phase: RegexPhase, regexEngine: RegexEngine): string {
  const raw = included.map((n) => `[${n.source}]\n${n.content}`).join("\n\n")

  // 通过正则引擎做阶段处理
  return regexEngine.apply(raw, phase)
}

const DEGRADATION_ACTIONS = new Set(["dropped", "compressed", "summarized", "truncated"])

/** 追踪记录汇总 */
function summarizeTrace(trace: TraceEntry[]): Partial<RuntimeStatus> {
  const degraded = trace.filter((t) => DEGRADATION_ACTIONS.has(t.action)).length
  return {
    nodeCount: trace.length,
    trace,
    degradationApplied: degraded > 0,
  }
}

export type PipelinePhase =
  | { phase: "idle" }
  | { phase: "collecting"; collectors: string[] }
  | { phase: "prioritizing"; totalNodes: number }
  | { phase: "scheduling"; totalBytes: number }
  | { phase: "rendering" }
  | { phase: "ready"; prompt: string; displayPrompt: string; status: Partial<RuntimeStatus>; collectorBytes: Record<string, number> }
  | { phase: "error"; message: string }

export class ContextPipeline {
  private collectors: Collector[] = []
  private budget: Budget = { target: 8192, hard: 12288 }
  private _stateStore: StateStore
  private _regexEngine: RegexEngine

  constructor(stateStore?: StateStore, regexEngine?: RegexEngine) {
    this._stateStore = stateStore ?? _defaultStateStore
    this._regexEngine = regexEngine ?? _defaultRegexEngine
  }

  private get stateStore(): StateStore {
    return this._stateStore
  }

  private get regexEngine(): RegexEngine {
    return this._regexEngine
  }

  setBudget(budget: Budget): void {
    this.budget = budget
  }

  registerCollector(collector: Collector): void {
    this.collectors.push(collector)
  }

  async assemble(sessionId: string): Promise<PipelinePhase> {
    // ---- Phase 1: Collect ----
    const allNodes: PromptNode[] = []
    const trace: TraceEntry[] = []
    const collectorNames: string[] = []

    for (const collector of this.collectors) {
      collectorNames.push(collector.name)
      try {
        const nodes = await collector.collect(sessionId)
        for (const node of nodes) {
          trace.push({
            nodeId: node.id,
            action: "collected",
            reason: `Collected by ${collector.name}`,
            byteSizeAfter: node.byteSize,
            timestamp: Date.now(),
          })
        }
        allNodes.push(...nodes)
      } catch (err) {
        trace.push({
          nodeId: `collector:${collector.name}`,
          action: "dropped",
          reason: `Collector ${collector.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        })
      }
    }

    // ---- Phase 2: Prioritize ----
    const prioritized = prioritize(allNodes)
    trace.push({
      nodeId: "pipeline",
      action: "prioritized",
      reason: `Sorted ${prioritized.length} nodes`,
      byteSizeAfter: prioritized.reduce((s, n) => s + n.byteSize, 0),
      timestamp: Date.now(),
    })

    // ---- Phase 3: Schedule ----
    const result = schedule(prioritized, this.budget)

    // 按 source 前缀估算各 collector 的字节贡献
    const collectorBytes: Record<string, number> = {}
    for (const node of result.included) {
      const src = node.source
      let key = "other"
      if (src.startsWith("系统提示")) key = "card-base"
      else if (src.startsWith("格式规则")) key = "format-rules"
      else if (src.startsWith("Skill:")) key = "rp-skills"
      else if (src.startsWith("世界书触发:")) key = "worldbook-trigger"
      else if (src.startsWith("角色状态")) key = "state-variables"
      collectorBytes[key] = (collectorBytes[key] ?? 0) + node.byteSize
    }

    // ---- Phase 4: Render ----
    // prompt 版本：供 LLM 消费（剥离 {thought} 等内部块）
    const prompt = render(result.included, "prompt", this.regexEngine)
    // display 版本：供前端渲染（替换图片标签等）
    const displayPrompt = render(result.included, "display", this.regexEngine)

    // ---- Phase 5: Trace ----
    const status = summarizeTrace(result.trace)

    // ---- Phase 6: 同步到 Session runtimeStatus ----
    const session = this.stateStore.getSession(sessionId)
    if (session) {
      session.runtimeStatus = {
        phase: "ready",
        currentBudget: this.budget,
        totalBytesUsed: result.totalBytes,
        nodeCount: result.included.length,
        trace: result.trace,
        degradationApplied: status.degradationApplied ?? false,
      }
    }

    return {
      phase: "ready",
      prompt,
      displayPrompt,
      status,
      collectorBytes,
    }
  }
}

/** @deprecated 使用组合根 `createApp()` 或 `new ContextPipeline(stateStore, regexEngine)` 替代 */
export const contextPipeline = new ContextPipeline()
