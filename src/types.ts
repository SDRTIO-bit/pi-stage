// ============================================================
// 核心类型 — PromptNode / RuntimeStatus / 生命周期事件
// ============================================================

/** 上下文层次（对应依赖金字塔三层） */
export type ContextLayer = "L0-survival" | "L1-stable" | "L2-enhanced"

/** 降级策略 */
export type DegradationStrategy = "drop" | "compress" | "summarize" | "truncate"

/** 上下文片段标准结构 */
export interface PromptNode {
  id: string
  layer: ContextLayer
  source: string
  priority: number // 0（最高）~ 100（最低）
  attentionWeight: number // 0.0 ~ 1.0
  content: string
  byteSize: number
  degradationStrategy: DegradationStrategy
  metadata?: Record<string, unknown>
}

/** 调度预算 */
export interface Budget {
  target: number // 舒适区字节数
  hard: number // 硬上限字节数
}

/** 调试追踪记录 */
export interface TraceEntry {
  nodeId: string
  action:
    | "collected"
    | "prioritized"
    | "scheduled"
    | "dropped"
    | "compressed"
    | "summarized"
    | "truncated"
  reason: string
  byteSizeBefore?: number
  byteSizeAfter?: number
  timestamp: number
}

/** Runtime 运行时状态 */
export interface RuntimeStatus {
  phase: "idle" | "collecting" | "prioritizing" | "scheduling" | "rendering" | "ready"
  currentBudget: Budget
  totalBytesUsed: number
  nodeCount: number
  trace: TraceEntry[]
  degradationApplied: boolean
}

// ---- 生命周期事件类型 ----

/** 事件阶段 */
export type LifecyclePhase =
  | "session_start"
  | "session_tick"
  | "session_shutdown"
  | "turn_start"
  | "turn_end"
  | "before_agent_start"
  | "message_end"
  | "input"
  | "tool_call"
  | "tool_result"

/** 生命周期事件载荷 */
export interface LifecycleEvent {
  phase: LifecyclePhase
  timestamp: number
  sessionId: string
  payload?: unknown
}

/** 事件处理器 */
export type LifecycleHandler = (event: LifecycleEvent) => Promise<void>

// ---- 卡片相关 ----

export interface CardMeta {
  id: string
  name: string
  version: number
  description?: string
  tags?: string[]
  activatedAt?: number
}

export interface CardState {
  cardId: string
  variables: Record<string, unknown>
  lastUpdated: number
}

// ---- 世界书 ----

export interface WorldbookEntry {
  id: string
  name: string
  keywords: string[]
  priority: number
  constant: boolean
  enabled: boolean
  content: string
  category: "常开设定" | "触发词条" | "禁用设定"
}

export interface WorldbookIndex {
  constantEntries: WorldbookEntry[]
  triggerKeywords: Map<string, string[]>
}

// ---- 聚合类型 ----

export interface SessionState {
  sessionId: string
  startedAt: number
  activatedCards: Map<string, CardState>
  history: string[]
  runtimeStatus: RuntimeStatus
}
