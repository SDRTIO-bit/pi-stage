/**
 * belief-system.ts — 信念系统（Belief Runtime）
 *
 * Agent 不只拥有"事实"，还拥有信念。
 * 信念是 Agent 对世界的主观理解模型，不等同于客观事实。
 *
 * 信念特性：
 * - 被证实（confirmed）：有充分证据支持
 * - 被推翻（refuted）：有证据否定
 * - 被强化（strengthened）：新证据加强
 * - 被误导（misled）：错误信息塑造的信念
 *
 * 信念 vs 认知事实：
 * - 认知事实（Awareness Fact）："我知道他在房间里"
 * - 信念（Belief）："我觉得他在躲着我"（基于多个事实的推断）
 *
 * 信念来源：
 * - 多个认知事实的归纳
 * - 情绪状态的投射
 * - 关系信任度的泛化
 * - 性格特质的偏见
 * - 他人的影响
 *
 * 整合：
 * - Goal Runtime：信念影响目标生成（"他觉得我不信任他"→修复关系目标）
 * - Decision Engine：信念影响效用计算
 * - Context Assembly：信念作为 Agent 的"世界观"注入
 * - Emotional Response：信念冲突导致情绪波动
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 类型定义
// ============================================================

export type BeliefStatus = 'forming' | 'held' | 'strong' | 'weakening' | 'refuted' | 'abandoned';

export type BeliefCategory =
  | 'self_perception'     // 自我认知（"我擅长社交"）
  | 'other_perception'    // 对他人的看法（"他不可信任"）
  | 'world_view'          // 世界观（"世界是危险的"）
  | 'relationship_belief' // 关系信念（"她在乎我"）
  | 'causal_belief'       // 因果信念（"如果我主动，会被拒绝"）
  | 'value_judgment'      // 价值判断（"权力比友谊重要"）
  | 'prediction'          // 预测（"他明天会来"）
  ;

export type BeliefSource =
  | 'direct_experience'
  | 'repeated_pattern'
  | 'emotional_state'
  | 'social_influence'
  | 'personality_trait'
  | 'trauma'
  | 'inference'
  | 'upbringing'
  ;

export interface Belief {
  id: string;
  /** 信念内容 */
  content: string;
  /** 信念类别 */
  category: BeliefCategory;
  /** 当前状态 */
  status: BeliefStatus;
  /** 信念强度 0-1 */
  strength: number;
  /** 形成时间 */
  formedAt: number;
  /** 最后更新时间 */
  lastUpdated: number;
  /** 来源 */
  sources: Array<{
    type: BeliefSource;
    /** 来源详情 */
    detail: string;
    /** 此来源的权重 0-1 */
    weight: number;
  }>;
  /** 支持的证据（关联的认知事实 ID） */
  supportingFacts: string[];
  /** 反对的证据 */
  contradictoryFacts: string[];
  /** 信任度加权（对信息来源的信任） */
  trustWeightedConfidence: number;
  /** 情绪关联 */
  associatedEmotions: Array<{ emotion: string; intensity: number }>;
  /** 是否是无意识信念（默认假设） */
  isImplicit: boolean;
  /** 影响的行为倾向 */
  behavioralTendencies: string[];
}

// ============================================================
// 信念变化事件
// ============================================================

export interface BeliefChange {
  beliefId: string;
  content: string;
  type: 'confirmed' | 'refuted' | 'strengthened' | 'weakened' | 'formed' | 'abandoned';
  oldStrength: number;
  newStrength: number;
  reason: string;
  timestamp: number;
}

// ============================================================
// BeliefSystem 配置
// ============================================================

export interface BeliefSystemConfig {
  /** 最大信念数 */
  maxBeliefs: number;
  /** 新信念形成所需的最小强度 */
  formationThreshold: number;
  /** 信念被放弃的强度阈值 */
  abandonmentThreshold: number;
  /** 信念强化所需的新证据量 */
  strengthenEvidenceThreshold: number;
  /** 情绪对信念的影响权重 */
  emotionInfluenceWeight: number;
  /** 性格特质对信念的影响权重 */
  personalityInfluenceWeight: number;
  /** 信念衰减率（每 tick） */
  decayRate: number;
}

const DEFAULT_BELIEF_CONFIG: BeliefSystemConfig = {
  maxBeliefs: 50,
  formationThreshold: 0.3,
  abandonmentThreshold: 0.1,
  strengthenEvidenceThreshold: 2,
  emotionInfluenceWeight: 0.3,
  personalityInfluenceWeight: 0.2,
  decayRate: 0.005,
};

// ============================================================
// BeliefSystem 实现
// ============================================================

export class BeliefSystem {
  private beliefs: Map<string, Belief> = new Map();
  private config: BeliefSystemConfig;
  private eventBus: EventBus | null;

  /** 信念变化历史 */
  private changeHistory: BeliefChange[] = [];
  private readonly MAX_HISTORY = 300;

  constructor(config?: Partial<BeliefSystemConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_BELIEF_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 核心接口：信念形成与更新
  // ============================================================

  /**
   * 形成或更新信念
   * 由 AwarenessRuntime 在积累足够证据后调用
   */
  formOrUpdateBelief(params: {
    content: string;
    category: BeliefCategory;
    strength: number;
    source: BeliefSource;
    sourceDetail: string;
    supportingFacts?: string[];
    associatedEmotions?: Array<{ emotion: string; intensity: number }>;
    isImplicit?: boolean;
  }): Belief {
    // 检查是否已存在相似信念
    const existing = this.findBeliefByContent(params.content);

    if (existing) {
      return this.strengthenBelief(existing.id, {
        source: params.source,
        detail: params.sourceDetail,
        weight: params.strength,
      });
    }

    // 强度低于阈值，不形成信念
    if (params.strength < this.config.formationThreshold) {
      // 返回一个弱信念但标记为 forming
    }

    const belief: Belief = {
      id: `belief_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content: params.content,
      category: params.category,
      status: params.strength > 0.6 ? 'held' : 'forming',
      strength: Math.max(0, Math.min(1, params.strength)),
      formedAt: Date.now(),
      lastUpdated: Date.now(),
      sources: [{
        type: params.source,
        detail: params.sourceDetail,
        weight: params.strength,
      }],
      supportingFacts: params.supportingFacts ?? [],
      contradictoryFacts: [],
      trustWeightedConfidence: params.strength,
      associatedEmotions: params.associatedEmotions ?? [],
      isImplicit: params.isImplicit ?? false,
      behavioralTendencies: [],
    };

    this.beliefs.set(belief.id, belief);
    this.trimToMax();

    this.recordChange({
      beliefId: belief.id,
      content: belief.content,
      type: 'formed',
      oldStrength: 0,
      newStrength: belief.strength,
      reason: `来源: ${params.source} - ${params.sourceDetail}`,
      timestamp: Date.now(),
    });

    this.eventBus?.emit('belief:formed', {
      beliefId: belief.id,
      content: belief.content,
      category: belief.category,
      strength: belief.strength,
    });

    return belief;
  }

  /**
   * 强化信念（新证据加入）
   */
  strengthenBelief(
    beliefId: string,
    newEvidence: { source: BeliefSource; detail: string; weight: number }
  ): Belief {
    const belief = this.beliefs.get(beliefId);
    if (!belief) throw new Error(`信念 ${beliefId} 不存在`);

    const oldStrength = belief.strength;

    // 加入新来源
    belief.sources.push({
      type: newEvidence.source,
      detail: newEvidence.detail,
      weight: Math.min(1, newEvidence.weight),
    });

    // 重新计算强度（加权平均）
    const totalWeight = belief.sources.reduce((s, src) => s + src.weight, 0);
    belief.strength = belief.sources.reduce((s, src) => s + src.weight * src.weight, 0) / totalWeight;
    belief.strength = Math.max(0, Math.min(1, belief.strength));

    // 状态升级
    if (belief.strength > 0.8) {
      const oldStatus = belief.status;
      belief.status = 'strong';
      this.recordChange({
        beliefId, content: belief.content,
        type: 'strengthened',
        oldStrength, newStrength: belief.strength,
        reason: `新证据: ${newEvidence.detail}`,
        timestamp: Date.now(),
      });
    } else if (belief.strength > 0.4 && belief.status === 'forming') {
      belief.status = 'held';
      this.recordChange({
        beliefId, content: belief.content,
        type: 'confirmed',
        oldStrength, newStrength: belief.strength,
        reason: '证据积累达到确信阈值',
        timestamp: Date.now(),
      });
    } else {
      this.recordChange({
        beliefId, content: belief.content,
        type: 'strengthened',
        oldStrength, newStrength: belief.strength,
        reason: `新证据: ${newEvidence.detail}`,
        timestamp: Date.now(),
      });
    }

    belief.lastUpdated = Date.now();

    this.eventBus?.emit('belief:strengthened', {
      beliefId,
      content: belief.content,
      oldStrength,
      newStrength: belief.strength,
      source: newEvidence.source,
    });

    return belief;
  }

  /**
   * 用反面证据挑战信念
   */
  challengeBelief(beliefId: string, contradictoryFactId: string, challengeStrength: number): boolean {
    const belief = this.beliefs.get(beliefId);
    if (!belief) return false;

    const oldStrength = belief.strength;

    belief.contradictoryFacts.push(contradictoryFactId);

    // 反面证据削弱信念
    belief.strength = Math.max(0, belief.strength - challengeStrength * 0.3);
    belief.lastUpdated = Date.now();

    // 状态变化
    if (belief.strength < this.config.abandonmentThreshold) {
      const oldStatus = belief.status;
      belief.status = 'abandoned';
      this.recordChange({
        beliefId, content: belief.content,
        type: 'abandoned',
        oldStrength, newStrength: belief.strength,
        reason: '反面证据压倒性',
        timestamp: Date.now(),
      });
      this.eventBus?.emit('belief:abandoned', {
        beliefId,
        content: belief.content,
        oldStrength,
        newStrength: belief.strength,
      });
      return true;
    }

    if (belief.strength < 0.4 && belief.status !== 'weakening') {
      belief.status = 'weakening';
      this.recordChange({
        beliefId, content: belief.content,
        type: 'weakened',
        oldStrength, newStrength: belief.strength,
        reason: '受到反面证据挑战',
        timestamp: Date.now(),
      });
    }

    return true;
  }

  /**
   * 彻底推翻信念（有确凿证据）
   */
  refuteBelief(beliefId: string, refutationReason: string): boolean {
    const belief = this.beliefs.get(beliefId);
    if (!belief) return false;

    const oldStrength = belief.strength;
    belief.status = 'refuted';
    belief.strength = 0.05;
    belief.lastUpdated = Date.now();

    this.recordChange({
      beliefId, content: belief.content,
      type: 'refuted',
      oldStrength, newStrength: 0.05,
      reason: refutationReason,
      timestamp: Date.now(),
    });

    this.eventBus?.emit('belief:refuted', {
      beliefId,
      content: belief.content,
      reason: refutationReason,
    });

    return true;
  }

  // ============================================================
  // 信念与外部系统交互
  // ============================================================

  /**
   * 情绪影响信念（情绪一致性偏差）
   */
  applyEmotionalInfluence(emotions: Record<string, number>): void {
    for (const belief of this.beliefs.values()) {
      if (belief.status === 'abandoned' || belief.status === 'refuted') continue;

      // 检查情绪与信念内容的关联
      for (const [emotion, intensity] of Object.entries(emotions)) {
        if (intensity < 0.4) continue;

        // 情绪一致性：积极情绪强化积极信念，消极情绪强化消极信念
        const contentLower = belief.content.toLowerCase();
        const isNegativeBelief = contentLower.includes('危险') || contentLower.includes('不信任')
          || contentLower.includes('糟糕') || contentLower.includes('失败');
        const isPositiveBelief = contentLower.includes('信任') || contentLower.includes('安全')
          || contentLower.includes('希望') || contentLower.includes('成功');

        if (emotion === 'happy' && isPositiveBelief) {
          belief.strength = Math.min(1, belief.strength + this.config.emotionInfluenceWeight * intensity * 0.1);
        } else if (emotion === 'fearful' && isNegativeBelief) {
          belief.strength = Math.min(1, belief.strength + this.config.emotionInfluenceWeight * intensity * 0.1);
        } else if (emotion === 'sad' && isPositiveBelief) {
          belief.strength = Math.max(0, belief.strength - this.config.emotionInfluenceWeight * intensity * 0.05);
        } else if (emotion === 'angry' && isNegativeBelief) {
          belief.strength = Math.min(1, belief.strength + this.config.emotionInfluenceWeight * intensity * 0.1);
        }
      }
    }
  }

  /**
   * 获取信念驱动的情感反应
   */
  getEmotionalResponseToEvent(eventDescription: string): Array<{ emotion: string; intensity: number }> {
    const responses: Array<{ emotion: string; intensity: number }> = [];
    const lowerEvent = eventDescription.toLowerCase();

    for (const belief of this.getActiveBeliefs()) {
      const lowerBelief = belief.content.toLowerCase();

      // 检查事件是否与信念相关
      if (lowerEvent.includes(lowerBelief) || lowerBelief.includes(lowerEvent)) {
        // 信念被确认 → 安心/满足
        for (const ae of belief.associatedEmotions) {
          responses.push({
            emotion: ae.emotion,
            intensity: ae.intensity * belief.strength,
          });
        }

        // 信念被挑战 → 不安/防御
        if (belief.status === 'weakening') {
          responses.push({ emotion: 'anxious', intensity: belief.strength * 0.5 });
        }
      }
    }

    // 信念冲突检测
    const relevantBeliefs = this.getActiveBeliefs().filter(b =>
      lowerEvent.includes(b.content.toLowerCase())
    );
    for (let i = 0; i < relevantBeliefs.length; i++) {
      for (let j = i + 1; j < relevantBeliefs.length; j++) {
        if (this.beliefsConflict(relevantBeliefs[i], relevantBeliefs[j])) {
          responses.push({ emotion: 'confused', intensity: 0.6 });
        }
      }
    }

    return responses;
  }

  /**
   * 检查两个信念是否冲突
   */
  private beliefsConflict(a: Belief, b: Belief): boolean {
    const categories = ['self_perception', 'other_perception', 'relationship_belief'] as const;
    if (!categories.includes(a.category as any) || !categories.includes(b.category as any)) return false;

    // 简单冲突检测：关于同一对象但倾向相反
    const extractSubject = (content: string) => content.split(/[的我看他她它]/).pop()?.trim() ?? '';
    const subjectA = extractSubject(a.content);
    const subjectB = extractSubject(b.content);
    if (subjectA !== subjectB) return false;

    // 一个正面一个负面
    const positiveWords = ['信任', '喜欢', '好', '安全', '可靠'];
    const negativeWords = ['不信任', '讨厌', '坏', '危险', '不可靠'];
    const isPositiveA = positiveWords.some(w => a.content.includes(w));
    const isPositiveB = positiveWords.some(w => b.content.includes(w));
    const isNegativeA = negativeWords.some(w => a.content.includes(w));
    const isNegativeB = negativeWords.some(w => b.content.includes(w));

    return (isPositiveA && isNegativeB) || (isNegativeA && isPositiveB);
  }

  // ============================================================
  // 主 tick
  // ============================================================

  /**
   * 每 tick 调用：信念衰减、状态更新
   */
  tick(): void {
    for (const belief of this.beliefs.values()) {
      if (belief.status === 'abandoned' || belief.status === 'refuted') continue;

      // 自然衰减（但不衰减 strong 信念）
      if (belief.status !== 'strong') {
        belief.strength = Math.max(0, belief.strength - this.config.decayRate);
      }

      // 检查是否需要降级
      if (belief.strength < this.config.abandonmentThreshold && belief.status !== 'weakening') {
        belief.status = 'weakening';
      }

      if (belief.strength <= 0) {
        belief.status = 'abandoned';
      }
    }
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取所有活跃信念
   */
  getActiveBeliefs(category?: BeliefCategory): Belief[] {
    return Array.from(this.beliefs.values())
      .filter(b =>
        (b.status === 'held' || b.status === 'strong' || b.status === 'forming') &&
        (!category || b.category === category)
      )
      .sort((a, b) => b.strength - a.strength);
  }

  /**
   * 获取关于特定对象的信念
   */
  getBeliefsAbout(target: string): Belief[] {
    const lower = target.toLowerCase();
    return this.getActiveBeliefs().filter(b =>
      b.content.toLowerCase().includes(lower)
    );
  }

  /**
   * 获取特定类别的强信念
   */
  getStrongBeliefs(category?: BeliefCategory): Belief[] {
    return this.getActiveBeliefs(category).filter(b => b.status === 'strong');
  }

  /**
   * 获取正在削弱的信念（可能即将改变）
   */
  getWeakeningBeliefs(): Belief[] {
    return Array.from(this.beliefs.values())
      .filter(b => b.status === 'weakening')
      .sort((a, b) => a.strength - b.strength);
  }

  /**
   * 获取信念摘要（用于 Context Assembly 注入）
   */
  getBeliefSummary(): string {
    const strong = this.getStrongBeliefs();
    const active = this.getActiveBeliefs().filter(b => b.status === 'held');
    const weakening = this.getWeakeningBeliefs();

    const parts: string[] = [];

    if (strong.length > 0) {
      parts.push('## 你的核心信念');
      parts.push(...strong.map(b =>
        `- ${b.content} (深信不疑)`
      ));
    }

    if (active.length > 0) {
      parts.push('## 你的看法');
      parts.push(...active.slice(0, 5).map(b =>
        `- ${b.content}`
      ));
    }

    if (weakening.length > 0) {
      parts.push('## 你在动摇的信念');
      parts.push(...weakening.map(b =>
        `- ${b.content} (开始怀疑)`
      ));
    }

    return parts.join('\n\n');
  }

  /**
   * 获取特定类别信念的行为倾向
   */
  getBehavioralTendencies(category?: BeliefCategory): string[] {
    const tendencies: string[] = [];
    const beliefs = this.getActiveBeliefs(category);

    for (const belief of beliefs) {
      tendencies.push(...belief.behavioralTendencies);
    }

    return [...new Set(tendencies)];
  }

  /**
   * 检查信念一致性（是否有冲突信念）
   */
  checkConsistency(): Array<{ beliefA: string; beliefB: string; conflict: string }> {
    const conflicts: Array<{ beliefA: string; beliefB: string; conflict: string }> = [];
    const active = this.getActiveBeliefs();

    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        if (this.beliefsConflict(active[i], active[j])) {
          conflicts.push({
            beliefA: active[i].content,
            beliefB: active[j].content,
            conflict: `信念 "${active[i].content}" 与 "${active[j].content}" 相互矛盾`,
          });
        }
      }
    }

    return conflicts;
  }

  /**
   * 添加行为倾向到信念
   */
  addBehavioralTendency(beliefId: string, tendency: string): void {
    const belief = this.beliefs.get(beliefId);
    if (belief && !belief.behavioralTendencies.includes(tendency)) {
      belief.behavioralTendencies.push(tendency);
    }
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 按内容查找已有信念
   */
  private findBeliefByContent(content: string): Belief | undefined {
    const lower = content.toLowerCase();
    return Array.from(this.beliefs.values()).find(b =>
      b.content.toLowerCase() === lower
    );
  }

  /**
   * 限制信念数量
   */
  private trimToMax(): void {
    if (this.beliefs.size <= this.config.maxBeliefs) return;

    const sorted = Array.from(this.beliefs.values())
      .sort((a, b) => a.strength - b.strength);

    while (this.beliefs.size > this.config.maxBeliefs) {
      const toRemove = sorted.shift();
      if (toRemove) this.beliefs.delete(toRemove.id);
    }
  }

  /**
   * 记录变化
   */
  private recordChange(change: BeliefChange): void {
    this.changeHistory.push(change);
    if (this.changeHistory.length > this.MAX_HISTORY) {
      this.changeHistory.shift();
    }
  }

  // ============================================================
  // 调试/统计
  // ============================================================

  /**
   * 获取统计
   */
  getStats(): BeliefSystemStats {
    const all = Array.from(this.beliefs.values());
    return {
      totalBeliefs: all.length,
      byStatus: {
        forming: all.filter(b => b.status === 'forming').length,
        held: all.filter(b => b.status === 'held').length,
        strong: all.filter(b => b.status === 'strong').length,
        weakening: all.filter(b => b.status === 'weakening').length,
        refuted: all.filter(b => b.status === 'refuted').length,
        abandoned: all.filter(b => b.status === 'abandoned').length,
      },
      byCategory: Object.fromEntries(
        ['self_perception', 'other_perception', 'world_view', 'relationship_belief',
         'causal_belief', 'value_judgment', 'prediction'] as BeliefCategory[]
          .map(c => [c, all.filter(b => b.category === c).length])
      ) as Record<string, number>,
      averageStrength: all.length > 0
        ? all.filter(b => b.status !== 'abandoned' && b.status !== 'refuted')
            .reduce((s, b) => s + b.strength, 0) /
          all.filter(b => b.status !== 'abandoned' && b.status !== 'refuted').length
        : 0,
      conflictCount: this.checkConsistency().length,
      changeCount: this.changeHistory.length,
    };
  }

  /**
   * 重置
   */
  reset(): void {
    this.beliefs.clear();
    this.changeHistory = [];
  }
}

export interface BeliefSystemStats {
  totalBeliefs: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  averageStrength: number;
  conflictCount: number;
  changeCount: number;
}

export default BeliefSystem;
