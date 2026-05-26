/**
 * decision-engine.ts - 决策引擎
 *
 * 当 Agent 有多个可能的 Goal/Action 时，计算效用并选择最优行动。
 *
 * 效用函数：
 *   Utility = w1*goalPriority + w2*emotionalUrge + w3*expectedOutcomeUtility
 *           + w4*riskPenalty + w5*relationImpact + w6*narrativeSignificance
 *           + w7*attentionCongruence
 *
 * 核心原则：
 * - 不是简单取最高值，而是考虑多维度平衡
 * - 支持探索 vs 利用的权衡（epsilon-greedy）
 * - 每次决策都记录完整效用分解（供 Debug 使用）
 */

import type { Goal, ActionStep, EmotionalVector } from './goal-planner';
import type { EventBus } from '../events/event-bus';

// ============================================================
// 类型定义
// ============================================================

export interface DecisionContext {
  /** 当前主导情绪 */
  dominantEmotion: string;
  /** 全部情绪状态 */
  emotions: Record<string, number>;
  /** 当前注意力焦点（概念/实体名） */
  attentionFocus: string[];
  /** 当前世界状态摘要 */
  worldSummary?: string;
  /** 时间信息 */
  currentTime?: number;
  /** 位置 */
  currentLocation?: string;
}

export interface CandidateAction {
  goalId: string;
  goalDescription: string;
  goalPriority: number;
  goalProgress: number;
  step: ActionStep;
  /** 目标关联的情绪向量 */
  emotionalInfluence: EmotionalVector;
  /** 目标关联的关系目标 */
  relationTarget?: string;
}

export interface UtilityBreakdown {
  goalPriorityScore: number;
  emotionalUrgeScore: number;
  expectedOutcomeScore: number;
  riskPenaltyScore: number;
  relationImpactScore: number;
  narrativeSignificanceScore: number;
  attentionCongruenceScore: number;
  totalUtility: number;
}

export interface SelectedAction {
  goalId: string;
  step: ActionStep;
  utility: UtilityBreakdown;
  runnerUp?: {
    goalId: string;
    step: ActionStep;
    utility: number;
  };
  timestamp: number;
}

export interface DecisionEngineConfig {
  /** 效用权重 */
  weights: {
    goalPriority: number;
    emotionalUrge: number;
    expectedOutcome: number;
    riskPenalty: number;
    relationImpact: number;
    narrativeSignificance: number;
    attentionCongruence: number;
  };
  /** 探索率 (epsilon for epsilon-greedy) */
  explorationRate: number;
  /** 风险规避系数 */
  riskAversion: number;
  /** 是否启用情绪对决策的调制 */
  enableEmotionalModulation: boolean;
  /** 是否启用关系影响 */
  enableRelationImpact: boolean;
}

const DEFAULT_DECISION_CONFIG: DecisionEngineConfig = {
  weights: {
    goalPriority: 0.25,
    emotionalUrge: 0.15,
    expectedOutcome: 0.20,
    riskPenalty: 0.12,
    relationImpact: 0.10,
    narrativeSignificance: 0.08,
    attentionCongruence: 0.10,
  },
  explorationRate: 0.1,
  riskAversion: 0.5,
  enableEmotionalModulation: true,
  enableRelationImpact: true,
};

// ============================================================
// DecisionEngine 实现
// ============================================================

export class DecisionEngine {
  private config: DecisionEngineConfig;
  private eventBus: EventBus | null;

  /** 决策历史（用于调试） */
  private decisionHistory: SelectedAction[] = [];
  private readonly MAX_HISTORY = 100;

  constructor(config?: Partial<DecisionEngineConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_DECISION_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 核心决策接口
  // ============================================================

  /**
   * 从候选动作中选择最优
   */
  selectAction(candidates: CandidateAction[], context: DecisionContext): SelectedAction | null {
    if (candidates.length === 0) return null;

    // 1. 计算每个候选的效用
    const scored = candidates.map(c => ({
      candidate: c,
      utility: this.computeUtility(c, context),
    }));

    // 2. 按效用排序
    scored.sort((a, b) => b.utility.totalUtility - a.utility.totalUtility);

    // 3. epsilon-greedy 探索
    let selectedIndex = 0;
    if (Math.random() < this.config.explorationRate && scored.length > 1) {
      // 探索：按概率选择非最优
      const exploreWeights = scored.map((_, i) => i === 0 ? 0.1 : 0.9 / (scored.length - 1));
      const r = Math.random();
      let cumulative = 0;
      for (let i = 0; i < exploreWeights.length; i++) {
        cumulative += exploreWeights[i];
        if (r <= cumulative) {
          selectedIndex = i;
          break;
        }
      }
    }

    const selected = scored[selectedIndex];
    const runnerUp = scored.length > 1 ? scored[1] : undefined;

    const result: SelectedAction = {
      goalId: selected.candidate.goalId,
      step: selected.candidate.step,
      utility: selected.utility,
      runnerUp: runnerUp ? {
        goalId: runnerUp.candidate.goalId,
        step: runnerUp.candidate.step,
        utility: runnerUp.utility.totalUtility,
      } : undefined,
      timestamp: Date.now(),
    };

    // 记录决策
    this.decisionHistory.push(result);
    if (this.decisionHistory.length > this.MAX_HISTORY) {
      this.decisionHistory.shift();
    }

    // 事件广播
    this.eventBus?.emit('decision:made', {
      selectedGoalId: result.goalId,
      selectedStep: result.step.description,
      utility: result.utility,
      totalCandidates: candidates.length,
      explorationUsed: selectedIndex !== 0,
    });

    return result;
  }

  // ============================================================
  // 效用计算
  // ============================================================

  /**
   * 计算候选动作的综合效用
   */
  private computeUtility(candidate: CandidateAction, context: DecisionContext): UtilityBreakdown {
    const weights = this.config.weights;

    // 1. 目标优先级分
    const goalPriorityScore = candidate.goalPriority;

    // 2. 情绪驱动力分
    const emotionalUrgeScore = this.computeEmotionalUrge(candidate, context);

    // 3. 预期结果效用
    const expectedOutcomeScore = this.computeExpectedOutcome(candidate, context);

    // 4. 风险惩罚
    const riskPenaltyScore = this.computeRiskPenalty(candidate, context);

    // 5. 关系影响
    const relationImpactScore = this.computeRelationImpact(candidate, context);

    // 6. 叙事意义
    const narrativeSignificanceScore = this.computeNarrativeSignificance(candidate);

    // 7. 注意力一致性
    const attentionCongruenceScore = this.computeAttentionCongruence(candidate, context);

    // 综合效用
    const totalUtility =
      weights.goalPriority * goalPriorityScore +
      weights.emotionalUrge * emotionalUrgeScore +
      weights.expectedOutcome * expectedOutcomeScore -
      weights.riskPenalty * riskPenaltyScore +
      weights.relationImpact * relationImpactScore +
      weights.narrativeSignificance * narrativeSignificanceScore +
      weights.attentionCongruence * attentionCongruenceScore;

    return {
      goalPriorityScore,
      emotionalUrgeScore,
      expectedOutcomeScore,
      riskPenaltyScore,
      relationImpactScore,
      narrativeSignificanceScore,
      attentionCongruenceScore,
      totalUtility: Math.max(0, Math.min(1, totalUtility)),
    };
  }

  /**
   * 计算情绪驱动力
   * 情绪与目标的情感倾向越匹配，驱动力越强
   */
  private computeEmotionalUrge(candidate: CandidateAction, context: DecisionContext): number {
    if (!this.config.enableEmotionalModulation) return 0.5;

    const e = candidate.emotionalInfluence;

    // 检查当前主导情绪是否与此目标的情感倾向一致
    const dominant = context.dominantEmotion;
    let congruence = 0;

    switch (dominant) {
      case 'angry':
        congruence = e.anger;
        break;
      case 'fearful':
        congruence = e.fear;
        break;
      case 'happy':
        congruence = e.joy;
        break;
      case 'sad':
        congruence = e.sadness;
        break;
      case 'surprised':
        congruence = e.surprise;
        break;
      case 'trusting':
        congruence = e.trust;
        break;
      default:
        congruence = 0.3;
    }

    // 高情绪强度整体提升行动力
    const totalIntensity = (e.anger + e.fear + e.joy + e.sadness + e.surprise + e.trust) / 6;

    return Math.min(1, congruence * 0.6 + totalIntensity * 0.4);
  }

  /**
   * 计算预期结果效用
   * 基于步骤类型和描述的通用评估
   */
  private computeExpectedOutcome(candidate: CandidateAction, context: DecisionContext): number {
    const step = candidate.step;

    // 不同步骤类型的基准效用
    const typeBase: Record<string, number> = {
      action: 0.5,
      decision: 0.6,
      wait: 0.2,
      subgoal: 0.7,
    };

    const base = typeBase[step.type] ?? 0.4;

    // 有具体预期持续时间的步骤，效用微调
    const durationBonus = step.expectedDuration
      ? Math.min(0.1, step.expectedDuration / 60000 * 0.1)
      : 0;

    // 目标进度接近完成时，后续步骤效用更高
    const progressBonus = candidate.goalProgress > 0.8 ? 0.15
      : candidate.goalProgress > 0.5 ? 0.05
      : 0;

    return Math.min(1, base + durationBonus + progressBonus);
  }

  /**
   * 计算风险惩罚
   */
  private computeRiskPenalty(candidate: CandidateAction, context: DecisionContext): number {
    const step = candidate.step;

    // 步骤类型风险
    let risk = 0;
    switch (step.type) {
      case 'decision':
        risk = 0.3; // 决策步骤有一定风险
        break;
      case 'action':
        risk = 0.2;
        break;
      case 'subgoal':
        risk = 0.4; // 子目标风险更高
        break;
      case 'wait':
        risk = 0.1;
        break;
    }

    // 情绪状态调制的风险感知
    if (this.config.enableEmotionalModulation) {
      const fearLevel = context.emotions['fearful'] ?? 0;
      // 恐惧时风险感知上升
      risk *= (1 + fearLevel * 0.5);
    }

    // 风险规避系数
    return risk * this.config.riskAversion;
  }

  /**
   * 计算关系影响
   */
  private computeRelationImpact(candidate: CandidateAction, context: DecisionContext): number {
    if (!this.config.enableRelationImpact) return 0.5;

    // 如果目标涉及关系人物，给予加分
    if (candidate.relationTarget) {
      // 关系目标与当前注意力焦点匹配度
      const inFocus = context.attentionFocus.some(f =>
        f.toLowerCase().includes(candidate.relationTarget!.toLowerCase())
      );
      return inFocus ? 0.8 : 0.6;
    }

    // 社交类步骤额外加分
    if (candidate.step.description.includes('对话') ||
        candidate.step.description.includes('社交') ||
        candidate.step.description.includes('找人')) {
      return 0.7;
    }

    return 0.4;
  }

  /**
   * 计算叙事意义
   */
  private computeNarrativeSignificance(candidate: CandidateAction): number {
    const step = candidate.step;

    // 关键叙事步骤
    if (step.type === 'decision') return 0.7;
    if (step.type === 'subgoal') return 0.8;

    // 描述中带有关键词
    const keywords = ['关键', '重要', '决定', '转折', '冒险', '挑战', ' confrontation'];
    const hasKeyword = keywords.some(kw => step.description.includes(kw));
    if (hasKeyword) return 0.7;

    return 0.4;
  }

  /**
   * 计算注意力一致性
   */
  private computeAttentionCongruence(candidate: CandidateAction, context: DecisionContext): number {
    if (context.attentionFocus.length === 0) return 0.5;

    const stepDesc = candidate.step.description.toLowerCase();
    const goalDesc = candidate.goalDescription.toLowerCase();

    // 步骤或目标描述与注意力焦点匹配
    const matches = context.attentionFocus.filter(focus =>
      stepDesc.includes(focus.toLowerCase()) || goalDesc.includes(focus.toLowerCase())
    ).length;

    if (matches === 0) return 0.3;
    return Math.min(1, 0.3 + matches * 0.2);
  }

  // ============================================================
  // 辅助方法
  // ============================================================

  /**
   * 获取决策历史
   */
  getDecisionHistory(limit?: number): SelectedAction[] {
    const history = [...this.decisionHistory].reverse();
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * 获取上一次决策详情
   */
  getLastDecision(): SelectedAction | null {
    return this.decisionHistory.length > 0
      ? this.decisionHistory[this.decisionHistory.length - 1]
      : null;
  }

  /**
   * 格式化决策效用（用于调试）
   */
  formatUtilityBreakdown(breakdown: UtilityBreakdown): string {
    const w = this.config.weights;
    return [
      `效用分解: ${(breakdown.totalUtility * 100).toFixed(1)}%`,
      `  目标优先级: ${(breakdown.goalPriorityScore * 100).toFixed(0)}% × ${w.goalPriority} = ${(breakdown.goalPriorityScore * w.goalPriority * 100).toFixed(1)}%`,
      `  情绪驱动力: ${(breakdown.emotionalUrgeScore * 100).toFixed(0)}% × ${w.emotionalUrge} = ${(breakdown.emotionalUrgeScore * w.emotionalUrge * 100).toFixed(1)}%`,
      `  预期结果:   ${(breakdown.expectedOutcomeScore * 100).toFixed(0)}% × ${w.expectedOutcome} = ${(breakdown.expectedOutcomeScore * w.expectedOutcome * 100).toFixed(1)}%`,
      `  风险惩罚:   ${(breakdown.riskPenaltyScore * 100).toFixed(0)}% × ${w.riskPenalty} = ${(-breakdown.riskPenaltyScore * w.riskPenalty * 100).toFixed(1)}%`,
      `  关系影响:   ${(breakdown.relationImpactScore * 100).toFixed(0)}% × ${w.relationImpact} = ${(breakdown.relationImpactScore * w.relationImpact * 100).toFixed(1)}%`,
      `  叙事意义:   ${(breakdown.narrativeSignificanceScore * 100).toFixed(0)}% × ${w.narrativeSignificance} = ${(breakdown.narrativeSignificanceScore * w.narrativeSignificance * 100).toFixed(1)}%`,
      `  注意力一致: ${(breakdown.attentionCongruenceScore * 100).toFixed(0)}% × ${w.attentionCongruence} = ${(breakdown.attentionCongruenceScore * w.attentionCongruence * 100).toFixed(1)}%`,
    ].join('\n');
  }

  /**
   * 重置
   */
  reset(): void {
    this.decisionHistory = [];
  }
}

export default DecisionEngine;
