/**
 * salience-engine.ts - 显著性计算引擎
 *
 * Memory 不再按时间排序。
 * 而是按显著性（salience）排序。
 *
 * 显著性维度：
 * - emotional intensity（情绪强度）
 * - relation importance（关系重要性）
 * - current goals（当前目标相关性）
 * - recent conflicts（近期冲突）
 * - narrative significance（叙事意义）
 * - repeated mentions（重复提及频率）
 * - active location（当前活跃地点）
 * - active events（当前活跃事件）
 *
 * 输出：
 * - per-layer salience scores
 * - salience-weighted memory ranking
 * - dynamic salience update
 */

import { AttentionPriority, DEFAULT_ATTENTION_LAYERS, type SalienceSignals } from './attention-manager';

// ============================================================
// 显著性得分接口
// ============================================================

export interface SalienceScore {
  /** 综合得分 (0-2) */
  composite: number;
  /** 情绪强度 (0-2) */
  emotionalIntensity: number;
  /** 关系重要性 (0-2) */
  relationImportance: number;
  /** 目标相关性 (0-2) */
  goalRelevance: number;
  /** 冲突强度 (0-2) */
  conflictIntensity: number;
  /** 叙事意义 (0-2) */
  narrativeSignificance: number;
  /** 重复提及频率 (0-2) */
  repetitionFrequency: number;
  /** 地点相关 (0-2) */
  locationRelevance: number;
  /** 事件相关 (0-2) */
  eventRelevance: number;
}

export interface SalienceConfig {
  /** 各维度的权重（总和为 1） */
  weights: {
    emotional: number;
    relation: number;
    goal: number;
    conflict: number;
    narrative: number;
    repetition: number;
    location: number;
    event: number;
  };
  /** 情绪衰减半衰期（轮数） */
  emotionalHalfLife: number;
  /** 关系变化的敏感度 (0-1) */
  relationSensitivity: number;
  /** 事件显著性阈值（低于此值不贡献） */
  eventSalienceThreshold: number;
}

export const DEFAULT_SALIENCE_CONFIG: SalienceConfig = {
  weights: {
    emotional: 0.15,
    relation: 0.15,
    goal: 0.20,
    conflict: 0.10,
    narrative: 0.10,
    repetition: 0.10,
    location: 0.10,
    event: 0.10,
  },
  emotionalHalfLife: 20,    // 20 轮后情绪强度减半
  relationSensitivity: 0.5,
  eventSalienceThreshold: 0.3,
};

// ============================================================
// 记忆条目（用于评分）
// ============================================================

export interface SalienceMemoryEntry {
  id: string;
  content: string;
  timestamp: number;
  /** 情感效价 -1 ~ 1 */
  emotionalValence: number;
  /** 情感强度 0-1 */
  emotionalIntensity: number;
  /** 涉及的角色 */
  relatedCharacters: string[];
  /** 涉及的对象 */
  relatedObjects: string[];
  /** 发生地点 */
  location: string;
  /** 参与的事件 */
  event: string;
  /** 冲突标记 */
  isConflict: boolean;
  /** 叙事转折标记 */
  isNarrativeTurn: boolean;
}

// ============================================================
// 当前上下文快照（用于比较评分）
// ============================================================

export interface ContextSnapshot {
  /** 当前活跃目标 */
  activeGoals: string[];
  /** 当前位置 */
  currentLocation: string;
  /** 当前活跃事件 */
  activeEvents: string[];
  /** 当前活跃角色 */
  activeCharacters: string[];
  /** 近期提到的关键词 */
  recentKeywords: string[];
}

// ============================================================
// SalienceEngine
// ============================================================

export class SalienceEngine {
  private config: SalienceConfig;

  /** 上一轮各记忆的显著性得分（用于检测变化） */
  private previousScores: Map<string, SalienceScore> = new Map();
  /** 各记忆的历史情感强度轨迹 */
  private emotionalTrajectory: Map<string, number[]> = new Map();
  /** 各记忆的提及计数 */
  private mentionCounts: Map<string, number> = new Map();
  /** 当前轮次 */
  private turnCounter: number = 0;

  constructor(config?: Partial<SalienceConfig>) {
    this.config = { ...DEFAULT_SALIENCE_CONFIG, ...config };
  }

  /**
   * 核心入口：对一组记忆条目进行显著性评分
   * 
   * @param entries 记忆条目列表
   * @param context 当前上下文快照
   * @returns 评分后的条目列表（按 composite 降序）
   */
  score(
    entries: SalienceMemoryEntry[],
    context: ContextSnapshot
  ): Array<{ entry: SalienceMemoryEntry; score: SalienceScore }> {
    this.turnCounter++;

    const scored = entries.map(entry => {
      const score = this.calculateScore(entry, context);

      // 更新历史数据
      this.previousScores.set(entry.id, score);
      this.updateEmotionalTrajectory(entry);
      this.mentionCounts.set(
        entry.id,
        (this.mentionCounts.get(entry.id) ?? 0) + 1
      );

      return { entry, score };
    });

    // 按 composite 降序
    scored.sort((a, b) => b.score.composite - a.score.composite);

    return scored;
  }

  /**
   * 计算单条记忆的综合显著性得分
   */
  private calculateScore(
    entry: SalienceMemoryEntry,
    context: ContextSnapshot
  ): SalienceScore {
    // 各维度评分
    const emotionalIntensity = this.scoreEmotionalIntensity(entry);
    const relationImportance = this.scoreRelationImportance(entry, context);
    const goalRelevance = this.scoreGoalRelevance(entry, context);
    const conflictIntensity = this.scoreConflictIntensity(entry);
    const narrativeSignificance = this.scoreNarrativeSignificance(entry);
    const repetitionFrequency = this.scoreRepetitionFrequency(entry);
    const locationRelevance = this.scoreLocationRelevance(entry, context);
    const eventRelevance = this.scoreEventRelevance(entry, context);

    // 综合 = 加权求和
    const composite =
      emotionalIntensity * this.config.weights.emotional +
      relationImportance * this.config.weights.relation +
      goalRelevance * this.config.weights.goal +
      conflictIntensity * this.config.weights.conflict +
      narrativeSignificance * this.config.weights.narrative +
      repetitionFrequency * this.config.weights.repetition +
      locationRelevance * this.config.weights.location +
      eventRelevance * this.config.weights.event;

    return {
      composite: Math.min(2.0, composite), // 钳制到 [0, 2]
      emotionalIntensity,
      relationImportance,
      goalRelevance,
      conflictIntensity,
      narrativeSignificance,
      repetitionFrequency,
      locationRelevance,
      eventRelevance,
    };
  }

  /**
   * 情绪强度评分 (0-2)
   * - 情感效价绝对值越高 → 得分越高
   * - 情感强度越高 → 得分越高
   * - 时间衰减：越久远的记忆情绪强度越低
   */
  private scoreEmotionalIntensity(entry: SalienceMemoryEntry): number {
    const ageTurns = this.turnCounter - Math.floor(
      (Date.now() - entry.timestamp) / 60000
    );

    // 情绪基础强度
    const baseIntensity = Math.abs(entry.emotionalValence) * entry.emotionalIntensity;
    // 将 [0, 1] 映射到 [0, 2]
    const baseScore = baseIntensity * 2;

    // 时间衰减
    const decayFactor = Math.pow(0.5, ageTurns / this.config.emotionalHalfLife);

    return baseScore * decayFactor + 0.2; // 最低 0.2（情绪不会完全消失）
  }

  /**
   * 关系重要性评分 (0-2)
   * - 涉及当前活跃角色 → 高
   * - 涉及多个角色 → 更高（复杂关系事件）
   * - 关系变化敏感度
   */
  private scoreRelationImportance(
    entry: SalienceMemoryEntry,
    context: ContextSnapshot
  ): number {
    if (entry.relatedCharacters.length === 0) return 0;

    let score = 0;

    // 涉及活跃角色的比例
    const activeRelated = entry.relatedCharacters.filter(c =>
      context.activeCharacters.includes(c)
    ).length;
    score += activeRelated / Math.max(context.activeCharacters.length, 1);

    // 涉及多个角色代表复杂社会事件
    if (entry.relatedCharacters.length >= 3) {
      score += 0.5;
    }

    // 与其他角色的关系交叉
    const uniqueRelation = entry.relatedCharacters.length >= 2 ? 0.3 : 0;

    score = Math.min(2.0, (score + uniqueRelation) * (1 + this.config.relationSensitivity));

    return score;
  }

  /**
   * 目标相关性评分 (0-2)
   * - 内容匹配当前活跃目标 → 高
   * - 阻碍/推动目标的事件 → 极高
   */
  private scoreGoalRelevance(
    entry: SalienceMemoryEntry,
    context: ContextSnapshot
  ): number {
    if (context.activeGoals.length === 0) return 0.1;

    let score = 0;
    const fullText = `${entry.content} ${entry.event} ${entry.relatedObjects.join(' ')}`;

    for (const goal of context.activeGoals) {
      // 完整匹配
      if (fullText.includes(goal)) {
        score += 1.0;
        continue;
      }
      // 关键词匹配
      const goalWords = goal.split(/\s+/);
      const matchCount = goalWords.filter(w =>
        fullText.includes(w) && w.length > 1
      ).length;
      score += matchCount / Math.max(goalWords.length, 1);
    }

    // 如果是冲突事件且匹配目标 → 极高显著性
    if (entry.isConflict && score > 0.5) {
      score *= 1.5;
    }

    return Math.min(2.0, score);
  }

  /**
   * 冲突强度评分 (0-2)
   * - 标记为冲突 → 基础 1.0
   * - 涉及多个角色冲突 → 更高
   * - 情绪强烈的冲突 → 极高
   */
  private scoreConflictIntensity(entry: SalienceMemoryEntry): number {
    if (!entry.isConflict) return 0;

    let score = 1.0;

    // 多个角色参与 → 冲突升级
    if (entry.relatedCharacters.length >= 2) {
      score += 0.5 * Math.min(entry.relatedCharacters.length - 1, 3);
    }

    // 情绪强烈的冲突
    if (entry.emotionalIntensity > 0.7) {
      score += 0.5;
    }

    return Math.min(2.0, score);
  }

  /**
   * 叙事意义评分 (0-2)
   * - 叙事转折点 → 高
   * - 涉及关键角色首次/最后一次出现 → 高
   * - 决定性事件 → 极高
   */
  private scoreNarrativeSignificance(entry: SalienceMemoryEntry): number {
    if (!entry.isNarrativeTurn) return 0.1;

    let score = 1.5;

    // 高情绪强度的叙事转折
    if (entry.emotionalIntensity > 0.8) {
      score += 0.5;
    }

    // 涉及多个关键对象的叙事转折
    if (entry.relatedCharacters.length + entry.relatedObjects.length >= 4) {
      score += 0.3;
    }

    return Math.min(2.0, score);
  }

  /**
   * 重复提及频率评分 (0-2)
   * - 被提及次数越多 → 越高
   * - 有衰减（旧重复不如新重复重要）
   */
  private scoreRepetitionFrequency(entry: SalienceMemoryEntry): number {
    const count = this.mentionCounts.get(entry.id) ?? 0;
    if (count === 0) return 0;

    // log 曲线：1次=0.5, 2次=0.8, 3次=1.0, 5次=1.3, 10次=1.6
    const score = Math.log2(count + 1) * 0.5;

    return Math.min(2.0, score);
  }

  /**
   * 地点相关性评分 (0-2)
   * - 记忆发生地点与当前位置一致 → 高
   * - 地点类型匹配 → 中
   */
  private scoreLocationRelevance(
    entry: SalienceMemoryEntry,
    context: ContextSnapshot
  ): number {
    if (!entry.location || !context.currentLocation) return 0.1;

    if (entry.location === context.currentLocation) return 2.0;

    // 部分匹配（同区域/同类型）
    const locationWords = context.currentLocation.split(/[的>/]/).filter(w => w.length > 1);
    const match = locationWords.some(w => entry.location.includes(w));

    return match ? 1.0 : 0.3;
  }

  /**
   * 事件相关性评分 (0-2)
   * - 记忆关联事件与当前活跃事件一致 → 高
   * - 事件链上相关 → 中
   */
  private scoreEventRelevance(
    entry: SalienceMemoryEntry,
    context: ContextSnapshot
  ): number {
    if (context.activeEvents.length === 0) return 0.1;

    let score = 0;
    for (const event of context.activeEvents) {
      if (entry.event === event) {
        score = Math.max(score, 2.0);
      } else if (entry.event.includes(event) || event.includes(entry.event)) {
        score = Math.max(score, 1.0);
      } else if (
        entry.relatedObjects.some(obj => event.includes(obj)) ||
        event.split(/\s+/).some(w => entry.content.includes(w))
      ) {
        score = Math.max(score, 0.5);
      }
    }

    // 低于阈值的归零
    if (score < this.config.eventSalienceThreshold) {
      score = 0.1;
    }

    return score;
  }

  /**
   * 更新情绪轨迹
   */
  private updateEmotionalTrajectory(entry: SalienceMemoryEntry): void {
    const trajectory = this.emotionalTrajectory.get(entry.id) ?? [];
    trajectory.push(entry.emotionalIntensity);
    if (trajectory.length > 10) trajectory.shift();
    this.emotionalTrajectory.set(entry.id, trajectory);
  }

  /**
   * 将显著性得分转换为注意力管理器可用的 SalienceSignals
   * 
   * @param scoredEntries 评分后的记忆条目
   * @param context 当前上下文
   * @returns 各层的显著性加成信号
   */
  toSalienceSignals(
    scoredEntries: Array<{ entry: SalienceMemoryEntry; score: SalienceScore }>,
    context: ContextSnapshot
  ): SalienceSignals {
    const emotionalBoosts: Partial<Record<AttentionPriority, number>> = {};
    const goalBoosts: Partial<Record<AttentionPriority, number>> = {};

    // 按最高情绪强度给 scene/working/short-term 加成
    const maxEmotional = scoredEntries.length > 0
      ? Math.max(...scoredEntries.map(s => s.score.emotionalIntensity))
      : 0.5;

    const boost = Math.min(1.5, 0.8 + maxEmotional * 0.5);

    emotionalBoosts[AttentionPriority.CURRENT_SCENE] = boost;
    emotionalBoosts[AttentionPriority.WORKING_MEMORY] = boost * 0.9;
    emotionalBoosts[AttentionPriority.SHORT_TERM_MEMORY] = boost * 0.8;

    // 按目标相关性给 goals/scene/knowledge 加成
    const maxGoalScore = scoredEntries.length > 0
      ? Math.max(...scoredEntries.map(s => s.score.goalRelevance))
      : 0.3;

    const goalBoost = Math.min(1.5, 0.8 + maxGoalScore * 0.5);

    goalBoosts[AttentionPriority.CURRENT_GOALS] = goalBoost;
    goalBoosts[AttentionPriority.ACTIVE_KNOWLEDGE] = goalBoost * 0.8;
    goalBoosts[AttentionPriority.CURRENT_SCENE] = goalBoost * 0.7;

    return { emotionalBoosts, goalBoosts };
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SalienceConfig>): void {
    Object.assign(this.config, config);
  }
}

export default SalienceEngine;
