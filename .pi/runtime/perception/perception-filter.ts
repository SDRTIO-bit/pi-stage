/**
 * perception-filter.ts — 感知过滤器
 *
 * 核心哲学：世界状态 ≠ Agent 认知
 *
 * 所有世界信息必须先经过 Perception Filter 再进入 Agent。
 * 不同 Agent 对同一事件的感知不同。
 *
 * 过滤维度：
 * - line of sight（视线）：Agent 只能感知到视野内的信息
 * - location awareness（位置感知）：不在同一地点的事件不可感知
 * - relation-based sharing（关系共享）：只有有关系的人物才会传递信息
 * - event visibility（事件可见性）：并非所有事件都公开可见
 * - emotional perception bias（情绪感知偏差）：情绪扭曲感知
 * - attention-based filtering（注意力过滤）：注意力焦点外的信息被弱化
 * - memory-based filtering（记忆过滤）：遗忘、错误记忆影响感知
 *
 * 整合：
 * - Attention Runtime：注意力焦点增强特定信息的感知
 * - WorldState：提供原始世界状态
 * - AgentRuntimeState：提供 Agent 位置、情绪、关系等信息
 * - Memory Runtime：已遗忘的记忆不可感知
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 感知上下文
// ============================================================

export interface PerceptionContext {
  /** Agent ID */
  agentId: string;
  /** Agent 当前位置 ID */
  agentLocation: string;
  /** Agent 当前位置的 occupants（世界状态提供） */
  locationOccupants: string[];
  /** Agent 的情绪状态 */
  emotions: Record<string, number>;
  /** Agent 当前注意力焦点实体 */
  attentionFocus: string[];
  /** Agent 拥有的关系摘要 */
  relations: Array<{ characterId: string; value: number; trust: number }>;
  /** Agent 各感知能力（0-1），受生理/精神状态影响 */
  sensoryCapabilities: SensoryCapabilities;
  /** Agent 是否处于隐藏/潜行状态 */
  isStealthed: boolean;
}

export interface SensoryCapabilities {
  /** 视觉敏锐度 */
  sight: number;
  /** 听觉敏锐度 */
  hearing: number;
  /** 嗅觉敏锐度 */
  smell: number;
  /** 直觉敏锐度 */
  intuition: number;
  /** 社交感知（察言观色） */
  socialPerception: number;
}

// ============================================================
// 感知结果
// ============================================================

export interface PerceivedEvent {
  /** 原始事件 ID */
  rawEventId: string;
  /** 事件名称（Agent 感知到的版本） */
  name: string;
  /** 事件描述（Agent 感知到的版本，可能有偏差） */
  description: string;
  /** 感知置信度 0-1 */
  confidence: number;
  /** 感知到的类型 */
  perceivedType: string;
  /** 感知偏差说明 */
  biases: string[];
  /** 是否需要进一步验证 */
  requiresVerification: boolean;
  /** 感知时间 */
  perceivedAt: number;
}

export interface PerceivedLocation {
  /** 地点 ID */
  locationId: string;
  /** 地点名称 */
  name: string;
  /** Agent 感知到的描述 */
  description: string;
  /** Agent 知道的 occupants（可能不全） */
  knownOccupants: string[];
  /** 描述置信度 */
  confidence: number;
  /** 未知的 occupants（Agent 不知道他们在） */
  unknownOccupants: string[];
  /** 该地点是否有被隐藏的信息 */
  hasHiddenInfo: boolean;
}

export interface PerceivedAgent {
  /** 被感知的 Agent ID */
  agentId: string;
  /** 感知到的名称 */
  name: string;
  /** 感知到的位置（可能不精确） */
  perceivedLocation: string;
  /** 感知到的情绪（基于观察的推断） */
  perceivedEmotion: string;
  /** 感知精度 0-1 */
  accuracy: number;
  /** 是否被识别出真实身份 */
  identityConfirmed: boolean;
  /** 对方是否也在观察自己 */
  mutualAwareness: boolean;
}

export interface PerceivedWorldState {
  /** Agent 感知到的时间 */
  perceivedTime: string;
  /** Agent 感知到的天气 */
  perceivedWeather: string;
  /** Agent 感知到的事件列表 */
  perceivedEvents: PerceivedEvent[];
  /** Agent 已知的地点信息 */
  knownLocations: PerceivedLocation[];
  /** Agent 当前能感知到的其他人 */
  perceivedAgents: PerceivedAgent[];
  /** 整体感知可靠性 0-1 */
  overallReliability: number;
}

// ============================================================
// 感知过滤器配置
// ============================================================

export interface PerceptionFilterConfig {
  /** 视线最大距离（地点连接数） */
  maxSightDistance: number;
  /** 听觉最大距离 */
  maxHearingDistance: number;
  /** 情绪对感知的扭曲强度 0-1 */
  emotionalBiasStrength: number;
  /** 注意力对感知的增益强度 0-1 */
  attentionBoostStrength: number;
  /** 关系信任对信息可信度的影响 0-1 */
  trustImpactOnPerception: number;
  /** 是否启用潜行检测 */
  enableStealthDetection: boolean;
}

const DEFAULT_PERCEPTION_CONFIG: PerceptionFilterConfig = {
  maxSightDistance: 2,
  maxHearingDistance: 1,
  emotionalBiasStrength: 0.3,
  attentionBoostStrength: 0.4,
  trustImpactOnPerception: 0.5,
  enableStealthDetection: true,
};

// ============================================================
// PerceptionFilter 实现
// ============================================================

export class PerceptionFilter {
  private config: PerceptionFilterConfig;
  private eventBus: EventBus | null;

  constructor(config?: Partial<PerceptionFilterConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_PERCEPTION_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 核心过滤入口
  // ============================================================

  /**
   * 对原始世界状态执行感知过滤，返回 Agent 感知到的版本
   */
  filterWorld(
    rawWorld: RawWorldInput,
    context: PerceptionContext,
    locationConnections: Map<string, string[]>
  ): PerceivedWorldState {
    // 1. 过滤事件
    const perceivedEvents = this.filterEvents(rawWorld.events, context, locationConnections);

    // 2. 过滤地点信息
    const knownLocations = this.filterLocations(rawWorld.locations, context, locationConnections);

    // 3. 过滤其他 Agent
    const perceivedAgents = this.filterAgents(rawWorld.agents, context, locationConnections);

    // 4. 感知环境（带情绪偏差）
    const perceivedTime = this.applyTimePerception(rawWorld.time, context);
    const perceivedWeather = this.applyWeatherPerception(rawWorld.weather, context);

    // 5. 计算整体可靠性
    const overallReliability = this.computeOverallReliability(perceivedEvents, perceivedAgents, context);

    this.eventBus?.emit('perception:filtered', {
      agentId: context.agentId,
      rawEventCount: rawWorld.events.length,
      perceivedEventCount: perceivedEvents.length,
      rawAgentCount: rawWorld.agents.length,
      perceivedAgentCount: perceivedAgents.length,
      overallReliability,
    });

    return {
      perceivedTime,
      perceivedWeather,
      perceivedEvents,
      knownLocations,
      perceivedAgents,
      overallReliability,
    };
  }

  // ============================================================
  // 事件过滤
  // ============================================================

  /**
   * 过滤事件：基于视线、位置、事件可见性、注意力
   */
  private filterEvents(
    rawEvents: RawEvent[],
    context: PerceptionContext,
    locationConnections: Map<string, string[]>
  ): PerceivedEvent[] {
    const result: PerceivedEvent[] = [];

    for (const event of rawEvents) {
      // 1. 检查事件可见性（有些事件天然不可见）
      if (event.visibility === 'secret') continue;
      if (event.visibility === 'private' && !event.observableAgents?.includes(context.agentId)) continue;

      // 2. 检查位置可达性（Agent 能否感知到这个位置的事件）
      const locationDistance = this.calculateLocationDistance(
        context.agentLocation,
        event.location,
        locationConnections
      );
      if (locationDistance === Infinity) continue;

      // 3. 视线检查
      const canSee = this.checkLineOfSight(locationDistance, context, event);
      if (!canSee) continue;

      // 4. 应用注意力增强/衰减
      const attentionModifier = this.computeAttentionModifier(event, context);

      // 5. 应用情绪偏差
      const biasedDescription = this.applyEmotionalBias(event.description, context);
      const biases = this.detectBiases(event, context);

      // 6. 计算置信度
      const confidence = this.computeEventConfidence(locationDistance, context, attentionModifier, event);

      result.push({
        rawEventId: event.id,
        name: event.name,
        description: biasedDescription,
        confidence,
        perceivedType: event.type,
        biases,
        requiresVerification: confidence < 0.6,
        perceivedAt: Date.now(),
      });
    }

    return result;
  }

  /**
   * 检查视线
   */
  private checkLineOfSight(
    locationDistance: number,
    context: PerceptionContext,
    event: RawEvent
  ): boolean {
    // 同地点：必然可见（除非事件是秘密的）
    if (locationDistance === 0) return true;

    // 相邻地点：需要视线条件
    if (locationDistance === 1) {
      const sightEffectiveness = context.sensoryCapabilities.sight * this.config.maxSightDistance;
      return sightEffectiveness >= 1;
    }

    // 更远的地点：只有高视觉敏锐度或事件足够显著才可感知
    if (locationDistance <= this.config.maxSightDistance) {
      const sightThreshold = locationDistance / context.sensoryCapabilities.sight;
      // 显著性高的事件更容易被感知
      const salienceBoost = event.salience ?? 0.5;
      return (sightThreshold * (1 - salienceBoost * 0.5)) <= 1;
    }

    return false;
  }

  /**
   * 计算位置距离
   */
  private calculateLocationDistance(
    fromLocation: string,
    toLocation: string,
    connections: Map<string, string[]>
  ): number {
    if (fromLocation === toLocation) return 0;

    // BFS 找最短路径
    const visited = new Set<string>();
    const queue: Array<{ id: string; distance: number }> = [{ id: fromLocation, distance: 0 }];
    visited.add(fromLocation);

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = connections.get(current.id) ?? [];

      for (const neighbor of neighbors) {
        if (neighbor === toLocation) return current.distance + 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ id: neighbor, distance: current.distance + 1 });
        }
      }
    }

    return Infinity; // 不可达
  }

  /**
   * 计算注意力调制器
   */
  private computeAttentionModifier(event: RawEvent, context: PerceptionContext): number {
    if (context.attentionFocus.length === 0) return 1;

    const eventKeywords = [event.name, event.type, ...(event.tags ?? [])];
    const focusBonus = context.attentionFocus.some(focus =>
      eventKeywords.some(kw => kw.toLowerCase().includes(focus.toLowerCase()))
    );

    return focusBonus
      ? 1 + this.config.attentionBoostStrength  // 注意力焦点内 → 增强
      : 1 - this.config.attentionBoostStrength * 0.3; // 焦点外 → 轻微衰减
  }

  /**
   * 应用情绪偏差
   */
  private applyEmotionalBias(originalDescription: string, context: PerceptionContext): string {
    const e = context.emotions;
    if (!e || Object.keys(e).length === 0) return originalDescription;

    let bias = '';
    const strength = this.config.emotionalBiasStrength;

    // 恐惧 → 倾向将中性事件感知为威胁
    if ((e['fearful'] ?? 0) > 0.5) {
      bias = '（你感到不安，觉得这件事可能有危险）';
    }
    // 愤怒 → 倾向将事件归因于恶意
    else if ((e['angry'] ?? 0) > 0.5) {
      bias = '（你感到愤怒，觉得这事背后有恶意）';
    }
    // 快乐 → 倾向将事件感知为积极
    else if ((e['happy'] ?? 0) > 0.6) {
      bias = '（你心情很好，觉得这是个好兆头）';
    }
    // 悲伤 → 倾向消极解读
    else if ((e['sad'] ?? 0) > 0.5) {
      bias = '（你感到悲伤，觉得这一切都很糟糕）';
    }

    if (bias && Math.random() < strength) {
      return `${originalDescription} ${bias}`;
    }

    return originalDescription;
  }

  /**
   * 检测感知偏差
   */
  private detectBiases(event: RawEvent, context: PerceptionContext): string[] {
    const biases: string[] = [];

    // 情绪偏差
    if ((context.emotions['fearful'] ?? 0) > 0.5) biases.push('恐惧放大威胁感知');
    if ((context.emotions['angry'] ?? 0) > 0.5) biases.push('愤怒导致归因偏差');

    // 注意力偏差
    const eventInFocus = context.attentionFocus.some(f =>
      event.name.toLowerCase().includes(f.toLowerCase())
    );
    if (!eventInFocus) biases.push('注意力焦点外，细节可能被忽略');

    // 关系偏差
    if (event.sourceCharacter) {
      const relation = context.relations.find(r => r.characterId === event.sourceCharacter);
      if (relation) {
        if (relation.value < -0.3) biases.push(`对 ${event.sourceCharacter} 的负面关系影响判断`);
        if (relation.value > 0.5) biases.push(`对 ${event.sourceCharacter} 的正面关系影响判断`);
      }
    }

    return biases;
  }

  /**
   * 计算事件置信度
   */
  private computeEventConfidence(
    locationDistance: number,
    context: PerceptionContext,
    attentionModifier: number,
    event: RawEvent
  ): number {
    let confidence = 0.8; // 基准

    // 距离衰减
    confidence -= locationDistance * 0.15;

    // 感官能力修正
    confidence *= 0.5 + context.sensoryCapabilities.sight * 0.3 +
      context.sensoryCapabilities.hearing * 0.2;

    // 注意力调制
    confidence *= attentionModifier;

    // 事件显著性提升
    if (event.salience) confidence = Math.min(1, confidence + event.salience * 0.1);

    // 潜行降低置信度
    if (event.isStealthRelated && this.config.enableStealthDetection) {
      confidence *= 0.5;
    }

    return Math.max(0.1, Math.min(1, confidence));
  }

  // ============================================================
  // 地点过滤
  // ============================================================

  /**
   * 过滤地点信息
   */
  private filterLocations(
    rawLocations: RawLocation[],
    context: PerceptionContext,
    locationConnections: Map<string, string[]>
  ): PerceivedLocation[] {
    const result: PerceivedLocation[] = [];

    for (const loc of rawLocations) {
      const distance = this.calculateLocationDistance(
        context.agentLocation,
        loc.id,
        locationConnections
      );

      // 太远的地点无法感知
      if (distance > this.config.maxSightDistance + 1) continue;

      // 不在视野内但知道存在（去过的地方）
      const knownFromMemory = loc.visitedBy?.includes(context.agentId) ?? false;
      if (distance > 0 && !knownFromMemory) continue;

      // 确定已知 occupants 和未知 occupants
      const knownOccupants: string[] = [];
      const unknownOccupants: string[] = [];

      for (const occupant of loc.occupants) {
        if (occupant === context.agentId) continue;
        if (occupant === 'unknown') {
          unknownOccupants.push('某人');
          continue;
        }

        // 潜行检测：如果 occupant 在潜行且 Agent 感知不足
        if (this.config.enableStealthDetection && loc.stealthedOccupants?.includes(occupant)) {
          const detectionChance = context.sensoryCapabilities.sight * context.sensoryCapabilities.intuition;
          if (Math.random() > detectionChance) {
            unknownOccupants.push(occupant);
            continue;
          }
        }

        knownOccupants.push(occupant);
      }

      // 描述置信度随距离下降
      const confidence = distance === 0 ? 0.95
        : distance === 1 ? 0.7
        : 0.4;

      result.push({
        locationId: loc.id,
        name: loc.name,
        description: loc.description,
        knownOccupants,
        unknownOccupants,
        confidence,
        hasHiddenInfo: unknownOccupants.length > 0 || loc.hasSecret,
      });
    }

    return result;
  }

  // ============================================================
  // Agent 感知过滤
  // ============================================================

  /**
   * 过滤其他 Agent 的感知
   */
  private filterAgents(
    rawAgents: RawAgentInfo[],
    context: PerceptionContext,
    locationConnections: Map<string, string[]>
  ): PerceivedAgent[] {
    const result: PerceivedAgent[] = [];

    for (const agent of rawAgents) {
      if (agent.id === context.agentId) continue; // 不感知自己

      const distance = this.calculateLocationDistance(
        context.agentLocation,
        agent.location,
        locationConnections
      );

      // 同地点或相邻地点才能感知到人
      if (distance > 1) continue;

      // 潜行检测
      if (agent.isStealthed && this.config.enableStealthDetection) {
        const detectChance = context.sensoryCapabilities.sight * context.sensoryCapabilities.intuition;
        if (Math.random() > detectChance) continue; // 没发现
      }

      // 情绪推断（可能不准确）
      const perceivedEmotion = this.inferEmotion(agent, context);

      // 身份确认
      const identityConfirmed = this.confirmIdentity(agent, context, distance);

      // 感知精度
      let accuracy = distance === 0 ? 0.9 : 0.6;
      accuracy *= (0.5 + context.sensoryCapabilities.sight * 0.3 +
        context.sensoryCapabilities.socialPerception * 0.2);

      // 对方是否也在观察自己
      const mutualAwareness = agent.awareOfOthers?.includes(context.agentId) ?? false;

      result.push({
        agentId: agent.id,
        name: identityConfirmed ? agent.name : '某人',
        perceivedLocation: agent.location,
        perceivedEmotion,
        accuracy,
        identityConfirmed,
        mutualAwareness,
      });
    }

    return result;
  }

  /**
   * 推断他人的情绪（基于社交感知能力）
   */
  private inferEmotion(agent: RawAgentInfo, context: PerceptionContext): string {
    const socialPerception = context.sensoryCapabilities.socialPerception;
    if (!agent.visibleEmotion) return '未知';

    // 高社交感知能看到真实情绪
    if (socialPerception > 0.7) return agent.visibleEmotion;

    // 中等社交感知可能看错
    if (socialPerception > 0.4 && Math.random() > 0.3) return agent.visibleEmotion;

    // 低社交感知基本靠猜
    const emotions = ['平静', '开心', '不开心', '紧张', '专注'];
    return emotions[Math.floor(Math.random() * emotions.length)];
  }

  /**
   * 确认身份
   */
  private confirmIdentity(agent: RawAgentInfo, context: PerceptionContext, distance: number): boolean {
    // 同地点近距离大概率能认出
    if (distance === 0) return true;

    // 认识的人可以认出
    const known = context.relations.some(r => r.characterId === agent.id);
    if (known) return true;

    // 远距离或陌生人需要感知检定
    return Math.random() < context.sensoryCapabilities.sight * 0.3;
  }

  // ============================================================
  // 环境感知
  // ============================================================

  /**
   * 时间感知（情绪影响时间感知）
   */
  private applyTimePerception(rawTime: string, context: PerceptionContext): string {
    const fearLevel = context.emotions['fearful'] ?? 0;
    if (fearLevel > 0.6) {
      return `${rawTime}（你感觉时间过得很慢）`;
    }

    const joy = context.emotions['happy'] ?? 0;
    if (joy > 0.6) {
      return `${rawTime}（快乐的时光总是过得很快）`;
    }

    return rawTime;
  }

  /**
   * 天气感知（情绪影响天气感知）
   */
  private applyWeatherPerception(rawWeather: string, context: PerceptionContext): string {
    const sad = context.emotions['sad'] ?? 0;
    if (sad > 0.5) {
      return `${rawWeather}（连天气都显得阴沉）`;
    }

    const happy = context.emotions['happy'] ?? 0;
    if (happy > 0.5) {
      return `${rawWeather}（连天气都格外好）`;
    }

    return rawWeather;
  }

  // ============================================================
  // 可靠性计算
  // ============================================================

  /**
   * 计算整体感知可靠性
   */
  private computeOverallReliability(
    events: PerceivedEvent[],
    agents: PerceivedAgent[],
    context: PerceptionContext
  ): number {
    if (events.length === 0 && agents.length === 0) return 1;

    const avgEventConfidence = events.length > 0
      ? events.reduce((s, e) => s + e.confidence, 0) / events.length
      : 1;

    const avgAgentAccuracy = agents.length > 0
      ? agents.reduce((s, a) => s + a.accuracy, 0) / agents.length
      : 1;

    // 感官能力基础
    const sensoryBase = (context.sensoryCapabilities.sight +
      context.sensoryCapabilities.hearing +
      context.sensoryCapabilities.intuition) / 3;

    return (avgEventConfidence * 0.4 + avgAgentAccuracy * 0.3 + sensoryBase * 0.3);
  }

  // ============================================================
  // 运行时更新
  // ============================================================

  /**
   * 更新感知配置
   */
  updateConfig(config: Partial<PerceptionFilterConfig>): void {
    Object.assign(this.config, config);
  }
}

// ============================================================
// 原始世界输入类型
// ============================================================

export interface RawWorldInput {
  events: RawEvent[];
  locations: RawLocation[];
  agents: RawAgentInfo[];
  time: string;
  weather: string;
}

export interface RawEvent {
  id: string;
  name: string;
  description: string;
  type: string;
  location: string;
  /** 事件可见性 */
  visibility: 'public' | 'private' | 'secret';
  /** 可观察此事件的 Agent ID 列表（private 时生效） */
  observableAgents?: string[];
  /** 事件显著性 0-1 */
  salience?: number;
  /** 事件标签 */
  tags?: string[];
  /** 事件来源角色 */
  sourceCharacter?: string;
  /** 是否与潜行相关 */
  isStealthRelated?: boolean;
}

export interface RawLocation {
  id: string;
  name: string;
  description: string;
  occupants: string[];
  /** 处于潜行状态的 occupant ID 列表 */
  stealthedOccupants?: string[];
  /** 是否有秘密 */
  hasSecret?: boolean;
  /** 曾经访问过的 Agent ID 列表 */
  visitedBy?: string[];
}

export interface RawAgentInfo {
  id: string;
  name: string;
  location: string;
  /** 是否处于潜行状态 */
  isStealthed: boolean;
  /** 可被观察到的情绪 */
  visibleEmotion?: string;
  /** 此 Agent 知道谁在这里（互感知用） */
  awareOfOthers?: string[];
}

export default PerceptionFilter;
