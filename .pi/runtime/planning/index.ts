/**
 * planning/index.ts - Goal Planning Runtime 统一导出
 *
 * Module: Phase 4 - Goal Planning Runtime
 *
 * 将 Agent 从被动响应进化为主动目标驱动。
 * 核心行为链：
 *   MotivationEngine → GoalPlanner → BehaviorPlanner → DecisionEngine → IntentionRuntime
 *
 * 完整闭环：
 *   动机 → 目标 → 计划 → 决策 → 行为 → 结果 → 记忆与情感 → 动机
 *
 * 导入方式：
 *   import { GoalRuntime } from './planning';
 *   const runtime = new GoalRuntime(config, eventBus);
 *   runtime.initialize();
 *   runtime.tick();
 *
 * 调试：
 *   import { GoalTracer, DecisionTracer, PlannerTracer, MotivationTracer } from './debug/planning';
 */

// ============================================================
// GoalPlanner - 目标规划器
// ============================================================

export { GoalPlanner } from './goal-planner';
export type {
  Goal,
  GoalType,
  GoalStatus,
  GoalTrigger,
  GoalTriggerType,
  EmotionalVector,
  WorldCondition,
  Plan,
  ActionStep,
  ConditionalBranch,
  EmotionalTrigger,
  GoalPlannerConfig,
  GoalPlannerStats,
} from './goal-planner';

// ============================================================
// MotivationEngine - 动机系统
// ============================================================

export { MotivationEngine } from './motivation-engine';
export type {
  MotivationProfile,
  NeedState,
  NeedType as MotivationNeedType,
  Desire,
  Fear,
  Attachment,
  Ambition,
  GoalCandidate,
  MotivationEngineConfig,
} from './motivation-engine';

// ============================================================
// BehaviorPlanner - 行为规划器
// ============================================================

export { BehaviorPlanner } from './behavior-planner';
export type {
  PlanTemplate,
  PlanTemplateId,
  InterruptEvent,
  InterruptResult,
  BehaviorPlannerConfig,
  BehaviorPlannerStats,
} from './behavior-planner';

// ============================================================
// DecisionEngine - 决策引擎
// ============================================================

export { DecisionEngine } from './decision-engine';
export type {
  DecisionContext,
  CandidateAction,
  UtilityBreakdown,
  SelectedAction,
  DecisionEngineConfig,
} from './decision-engine';

// ============================================================
// IntentionRuntime - 意图运行时
// ============================================================

export { IntentionRuntime } from './intention-runtime';
export type {
  Intention,
  IntentionType,
  IntentionStatus,
  IntentionRuntimeConfig,
  IntentionRuntimeStats,
} from './intention-runtime';

// ============================================================
// PlannerIntegration - 整合层
// ============================================================

export { GoalRuntime } from './planner-integration';
export type {
  GoalRuntimeConfig,
  GoalRuntimeSnapshot,
} from './planner-integration';

// ============================================================
// 默认导出：GoalRuntime（最常用的高级接口）
// ============================================================

export default GoalRuntime;
