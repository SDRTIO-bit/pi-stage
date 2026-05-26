/**
 * planner-trace.ts - 行为规划追踪（调试/可视化）
 *
 * 记录 Plan 的完整生命周期：
 * - 计划生成 → 步骤执行 → 中断 → 重规划 → 完成/失败
 * - 展示每一步的执行状态和结果
 * - 显示重规划原因和备用计划切换
 */

import type { Plan, ActionStep } from '../../planning/goal-planner';

export type PlannerTraceEventType =
  | 'plan:generated'
  | 'plan:execution_started'
  | 'plan:step_executed'
  | 'plan:step_skipped'
  | 'plan:branch_taken'
  | 'plan:interrupted'
  | 'plan:resumed'
  | 'plan:replanned'
  | 'plan:fallback_activated'
  | 'plan:emotional_override'
  | 'plan:completed'
  | 'plan:failed'
  ;

export interface PlannerTraceEntry {
  id: string;
  timestamp: number;
  eventType: PlannerTraceEventType;
  planId: string;
  goalId: string;
  goalDescription: string;
  /** 当前步骤索引 */
  stepIndex: number;
  /** 步骤描述 */
  stepDescription: string;
  /** 总步骤数 */
  totalSteps: number;
  /** 额外数据 */
  data: Record<string, any>;
  description: string;
}

export class PlannerTracer {
  private entries: PlannerTraceEntry[] = [];
  /** 按 planId 索引 */
  private planTimelines: Map<string, PlannerTraceEntry[]> = new Map();
  private readonly MAX_ENTRIES = 2000;
  private idCounter: number = 0;

  /**
   * 记录计划生成
   */
  planGenerated(plan: Plan, goalDescription: string, templateId?: string): void {
    this.addEntry({
      eventType: 'plan:generated',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: 0,
      stepDescription: `计划创建 (${plan.steps.length} 步)`,
      totalSteps: plan.steps.length,
      data: { templateId, stepDescriptions: plan.steps.map(s => s.description) },
      description: `计划生成: ${goalDescription.substring(0, 40)} — ${plan.steps.length} 步${templateId ? ` (模板: ${templateId})` : ''}`,
    });
  }

  /**
   * 记录计划开始执行
   */
  planExecutionStarted(plan: Plan, goalDescription: string): void {
    this.addEntry({
      eventType: 'plan:execution_started',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: 0,
      stepDescription: plan.steps[0]?.description ?? '',
      totalSteps: plan.steps.length,
      data: {},
      description: `计划开始执行: 第 1 步 "${plan.steps[0]?.description ?? '无'}"`,
    });
  }

  /**
   * 记录步骤执行
   */
  stepExecuted(plan: Plan, stepIndex: number, goalDescription: string, result?: string): void {
    const step = plan.steps[stepIndex];
    this.addEntry({
      eventType: 'plan:step_executed',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex,
      stepDescription: step?.description ?? '',
      totalSteps: plan.steps.length,
      data: { result },
      description: `步骤 ${stepIndex + 1}/${plan.steps.length}: "${step?.description ?? ''}" 完成`,
    });
  }

  /**
   * 记录步骤跳过
   */
  stepSkipped(plan: Plan, stepIndex: number, goalDescription: string, reason: string): void {
    const step = plan.steps[stepIndex];
    this.addEntry({
      eventType: 'plan:step_skipped',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex,
      stepDescription: step?.description ?? '',
      totalSteps: plan.steps.length,
      data: { reason },
      description: `步骤 ${stepIndex + 1} 跳过: "${step?.description ?? ''}" — ${reason}`,
    });
  }

  /**
   * 记录条件分支
   */
  branchTaken(plan: Plan, fromIndex: number, toIndex: number, condition: string, goalDescription: string): void {
    this.addEntry({
      eventType: 'plan:branch_taken',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: toIndex,
      stepDescription: plan.steps[toIndex]?.description ?? '',
      totalSteps: plan.steps.length,
      data: { fromIndex, condition },
      description: `条件分支: 步骤 ${fromIndex + 1} → 步骤 ${toIndex + 1} (条件: ${condition})`,
    });
  }

  /**
   * 记录计划中断
   */
  planInterrupted(plan: Plan, goalDescription: string, reason: string, salience: number): void {
    this.addEntry({
      eventType: 'plan:interrupted',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: plan.currentStepIndex,
      stepDescription: plan.steps[plan.currentStepIndex]?.description ?? '',
      totalSteps: plan.steps.length,
      data: { reason, salience },
      description: `计划中断: 步骤 ${plan.currentStepIndex + 1}/${plan.steps.length} — ${reason} (显著性: ${(salience * 100).toFixed(0)}%)`,
    });
  }

  /**
   * 记录计划恢复
   */
  planResumed(plan: Plan, goalDescription: string): void {
    this.addEntry({
      eventType: 'plan:resumed',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: plan.currentStepIndex,
      stepDescription: plan.steps[plan.currentStepIndex]?.description ?? '',
      totalSteps: plan.steps.length,
      data: {},
      description: `计划恢复: 从步骤 ${plan.currentStepIndex + 1} 继续`,
    });
  }

  /**
   * 记录重规划
   */
  replanned(plan: Plan, goalDescription: string, newPlanId: string, reason: string): void {
    this.addEntry({
      eventType: 'plan:replanned',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: plan.currentStepIndex,
      stepDescription: '',
      totalSteps: plan.steps.length,
      data: { newPlanId, reason },
      description: `重规划: ${goalDescription.substring(0, 40)} — ${reason} → 新计划 ${newPlanId}`,
    });
  }

  /**
   * 记录备用计划激活
   */
  fallbackActivated(plan: Plan, goalDescription: string, fallbackPlanId: string): void {
    this.addEntry({
      eventType: 'plan:fallback_activated',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: 0,
      stepDescription: '',
      totalSteps: plan.steps.length,
      data: { fallbackPlanId },
      description: `备用计划激活: ${goalDescription.substring(0, 40)} → 计划 ${fallbackPlanId}`,
    });
  }

  /**
   * 记录情绪超控
   */
  emotionalOverride(plan: Plan, goalDescription: string, emotion: string, intensity: number, action: string): void {
    this.addEntry({
      eventType: 'plan:emotional_override',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: plan.currentStepIndex,
      stepDescription: action,
      totalSteps: plan.steps.length,
      data: { emotion, intensity },
      description: `情绪超控: ${emotion} (${(intensity * 100).toFixed(0)}%) → ${action}`,
    });
  }

  /**
   * 记录计划完成
   */
  planCompleted(plan: Plan, goalDescription: string): void {
    this.addEntry({
      eventType: 'plan:completed',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: plan.steps.length,
      stepDescription: '全部完成',
      totalSteps: plan.steps.length,
      data: {},
      description: `计划完成: ${plan.steps.length}/${plan.steps.length} 步`,
    });
  }

  /**
   * 记录计划失败
   */
  planFailed(plan: Plan, goalDescription: string, reason: string): void {
    this.addEntry({
      eventType: 'plan:failed',
      planId: plan.id,
      goalId: plan.goalId,
      goalDescription,
      stepIndex: plan.currentStepIndex,
      stepDescription: plan.steps[plan.currentStepIndex]?.description ?? '',
      totalSteps: plan.steps.length,
      data: { reason },
      description: `计划失败: 步骤 ${plan.currentStepIndex + 1}/${plan.steps.length} — ${reason}`,
    });
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取计划的时间线
   */
  getPlanTimeline(planId: string): PlannerTraceEntry[] {
    return this.planTimelines.get(planId) ?? [];
  }

  /**
   * 获取所有追踪条目
   */
  getEntries(filter?: {
    eventType?: PlannerTraceEventType;
    planId?: string;
    goalId?: string;
    limit?: number;
  }): PlannerTraceEntry[] {
    let result = [...this.entries];

    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.planId) result = result.filter(e => e.planId === filter.planId);
    if (filter?.goalId) result = result.filter(e => e.goalId === filter.goalId);

    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  /**
   * 获取统计
   */
  getStats(): PlannerTraceStats {
    const byType: Record<string, number> = {};
    for (const e of this.entries) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

    const uniquePlans = new Set(this.entries.map(e => e.planId)).size;
    const completed = byType['plan:completed'] ?? 0;
    const interrupted = byType['plan:interrupted'] ?? 0;
    const failed = byType['plan:failed'] ?? 0;
    const total = completed + interrupted + failed;
    const avgSteps = this.entries
      .filter(e => e.eventType === 'plan:completed')
      .reduce((s, e) => s + e.totalSteps, 0) / Math.max(1, completed);

    return {
      totalEntries: this.entries.length,
      uniquePlans,
      completedPlans: completed,
      interruptedPlans: interrupted,
      failedPlans: failed,
      completionRate: total > 0 ? (completed / total) * 100 : 0,
      averageStepsPerPlan: avgSteps,
    };
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
    this.planTimelines.clear();
  }

  private addEntry(data: Omit<PlannerTraceEntry, 'id' | 'timestamp'>): void {
    const entry: PlannerTraceEntry = {
      id: `ptrace_${++this.idCounter}`,
      timestamp: Date.now(),
      ...data,
    };

    this.entries.push(entry);

    // 更新计划时间线
    if (!this.planTimelines.has(entry.planId)) {
      this.planTimelines.set(entry.planId, []);
    }
    this.planTimelines.get(entry.planId)!.push(entry);

    if (this.entries.length > this.MAX_ENTRIES) {
      const removed = this.entries.shift()!;
      const timeline = this.planTimelines.get(removed.planId);
      if (timeline) {
        const idx = timeline.indexOf(removed);
        if (idx >= 0) timeline.splice(idx, 1);
      }
    }
  }
}

export interface PlannerTraceStats {
  totalEntries: number;
  uniquePlans: number;
  completedPlans: number;
  interruptedPlans: number;
  failedPlans: number;
  completionRate: number;
  averageStepsPerPlan: number;
}

export default PlannerTracer;
