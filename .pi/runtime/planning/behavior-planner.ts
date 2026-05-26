/**
 * behavior-planner.ts - 行为规划器
 *
 * 将目标转换为可执行的 Plan → Sub-plan → Action Sequence
 *
 * 核心特性：
 * - 条件计划：步骤带前置条件检查，不满足自动跳过或等待
 * - 中断与重规划：高显著性突发事件可中断当前 Plan，事后恢复或重规划
 * - 情绪超控：强烈情绪可立即插入高优先级动作覆盖当前行为
 * - 备用计划：主计划失败时自动切换 fallback
 *
 * 与 DecisionEngine 整合：
 * - BehaviorPlanner 生成候选动作 → DecisionEngine 选择 → 执行
 *
 * 与 Attention Runtime 整合：
 * - 当前 Plan 的下一步骤作为高注意力锚点
 * - 突发事件显著性高于阈值时触发 Plan 中断
 */

import type { Goal, Plan, ActionStep, ConditionalBranch, EmotionalTrigger } from './goal-planner';
import { GoalPlanner } from './goal-planner';
import type { EventBus } from '../events/event-bus';

// ============================================================
// 类型定义
// ============================================================

export type PlanTemplateId = string;

export interface PlanTemplate {
  id: PlanTemplateId;
  /** 适用的目标描述关键词 */
  applicableTo: string[];
  /** 计划步骤模板 */
  steps: Array<{
    description: string;
    type: ActionStep['type'];
    prerequisite?: string;
    expectedDuration?: number;
  }>;
  /** 条件分支 */
  conditionalBranches?: Array<{
    condition: string;
    targetStepIndex: number;
    description: string;
  }>;
  /** 备用计划模板 ID */
  fallbackTemplateId?: string;
  /** 情绪超控配置 */
  emotionalOverride?: EmotionalTrigger;
}

export interface InterruptEvent {
  /** 中断源类型 */
  source: 'attention' | 'emotion' | 'external' | 'world_event';
  /** 中断原因 */
  reason: string;
  /** 显著性分数 0-1 */
  salience: number;
  /** 关联的动作描述 */
  suggestedAction?: string;
  /** 中断时间戳 */
  timestamp: number;
}

export type InterruptResult = 'resume' | 'replan' | 'abandon';

export interface BehaviorPlannerConfig {
  /** 最大步骤数 */
  maxStepsPerPlan: number;
  /** 步骤等待超时（毫秒） */
  stepWaitTimeout: number;
  /** 重规划冷却 tick */
  replanCooldownTicks: number;
  /** 是否启用情绪超控 */
  enableEmotionalOverride: boolean;
  /** 情绪超控阈值 */
  emotionalOverrideThreshold: number;
  /** 计划模板 */
  planTemplates: PlanTemplate[];
}

const DEFAULT_BEHAVIOR_PLANNER_CONFIG: BehaviorPlannerConfig = {
  maxStepsPerPlan: 10,
  stepWaitTimeout: 30000,
  replanCooldownTicks: 5,
  enableEmotionalOverride: true,
  emotionalOverrideThreshold: 0.7,
  planTemplates: [],
};

// ============================================================
// 默认计划模板
// ============================================================

const DEFAULT_PLAN_TEMPLATES: PlanTemplate[] = [
  {
    id: 'socialize_default',
    applicableTo: ['社交', '聊天', '找人', 'social', 'talk', '对话'],
    steps: [
      { description: '找到目标人物所在位置', type: 'action', expectedDuration: 5000 },
      { description: '靠近目标人物', type: 'action', expectedDuration: 3000 },
      { description: '开启对话', type: 'decision', expectedDuration: 2000 },
      { description: '根据对方反应调整话题', type: 'decision' },
      { description: '结束对话并评估关系变化', type: 'action', expectedDuration: 2000 },
    ],
    conditionalBranches: [
      { condition: '对方不在当前位置', targetStepIndex: 0, description: '询问他人目标去向' },
    ],
    emotionalOverride: {
      emotion: 'fear',
      threshold: 0.7,
      action: 'interrupt',
      targetActionDescription: '礼貌地结束对话并离开',
    },
  },
  {
    id: 'explore_default',
    applicableTo: ['探索', '查看', '四处看看', 'explore', '探索新地点'],
    steps: [
      { description: '环顾四周，观察环境', type: 'action', expectedDuration: 3000 },
      { description: '选择感兴趣的方向', type: 'decision', expectedDuration: 2000 },
      { description: '向选定的方向移动', type: 'action', expectedDuration: 5000 },
      { description: '记录发现', type: 'action', expectedDuration: 2000 },
    ],
    conditionalBranches: [
      { condition: '发现危险', targetStepIndex: 3, description: '记录危险标记后返回' },
    ],
  },
  {
    id: 'rest_default',
    applicableTo: ['休息', '放松', 'rest', 'relax'],
    steps: [
      { description: '寻找舒适的地方', type: 'action', expectedDuration: 3000 },
      { description: '确认环境安全', type: 'action', expectedDuration: 2000 },
      { description: '开始休息', type: 'action', expectedDuration: 10000 },
    ],
  },
  {
    id: 'relationship_repair',
    applicableTo: ['修复', '关系', '和好', 'repair', 'relationship'],
    steps: [
      { description: '回忆关系恶化的原因', type: 'action', expectedDuration: 3000 },
      { description: '找到对方', type: 'action', expectedDuration: 5000 },
      { description: '主动开口，表达歉意或理解', type: 'decision', expectedDuration: 3000 },
      { description: '观察对方反应', type: 'decision' },
      { description: '根据反应决定下一步行动', type: 'decision' },
    ],
    emotionalOverride: {
      emotion: 'anger',
      threshold: 0.6,
      action: 'interrupt',
      targetActionDescription: '冷静一下，暂时离开现场',
    },
  },
];

// ============================================================
// BehaviorPlanner 实现
// ============================================================

export class BehaviorPlanner {
  private config: BehaviorPlannerConfig;
  private eventBus: EventBus | null;
  private goalPlanner: GoalPlanner;

  /** 中断事件队列 */
  private interruptQueue: InterruptEvent[] = [];

  /** 重规划冷却跟踪 */
  private replanCooldowns: Map<string, number> = new Map();

  /** tick 计数器 */
  private tickCounter: number = 0;

  constructor(
    goalPlanner: GoalPlanner,
    config?: Partial<BehaviorPlannerConfig>,
    eventBus?: EventBus
  ) {
    this.goalPlanner = goalPlanner;
    this.eventBus = eventBus ?? null;
    this.config = {
      ...DEFAULT_BEHAVIOR_PLANNER_CONFIG,
      ...config,
      planTemplates: [...DEFAULT_PLAN_TEMPLATES, ...(config?.planTemplates ?? [])],
    };
  }

  // ============================================================
  // 主 tick
  // ============================================================

  /**
   * 每 tick 调用：推进活跃目标的计划执行
   */
  tick(): void {
    this.tickCounter++;

    // 1. 冷却递减
    for (const [planId, remaining] of this.replanCooldowns) {
      if (remaining > 0) {
        this.replanCooldowns.set(planId, remaining - 1);
      } else {
        this.replanCooldowns.delete(planId);
      }
    }

    // 2. 处理中断队列
    this.processInterrupts();

    // 3. 推进活跃目标的计划
    const activeGoals = this.goalPlanner.getActiveGoals();
    for (const goal of activeGoals) {
      this.advanceGoalPlan(goal);
    }
  }

  // ============================================================
  // 计划生成
  // ============================================================

  /**
   * 为目标生成计划
   */
  generatePlan(goal: Goal): Plan | null {
    // 1. 根据目标描述匹配合适的模板
    const template = this.findMatchingTemplate(goal.description);
    if (!template) {
      // 无匹配模板，生成简单线性计划
      return this.generateSimplePlan(goal);
    }

    // 2. 从模板创建计划
    const steps: ActionStep[] = template.steps.map((s, i) => ({
      id: `step_${goal.id}_${i}`,
      description: s.description,
      type: s.type,
      prerequisite: s.prerequisite,
      expectedDuration: s.expectedDuration,
    }));

    const conditionalBranches: ConditionalBranch[] = (template.conditionalBranches ?? []).map(b => ({
      condition: b.condition,
      targetStepIndex: b.targetStepIndex,
      description: b.description,
    }));

    const plan = this.goalPlanner.addPlan(goal.id, {
      steps,
      currentStepIndex: 0,
      status: 'pending',
      conditionalBranches,
      fallbackPlanId: undefined,
      emotionalOverride: template.emotionalOverride,
    });

    // 如果有备用模板，也创建备用计划
    if (template.fallbackTemplateId) {
      const fallbackTemplate = this.config.planTemplates.find(t => t.id === template.fallbackTemplateId);
      if (fallbackTemplate) {
        const fallbackSteps: ActionStep[] = fallbackTemplate.steps.map((s, i) => ({
          id: `step_${goal.id}_fallback_${i}`,
          description: s.description,
          type: s.type,
          prerequisite: s.prerequisite,
          expectedDuration: s.expectedDuration,
        }));

        const fallbackPlan = this.goalPlanner.addPlan(goal.id, {
          steps: fallbackSteps,
          currentStepIndex: 0,
          status: 'pending',
          conditionalBranches: [],
          emotionalOverride: fallbackTemplate.emotionalOverride,
        });
        plan.fallbackPlanId = fallbackPlan.id;
      }
    }

    this.eventBus?.emit('plan:generated', {
      planId: plan.id,
      goalId: goal.id,
      templateId: template.id,
      stepCount: steps.length,
    });

    return plan;
  }

  /**
   * 查找匹配的计划模板
   */
  private findMatchingTemplate(goalDescription: string): PlanTemplate | undefined {
    const lowerDesc = goalDescription.toLowerCase();
    // 按 applicableTo 匹配度排序
    const scored = this.config.planTemplates.map(template => {
      const matchCount = template.applicableTo.filter(keyword =>
        lowerDesc.includes(keyword.toLowerCase())
      ).length;
      return { template, score: matchCount };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0]?.score > 0 ? scored[0].template : undefined;
  }

  /**
   * 生成简单线性计划（无匹配模板时）
   */
  private generateSimplePlan(goal: Goal): Plan {
    const steps: ActionStep[] = [
      {
        id: `step_${goal.id}_analyze`,
        description: `分析当前状态，为"${goal.description}"做准备`,
        type: 'action',
        expectedDuration: 3000,
      },
      {
        id: `step_${goal.id}_action`,
        description: `执行：${goal.description}`,
        type: 'action',
        expectedDuration: 5000,
      },
      {
        id: `step_${goal.id}_evaluate`,
        description: `评估"${goal.description}"的进展`,
        type: 'decision',
        expectedDuration: 2000,
      },
      {
        id: `step_${goal.id}_adjust`,
        description: `根据评估结果调整策略`,
        type: 'decision',
      },
    ];

    return this.goalPlanner.addPlan(goal.id, {
      steps,
      currentStepIndex: 0,
      status: 'pending',
      conditionalBranches: [],
    });
  }

  // ============================================================
  // 计划推进
  // ============================================================

  /**
   * 推进目标当前的计划
   */
  private advanceGoalPlan(goal: Goal): void {
    const activePlan = this.goalPlanner.getActivePlan(goal.id);
    let plan = activePlan ?? this.goalPlanner.getNextPlan(goal.id);

    if (!plan) {
      // 没有计划 → 生成
      plan = this.generatePlan(goal);
      if (!plan) return;
    }

    // 如果计划还没开始，开始执行
    if (plan.status === 'pending') {
      plan.status = 'executing';
      plan.currentStepIndex = 0;
      plan.lastModified = Date.now();

      this.eventBus?.emit('plan:execution_started', {
        planId: plan.id,
        goalId: goal.id,
        firstStep: plan.steps[0]?.description,
      });
    }

    // 检查是否应该执行当前步骤
    if (plan.status === 'executing') {
      this.executeCurrentStep(goal, plan);
    }

    // 检查所有步骤是否已完成
    if (plan.currentStepIndex >= plan.steps.length) {
      plan.status = 'completed';
      plan.lastModified = Date.now();

      this.eventBus?.emit('plan:completed', {
        planId: plan.id,
        goalId: goal.id,
        stepCount: plan.steps.length,
      });

      // 推进目标进度
      this.goalPlanner.updateProgress(goal.id, 0.3);
    }
  }

  /**
   * 执行当前步骤
   */
  private executeCurrentStep(goal: Goal, plan: Plan): void {
    if (plan.currentStepIndex >= plan.steps.length) return;

    const step = plan.steps[plan.currentStepIndex];

    // 检查前置条件
    if (step.prerequisite) {
      const conditionMet = this.checkPrerequisite(step.prerequisite, goal, plan);
      if (!conditionMet) {
        // 条件不满足，跳过或等待（由条件分支决定）
        const branch = this.evaluateConditionalBranches(plan, goal);
        if (branch !== undefined) {
          plan.currentStepIndex = branch;
          plan.lastModified = Date.now();
          this.eventBus?.emit('plan:branch_taken', {
            planId: plan.id,
            goalId: goal.id,
            fromStep: step.id,
            toStepIndex: branch,
            condition: plan.conditionalBranches.find(b =>
              plan.steps.indexOf(step) < b.targetStepIndex
            )?.condition ?? 'unknown',
          });
          return;
        }
        // 没有分支匹配，等待
        return;
      }
    }

    // 检查情绪超控
    if (this.config.enableEmotionalOverride && plan.emotionalOverride) {
      const override = plan.emotionalOverride;
      // 情绪超控由外部检查触发，这里只做标记
    }

    // 执行步骤（标记为"已执行"，实际行为由 DecisionEngine 选择）
    step.completedAt = Date.now();
    plan.currentStepIndex++;
    plan.lastModified = Date.now();

    this.eventBus?.emit('plan:step_executed', {
      planId: plan.id,
      goalId: goal.id,
      stepId: step.id,
      stepDescription: step.description,
      stepIndex: plan.currentStepIndex - 1,
      remainingSteps: plan.steps.length - plan.currentStepIndex,
    });
  }

  /**
   * 检查前置条件
   */
  private checkPrerequisite(prerequisite: string, goal: Goal, plan: Plan): boolean {
    // 简化的前置条件检查
    // 实际实现中应查询 WorldState、关系系统等
    const lower = prerequisite.toLowerCase();

    // 常见前置条件模式
    if (lower.includes('存在') || lower.includes('有')) {
      // TODO: 查询世界状态
      return true; // 默认假设满足
    }
    if (lower.includes('不在')) {
      // TODO: 查询位置
      return true;
    }

    return true; // 默认满足
  }

  /**
   * 评估条件分支
   */
  private evaluateConditionalBranches(plan: Plan, goal: Goal): number | undefined {
    for (const branch of plan.conditionalBranches) {
      if (this.evaluateCondition(branch.condition, goal, plan)) {
        return branch.targetStepIndex;
      }
    }
    return undefined;
  }

  /**
   * 评估单个条件
   */
  private evaluateCondition(condition: string, goal: Goal, plan: Plan): boolean {
    const lower = condition.toLowerCase();

    // 常见条件模式
    if (lower.includes('不在') || lower.includes('找不到')) return Math.random() < 0.2;
    if (lower.includes('危险')) return Math.random() < 0.1;
    if (lower.includes('对方') && lower.includes('反应')) return Math.random() < 0.5;

    return false;
  }

  // ============================================================
  // 中断与重规划
  // ============================================================

  /**
   * 推送中断事件（由 Attention Runtime 等外部系统调用）
   */
  pushInterrupt(event: InterruptEvent): void {
    this.interruptQueue.push(event);
    this.eventBus?.emit('plan:interrupt_pushed', {
      source: event.source,
      reason: event.reason,
      salience: event.salience,
    });
  }

  /**
   * 处理中断队列
   */
  private processInterrupts(): void {
    if (this.interruptQueue.length === 0) return;

    // 按显著性排序
    this.interruptQueue.sort((a, b) => b.salience - a.salience);

    for (const interrupt of this.interruptQueue) {
      if (interrupt.salience < 0.6) continue; // 低显著性忽略

      const activeGoals = this.goalPlanner.getActiveGoals();
      for (const goal of activeGoals) {
        const activePlan = this.goalPlanner.getActivePlan(goal.id);
        if (!activePlan || activePlan.status !== 'executing') continue;

        const result = this.handleInterrupt(goal, activePlan, interrupt);

        this.eventBus?.emit('plan:interrupted', {
          planId: activePlan.id,
          goalId: goal.id,
          interruptSource: interrupt.source,
          reason: interrupt.reason,
          result,
        });

        if (result === 'abandon') break;
      }
    }

    this.interruptQueue = [];
  }

  /**
   * 处理单个中断
   */
  private handleInterrupt(goal: Goal, plan: Plan, interrupt: InterruptEvent): InterruptResult {
    // 检查重规划冷却
    const cooldown = this.replanCooldowns.get(plan.id);
    if (cooldown && cooldown > 0) return 'resume';

    if (interrupt.salience >= 0.9) {
      // 极高显著性：放弃当前计划
      plan.status = 'interrupted';
      plan.lastModified = Date.now();

      // 如果中断带建议动作，生成反应式计划
      if (interrupt.suggestedAction) {
        const reactiveGoal = this.goalPlanner.createGoal({
          type: 'reactive',
          description: interrupt.suggestedAction,
          priority: interrupt.salience,
          createdFrom: {
            type: 'world_event',
            sourceId: `interrupt_${Date.now()}`,
            description: interrupt.reason,
            timestamp: Date.now(),
          },
          tags: ['reactive', 'interrupt'],
        });
        this.generatePlan(reactiveGoal);
      }

      this.replanCooldowns.set(plan.id, this.config.replanCooldownTicks);
      return 'abandon';
    }

    if (interrupt.salience >= 0.7) {
      // 高显著性：中断计划但保留，后续可恢复
      plan.status = 'interrupted';
      plan.lastModified = Date.now();
      this.replanCooldowns.set(plan.id, this.config.replanCooldownTicks);
      return 'replan';
    }

    // 中等显著性：记录但不中断
    return 'resume';
  }

  /**
   * 恢复中断的计划
   */
  resumePlan(planId: string): boolean {
    const allGoals = this.goalPlanner.getAllGoals();
    for (const goal of allGoals) {
      const plan = goal.plans.find(p => p.id === planId);
      if (plan && plan.status === 'interrupted') {
        plan.status = 'executing';
        plan.lastModified = Date.now();
        this.eventBus?.emit('plan:resumed', {
          planId: plan.id,
          goalId: goal.id,
          currentStep: plan.steps[plan.currentStepIndex]?.description,
        });
        return true;
      }
    }
    return false;
  }

  /**
   * 重规划：为中断的计划生成新的替代计划
   */
  replan(goalId: string): Plan | null {
    const goal = this.goalPlanner.getGoal(goalId);
    if (!goal) return null;

    // 标记旧计划为失败
    for (const plan of goal.plans) {
      if (plan.status === 'interrupted' || plan.status === 'failed') continue;
      plan.status = 'failed';
    }

    // 如果有备用计划，激活它
    const interruptedPlan = goal.plans.find(p => p.status === 'interrupted' || p.fallbackPlanId);
    if (interruptedPlan?.fallbackPlanId) {
      const fallback = goal.plans.find(p => p.id === interruptedPlan.fallbackPlanId);
      if (fallback) {
        fallback.status = 'pending';
        fallback.currentStepIndex = 0;
        fallback.lastModified = Date.now();
        this.eventBus?.emit('plan:fallback_activated', {
          planId: fallback.id,
          goalId: goal.id,
        });
        return fallback;
      }
    }

    // 否则生成新计划
    return this.generatePlan(goal);
  }

  // ============================================================
  // 情绪超控
  // ============================================================

  /**
   * 检查并应用情绪超控
   * 由外部（Emotion 系统）调用
   */
  applyEmotionalOverride(
    emotion: string,
    intensity: number,
    goalId?: string
  ): { action: 'interrupt' | 'override' | 'append'; description: string } | null {
    if (!this.config.enableEmotionalOverride) return null;
    if (intensity < this.config.emotionalOverrideThreshold) return null;

    const targets = goalId
      ? [this.goalPlanner.getGoal(goalId)].filter(Boolean) as Goal[]
      : this.goalPlanner.getActiveGoals();

    for (const goal of targets) {
      const activePlan = this.goalPlanner.getActivePlan(goal.id);
      if (!activePlan?.emotionalOverride) continue;
      if (activePlan.emotionalOverride.emotion !== emotion) continue;
      if (intensity < activePlan.emotionalOverride.threshold) continue;

      const override = activePlan.emotionalOverride;

      if (override.action === 'interrupt') {
        activePlan.status = 'interrupted';
        activePlan.lastModified = Date.now();
        this.eventBus?.emit('plan:emotional_override', {
          planId: activePlan.id,
          goalId: goal.id,
          emotion,
          intensity,
          action: 'interrupt',
        });
        return { action: 'interrupt', description: override.targetActionDescription };
      }

      if (override.action === 'override') {
        // 替换当前步骤
        this.eventBus?.emit('plan:emotional_override', {
          planId: activePlan.id,
          goalId: goal.id,
          emotion,
          intensity,
          action: 'override',
        });
        return { action: 'override', description: override.targetActionDescription };
      }

      if (override.action === 'append') {
        // 在当前步骤后追加动作
        const newStep: ActionStep = {
          id: `step_em_${Date.now()}`,
          description: override.targetActionDescription,
          type: 'action',
        };
        activePlan.steps.splice(activePlan.currentStepIndex + 1, 0, newStep);
        activePlan.lastModified = Date.now();
        this.eventBus?.emit('plan:emotional_override', {
          planId: activePlan.id,
          goalId: goal.id,
          emotion,
          intensity,
          action: 'append',
        });
        return { action: 'append', description: override.targetActionDescription };
      }
    }

    return null;
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取目标的下一个待执行动作描述
   */
  getNextAction(goalId: string): string | null {
    const goal = this.goalPlanner.getGoal(goalId);
    if (!goal) return null;

    const activePlan = this.goalPlanner.getActivePlan(goalId);
    const plan = activePlan ?? this.goalPlanner.getNextPlan(goalId);
    if (!plan || plan.status === 'completed') return null;

    if (plan.currentStepIndex < plan.steps.length) {
      return plan.steps[plan.currentStepIndex].description;
    }

    return null;
  }

  /**
   * 获取所有待执行的动作（供 DecisionEngine 选择）
   */
  getAllCandidateActions(): Array<{ goalId: string; planId: string; step: ActionStep; priority: number }> {
    const candidates: Array<{ goalId: string; planId: string; step: ActionStep; priority: number }> = [];
    const activeGoals = this.goalPlanner.getActiveGoals();

    for (const goal of activeGoals) {
      const plan = this.goalPlanner.getActivePlan(goal.id) ?? this.goalPlanner.getNextPlan(goal.id);
      if (!plan || plan.status === 'completed' || plan.status === 'failed') continue;

      if (plan.currentStepIndex < plan.steps.length) {
        candidates.push({
          goalId: goal.id,
          planId: plan.id,
          step: plan.steps[plan.currentStepIndex],
          priority: goal.priority,
        });
      }
    }

    // 按目标优先级排序
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates;
  }

  /**
   * 添加自定义计划模板
   */
  addPlanTemplate(template: PlanTemplate): void {
    this.config.planTemplates.push(template);
  }

  /**
   * 获取统计
   */
  getStats(): BehaviorPlannerStats {
    const allGoals = this.goalPlanner.getAllGoals();
    let totalPlans = 0;
    let executingPlans = 0;
    let completedPlans = 0;
    let interruptedPlans = 0;
    let failedPlans = 0;

    for (const goal of allGoals) {
      for (const plan of goal.plans) {
        totalPlans++;
        switch (plan.status) {
          case 'executing': executingPlans++; break;
          case 'completed': completedPlans++; break;
          case 'interrupted': interruptedPlans++; break;
          case 'failed': failedPlans++; break;
        }
      }
    }

    return {
      totalPlans,
      executingPlans,
      completedPlans,
      interruptedPlans,
      failedPlans,
      pendingInterrupts: this.interruptQueue.length,
      activeTemplates: this.config.planTemplates.length,
    };
  }
}

export interface BehaviorPlannerStats {
  totalPlans: number;
  executingPlans: number;
  completedPlans: number;
  interruptedPlans: number;
  failedPlans: number;
  pendingInterrupts: number;
  activeTemplates: number;
}

export default BehaviorPlanner;
