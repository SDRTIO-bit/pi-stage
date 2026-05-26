/**
 * awareness-runtime.ts — 认知运行时
 *
 * 每个 Agent 维护自己的认知空间（Awareness Space），包含：
 * - known facts（已知事实）：Agent 确信为真的信息
 * - suspected facts（怀疑事实）：Agent 认为可能为真的信息
 * - forgotten facts（遗忘事实）：曾经知道但已遗忘的信息
 * - misunderstood facts（误解事实）：Agent 理解错误的信息
 * - hidden facts（隐藏事实）：存在于世界中但 Agent 不知道的信息
 *
 * 每个认知条目都带有置信度（confidence level），
 * 并且会随时间、新证据、关系信任度动态变化。
 *
 * 整合：
 * - PerceptionFilter：新感知到的信息进入 Awareness
 * - Memory Runtime：Awareness 中的信息可被编码进长期记忆
 * - Goal Runtime：未知信息可以驱动探索目标
 * - Context Assembly：只组装 Awareness 中存在的信息
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 认知条目类型
// ============================================================

export type FactStatus = 'known' | 'suspected' | 'forgotten' | 'misunderstood' | 'hidden';

export interface AwarenessFact {
  id: string;
  /** 事实内容描述 */
  content: string;
  /** 事实类别 */
  category: 'event' | 'location' | 'agent' | 'relation' | 'world_state' | 'knowledge' | 'secret';
  /** 认知状态 */
  status: FactStatus;
  /** 置信度 0-1（1=完全确信） */
  confidence: number;
  /** 信息来源 */
  source: 'direct_observation' | 'communication' | 'inference' | 'memory_recall' | 'third_party';
  /** 信息来源 Agent ID（如果是通过他人得知） */
  sourceAgentId?: string;
  /** 原始事实（如果被误解，存储正确的版本） */
  groundTruth?: string;
  /** 误解说明（如果被误解） */
  misunderstanding?: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后更新时间 */
  lastUpdated: number;
  /** 访问次数（用于衰减计算） */
  accessCount: number;
  /** 关联的标签 */
  tags: string[];
  /** 情感效价关联 (-1 ~ 1) */
  emotionalValence: number;
}

// ============================================================
// 认知更新事件
// ============================================================

export interface AwarenessUpdate {
  type: 'new_fact' | 'confidence_change' | 'status_change' | 'correction' | 'forgetting';
  factId: string;
  content: string;
  oldConfidence?: number;
  newConfidence?: number;
  oldStatus?: FactStatus;
  newStatus?: FactStatus;
  timestamp: number;
}

// ============================================================
// AwarenessRuntime 配置
// ============================================================

export interface AwarenessRuntimeConfig {
  /** 最大认知条目数 */
  maxFacts: number;
  /** 遗忘阈值（低于此置信度的 known 变为 forgotten） */
  forgettingThreshold: number;
  /** 置信度日衰减率 */
  confidenceDecayRate: number;
  /** 怀疑升级为已知所需的置信度 */
  suspectToKnownThreshold: number;
  /** 信任对信息置信度的影响权重 */
  trustImpactOnConfidence: number;
  /** 误解修正所需的证据强度 */
  correctionEvidenceThreshold: number;
}

const DEFAULT_AWARENESS_CONFIG: AwarenessRuntimeConfig = {
  maxFacts: 200,
  forgettingThreshold: 0.15,
  confidenceDecayRate: 0.02,
  suspectToKnownThreshold: 0.7,
  trustImpactOnConfidence: 0.3,
  correctionEvidenceThreshold: 0.6,
};

// ============================================================
// AwarenessRuntime 实现
// ============================================================

export class AwarenessRuntime {
  private facts: Map<string, AwarenessFact> = new Map();
  private config: AwarenessRuntimeConfig;
  private eventBus: EventBus | null;

  /** 更新历史（用于调试回溯） */
  private updateHistory: AwarenessUpdate[] = [];
  private readonly MAX_HISTORY = 500;

  constructor(config?: Partial<AwarenessRuntimeConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_AWARENESS_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 核心接口：信息摄入
  // ============================================================

  /**
   * 摄入新感知到的信息（由 PerceptionFilter 调用）
   */
  ingestPerception(
    content: string,
    category: AwarenessFact['category'],
    confidence: number,
    source: AwarenessFact['source'],
    sourceAgentId?: string,
    tags?: string[],
    emotionalValence?: number
  ): AwarenessFact {
    // 检查是否已存在相同内容
    const existing = this.findFactByContent(content);
    if (existing) {
      // 更新现有事实的置信度
      return this.updateConfidence(existing.id, confidence, source);
    }

    const fact: AwarenessFact = {
      id: `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      category,
      status: confidence >= this.config.suspectToKnownThreshold ? 'known' : 'suspected',
      confidence: Math.max(0, Math.min(1, confidence)),
      source,
      sourceAgentId,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      accessCount: 0,
      tags: tags ?? [],
      emotionalValence: emotionalValence ?? 0,
    };

    this.facts.set(fact.id, fact);
    this.trimToMax();

    this.recordUpdate({
      type: 'new_fact',
      factId: fact.id,
      content,
      newConfidence: fact.confidence,
      newStatus: fact.status,
      timestamp: Date.now(),
    });

    this.eventBus?.emit('awareness:new_fact', {
      factId: fact.id,
      content,
      category,
      confidence: fact.confidence,
      status: fact.status,
      source,
    });

    return fact;
  }

  /**
   * 摄入来自他人沟通的信息（受信任度调制）
   */
  ingestCommunication(
    content: string,
    category: AwarenessFact['category'],
    speakerId: string,
    speakerTrust: number,
    tags?: string[]
  ): AwarenessFact {
    // 信任度影响信息置信度
    const trustModulatedConfidence = 0.3 + speakerTrust * 0.5;

    return this.ingestPerception(
      content,
      category,
      trustModulatedConfidence,
      'communication',
      speakerId,
      tags,
    );
  }

  /**
   * 通过推理获得信息
   */
  ingestInference(content: string, category: AwarenessFact['category'], confidence: number): AwarenessFact {
    return this.ingestPerception(
      content,
      category,
      confidence * 0.7, // 推理的置信度天生打折扣
      'inference',
    );
  }

  /**
   * 记录误解（Agent 对某事理解错误）
   */
  recordMisunderstanding(
    content: string,
    groundTruth: string,
    misunderstanding: string,
    category: AwarenessFact['category']
  ): AwarenessFact {
    const fact: AwarenessFact = {
      id: `fact_mis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      category,
      status: 'misunderstood',
      confidence: 0.8, // Agent 通常对自己的误解很有信心
      source: 'inference',
      groundTruth,
      misunderstanding,
      createdAt: Date.now(),
      lastUpdated: Date.now(),
      accessCount: 0,
      tags: ['misunderstanding'],
      emotionalValence: 0,
    };

    this.facts.set(fact.id, fact);
    this.trimToMax();

    this.eventBus?.emit('awareness:misunderstanding', {
      factId: fact.id,
      content,
      groundTruth,
      misunderstanding,
    });

    return fact;
  }

  // ============================================================
  // 置信度与状态管理
  // ============================================================

  /**
   * 更新事实置信度
   */
  updateConfidence(factId: string, newConfidence: number, source?: AwarenessFact['source']): AwarenessFact {
    const fact = this.facts.get(factId);
    if (!fact) throw new Error(`事实 ${factId} 不存在`);

    const oldConfidence = fact.confidence;
    // 加权平均：新证据与旧信念
    const sourceWeight = source === 'direct_observation' ? 0.7
      : source === 'communication' ? 0.4
      : source === 'inference' ? 0.3
      : 0.5;

    fact.confidence = oldConfidence * (1 - sourceWeight) + newConfidence * sourceWeight;
    fact.lastUpdated = Date.now();

    // 状态迁移
    const oldStatus = fact.status;
    if (fact.confidence >= this.config.suspectToKnownThreshold) {
      fact.status = 'known';
    } else if (fact.confidence > this.config.forgettingThreshold) {
      fact.status = 'suspected';
    } else {
      fact.status = 'forgotten';
    }

    this.recordUpdate({
      type: 'confidence_change',
      factId,
      content: fact.content,
      oldConfidence,
      newConfidence: fact.confidence,
      oldStatus,
      newStatus: fact.status,
      timestamp: Date.now(),
    });

    return fact;
  }

  /**
   * 纠正误解（当 Agent 获得足够证据时）
   */
  correctMisunderstanding(factId: string, evidenceStrength: number): boolean {
    const fact = this.facts.get(factId);
    if (!fact || fact.status !== 'misunderstood') return false;

    if (evidenceStrength >= this.config.correctionEvidenceThreshold) {
      // 纠正：用 groundTruth 替换
      if (fact.groundTruth) {
        const correctedFact = this.ingestPerception(
          fact.groundTruth,
          fact.category,
          evidenceStrength,
          'direct_observation',
        );

        // 标记旧误解
        fact.status = 'forgotten';
        fact.confidence = 0;

        this.recordUpdate({
          type: 'correction',
          factId,
          content: fact.content,
          oldStatus: 'misunderstood',
          newStatus: 'forgotten',
          timestamp: Date.now(),
        });

        this.eventBus?.emit('awareness:corrected', {
          oldFactId: factId,
          newFactId: correctedFact.id,
          correctedContent: fact.groundTruth,
        });

        return true;
      }
    }

    return false;
  }

  // ============================================================
  // 主 tick
  // ============================================================

  /**
   * 每 tick 调用：置信度衰减、遗忘处理
   */
  tick(): void {
    const toForget: string[] = [];

    for (const [id, fact] of this.facts) {
      if (fact.status === 'forgotten' || fact.status === 'hidden') continue;

      // 根据访问次数决定衰减速率（常被回忆的信息衰减慢）
      const accessBonus = Math.min(0.5, fact.accessCount * 0.01);
      const decay = this.config.confidenceDecayRate * (1 - accessBonus);

      if (decay > 0 && fact.confidence > 0) {
        fact.confidence = Math.max(0, fact.confidence - decay);
        fact.lastUpdated = Date.now();
      }

      // 检查遗忘
      if (fact.confidence <= this.config.forgettingThreshold && fact.status === 'known') {
        const oldStatus = fact.status;
        fact.status = 'forgotten';
        toForget.push(id);

        this.recordUpdate({
          type: 'forgetting',
          factId: id,
          content: fact.content,
          oldStatus,
          newStatus: 'forgotten',
          timestamp: Date.now(),
        });

        this.eventBus?.emit('awareness:forgotten', {
          factId: id,
          content: fact.content,
        });
      }
    }
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取所有已知事实（置信度最高的）
   */
  getKnownFacts(category?: AwarenessFact['category']): AwarenessFact[] {
    return Array.from(this.facts.values())
      .filter(f => f.status === 'known' && (!category || f.category === category))
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 获取怀疑中的事实
   */
  getSuspectedFacts(): AwarenessFact[] {
    return Array.from(this.facts.values())
      .filter(f => f.status === 'suspected')
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 获取误解列表
   */
  getMisunderstandings(): AwarenessFact[] {
    return Array.from(this.facts.values())
      .filter(f => f.status === 'misunderstood');
  }

  /**
   * 获取遗忘但可被回忆的事实
   */
  getForgottenFacts(): AwarenessFact[] {
    return Array.from(this.facts.values())
      .filter(f => f.status === 'forgotten')
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 按内容搜索事实
   */
  searchFacts(query: string, minConfidence?: number): AwarenessFact[] {
    const lower = query.toLowerCase();
    return Array.from(this.facts.values())
      .filter(f => {
        if (minConfidence !== undefined && f.confidence < minConfidence) return false;
        return (
          f.content.toLowerCase().includes(lower) ||
          (f.misunderstanding?.toLowerCase().includes(lower)) ||
          f.tags.some(t => t.toLowerCase().includes(lower))
        );
      })
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 获取关于某个 agent 的已知信息
   */
  getFactsAboutAgent(agentId: string): AwarenessFact[] {
    return Array.from(this.facts.values())
      .filter(f =>
        f.category === 'agent' &&
        (f.content.toLowerCase().includes(agentId.toLowerCase()) ||
         f.tags.includes(agentId))
      )
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 获取特定地点的事实
   */
  getFactsAboutLocation(locationId: string): AwarenessFact[] {
    return Array.from(this.facts.values())
      .filter(f =>
        f.category === 'location' &&
        (f.content.toLowerCase().includes(locationId.toLowerCase()) ||
         f.tags.includes(locationId))
      );
  }

  /**
   * 检查 Agent 是否知道某条信息
   */
  knows(content: string, minConfidence?: number): boolean {
    const fact = this.findFactByContent(content);
    if (!fact) return false;
    if (fact.status === 'forgotten') return false;
    if (minConfidence !== undefined && fact.confidence < minConfidence) return false;
    return fact.status === 'known' || fact.status === 'suspected';
  }

  /**
   * 获取关于某事的置信度
   */
  getConfidence(content: string): number {
    const fact = this.findFactByContent(content);
    return fact?.confidence ?? 0;
  }

  /**
   * 获取认知摘要（用于 Context Assembly）
   */
  getAwarenessSummary(): string {
    const known = this.getKnownFacts();
    const suspected = this.getSuspectedFacts();
    const misunderstood = this.getMisunderstandings();

    const parts: string[] = [];

    if (known.length > 0) {
      parts.push('## 你知道的事实');
      parts.push(...known.slice(0, 10).map(f =>
        `- ${f.content} (确信度: ${(f.confidence * 100).toFixed(0)}%)`
      ));
    }

    if (suspected.length > 0) {
      parts.push('## 你怀疑的事');
      parts.push(...suspected.slice(0, 5).map(f =>
        `- ${f.content} (可能性: ${(f.confidence * 100).toFixed(0)}%)`
      ));
    }

    if (misunderstood.length > 0) {
      parts.push('## 你可能搞错的事');
      parts.push(...misunderstood.slice(0, 3).map(f =>
        `- 你认为: ${f.content}`
      ));
    }

    return parts.join('\n\n');
  }

  /**
   * 获取认知差距（Agent 不知道但重要的事）
   * 由外部系统标记重要事实后调用
   */
  getKnowledgeGaps(importantTopics: string[]): Array<{ topic: string; isKnown: boolean; confidence: number }> {
    return importantTopics.map(topic => {
      const fact = this.findFactByContent(topic);
      return {
        topic,
        isKnown: !!fact && fact.status === 'known',
        confidence: fact?.confidence ?? 0,
      };
    }).filter(gap => !gap.isKnown || gap.confidence < 0.5);
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 按内容查找已有事实（模糊匹配）
   */
  private findFactByContent(content: string): AwarenessFact | undefined {
    const lower = content.toLowerCase();
    return Array.from(this.facts.values()).find(f =>
      f.content.toLowerCase().includes(lower) ||
      lower.includes(f.content.toLowerCase())
    );
  }

  /**
   * 限制事实数量
   */
  private trimToMax(): void {
    if (this.facts.size <= this.config.maxFacts) return;

    // 移除遗忘的和置信度最低的
    const sorted = Array.from(this.facts.values())
      .sort((a, b) => {
        // 遗忘的优先移除
        if (a.status === 'forgotten' && b.status !== 'forgotten') return -1;
        if (b.status === 'forgotten' && a.status !== 'forgotten') return 1;
        // 再按置信度
        return a.confidence - b.confidence;
      });

    while (this.facts.size > this.config.maxFacts) {
      const toRemove = sorted.shift();
      if (toRemove) {
        this.facts.delete(toRemove.id);
      } else {
        break;
      }
    }
  }

  /**
   * 记录更新
   */
  private recordUpdate(update: AwarenessUpdate): void {
    this.updateHistory.push(update);
    if (this.updateHistory.length > this.MAX_HISTORY) {
      this.updateHistory.shift();
    }
  }

  // ============================================================
  // 调试/统计
  // ============================================================

  /**
   * 获取统计
   */
  getStats(): AwarenessRuntimeStats {
    const all = Array.from(this.facts.values());
    return {
      totalFacts: all.length,
      byStatus: {
        known: all.filter(f => f.status === 'known').length,
        suspected: all.filter(f => f.status === 'suspected').length,
        forgotten: all.filter(f => f.status === 'forgotten').length,
        misunderstood: all.filter(f => f.status === 'misunderstood').length,
        hidden: all.filter(f => f.status === 'hidden').length,
      },
      byCategory: {
        event: all.filter(f => f.category === 'event').length,
        location: all.filter(f => f.category === 'location').length,
        agent: all.filter(f => f.category === 'agent').length,
        relation: all.filter(f => f.category === 'relation').length,
        world_state: all.filter(f => f.category === 'world_state').length,
        knowledge: all.filter(f => f.category === 'knowledge').length,
        secret: all.filter(f => f.category === 'secret').length,
      },
      averageConfidence: all.length > 0
        ? all.reduce((s, f) => s + f.confidence, 0) / all.length
        : 0,
      updateCount: this.updateHistory.length,
    };
  }

  /**
   * 更新历史（用于调试回溯）
   */
  getUpdateHistory(limit?: number): AwarenessUpdate[] {
    const history = [...this.updateHistory].reverse();
    return limit ? history.slice(0, limit) : history;
  }

  /**
   * 重置
   */
  reset(): void {
    this.facts.clear();
    this.updateHistory = [];
  }
}

export interface AwarenessRuntimeStats {
  totalFacts: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  averageConfidence: number;
  updateCount: number;
}

export default AwarenessRuntime;
