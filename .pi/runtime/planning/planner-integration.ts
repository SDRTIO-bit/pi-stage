/**
 * planner-integration.ts - 规划系统与现有 Runtime 的整合层
 *
 * 提供与以下子系统的深度整合：
 * - Attention Runtime：目标影响注意力权重，Attention 状态反馈目标优先级
 * - Context Assembly：Collect/Reinforce/Compress 阶段的 Goal 感知
 * - Memory Runtime：情节记忆关联目标，consolidation 强化相关记忆
 * - Autonomous Runtime：目标驱动行为，替代随机动作
 * - Event Bus：目标生命周期事件的广播
 *
 * 核心接口：
 * - GoalRuntime：统一入口，整合所有子模块
 * - 适配器函数：将 Goal Planning 的数据结构转换为各子系统需要的格式
 */

import { GoalPlanner, type Goal, type GoalType, type GoalStatus } from './goal-planner';
import { MotivationEngine, type GoalCandidate, type MotivationProfile } from './motivation-engine';
import { BehaviorPlanner, type PlanTemplate } from './behavior-planner';
import { DecisionEngine, type DecisionContext, type CandidateAction, type SelectedAction } from './decision-engine';
import { IntentionRuntime } from './intention-runtime';
import type { EventBus } from '../events/event-bus';

// ============================================================
// GoalRuntime 配置
// ============================================================

export interface GoalRuntimeConfig {
  /** GoalPlanner 配置 */
  goalPlanner?: Partial<import('./goal-planner').GoalPlannerConfig>;
  /** MotivationEngine 配置 */
  motivation?: Partial<import('./motivation-engine').MotivationEngineConfig>;
  /** BehaviorPlanner 配置 */
  behavior?: Partial<import('./behavior-planner').BehaviorPlannerConfig>;
  /** DecisionEngine 配置 */
  decision?: Partial<import('./decision-engine').DecisionEngineConfig>;
  /** IntentionRuntime 配置 */
  intention?: Partial<import('./intention-runtime').IntentionRuntimeConfig>;
  /** 是否启用完整规划链 */
  enableFullChain?: boolean;
  /** 是否启用决策引擎（false 时直接取最高优先级目标的下一步） */
  enableDecisionEngine?: boolean;
}

// ============================================================
// GoalRuntime 状态快照
// ============================================================

export interface GoalRuntimeSnapshot {
  activeGoalCount: number;
  totalGoalCount: number;
  activeGoals: Array<{
    id: string;
    description: string;
    type: GoalType;
    priority: number;
    progress: number;
    status: GoalStatus;
  }>;
  topMotivations: Array<{ type: string; strength: number }>;
  activePlanCount: number;
  pendingIntentions: number;
  lastDecision: SelectedAction | null;
}

// ============================================================
// GoalRuntime - 统一入口
// ============================================================

export class GoalRuntime {
  readonly goalPlanner: GoalPlanner;
  readonly motivationEngine: MotivationEngine;
  readonly behaviorPlanner: BehaviorPlanner;
  readonly decisionEngine: DecisionEngine;
  readonly intentionRuntime: IntentionRuntime;

  private config: GoalRuntimeConfig;
  private eventBus: EventBus | null;

  /** 是否已初始化 */
  private initialized: boolean = false;

  /** 上次决策结果（用于外部查询） */
  private lastDecision: SelectedAction | null = null;

  constructor(config?: GoalRuntimeConfig, eventBus?: EventBus) {
    this.config = {
      enableFullChain: true,
      enableDecisionEngine: true,
      ...config,
    };
    this.eventBus = eventBus ?? null;

    // 创建子模块（先不传 eventBus，初始化时再绑定）
    this.goalPlanner = new GoalPlanner(
      this.config.goalPlanner,
      this.eventBus ?? undefined
    );
    this.motivationEngine = new MotivationEngine(this.config.motivation);
    this.behaviorPlanner = new BehaviorPlanner(
      this.goalPlanner,
      this.config.behavior,
      this.eventBus ?? undefined
    );
    this.decisionEngine = new DecisionEngine(
      this.config.decision,
      this.eventBus ?? undefined
    );
    this.intentionRuntime = new IntentionRuntime(
      this.config.intention,
      this.eventBus ?? undefined
    );
  }

  // ============================================================
  // 初始化
  // ============================================================

  /**
   * 初始化：绑定事件监听
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.eventBus) {
      // 监听目标生命周期事件
      this.setupEventListeners();
    }
  }

  /**
   * 设置事件监听
   */
  private setupEventListeners(): void {
    if (!this.eventBus) return;

    // 目标创建 → 自动生成计划
    this.eventBus.on('goal:activated', (data: any) => {
      const goal = this.goalPlanner.getGoal(data.goalId);
      if (goal && goal.plans.length === 0) {
        this.behaviorPlanner.generatePlan(goal);
      }
    });

    // 世界事件 → 动机系统更新
    this.eventBus.on('world:event_triggered', (data: any) => {
      // 世界事件触发动机更新（在 autonomous tick 中处理）
    });

    // 关系变化 → 动机更新
    this.eventBus.on('agent:relation_changed', (data: any) => {
      if (data.delta && Math.abs(data.delta) > 0.15) {
        const candidates = this.motivationEngine.onRelationChange(
          data.characterId, data.delta
        );
        for (const candidate of candidates) {
          this.createGoalFromCandidate(candidate);
        }
      }
    });

    // Goal tick → 同步推进所有子模块
    this.eventBus.on('goal:tick', () => {
      this.tick();
    });
  }

  // ============================================================
  // 主 tick
  // ============================================================

  /**
   * 主 tick：完整的行为链闭环
   *
   * 1. MotivationEngine → 生成动机向量和候选目标
   * 2. GoalPlanner → 更新优先级，激活/阻塞目标
   * 3. BehaviorPlanner → 推进计划执行
   * 4. DecisionEngine → 选择具体动作（如果启用）
   * 5. IntentionRuntime → 意图衰减和清理
   */
  tick(): void {
    // 1. 动机系统推进
    this.motivationEngine.tick();

    // 2. 从动机生成候选目标
    const candidates = this.motivationEngine.generateGoalCandidates();
    for (const candidate of candidates) {
      this.createGoalFromCandidate(candidate);
    }

    // 3. 目标规划器 tick
    this.goalPlanner.tick();

    // 4. 行为规划器 tick
    this.behaviorPlanner.tick();

    // 5. 意图运行时 tick
    this.intentionRuntime.tick();

    // 6. 决策（如果启用）
    if (this.config.enableDecisionEngine && this.config.enableFullChain) {
      this.makeDecision();
    }
  }

  // ============================================================
  // 候选目标 → 正式目标
  // ============================================================

  /**
   * 从候选目标创建正式目标
   */
  createGoalFromCandidate(candidate: GoalCandidate): string | null {
    // 检查是否已存在类似目标（避免重复）
    const existing = this.goalPlanner.getAllGoals().find(g =>
      g.status !== 'completed' &&
      g.status !== 'abandoned' &&
      g.description === candidate.description
    );
    if (existing) return null;

    const goal = this.goalPlanner.createGoal({
      type: candidate.type,
      description: candidate.description,
      priority: candidate.priority,
      createdFrom: candidate.trigger,
      emotionalInfluence: candidate.emotionalInfluence,
      relationTarget: candidate.relationTarget,
      tags: candidate.tags,
    });

    return goal.id;
  }

  // ============================================================
  // 决策
  // ============================================================

  /**
   * 执行一次决策：收集候选动作 → 选择最优 → 创建意图
   */
  makeDecision(context?: Partial<DecisionContext>): SelectedAction | null {
    // 1. 获取所有候选动作
    const actions = this.behaviorPlanner.getAllCandidateActions();
    if (actions.length === 0) return null;

    // 2. 转换为决策引擎需要的格式
    const candidates: CandidateAction[] = actions.map(a => {
      const goal = this.goalPlanner.getGoal(a.goalId);
      return {
        goalId: a.goalId,
        goalDescription: goal?.description ?? '',
        goalPriority: a.priority,
        goalProgress: goal?.progress ?? 0,
        step: a.step,
        emotionalInfluence: goal?.emotionalInfluence ?? {
          anger: 0, fear: 0, joy: 0, sadness: 0, surprise: 0, trust: 0,
        },
        relationTarget: goal?.relationTarget,
      };
    });

    // 3. 构建决策上下文
    const decisionContext: DecisionContext = {
      dominantEmotion: context?.dominantEmotion ?? 'neutral',
      emotions: context?.emotions ?? {},
      attentionFocus: context?.attentionFocus ?? [],
      worldSummary: context?.worldSummary,
      currentTime: context?.currentTime ?? Date.now(),
      currentLocation: context?.currentLocation,
    };

    // 4. 执行决策
    const decision = this.decisionEngine.selectAction(candidates, decisionContext);
    if (!decision) return null;

    this.lastDecision = decision;

    // 5. 从决策创建意图
    this.intentionRuntime.createIntention({
      type: decision.step.type === 'decision' ? 'short_term' : 'proactive',
      description: decision.step.description,
      strength: decision.utility.totalUtility,
      urgency: decision.utility.totalUtility,
      source: 'decision',
      relatedGoalId: decision.goalId,
      relatedStepId: decision.step.id,
    });

    return decision;
  }

  // ============================================================
  // 外部整合接口
  // ============================================================

  /**
   * 获取活跃目标摘要（供 Context Assembly 使用）
   */
  getContextSummary(): string {
    const parts: string[] = [];

    // 活跃目标
    const activeGoals = this.goalPlanner.getActiveGoals();
    if (activeGoals.length > 0) {
      parts.push('## 当前目标');
      parts.push(...activeGoals.map((g, i) =>
        `${i + 1}. ${g.description} (优先级: ${(g.priority * 100).toFixed(0)}% | 进度: ${(g.progress * 100).toFixed(0)}%)`
      ));
    }

    // 最高优先级的意图
    const topIntention = this.intentionRuntime.getTopIntention();
    if (topIntention) {
      parts.push(`## 当前意图\n- ${topIntention.description}`);
    }

    return parts.join('\n\n');
  }

  /**
   * 获取活跃目标关联的标签/实体（供 Attention Runtime 使用）
   */
  getAttentionTargets(): string[] {
    const targets: string[] = [];
    const activeGoals = this.goalPlanner.getActiveGoals();

    for (const goal of activeGoals) {
      // 目标描述中的关键词
      const words = goal.description.split(/[\s,，。、]+/).filter(w => w.length > 1);
      targets.push(...words);

      // 关系目标
      if (goal.relationTarget) {
        targets.push(goal.relationTarget);
      }

      // 标签
      targets.push(...goal.tags);
    }

    // 意图
    const intentions = this.intentionRuntime.getActiveIntentions();
    for (const intent of intentions) {
      const words = intent.description.split(/[\s,，。、]+/).filter(w => w.length > 1);
      targets.push(...words);
    }

    return [...new Set(targets)];
  }

  /**
   * 评估特定实体与当前目标的相关性
   */
  evaluateGoalRelevance(entityName: string): number {
    const activeGoals = this.goalPlanner.getActiveGoals();
    if (activeGoals.length === 0) return 0;

    const lower = entityName.toLowerCase();
    let maxRelevance = 0;

    for (const goal of activeGoals) {
      let relevance = 0;
      if (goal.description.toLowerCase().includes(lower)) relevance += 0.8;
      if (goal.relationTarget?.toLowerCase() === lower) relevance += 1.0;
      if (goal.tags.some(t => t.toLowerCase() === lower)) relevance += 0.5;
      relevance *= goal.priority;
      maxRelevance = Math.max(maxRelevance, relevance);
    }

    return maxRelevance;
  }

  // ============================================================
  // 状态查询
  // ============================================================

  /**
   * 获取完整状态快照
   */
  getSnapshot(): GoalRuntimeSnapshot {
    const activeGoals = this.goalPlanner.getActiveGoals();
    const allGoals = this.goalPlanner.getAllGoals();
    const bpStats = this.behaviorPlanner.getStats();
    const intentStats = this.intentionRuntime.getStats();

    // 获取 top 动机
    const allDesires = this.motivationEngine['profile']?.desires ?? [];
    const allFears = this.motivationEngine['profile']?.fears ?? [];
    const topMotivations: Array<{ type: string; strength: number }> = [];

    // 从内部 profile 获取（通过类型断言访问）
    const profile = (this.motivationEngine as any).profile;
    if (profile?.needs) {
      for (const need of profile.needs) {
        if (need.current > 0.5) {
          topMotivations.push({ type: `need:${need.type}`, strength: need.current });
        }
      }
    }
    for (const d of allDesires) {
      if (!d.satisfied && d.strength > 0.5) {
        topMotivations.push({ type: `desire:${d.name}`, strength: d.strength });
      }
    }
    for (const f of allFears) {
      if (f.active && f.strength > 0.5) {
        topMotivations.push({ type: `fear:${f.name}`, strength: f.strength });
      }
    }
    topMotivations.sort((a, b) => b.strength - a.strength);

    return {
      activeGoalCount: activeGoals.length,
      totalGoalCount: allGoals.length,
      activeGoals: activeGoals.map(g => ({
        id: g.id,
        description: g.description,
        type: g.type,
        priority: g.priority,
        progress: g.progress,
        status: g.status,
      })),
      topMotivations: topMotivations.slice(0, 5),
      activePlanCount: bpStats.executingPlans,
      pendingIntentions: intentStats.byStatus.active + intentStats.byStatus.executing,
      lastDecision: this.lastDecision,
    };
  }

  /**
   * 打印状态摘要
   */
  printStatus(): string {
    const snap = this.getSnapshot();
    const lines = [
      '=== Goal Planning Runtime 状态 ===',
      `目标: ${snap.activeGoalCount} 活跃 / ${snap.totalGoalCount} 总`,
      ``,
      `活跃目标:`,
    ];

    if (snap.activeGoals.length === 0) {
      lines.push('  (无活跃目标)');
    } else {
      for (const g of snap.activeGoals) {
        lines.push(`  🎯 [${g.type}] ${g.description}`);
        lines.push(`     优先级: ${(g.priority * 100).toFixed(0)}% | 进度: ${(g.progress * 100).toFixed(0)}%`);
      }
    }

    if (snap.topMotivations.length > 0) {
      lines.push(``, `主要动机:`);
      for (const m of snap.topMotivations) {
        lines.push(`  🔥 ${m.type}: ${(m.strength * 100).toFixed(0)}%`);
      }
    }

    lines.push(``, `计划: ${snap.activePlanCount} 执行中`);
    lines.push(`意图: ${snap.pendingIntentions} 待处理`);

    if (snap.lastDecision) {
      lines.push(``, `上次决策: ${snap.lastDecision.step.description}`);
      lines.push(`  效用: ${(snap.lastDecision.utility.totalUtility * 100).toFixed(0)}%`);
    }

    return lines.join('\n');
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.goalPlanner.reset();
    this.behaviorPlanner['replanCooldowns']?.clear();
    this.decisionEngine.reset();
    this.intentionRuntime.reset();
    this.lastDecision = null;
  }
}

export default GoalRuntime;
