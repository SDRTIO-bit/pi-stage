/**
 * debug/planning/index.ts - 规划系统调试模块统一导出
 *
 * Phase 4 调试模块，追踪 Goal Planning Runtime 的完整状态。
 *
 * 组成：
 * - GoalTracer：目标生命周期追踪
 * - DecisionTracer：决策效用分解
 * - PlannerTracer：计划执行追踪
 * - MotivationTracer：动机变化追踪
 *
 * 使用方式：
 *   import { GoalTracer, DecisionTracer, PlannerTracer, MotivationTracer } from '../debug/planning';
 *
 *   const goalTrace = new GoalTracer();
 *   goalTrace.goalCreated(goalId, desc, type, priority, trigger);
 *   goalTrace.whyCreated(goalId);      // 回溯目标创建原因
 *
 * 所有 trace 数据可实时输出到 DebugDashboard，通过 WebSocket 推送到前端。
 */

export { GoalTracer } from './goal-trace';
export type {
  GoalTraceEntry,
  GoalTraceEventType,
} from './goal-trace';

export { DecisionTracer } from './decision-trace';
export type {
  DecisionTraceEntry,
  DecisionTraceStats,
} from './decision-trace';

export { PlannerTracer } from './planner-trace';
export type {
  PlannerTraceEntry,
  PlannerTraceEventType,
  PlannerTraceStats,
} from './planner-trace';

export { MotivationTracer } from './motivation-trace';
export type {
  MotivationTraceEntry,
  MotivationTraceEventType,
} from './motivation-trace';

// ============================================================
// PlanningDebugDashboard - 规划调试统一面板（可选）
// ============================================================

import { GoalTracer } from './goal-trace';
import { DecisionTracer } from './decision-trace';
import { PlannerTracer } from './planner-trace';
import { MotivationTracer } from './motivation-trace';

/**
 * PlanningDebugDashboard - 规划调试仪表盘
 *
 * 整合所有 planning tracer 的查询。
 */
export class PlanningDebugDashboard {
  readonly goals: GoalTracer;
  readonly decisions: DecisionTracer;
  readonly planner: PlannerTracer;
  readonly motivation: MotivationTracer;

  constructor() {
    this.goals = new GoalTracer();
    this.decisions = new DecisionTracer();
    this.planner = new PlannerTracer();
    this.motivation = new MotivationTracer();
  }

  /**
   * 获取完整摘要
   */
  getFullSummary(): string {
    return [
      '╔══════════════════════════════════════════════════╗',
      '║          Goal Planning Debug Dashboard           ║',
      '╚══════════════════════════════════════════════════╝',
      '',
      '--- Goals ---',
      this.goals.getSummary(),
      '',
      '--- Decisions ---',
      (() => {
        const stats = this.decisions.getStats();
        return [
          `总决策: ${stats.totalDecisions}`,
          `探索率: ${stats.explorationRate.toFixed(1)}%`,
          `平均效用: 目标=${(stats.averageUtilityBreakdown.goalPriority * 100).toFixed(0)}% 情绪=${(stats.averageUtilityBreakdown.emotionalUrge * 100).toFixed(0)}%`,
        ].join('\n');
      })(),
      '',
      '--- Planner ---',
      (() => {
        const stats = this.planner.getStats();
        return [
          `总条目: ${stats.totalEntries}`,
          `计划完成率: ${stats.completionRate.toFixed(1)}%`,
          `平均步骤: ${stats.averageStepsPerPlan.toFixed(1)}`,
        ].join('\n');
      })(),
      '',
      '--- Motivation ---',
      this.motivation.getSummary().split('\n').slice(0, 8).join('\n'),
    ].join('\n');
  }

  /**
   * 搜索所有追踪数据
   */
  search(query: string): {
    goals: any[];
    decisions: any[];
    planner: any[];
    motivation: any[];
  } {
    const q = query.toLowerCase();
    return {
      goals: this.goals.getEntries().filter(e => e.description.toLowerCase().includes(q)),
      decisions: this.decisions.getEntries().filter(e => e.summary.toLowerCase().includes(q)),
      planner: this.planner.getEntries().filter(e => e.description.toLowerCase().includes(q)),
      motivation: this.motivation.getEntries().filter(e => e.description.toLowerCase().includes(q)),
    };
  }

  /**
   * 清空所有追踪数据
   */
  clearAll(): void {
    this.goals.clear();
    this.decisions.clear();
    this.planner.clear();
    this.motivation.clear();
  }
}

export default PlanningDebugDashboard;
