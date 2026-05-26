/**
 * decision-trace.ts - 决策追踪（调试/可视化）
 *
 * 记录每次决策的完整效用分解：
 * - 所有候选动作的效用分数
 * - 选择理由
 * - 探索 vs 利用标记
 *
 * 可观察：
 * - Agent 为什么选择了这个行为
 * - 哪些因素起了决定性作用
 * - 哪些候选被忽略及原因
 */

import type { UtilityBreakdown, SelectedAction, CandidateAction, DecisionContext } from '../../planning/decision-engine';

export interface DecisionTraceEntry {
  id: string;
  timestamp: number;
  /** 被选中的动作 */
  selected: {
    goalId: string;
    goalDescription: string;
    stepDescription: string;
    utility: UtilityBreakdown;
  };
  /** 所有候选（含未选中的） */
  candidates: Array<{
    goalId: string;
    goalDescription: string;
    stepDescription: string;
    totalUtility: number;
    breakdown: UtilityBreakdown;
  }>;
  /** 决策上下文 */
  context: {
    dominantEmotion: string;
    attentionFocus: string[];
    location?: string;
  };
  /** 是否使用了探索策略 */
  explorationUsed: boolean;
  /** 决策摘要 */
  summary: string;
}

export class DecisionTracer {
  private entries: DecisionTraceEntry[] = [];
  private readonly MAX_ENTRIES = 500;
  private idCounter: number = 0;

  /**
   * 记录一次决策
   */
  decisionMade(
    selectedAction: SelectedAction,
    allCandidates: CandidateAction[],
    context: DecisionContext,
    explorationUsed: boolean
  ): void {
    const entry: DecisionTraceEntry = {
      id: `dtrace_${++this.idCounter}`,
      timestamp: Date.now(),
      selected: {
        goalId: selectedAction.goalId,
        goalDescription: allCandidates.find(c => c.goalId === selectedAction.goalId)?.goalDescription ?? '',
        stepDescription: selectedAction.step.description,
        utility: selectedAction.utility,
      },
      candidates: allCandidates.map(c => ({
        goalId: c.goalId,
        goalDescription: c.goalDescription,
        stepDescription: c.step.description,
        totalUtility: 0, // 将由外部计算后填充
        breakdown: {
          goalPriorityScore: 0,
          emotionalUrgeScore: 0,
          expectedOutcomeScore: 0,
          riskPenaltyScore: 0,
          relationImpactScore: 0,
          narrativeSignificanceScore: 0,
          attentionCongruenceScore: 0,
          totalUtility: 0,
        },
      })),
      context: {
        dominantEmotion: context.dominantEmotion,
        attentionFocus: [...context.attentionFocus],
        location: context.currentLocation,
      },
      explorationUsed,
      summary: this.buildSummary(selectedAction, allCandidates, explorationUsed),
    };

    this.entries.push(entry);

    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries.shift();
    }
  }

  /**
   * 更新候选效用分数（在决策完成后由外部填充）
   */
  updateCandidateUtility(goalId: string, stepDescription: string, utility: UtilityBreakdown): void {
    const latest = this.entries[this.entries.length - 1];
    if (!latest) return;

    const candidate = latest.candidates.find(
      c => c.goalId === goalId && c.stepDescription === stepDescription
    );
    if (candidate) {
      candidate.totalUtility = utility.totalUtility;
      candidate.breakdown = { ...utility };
    }
  }

  /**
   * 构建决策摘要
   */
  private buildSummary(
    selected: SelectedAction,
    allCandidates: CandidateAction[],
    explorationUsed: boolean
  ): string {
    const totalUtil = (selected.utility.totalUtility * 100).toFixed(0);
    const exploreMark = explorationUsed ? ' (探索)' : '';
    const candidateList = allCandidates.map((c, i) => {
      const isSelected = c.goalId === selected.goalId && c.step.id === selected.step.id;
      return `  ${isSelected ? '→' : ' '} [${i}] ${c.step.description} (目标: ${c.goalDescription.substring(0, 30)})`;
    }).join('\n');

    return [
      `决策: 选择 "${selected.step.description}"${exploreMark}`,
      `效用: ${totalUtil}%`,
      ``,
      `候选:`,
      candidateList,
    ].join('\n');
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取最近一次决策
   */
  getLastDecision(): DecisionTraceEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /**
   * 获取所有决策条目
   */
  getEntries(limit?: number): DecisionTraceEntry[] {
    const reversed = [...this.entries].reverse();
    return limit ? reversed.slice(0, limit) : reversed;
  }

  /**
   * 按目标 ID 过滤决策
   */
  getEntriesByGoal(goalId: string): DecisionTraceEntry[] {
    return this.entries.filter(e =>
      e.selected.goalId === goalId ||
      e.candidates.some(c => c.goalId === goalId)
    );
  }

  /**
   * 获取决策统计
   */
  getStats(): DecisionTraceStats {
    const total = this.entries.length;
    const explorationCount = this.entries.filter(e => e.explorationUsed).length;

    // 各因素的权重影响分析
    const avgFactors = this.entries.reduce(
      (acc, e) => {
        const u = e.selected.utility;
        acc.goalPriority += u.goalPriorityScore;
        acc.emotionalUrge += u.emotionalUrgeScore;
        acc.expectedOutcome += u.expectedOutcomeScore;
        acc.riskPenalty += u.riskPenaltyScore;
        acc.relationImpact += u.relationImpactScore;
        acc.narrativeSignificance += u.narrativeSignificanceScore;
        acc.attentionCongruence += u.attentionCongruenceScore;
        return acc;
      },
      {
        goalPriority: 0, emotionalUrge: 0, expectedOutcome: 0,
        riskPenalty: 0, relationImpact: 0, narrativeSignificance: 0,
        attentionCongruence: 0,
      }
    );

    const n = Math.max(1, total);
    return {
      totalDecisions: total,
      explorationRate: total > 0 ? (explorationCount / total) * 100 : 0,
      averageUtilityBreakdown: {
        goalPriority: avgFactors.goalPriority / n,
        emotionalUrge: avgFactors.emotionalUrge / n,
        expectedOutcome: avgFactors.expectedOutcome / n,
        riskPenalty: avgFactors.riskPenalty / n,
        relationImpact: avgFactors.relationImpact / n,
        narrativeSignificance: avgFactors.narrativeSignificance / n,
        attentionCongruence: avgFactors.attentionCongruence / n,
      },
    };
  }

  /**
   * 格式化单个决策为可读文本
   */
  formatEntry(entry: DecisionTraceEntry): string {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const explore = entry.explorationUsed ? ' [探索]' : '';
    const u = entry.selected.utility;

    return [
      `[${time}]${explore}`,
      `→ ${entry.selected.stepDescription}`,
      `  目标: ${entry.selected.goalDescription.substring(0, 50)}`,
      `  总效用: ${(u.totalUtility * 100).toFixed(0)}%`,
      `  分解: 目标=${(u.goalPriorityScore * 100).toFixed(0)}% 情绪=${(u.emotionalUrgeScore * 100).toFixed(0)}% 预期=${(u.expectedOutcomeScore * 100).toFixed(0)}% 风险=${(u.riskPenaltyScore * 100).toFixed(0)}%`,
      `        关系=${(u.relationImpactScore * 100).toFixed(0)}% 叙事=${(u.narrativeSignificanceScore * 100).toFixed(0)}% 注意=${(u.attentionCongruenceScore * 100).toFixed(0)}%`,
      `  候选: ${entry.candidates.length} 个`,
    ].join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
  }
}

export interface DecisionTraceStats {
  totalDecisions: number;
  explorationRate: number;
  averageUtilityBreakdown: {
    goalPriority: number;
    emotionalUrge: number;
    expectedOutcome: number;
    riskPenalty: number;
    relationImpact: number;
    narrativeSignificance: number;
    attentionCongruence: number;
  };
}

export default DecisionTracer;
