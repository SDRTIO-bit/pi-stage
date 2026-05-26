/**
 * context-decay.ts - 上下文衰减模型
 *
 * 所有上下文都存在 attention decay。
 * 不是自然衰减，而是受多种因素影响的组合衰减。
 *
 * 衰减维度：
 * - temporal decay（时间衰减）：越久远的内容注意力越低
 * - narrative decay（叙事衰减）：叙事上已结束的内容衰减更快
 * - emotional persistence（情感持久性）：高情绪内容衰减更慢
 * - goal persistence（目标持久性）：当前目标相关的内容衰减更慢
 * - reinforcement protection（强化保护）：被强化的内容不衰减
 *
 * 用途：
 * - 动态决定哪些内容进入上下文
 * - 动态决定哪些进入摘要
 * - 动态决定哪些进入长期记忆
 */

import { AttentionPriority, DEFAULT_ATTENTION_LAYERS, AttentionManager } from './attention-manager';

// ============================================================
// 衰减上下文条目
// ============================================================

export interface DecayEntry {
  /** 内容标识 */
  id: string;
  /** 内容文本 */
  content: string;
  /** 优先级层 */
  priority: AttentionPriority;
  /** 创建时间戳 */
  createdAt: number;
  /** 上次访问/引用的时间戳 */
  lastAccessAt: number;
  /** 原始 token 数 */
  tokenCount: number;
  /** 是否已结束的叙事弧 */
  narrativeArcClosed: boolean;
  /** 情感强度 0-1 */
  emotionalIntensity: number;
  /** 目标相关性 0-1 */
  goalRelevance: number;
  /** 是否被强化保护 */
  reinforced: boolean;
  /** 元数据标签 */
  tags: string[];
}

// ============================================================
// 衰减结果
// ============================================================

/**
 * DecayDecision - 衰减决策（用于调试追踪）
 */
export interface DecayDecision {
  action: 'keep_full' | 'keep_summary' | 'move_to_long_term' | 'archive';
  confidence: number;
  retentionRate: number;
  reasons: string[];
}

export interface DecayResult {
  entryId: string;
  /** 当前综合保留率 (0-1) */
  retentionRate: number;
  /** 各维度衰减值 */
  breakdown: {
    temporal: number;     // 时间衰减 (0=全衰减, 1=无衰减)
    narrative: number;    // 叙事衰减
    emotional: number;    // 情感持久性加成 (1=无加成, >1=存留更长)
    goal: number;         // 目标持久性加成
    reinforcement: number; // 强化保护 (0=无保护, 1=完全保护)
  };
  /** 决策建议 */
  suggestion: 'keep_full' | 'keep_summary' | 'move_to_long_term' | 'archive';
  /** 辅助决策（用于调试） */
  decision?: DecayDecision;
}

// ============================================================
// 衰减配置
// ============================================================

export interface DecayConfig {
  /** 时间衰减 */
  temporal: {
    /** 半衰期（轮数）：时间过了这么多轮衰减到 50%） */
    halfLifeTurns: Partial<Record<AttentionPriority, number>>;
    /** 最低保留率（时间衰减不会低于此值） */
    minRetention: number;
  };
  /** 叙事衰减 */
  narrative: {
    /** 叙事弧关闭后的衰减系数 (0-1) */
    closedNarrativeDecay: number;
    /** 叙事未关闭的保底保留 */
    openNarrativeRetention: number;
  };
  /** 情感持久性 */
  emotional: {
    /** 情感强度对衰减的抑制系数 */
    persistenceFactor: number;
    /** 情感衰减门槛（低于此强度的情感不产生影响） */
    intensityThreshold: number;
  };
  /** 目标持久性 */
  goal: {
    /** 目标相关性对衰减的抑制系数 */
    relevanceFactor: number;
    /** 最小相关性门槛 */
    relevanceThreshold: number;
  };
  /** 强化保护 */
  reinforcement: {
    /** 被强化后的保护轮数 */
    protectionTurns: number;
    /** 保护期内保留率 */
    protectedRetention: number;
  };
}

const DEFAULT_DECAY_CONFIG: DecayConfig = {
  temporal: {
    halfLifeTurns: {
      [AttentionPriority.HARD_RULES]: 1000,  // 几乎不衰减
      [AttentionPriority.CURRENT_GOALS]: 50,
      [AttentionPriority.CURRENT_SCENE]: 20,
      [AttentionPriority.WORKING_MEMORY]: 10,
      [AttentionPriority.SHORT_TERM_MEMORY]: 15,
      [AttentionPriority.ACTIVE_KNOWLEDGE]: 30,
      [AttentionPriority.LONG_TERM_MEMORY]: 40,
      [AttentionPriority.HISTORY_SUMMARY]: 50,
    },
    minRetention: 0.1,
  },
  narrative: {
    closedNarrativeDecay: 0.5,     // 叙事关闭后衰减多 50%
    openNarrativeRetention: 0.9,   // 叙事未关闭保留 90%
  },
  emotional: {
    persistenceFactor: 0.5,        // 情感强度 * 50% 加到保留率
    intensityThreshold: 0.3,
  },
  goal: {
    relevanceFactor: 0.4,          // 目标相关性 * 40% 加到保留率
    relevanceThreshold: 0.3,
  },
  reinforcement: {
    protectionTurns: 5,            // 强化后保护 5 轮
    protectedRetention: 0.95,      // 保护期内保留 95%
  },
};

// ============================================================
// ContextDecay - 上下文衰减模型
// ============================================================

export class ContextDecay {
  private config: DecayConfig;
  private attentionManager: AttentionManager;

  /** 记录哪些条目在什么轮次被强化过 */
  private reinforcedAt: Map<string, number> = new Map();
  /** 当前轮次 */
  private turnCounter: number = 0;

  constructor(
    attentionManager: AttentionManager,
    config?: Partial<DecayConfig>
  ) {
    this.attentionManager = attentionManager;
    this.config = this.mergeConfig(config);
  }

  /**
   * 核心方法：计算单个条目的综合保留率
   * 
   * @param entry 衰减条目
   * @returns 综合保留率和各维度分解
   */
  calculate(entry: DecayEntry): DecayResult {
    this.turnCounter++;

    // 1. 时间衰减
    const temporal = this.calculateTemporalDecay(entry);

    // 2. 叙事衰减
    const narrative = this.calculateNarrativeDecay(entry);

    // 3. 情感持久性
    const emotional = this.calculateEmotionalPersistence(entry);

    // 4. 目标持久性
    const goal = this.calculateGoalPersistence(entry);

    // 5. 强化保护
    const reinforcement = this.calculateReinforcement(entry);

    // 综合保留率 = 时间 × 叙事 + 情感加成 + 目标加成 + 强化保护
    let retentionRate = temporal * narrative;
    retentionRate += emotional > 1 ? (emotional - 1) * 0.3 : 0;   // 情感加成
    retentionRate += goal > 1 ? (goal - 1) * 0.3 : 0;            // 目标加成
    retentionRate += reinforcement;                               // 强化保护加成

    // 钳制到 [0, 1]
    retentionRate = Math.max(0, Math.min(1, retentionRate));

    // 决策建议
    const suggestion = this.makeDecision(retentionRate, entry);

    // 生成调试决策
    const reasons: string[] = [];
    if (temporal < 0.5) reasons.push(`时间衰减严重 (${(temporal * 100).toFixed(0)}%)`);
    if (narrative < 0.5) reasons.push('叙事弧已关闭');
    if (emotional > 1.0) reasons.push(`情感强度保留 (${((emotional - 1) * 100).toFixed(0)}%)`);
    if (goal > 1.0) reasons.push(`目标相关性保留 (${((goal - 1) * 100).toFixed(0)}%)`);
    if (reinforcement > 0) reasons.push(`强化保护 (${(reinforcement * 100).toFixed(0)}%)`);
    if (reasons.length === 0) reasons.push('常规保留');

    const decision: DecayDecision = {
      action: suggestion,
      confidence: retentionRate,
      retentionRate,
      reasons,
    };

    return {
      entryId: entry.id,
      retentionRate,
      breakdown: { temporal, narrative, emotional, goal, reinforcement },
      suggestion,
      decision,
    };
  }

  /**
   * 批量计算多个条目的保留率并排序
   * 
   * @param entries 条目列表
   * @returns 按保留率降序排列
   */
  evaluateBatch(entries: DecayEntry[]): DecayResult[] {
    const results = entries.map(e => this.calculate(e));
    results.sort((a, b) => b.retentionRate - a.retentionRate);
    return results;
  }

  /**
   * 根据衰减结果决定内容的"命运"
   * 
   * @param entries 衰减结果列表
   * @param maxTokens 可用预算
   * @returns 分区后的内容
   */
  categorize(
    results: DecayResult[],
    entries: Map<string, DecayEntry>,
    maxTokens: number
  ): {
    keepFull: DecayEntry[];
    keepSummary: DecayEntry[];
    moveToLongTerm: DecayEntry[];
    archive: DecayEntry[];
  } {
    const keepFull: DecayEntry[] = [];
    const keepSummary: DecayEntry[] = [];
    const moveToLongTerm: DecayEntry[] = [];
    const archive: DecayEntry[] = [];

    let budgetUsed = 0;

    for (const result of results) {
      const entry = entries.get(result.entryId);
      if (!entry) continue;

      switch (result.suggestion) {
        case 'keep_full':
          if (budgetUsed + entry.tokenCount <= maxTokens) {
            keepFull.push(entry);
            budgetUsed += entry.tokenCount;
          } else {
            keepSummary.push(entry);
          }
          break;
        case 'keep_summary':
          keepSummary.push(entry);
          break;
        case 'move_to_long_term':
          moveToLongTerm.push(entry);
          break;
        case 'archive':
          archive.push(entry);
          break;
      }
    }

    return { keepFull, keepSummary, moveToLongTerm, archive };
  }

  /**
   * 标记条目已被强化（提供保护）
   */
  markReinforced(entryId: string): void {
    this.reinforcedAt.set(entryId, this.turnCounter);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<DecayConfig>): void {
    this.config = this.mergeConfig(config);
  }

  // ============================================================
  // 各维度衰减计算
  // ============================================================

  /**
   * 时间衰减
   * 使用指数衰减模型：R(t) = minRetention + (1 - minRetention) * 0.5^(t / halfLife)
   */
  private calculateTemporalDecay(entry: DecayEntry): number {
    const halfLife = this.config.temporal.halfLifeTurns[entry.priority] ?? 20;
    const ageTurns = this.turnCounter -
      Math.floor((Date.now() - entry.createdAt) / 60000);

    // 指数衰减
    const decay = Math.pow(0.5, ageTurns / halfLife);
    const retention = this.config.temporal.minRetention +
      (1 - this.config.temporal.minRetention) * decay;

    return Math.max(this.config.temporal.minRetention, Math.min(1, retention));
  }

  /**
   * 叙事衰减
   * 已关闭的叙事弧衰减更快
   */
  private calculateNarrativeDecay(entry: DecayEntry): number {
    if (entry.narrativeArcClosed) {
      return 1 - this.config.narrative.closedNarrativeDecay;
    }
    return this.config.narrative.openNarrativeRetention;
  }

  /**
   * 情感持久性
   * 高情绪内容衰减更慢
   */
  private calculateEmotionalPersistence(entry: DecayEntry): number {
    if (entry.emotionalIntensity < this.config.emotional.intensityThreshold) {
      return 1.0;
    }

    // 情感强度 → 持久性加成
    const persistence = 1 +
      entry.emotionalIntensity * this.config.emotional.persistenceFactor;

    return persistence;
  }

  /**
   * 目标持久性
   * 当前目标相关的内容衰减更慢
   */
  private calculateGoalPersistence(entry: DecayEntry): number {
    if (entry.goalRelevance < this.config.goal.relevanceThreshold) {
      return 1.0;
    }

    const persistence = 1 +
      entry.goalRelevance * this.config.goal.relevanceFactor;

    return persistence;
  }

  /**
   * 强化保护
   * 被强化过的内容在保护期内几乎不衰减
   */
  private calculateReinforcement(entry: DecayEntry): number {
    if (entry.reinforced) {
      const reinforcedTurn = this.reinforcedAt.get(entry.id) ?? 0;
      const turnsSinceReinforce = this.turnCounter - reinforcedTurn;

      if (turnsSinceReinforce <= this.config.reinforcement.protectionTurns) {
        return this.config.reinforcement.protectedRetention;
      }
    }

    return 0; // 无额外加成
  }

  /**
   * 决策建议
   */
  private makeDecision(
    retentionRate: number,
    entry: DecayEntry
  ): DecayResult['suggestion'] {
    const attention = this.attentionManager.getAttention(entry.priority);
    const effectiveRetention = retentionRate * attention;

    if (effectiveRetention >= 0.7) return 'keep_full';
    if (effectiveRetention >= 0.4) return 'keep_summary';
    if (effectiveRetention >= 0.2) return 'move_to_long_term';
    return 'archive';
  }

  /**
   * 合并配置
   */
  private mergeConfig(override?: Partial<DecayConfig>): DecayConfig {
    if (!override) return { ...DEFAULT_DECAY_CONFIG };

    return {
      temporal: { ...DEFAULT_DECAY_CONFIG.temporal, ...override.temporal },
      narrative: { ...DEFAULT_DECAY_CONFIG.narrative, ...override.narrative },
      emotional: { ...DEFAULT_DECAY_CONFIG.emotional, ...override.emotional },
      goal: { ...DEFAULT_DECAY_CONFIG.goal, ...override.goal },
      reinforcement: { ...DEFAULT_DECAY_CONFIG.reinforcement, ...override.reinforcement },
    };
  }

  /**
   * 重置
   */
  reset(): void {
    this.reinforcedAt.clear();
    this.turnCounter = 0;
  }
}

export default ContextDecay;
