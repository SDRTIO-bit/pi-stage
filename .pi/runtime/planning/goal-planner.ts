/**
 * goal-planner.ts - 目标规划器
 *
 * 核心职责：
 * 1. 接收来自 MotivationEngine 的候选目标，进行优先级排序与生命周期管理
 * 2. 维护 Goal 数据结构，驱动目标从 created → active → blocked → completed/abandoned
 * 3. 通过 EventBus 广播目标生命周期事件，供 Debug、Attention、Context 等子系统消费
 *
 * 目标生成触发源（由外部 MotivationEngine 等提供候选）：
 * - Need-based：生理/心理需求驱动
 * - Emotion-driven：主导情绪激发
 * - Relation-driven：关系值变化触发
 * - World-event：世界状态事件触发
 * - Memory-triggered：检索到高度情感记忆时产生
 * - Narrative arc：长剧情弧线驱动
 *
 * 与 Attention Runtime 整合：
 * - 活跃目标影响注意力权重，防止相关概念被衰减
 * - Attention 状态反馈：若目标相关元素衰减显著，触发提醒或优先级调整
 *
 * 与 Context Assembly 整合：
 * - Collect 阶段按 goalRelevance 维度检索记忆
 * - Reinforce 阶段将活跃目标摘要注入 system prompt
 * - Compress 阶段为 Goal 相关上下文保底 token
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 类型定义
// ============================================================

export type GoalType = 'long_term' | 'short_term' | 'hidden' | 'reactive';
export type GoalStatus = 'created' | 'active' | 'blocked' | 'completed' | 'abandoned' | 'transformed';

export interface EmotionalVector {
  anger: number;      // 愤怒 0-1
  fear: number;       // 恐惧 0-1
  joy: number;        // 喜悦 0-1
  sadness: number;    // 悲伤 0-1
  surprise: number;   // 惊讶 0-1
  trust: number;      // 信任 0-1
}

export type GoalTriggerType = 'need' | 'emotion' | 'relation' | 'world_event' | 'memory' | 'narrative' | 'internal';

export interface GoalTrigger {
  type: GoalTriggerType;
  sourceId: string;       // 触发源 ID（如需求类型、记忆 ID、事件 ID）
  description: string;    // 触发原因描述
  timestamp: number;
}

export interface WorldCondition {
  location?: string;
  timeRange?: [number, number];  // [start, end] 时间戳
  eventActive?: string;          // 需要某个事件在活跃中
  hasItem?: string;              // 需要持有某物品
  relationThreshold?: { characterId: string; minValue: number };
}

export interface Plan {
  id: string;
  goalId: string;
  steps: ActionStep[];
  currentStepIndex: number;
  status: 'pending' | 'executing' | 'interrupted' | 'completed' | 'failed';
  conditionalBranches: ConditionalBranch[];
  fallbackPlanId?: string;
  emotionalOverride?: EmotionalTrigger;
  createdAt: number;
  lastModified: number;
}

export interface ActionStep {
  id: string;
  description: string;
  type: 'action' | 'decision' | 'wait' | 'subgoal';
  subgoalId?: string;          // 如果是 subgoal 类型，关联的子目标 ID
  prerequisite?: string;       // 前置条件描述
  expectedDuration?: number;   // 预计耗时（毫秒）
  completedAt?: number;
  result?: string;             // 执行结果摘要
}

export interface ConditionalBranch {
  condition: string;           // 条件描述（自然语言）
  targetStepIndex: number;     // 满足条件后跳转的步骤索引
  description: string;
}

export interface EmotionalTrigger {
  emotion: string;             // 触发情绪名称
  threshold: number;           // 触发阈值 0-1
  action: 'interrupt' | 'override' | 'append';
  targetActionDescription: string;  // 要插入的行为描述
}

// ============================================================
// Goal 数据结构
// ============================================================

export interface Goal {
  id: string;
  type: GoalType;
  description: string;
  priority: number;                   // 动态优先级 0..1
  status: GoalStatus;
  parentGoalId?: string;
  conflictingGoals: string[];
  createdFrom: GoalTrigger;
  emotionalInfluence: EmotionalVector;
  relationTarget?: string;
  worldStateCondition?: WorldCondition;
  progress: number;                   // 0..1
  deadline?: number;                  // 时间戳，用于紧急度计算
  plans: Plan[];
  createdAt: number;
  lastModified: number;
  /** 关联的记忆 ID 列表（便于检索） */
  relatedMemoryIds: string[];
  /** 标签 */
  tags: string[];
}

// ============================================================
// GoalPlanner 配置
// ============================================================

export interface GoalPlannerConfig {
  /** 活跃目标数量上限 */
  maxActiveGoals: number;
  /** 优先级低于此值的目标自动被阻塞 */
  activePriorityThreshold: number;
  /** 优先级低于此值的目标自动放弃 */
  abandonPriorityThreshold: number;
  /** 目标进度检查间隔（tick 数） */
  progressCheckInterval: number;
  /** 是否启用目标冲突检测 */
  enableConflictDetection: boolean;
  /** 目标完成后的冷却 tick 数（同类目标） */
  goalCooldownTicks: number;
  /** 默认 deadline 时间（毫秒，从创建时算起），0 表示无期限 */
  defaultDeadlineMs: number;
}

const DEFAULT_GOAL_PLANNER_CONFIG: GoalPlannerConfig = {
  maxActiveGoals: 5,
  activePriorityThreshold: 0.3,
  abandonPriorityThreshold: 0.1,
  progressCheckInterval: 3,
  enableConflictDetection: true,
  goalCooldownTicks: 10,
  defaultDeadlineMs: 0,
};

// ============================================================
// GoalPlanner 实现
// ============================================================

export class GoalPlanner {
  private goals: Map<string, Goal> = new Map();
  private config: GoalPlannerConfig;
  private eventBus: EventBus | null;

  /** 同类目标冷却跟踪 */
  private typeCooldowns: Map<string, number> = new Map();

  /** 当前 tick 计数 */
  private tickCounter: number = 0;

  constructor(config?: Partial<GoalPlannerConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_GOAL_PLANNER_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 目标生命周期管理
  // ============================================================

  /**
   * 创建新目标
   * 由外部（MotivationEngine 等）调用
   */
  createGoal(params: {
    type: GoalType;
    description: string;
    priority: number;
    createdFrom: GoalTrigger;
    emotionalInfluence?: Partial<EmotionalVector>;
    parentGoalId?: string;
    conflictingGoals?: string[];
    relationTarget?: string;
    worldStateCondition?: WorldCondition;
    deadline?: number;
    tags?: string[];
  }): Goal {
    const id = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 检查同类型目标冷却
    if (this.typeCooldowns.has(params.type)) {
      const remaining = this.typeCooldowns.get(params.type)!;
      if (remaining > 0) {
        console.warn(`[GoalPlanner] 目标类型 ${params.type} 在冷却中，跳过创建`);
        // 仍然创建但标记为 blocked
      }
    }

    const defaultEmotion: EmotionalVector = {
      anger: 0, fear: 0, joy: 0, sadness: 0, surprise: 0, trust: 0,
    };

    const deadline = params.deadline
      ?? (this.config.defaultDeadlineMs > 0 ? Date.now() + this.config.defaultDeadlineMs : undefined);

    const goal: Goal = {
      id,
      type: params.type,
      description: params.description,
      priority: Math.max(0, Math.min(1, params.priority)),
      status: 'created',
      parentGoalId: params.parentGoalId,
      conflictingGoals: params.conflictingGoals ?? [],
      createdFrom: params.createdFrom,
      emotionalInfluence: { ...defaultEmotion, ...params.emotionalInfluence },
      relationTarget: params.relationTarget,
      worldStateCondition: params.worldStateCondition,
      progress: 0,
      deadline,
      plans: [],
      createdAt: Date.now(),
      lastModified: Date.now(),
      relatedMemoryIds: [],
      tags: params.tags ?? [],
    };

    this.goals.set(goal.id, goal);

    // 应用冷却
    this.typeCooldowns.set(params.type, this.config.goalCooldownTicks);

    // 触发事件
    this.eventBus?.emit('goal:created', {
      goalId: goal.id,
      type: goal.type,
      description: goal.description,
      priority: goal.priority,
      trigger: goal.createdFrom,
    });

    // 创建后立即尝试激活
    this.tryActivateGoal(goal.id);

    return goal;
  }

  /**
   * 主 tick：每个 autonomous tick 调用一次
   * 推进所有目标的生命周期
   */
  tick(): void {
    this.tickCounter++;

    // 1. 冷却递减
    for (const [type, remaining] of this.typeCooldowns) {
      if (remaining > 0) {
        this.typeCooldowns.set(type, remaining - 1);
      } else {
        this.typeCooldowns.delete(type);
      }
    }

    // 2. 收集所有待评估目标
    const allGoals = Array.from(this.goals.values());

    // 3. 更新优先级
    this.updatePriorities(allGoals);

    // 4. 检查激活/阻塞状态
    for (const goal of allGoals) {
      if (goal.status === 'created') {
        this.tryActivateGoal(goal.id);
      } else if (goal.status === 'active' || goal.status === 'blocked') {
        this.checkGoalProgress(goal);
        this.checkGoalDeadline(goal);
      }
    }

    // 5. 冲突检测（活跃目标之间）
    if (this.config.enableConflictDetection) {
      this.detectConflicts();
    }

    // 6. 定期检查是否要放弃低优先级目标
    if (this.tickCounter % this.config.progressCheckInterval === 0) {
      this.evictLowPriorityGoals();
    }
  }

  /**
   * 尝试激活目标
   */
  private tryActivateGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    // 活跃目标数量限制
    const activeCount = this.getActiveGoals().length;
    if (activeCount >= this.config.maxActiveGoals) {
      // 如果不能挤掉更低优先级的目标，保持 blocked
      const lowestActive = this.getLowestPriorityActiveGoal();
      if (lowestActive && goal.priority > lowestActive.priority) {
        this.deactivateGoal(lowestActive.id, 'blocked');
        this.activateGoal(goalId);
      } else {
        goal.status = 'blocked';
        goal.lastModified = Date.now();
      }
      return;
    }

    if (goal.priority < this.config.activePriorityThreshold) {
      goal.status = 'blocked';
      goal.lastModified = Date.now();
      return;
    }

    this.activateGoal(goalId);
  }

  /**
   * 激活目标
   */
  private activateGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    const prevStatus = goal.status;
    goal.status = 'active';
    goal.lastModified = Date.now();

    if (prevStatus !== 'active') {
      this.eventBus?.emit('goal:activated', {
        goalId: goal.id,
        description: goal.description,
        priority: goal.priority,
        previousStatus: prevStatus,
      });
    }
  }

  /**
   * 取消激活目标（设为 blocked）
   */
  private deactivateGoal(goalId: string, reason: 'blocked' | 'abandoned'): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    if (reason === 'abandoned') {
      this.abandonGoal(goalId, '优先级不足');
    } else {
      goal.status = 'blocked';
      goal.lastModified = Date.now();
    }
  }

  // ============================================================
  // 优先级管理
  // ============================================================

  /**
   * 更新所有目标的动态优先级
   * 受情绪、进度、deadline 等多因素调制
   */
  updatePriorities(goals: Goal[]): void {
    for (const goal of goals) {
      if (goal.status === 'completed' || goal.status === 'abandoned') continue;

      let basePriority = goal.priority;

      // 1. 进度因子：越接近完成优先级越高（但快完成时略微下降避免急转）
      const progressFactor = goal.progress < 0.9
        ? 1 + goal.progress * 0.3   // 进度 0→0.9 优先级逐渐上升
        : 1 - (goal.progress - 0.9) * 0.5; // 最后 10% 轻微下降

      // 2. 紧急度因子：deadline 越近越高
      let urgencyFactor = 1;
      if (goal.deadline) {
        const remaining = goal.deadline - Date.now();
        if (remaining <= 0) {
          urgencyFactor = 2.0; // 已过期，紧急度最高
        } else {
          const totalDuration = goal.deadline - goal.createdAt;
          if (totalDuration > 0) {
            urgencyFactor = 1 + (1 - remaining / totalDuration) * 1.0;
          }
        }
      }

      // 3. 情绪调制
      const emotionFactor = this.computeEmotionFactor(goal);

      // 4. 综合优先级
      const adjusted = basePriority * progressFactor * urgencyFactor * emotionFactor;
      goal.priority = Math.max(0, Math.min(1, adjusted));
    }
  }

  /**
   * 计算情绪对优先级的影响
   */
  private computeEmotionFactor(goal: Goal): number {
    const e = goal.emotionalInfluence;
    // 高情绪强度（无论正负）都会提升优先级
    const emotionalIntensity = (e.anger + e.fear + e.joy + e.sadness + e.surprise + e.trust) / 6;
    // 恐惧和悲伤抑制行动力（优先级降低），愤怒和喜悦提升
    const valenceFactor = 1 + (e.anger * 0.3 + e.joy * 0.2 - e.fear * 0.3 - e.sadness * 0.2);
    return 1 + emotionalIntensity * 0.5 * Math.max(0, valenceFactor);
  }

  // ============================================================
  // 进度管理
  // ============================================================

  /**
   * 更新目标进度
   */
  updateProgress(goalId: string, delta: number): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    goal.progress = Math.max(0, Math.min(1, goal.progress + delta));
    goal.lastModified = Date.now();

    if (goal.progress >= 1) {
      this.completeGoal(goalId);
    }
  }

  /**
   * 设置目标进度（精确值）
   */
  setProgress(goalId: string, progress: number): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    goal.progress = Math.max(0, Math.min(1, progress));
    goal.lastModified = Date.now();

    if (goal.progress >= 1) {
      this.completeGoal(goalId);
    }
  }

  /**
   * 检查目标进度条件（自动推进）
   */
  private checkGoalProgress(goal: Goal): void {
    // 子进度由 BehaviorPlanner 推进，这里只做状态检查
    // 如果有关联的 plan，根据 plan 状态更新进度
    for (const plan of goal.plans) {
      if (plan.status === 'completed' && goal.progress < 1) {
        // 单个 plan 完成不一定代表目标完成，但推进进度
        const stepProgress = plan.steps.length > 0
          ? (plan.currentStepIndex) / plan.steps.length
          : 0;
        this.updateProgress(goal.id, stepProgress * 0.1);
      }
    }
  }

  /**
   * 检查 deadline
   */
  private checkGoalDeadline(goal: Goal): void {
    if (!goal.deadline) return;

    if (Date.now() > goal.deadline) {
      // 超过 deadline 但还没完成
      if (goal.progress < 0.5) {
        // 进度太少，放弃
        this.abandonGoal(goal.id, 'deadline 到达但进度不足');
      } else if (goal.progress >= 1) {
        this.completeGoal(goal.id);
      }
      // 进度 50-99%：保留但大幅降优先级
      goal.priority *= 0.5;
    }
  }

  // ============================================================
  // 状态转移
  // ============================================================

  /**
   * 完成目标
   */
  completeGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal) return;

    const prevStatus = goal.status;
    goal.status = 'completed';
    goal.progress = 1;
    goal.lastModified = Date.now();

    // 完成所有关联 plan
    for (const plan of goal.plans) {
      if (plan.status !== 'completed') {
        plan.status = 'completed';
      }
    }

    this.eventBus?.emit('goal:completed', {
      goalId: goal.id,
      description: goal.description,
      previousStatus: prevStatus,
      duration: Date.now() - goal.createdAt,
    });

    // 检查是否有父目标需要推进
    if (goal.parentGoalId) {
      const parent = this.goals.get(goal.parentGoalId);
      if (parent) {
        this.updateProgress(parent.id, 0.2); // 子目标完成推进父目标
      }
    }
  }

  /**
   * 放弃目标
   */
  abandonGoal(goalId: string, reason: string): void {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status === 'abandoned') return;

    const prevStatus = goal.status;
    goal.status = 'abandoned';
    goal.lastModified = Date.now();

    this.eventBus?.emit('goal:abandoned', {
      goalId: goal.id,
      description: goal.description,
      previousStatus: prevStatus,
      reason,
    });

    // 终止所有关联 plan
    for (const plan of goal.plans) {
      if (plan.status === 'executing' || plan.status === 'pending') {
        plan.status = 'failed';
      }
    }
  }

  /**
   * 目标演化（完成度达到一定程度但结果偏离，演化成新目标）
   */
  transformGoal(goalId: string, newDescription: string, newPriority?: number): Goal | null {
    const goal = this.goals.get(goalId);
    if (!goal) return null;

    const prevStatus = goal.status;
    goal.status = 'transformed';
    goal.lastModified = Date.now();

    this.eventBus?.emit('goal:transformed', {
      goalId: goal.id,
      oldDescription: goal.description,
      newDescription,
      previousStatus: prevStatus,
    });

    // 创建新目标
    return this.createGoal({
      type: goal.type,
      description: newDescription,
      priority: newPriority ?? goal.priority,
      createdFrom: {
        type: 'internal',
        sourceId: goal.id,
        description: `从目标 ${goal.id} 演化而来: ${goal.description}`,
        timestamp: Date.now(),
      },
      emotionalInfluence: { ...goal.emotionalInfluence },
      parentGoalId: goal.parentGoalId,
      tags: [...goal.tags, 'transformed'],
    });
  }

  // ============================================================
  // 冲突检测
  // ============================================================

  /**
   * 检测活跃目标之间的互斥关系
   */
  private detectConflicts(): void {
    const activeGoals = this.getActiveGoals();

    for (let i = 0; i < activeGoals.length; i++) {
      for (let j = i + 1; j < activeGoals.length; j++) {
        const a = activeGoals[i];
        const b = activeGoals[j];

        // 检查双方是否互斥
        if (a.conflictingGoals.includes(b.id) || b.conflictingGoals.includes(a.id)) {
          // 优先级低的被阻塞
          if (a.priority >= b.priority) {
            this.deactivateGoal(b.id, 'blocked');
            this.eventBus?.emit('goal:conflict', {
              winnerId: a.id,
              loserId: b.id,
              reason: `目标 "${a.description}" 与 "${b.description}" 互斥`,
            });
          } else {
            this.deactivateGoal(a.id, 'blocked');
            this.eventBus?.emit('goal:conflict', {
              winnerId: b.id,
              loserId: a.id,
              reason: `目标 "${b.description}" 与 "${a.description}" 互斥`,
            });
          }
        }
      }
    }
  }

  // ============================================================
  // 低优先级目标清理
  // ============================================================

  /**
   * 移除优先级过低的目标
   */
  private evictLowPriorityGoals(): void {
    for (const goal of this.goals.values()) {
      if (goal.status === 'active' || goal.status === 'blocked') {
        if (goal.priority < this.config.abandonPriorityThreshold) {
          // 持续低优先级一段时间才放弃
          const inactiveDuration = Date.now() - goal.lastModified;
          if (inactiveDuration > 60000) { // 超过 1 分钟
            this.abandonGoal(goal.id, '优先级持续过低');
          }
        }
      }
    }
  }

  // ============================================================
  // Plan 管理
  // ============================================================

  /**
   * 为目标添加 plan
   */
  addPlan(goalId: string, plan: Omit<Plan, 'id' | 'goalId' | 'createdAt' | 'lastModified'>): Plan {
    const fullPlan: Plan = {
      ...plan,
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      goalId,
      createdAt: Date.now(),
      lastModified: Date.now(),
    };

    const goal = this.goals.get(goalId);
    if (goal) {
      goal.plans.push(fullPlan);
      goal.lastModified = Date.now();
    }

    this.eventBus?.emit('plan:created', {
      planId: fullPlan.id,
      goalId,
      stepCount: fullPlan.steps.length,
    });

    return fullPlan;
  }

  /**
   * 获取目标当前正在执行的 plan
   */
  getActivePlan(goalId: string): Plan | undefined {
    const goal = this.goals.get(goalId);
    if (!goal) return undefined;
    return goal.plans.find(p => p.status === 'executing');
  }

  /**
   * 获取目标的下一个待执行 plan
   */
  getNextPlan(goalId: string): Plan | undefined {
    const goal = this.goals.get(goalId);
    if (!goal) return undefined;
    return goal.plans.find(p => p.status === 'pending');
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取所有活跃目标（按优先级排序）
   */
  getActiveGoals(): Goal[] {
    return Array.from(this.goals.values())
      .filter(g => g.status === 'active')
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取所有目标
   */
  getAllGoals(): Goal[] {
    return Array.from(this.goals.values())
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 按状态获取目标
   */
  getGoalsByStatus(status: GoalStatus): Goal[] {
    return Array.from(this.goals.values())
      .filter(g => g.status === status)
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * 获取指定目标
   */
  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  /**
   * 获取优先级最低的活跃目标
   */
  getLowestPriorityActiveGoal(): Goal | undefined {
    const active = this.getActiveGoals();
    if (active.length === 0) return undefined;
    return active.reduce((lowest, g) => g.priority < lowest.priority ? g : lowest);
  }

  /**
   * 获取与特定关系人物相关的目标
   */
  getGoalsByRelationTarget(characterId: string): Goal[] {
    return Array.from(this.goals.values())
      .filter(g => g.relationTarget === characterId && g.status !== 'completed' && g.status !== 'abandoned');
  }

  /**
   * 获取某种类型的目标
   */
  getGoalsByType(type: GoalType): Goal[] {
    return Array.from(this.goals.values())
      .filter(g => g.type === type && g.status !== 'completed' && g.status !== 'abandoned');
  }

  /**
   * 获取目标的完整描述（用于注入到 prompt）
   */
  getGoalSummary(goalId: string): string {
    const goal = this.goals.get(goalId);
    if (!goal) return '';

    const statusEmoji: Record<GoalStatus, string> = {
      created: '🆕', active: '🎯', blocked: '🔒',
      completed: '✅', abandoned: '❌', transformed: '🔄',
    };

    const deadlineStr = goal.deadline
      ? ` | 截止: ${new Date(goal.deadline).toLocaleString()}`
      : '';

    return `${statusEmoji[goal.status]} [${goal.type}] ${goal.description} (优先级: ${(goal.priority * 100).toFixed(0)}% | 进度: ${(goal.progress * 100).toFixed(0)}%)${deadlineStr}`;
  }

  /**
   * 获取所有活跃目标的摘要（用于 Context Assembly 注入）
   */
  getActiveGoalsSummary(): string {
    const active = this.getActiveGoals();
    if (active.length === 0) return '当前没有活跃目标。';

    return active.map((g, i) =>
      `${i + 1}. ${g.description} [${(g.priority * 100).toFixed(0)}%]`
    ).join('\n');
  }

  /**
   * 检查特定条件是否与某个活跃目标相关
   */
  isRelatedToActiveGoal(entityName: string): boolean {
    const active = this.getActiveGoals();
    const lower = entityName.toLowerCase();
    return active.some(g =>
      g.description.toLowerCase().includes(lower) ||
      g.relationTarget?.toLowerCase() === lower ||
      g.tags.some(t => t.toLowerCase() === lower)
    );
  }

  // ============================================================
  // 调试/统计
  // ============================================================

  /**
   * 获取统计信息
   */
  getStats(): GoalPlannerStats {
    const all = Array.from(this.goals.values());
    return {
      total: all.length,
      byStatus: {
        created: all.filter(g => g.status === 'created').length,
        active: all.filter(g => g.status === 'active').length,
        blocked: all.filter(g => g.status === 'blocked').length,
        completed: all.filter(g => g.status === 'completed').length,
        abandoned: all.filter(g => g.status === 'abandoned').length,
        transformed: all.filter(g => g.status === 'transformed').length,
      },
      byType: {
        long_term: all.filter(g => g.type === 'long_term').length,
        short_term: all.filter(g => g.type === 'short_term').length,
        hidden: all.filter(g => g.type === 'hidden').length,
        reactive: all.filter(g => g.type === 'reactive').length,
      },
      averagePriority: all.length > 0
        ? all.reduce((s, g) => s + g.priority, 0) / all.length
        : 0,
      averageProgress: all.length > 0
        ? all.reduce((s, g) => s + g.progress, 0) / all.length
        : 0,
    };
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.goals.clear();
    this.typeCooldowns.clear();
    this.tickCounter = 0;
  }
}

export interface GoalPlannerStats {
  total: number;
  byStatus: Record<GoalStatus, number>;
  byType: Record<GoalType, number>;
  averagePriority: number;
  averageProgress: number;
}

export default GoalPlanner;
