/**
 * perception/index.ts — Perception Runtime 统一导出
 *
 * Phase 5：Perception Runtime
 * 让 Agent "感知世界" 而不是 "直接读取世界"
 *
 * 认知链：
 *   World State → Perception Filter → Awareness → Belief → Memory
 *                                                          ↓
 *   Action ← Planning ← Goal Update ← Context Assembly ← Knowledge Boundary
 *
 * 核心原则：世界状态 ≠ Agent 认知
 * Agent 只能知道：
 * - 自己看到的
 * - 自己经历的
 * - 别人告诉自己的
 * - 自己推断出的
 * - 自己记住的
 */

// ============================================================
// PerceptionFilter - 感知过滤器
// ============================================================

export { PerceptionFilter } from './perception-filter';
export type {
  PerceptionContext,
  PerceptionFilterConfig,
  PerceivedWorldState,
  PerceivedEvent,
  PerceivedLocation,
  PerceivedAgent,
  RawWorldInput,
  RawEvent,
  RawLocation,
  RawAgentInfo,
  SensoryCapabilities,
} from './perception-filter';

// ============================================================
// AwarenessRuntime - 认知运行时
// ============================================================

export { AwarenessRuntime } from './awareness-runtime';
export type {
  AwarenessFact,
  FactStatus,
  AwarenessUpdate,
  AwarenessRuntimeConfig,
  AwarenessRuntimeStats,
} from './awareness-runtime';

// ============================================================
// BeliefSystem - 信念系统
// ============================================================

export { BeliefSystem } from './belief-system';
export type {
  Belief,
  BeliefStatus,
  BeliefCategory,
  BeliefSource,
  BeliefChange,
  BeliefSystemConfig,
  BeliefSystemStats,
} from './belief-system';

// ============================================================
// VisibilityEngine - 可见性引擎
// ============================================================

export { VisibilityEngine } from './visibility-engine';
export type {
  VisibilityLevel,
  VisibilityRule,
  VisibilityCondition,
  StealthState,
  CoverType,
  PropagationState,
  VisibilityCheckContext,
  VisibleEntities,
  PropagationUpdate,
  VisibilityEngineConfig,
  VisibilityEngineStats,
} from './visibility-engine';

// ============================================================
// RumorEngine - 谣言传播
// ============================================================

export { RumorEngine } from './rumor-engine';
export type {
  Rumor,
  RumorStatus,
  RumorType,
  RumorSpreadEvent,
  RumorEngineConfig,
  RumorEngineStats,
} from './rumor-engine';

// ============================================================
// KnowledgeBoundary - 知识边界
// ============================================================

export { KnowledgeBoundary } from './knowledge-boundary';
export type {
  BoundedKnowledge,
  KnowledgeBoundaryConfig,
} from './knowledge-boundary';

// ============================================================
// PerceptionRuntime - 统一入口
// ============================================================

export { PerceptionRuntime } from './perception-runtime';
export type {
  PerceptionRuntimeConfig,
  PerceptionRuntimeSnapshot,
  PerceptionTickResult,
  ProcessedPerception,
} from './perception-runtime';

// ============================================================
// 默认导出
// ============================================================

export default PerceptionRuntime;
