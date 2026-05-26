/**
 * knowledge-boundary.ts — 知识边界系统
 *
 * 核心职责：Context Assembly 只组装 Agent 已知和可感知的信息，
 * 禁止直接注入全局世界知识。
 *
 * 知识边界原则：
 * 1. Agent 只能知道：
 *    - 自己亲眼看到的（感知过）
 *    - 自己经历过的（记忆）
 *    - 别人告诉自己的（沟通/谣言）
 *    - 自己推断出来的（推理）
 *    - 自己记住的（记忆回忆）
 * 2. 禁止：
 *    - 直接注入全局世界状态
 *    - 注入 Agent 不知道的事件
 *    - 注入 Agent 未访问过的地点详情
 *    - 注入其他 Agent 的私密信息
 *
 * 整合：
 * - Context Assembly：替代原有的 CollectStage 中的全局信息收集
 * - AwarenessRuntime：提供 Agent 的认知空间
 * - PerceptionFilter：提供当前感知
 * - BeliefSystem：提供信念
 * - Memory Runtime：提供记忆
 */

import type { AwarenessRuntime, AwarenessFact } from './awareness-runtime';
import type { BeliefSystem, Belief } from './belief-system';
import type { PerceivedWorldState } from './perception-filter';
import type { EventBus } from '../events/event-bus';

// ============================================================
// 知识边界输出
// ============================================================

export interface BoundedKnowledge {
  /** Agent 确认知道的事实 */
  knownFacts: Array<{
    content: string;
    confidence: number;
    category: string;
  }>;
  /** Agent 当前感知到的世界状态 */
  currentPerception: {
    time: string;
    weather: string;
    location: string;
    occupants: string[];
    events: Array<{ name: string; description: string; confidence: number }>;
    nearbyAgents: Array<{ name: string; perceivedEmotion: string; accuracy: number }>;
  };
  /** Agent 活跃信念 */
  activeBeliefs: Array<{
    content: string;
    strength: number;
    category: string;
  }>;
  /** Agent 怀疑的事项 */
  uncertainties: Array<{
    content: string;
    confidence: number;
  }>;
  /** Agent 的记忆摘要 */
  memorySummary: string;
  /** 需要保密的信息（Agent 不会主动说出的） */
  privateKnowledge: string[];
}

// ============================================================
// KnowledgeBoundary 配置
// ============================================================

export interface KnowledgeBoundaryConfig {
  /** 注入的最大已知事实数 */
  maxKnownFacts: number;
  /** 注入的最大信念数 */
  maxBeliefs: number;
  /** 是否注入不确定性 */
  includeUncertainties: boolean;
  /** 是否注入私密信息（只在内部使用，不暴露给其他 Agent） */
  trackPrivateKnowledge: boolean;
  /** 感知信息的最低置信度阈值 */
  minPerceptionConfidence: number;
}

const DEFAULT_KNOWLEDGE_BOUNDARY_CONFIG: KnowledgeBoundaryConfig = {
  maxKnownFacts: 15,
  maxBeliefs: 5,
  includeUncertainties: true,
  trackPrivateKnowledge: true,
  minPerceptionConfidence: 0.3,
};

// ============================================================
// KnowledgeBoundary 实现
// ============================================================

export class KnowledgeBoundary {
  private config: KnowledgeBoundaryConfig;
  private eventBus: EventBus | null;

  constructor(config?: Partial<KnowledgeBoundaryConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_KNOWLEDGE_BOUNDARY_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  /**
   * 构建 Agent 的知识边界上下文（供 Context Assembly 使用）
   * 替代原 CollectStage 中的全局世界状态注入
   */
  buildBoundedContext(
    agentId: string,
    awareness: AwarenessRuntime,
    beliefSystem: BeliefSystem,
    perception: PerceivedWorldState | null,
    memorySummary: string
  ): BoundedKnowledge {
    // 1. 已知事实（从 Awareness 中获取）
    const knownFacts = this.extractKnownFacts(awareness);

    // 2. 当前感知
    const currentPerception = this.buildPerceptionSection(perception, agentId);

    // 3. 信念
    const activeBeliefs = this.extractBeliefs(beliefSystem);

    // 4. 不确定性
    const uncertainties = this.config.includeUncertainties
      ? this.extractUncertainties(awareness)
      : [];

    // 5. 私密信息
    const privateKnowledge = this.config.trackPrivateKnowledge
      ? this.extractPrivateKnowledge(agentId, awareness, beliefSystem)
      : [];

    this.eventBus?.emit('knowledge_boundary:built', {
      agentId,
      factCount: knownFacts.length,
      beliefCount: activeBeliefs.length,
      perceptionAvailable: !!perception,
    });

    return {
      knownFacts,
      currentPerception,
      activeBeliefs,
      uncertainties,
      memorySummary,
      privateKnowledge,
    };
  }

  /**
   * 提取已知事实
   */
  private extractKnownFacts(awareness: AwarenessRuntime): BoundedKnowledge['knownFacts'] {
    const known = awareness.getKnownFacts();
    return known
      .slice(0, this.config.maxKnownFacts)
      .map(f => ({
        content: f.content,
        confidence: f.confidence,
        category: f.category,
      }));
  }

  /**
   * 构建感知部分
   */
  private buildPerceptionSection(
    perception: PerceivedWorldState | null,
    agentId: string
  ): BoundedKnowledge['currentPerception'] {
    if (!perception) {
      return {
        time: '未知',
        weather: '未知',
        location: '未知',
        occupants: [],
        events: [],
        nearbyAgents: [],
      };
    }

    // 过滤低置信度事件
    const events = perception.perceivedEvents
      .filter(e => e.confidence >= this.config.minPerceptionConfidence)
      .map(e => ({
        name: e.name,
        description: e.description,
        confidence: e.confidence,
      }));

    // 提取当前位置的 occupants
    const currentLocation = perception.knownLocations.find(l => l.confidence > 0.5);
    const occupants = currentLocation?.knownOccupants ?? [];

    // 附近 Agent
    const nearbyAgents = perception.perceivedAgents.map(a => ({
      name: a.name,
      perceivedEmotion: a.perceivedEmotion,
      accuracy: a.accuracy,
    }));

    return {
      time: perception.perceivedTime,
      weather: perception.perceivedWeather,
      location: currentLocation?.name ?? '未知',
      occupants,
      events,
      nearbyAgents,
    };
  }

  /**
   * 提取信念
   */
  private extractBeliefs(beliefSystem: BeliefSystem): BoundedKnowledge['activeBeliefs'] {
    const beliefs = beliefSystem.getActiveBeliefs();
    return beliefs
      .slice(0, this.config.maxBeliefs)
      .map(b => ({
        content: b.content,
        strength: b.strength,
        category: b.category,
      }));
  }

  /**
   * 提取不确定性
   */
  private extractUncertainties(awareness: AwarenessRuntime): BoundedKnowledge['uncertainties'] {
    const suspected = awareness.getSuspectedFacts();
    return suspected.slice(0, 5).map(f => ({
      content: f.content,
      confidence: f.confidence,
    }));
  }

  /**
   * 提取私密信息（Agent 不会主动分享的）
   */
  private extractPrivateKnowledge(
    agentId: string,
    awareness: AwarenessRuntime,
    beliefSystem: BeliefSystem
  ): string[] {
    const privateItems: string[] = [];

    // 关于自己的负面信念
    const selfBeliefs = beliefSystem.getBeliefsAbout(agentId);
    for (const belief of selfBeliefs) {
      if (belief.category === 'self_perception' && belief.strength > 0.6) {
        // 如果有羞愧/不安关联，视为私密
        const hasNegativeEmotion = belief.associatedEmotions.some(
          ae => ae.emotion === 'ashamed' || ae.emotion === 'anxious'
        );
        if (hasNegativeEmotion) {
          privateItems.push(belief.content);
        }
      }
    }

    // 隐藏意图相关的事实
    const secrets = awareness.getKnownFacts('secret');
    privateItems.push(...secrets.map(s => s.content));

    return privateItems;
  }

  /**
   * 生成 LLM 上下文用的字符串
   * 这个方法生成实际注入 prompt 的文本
   */
  toContextString(bounded: BoundedKnowledge): string {
    const parts: string[] = [];

    // === 当前感知 ===
    parts.push('## 你当前的感知');
    parts.push(`时间: ${bounded.currentPerception.time}`);
    parts.push(`天气: ${bounded.currentPerception.weather}`);
    parts.push(`你在: ${bounded.currentPerception.location}`);

    if (bounded.currentPerception.occupants.length > 0) {
      parts.push(`在场的人: ${bounded.currentPerception.occupants.join('、')}`);
    }

    if (bounded.currentPerception.events.length > 0) {
      parts.push('你注意到:');
      for (const event of bounded.currentPerception.events) {
        const confidenceMark = event.confidence > 0.7 ? '' : ' (不太确定)';
        parts.push(`- ${event.description}${confidenceMark}`);
      }
    }

    if (bounded.currentPerception.nearbyAgents.length > 0) {
      parts.push('你观察到的其他人:');
      for (const agent of bounded.currentPerception.nearbyAgents) {
        const accuracyNote = agent.accuracy < 0.5 ? ' (看不太清)' : '';
        parts.push(`- ${agent.name}看起来${agent.perceivedEmotion}${accuracyNote}`);
      }
    }

    // === 已知事实 ===
    if (bounded.knownFacts.length > 0) {
      parts.push('');
      parts.push('## 你知道的事');
      for (const fact of bounded.knownFacts) {
        const confidenceNote = fact.confidence < 0.8 ? ' (不完全确定)' : '';
        parts.push(`- ${fact.content}${confidenceNote}`);
      }
    }

    // === 信念 ===
    if (bounded.activeBeliefs.length > 0) {
      parts.push('');
      parts.push('## 你的看法');
      for (const belief of bounded.activeBeliefs) {
        parts.push(`- ${belief.content}`);
      }
    }

    // === 不确定性 ===
    if (bounded.uncertainties.length > 0) {
      parts.push('');
      parts.push('## 你不确定的事');
      for (const uncertainty of bounded.uncertainties) {
        parts.push(`- ${uncertainty.content} (可能性: ${(uncertainty.confidence * 100).toFixed(0)}%)`);
      }
    }

    // === 记忆 ===
    if (bounded.memorySummary) {
      parts.push('');
      parts.push('## 你的记忆');
      parts.push(bounded.memorySummary);
    }

    return parts.join('\n');
  }
}

export default KnowledgeBoundary;
