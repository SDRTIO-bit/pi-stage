/**
 * rumor-engine.ts — 谣言传播系统
 *
 * 世界中的信息不再瞬间全局同步。
 * 信息通过社交网络传播，并在这个过程中被扭曲。
 *
 * 核心机制：
 * - rumor spreading：信息从 Agent 到 Agent 传播
 * - distortion：每次传播信息都会失真
 * - source trust：信息来源的信任度影响接收者的置信度
 * - delayed propagation：传播需要时间
 * - misinformation：虚假信息可以被主动散布
 *
 * 认知链中的位置：
 *   World Event → Visibility → Propagation → Perception → Awareness → Belief
 *                                        ↑
 *                                   Rumor Engine
 *
 * 整合：
 * - VisibilityEngine：控制谣言传播的范围
 * - AwarenessRuntime：接收到的谣言成为 suspected facts
 * - BeliefSystem：反复听到的谣言可能固化为信念
 * - Relation System：信任度影响谣言可信度
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 类型定义
// ============================================================

export type RumorStatus = 'active' | 'spreading' | 'established' | 'dying' | 'extinct';
export type RumorType = 'truth' | 'misinformation' | 'exaggeration' | 'speculation' | 'malicious_lie';

export interface Rumor {
  id: string;
  /** 谣言内容 */
  content: string;
  /** 原始事件（如果基于真实事件） */
  basedOnEventId?: string;
  /** 类型 */
  type: RumorType;
  /** 当前状态 */
  status: RumorStatus;
  /** 初始传播者 */
  originatorId: string;
  /** 当前已知道的 Agent ID 列表 */
  knownBy: string[];
  /** 传播路径记录 */
  propagationPath: Array<{
    fromAgentId: string;
    toAgentId: string;
    timestamp: number;
    /** 传播时的扭曲版本 */
    versionAtPropagation: string;
  }>;
  /** 当前活跃版本 */
  currentVersion: string;
  /** 扭曲程度 0-1 */
  distortionLevel: number;
  /** 传播速度 */
  spreadSpeed: 'fast' | 'normal' | 'slow';
  /** 传播半径（跳数） */
  spreadRadius: number;
  /** 当前跳数 */
  currentHops: number;
  /** 可信度基准 0-1 */
  baseCredibility: number;
  /** 创建时间 */
  createdAt: number;
  /** 最后传播时间 */
  lastSpreadAt: number;
  /** 与谣言的关联标签 */
  tags: string[];
}

export interface RumorSpreadEvent {
  rumorId: string;
  content: string;
  fromAgentId: string;
  toAgentId: string;
  version: string;
  timestamp: number;
  /** 接收者的置信度（基于信任度调制后） */
  receiverConfidence: number;
  /** 传播时的扭曲程度 */
  distortionApplied: number;
}

// ============================================================
// RumorEngine 配置
// ============================================================

export interface RumorEngineConfig {
  /** 最大同时活跃谣言数 */
  maxActiveRumors: number;
  /** 基础传播概率（每 tick 每连接） */
  baseSpreadChance: number;
  /** 每次传播的扭曲增量 */
  distortionPerHop: number;
  /** 谣言存活时间（毫秒） */
  rumorLifespan: number;
  /** 传播冷却（同一条谣言对同一 Agent） */
  spreadCooldown: number;
  /** 关系信任对可信度的权重 */
  trustWeight: number;
}

const DEFAULT_RUMOR_CONFIG: RumorEngineConfig = {
  maxActiveRumors: 30,
  baseSpreadChance: 0.3,
  distortionPerHop: 0.05,
  rumorLifespan: 3600000, // 1小时
  spreadCooldown: 60000,  // 1分钟
  trustWeight: 0.4,
};

// ============================================================
// RumorEngine 实现
// ============================================================

export class RumorEngine {
  private rumors: Map<string, Rumor> = new Map();
  private spreadHistory: RumorSpreadEvent[] = [];
  private agentCooldowns: Map<string, Map<string, number>> = new Map(); // agentId → rumorId → timestamp
  private config: RumorEngineConfig;
  private eventBus: EventBus | null;

  constructor(config?: Partial<RumorEngineConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_RUMOR_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 谣言创建
  // ============================================================

  /**
   * 创建新谣言
   */
  createRumor(params: {
    content: string;
    type: RumorType;
    originatorId: string;
    basedOnEventId?: string;
    spreadSpeed?: Rumor['spreadSpeed'];
    spreadRadius?: number;
    baseCredibility?: number;
    tags?: string[];
  }): Rumor {
    // 限制活跃谣言数
    if (this.getActiveRumors().length >= this.config.maxActiveRumors) {
      this.evictOldestRumor();
    }

    const id = `rumor_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const rumor: Rumor = {
      id,
      content: params.content,
      basedOnEventId: params.basedOnEventId,
      type: params.type,
      status: 'active',
      originatorId: params.originatorId,
      knownBy: [params.originatorId],
      propagationPath: [],
      currentVersion: params.content,
      distortionLevel: 0,
      spreadSpeed: params.spreadSpeed ?? 'normal',
      spreadRadius: params.spreadRadius ?? 5,
      currentHops: 0,
      baseCredibility: params.baseCredibility ?? 0.5,
      createdAt: Date.now(),
      lastSpreadAt: Date.now(),
      tags: params.tags ?? [],
    };

    this.rumors.set(id, rumor);

    this.eventBus?.emit('rumor:created', {
      rumorId: id,
      content: params.content,
      type: params.type,
      originatorId: params.originatorId,
    });

    return rumor;
  }

  /**
   * 创建恶意虚假信息（诽谤/谎言）
   */
  createMisinformation(
    content: string,
    liarId: string,
    targetCharacterId?: string,
    baseCredibility?: number
  ): Rumor {
    return this.createRumor({
      content,
      type: 'malicious_lie',
      originatorId: liarId,
      baseCredibility: baseCredibility ?? 0.3, // 谎言天然可信度低
      tags: ['misinformation', ...(targetCharacterId ? [targetCharacterId] : [])],
    });
  }

  // ============================================================
  // 主 tick：谣言传播
  // ============================================================

  /**
   * 每 tick 调用：推进谣言传播
   */
  tick(
    agentRelations: Map<string, Array<{ characterId: string; value: number; trust: number }>>,
    agentLocations: Map<string, string>,
    locationConnections: Map<string, string[]>
  ): RumorSpreadEvent[] {
    const spreadEvents: RumorSpreadEvent[] = [];

    for (const rumor of this.rumors.values()) {
      if (rumor.status === 'extinct' || rumor.status === 'dying') continue;
      if (rumor.currentHops >= rumor.spreadRadius) {
        rumor.status = 'dying';
        continue;
      }

      // 找出发起传播的 Agent（活跃谣言传播者）
      const spreaders = rumor.knownBy.filter(agentId => {
        const cooldowns = this.agentCooldowns.get(agentId);
        if (!cooldowns) return true;
        const lastSpread = cooldowns.get(rumor.id);
        if (!lastSpread) return true;
        return Date.now() - lastSpread > this.config.spreadCooldown;
      });

      for (const spreaderId of spreaders) {
        const spreaderLocation = agentLocations.get(spreaderId);
        if (!spreaderLocation) continue;

        // 找到传播者所在位置的其他 Agent
        const localAgents = Array.from(agentLocations.entries())
          .filter(([id, loc]) =>
            id !== spreaderId &&
            loc === spreaderLocation &&
            !rumor.knownBy.includes(id)
          );

        for (const [targetId] of localAgents) {
          // 传播概率检查
          if (Math.random() > this.config.baseSpreadChance) continue;

          // 计算基于信任度的置信度
          const relations = agentRelations.get(spreaderId) ?? [];
          const relation = relations.find(r => r.characterId === targetId);
          const trust = relation?.trust ?? 0.3;
          const confidence = this.computeReceiverConfidence(rumor, trust);

          // 应用扭曲
          const distortedContent = this.applyDistortion(rumor);

          // 记录传播
          rumor.propagationPath.push({
            fromAgentId: spreaderId,
            toAgentId: targetId,
            timestamp: Date.now(),
            versionAtPropagation: distortedContent,
          });

          rumor.knownBy.push(targetId);
          rumor.currentVersion = distortedContent;
          rumor.currentHops++;
          rumor.lastSpreadAt = Date.now();

          // 更新冷却
          if (!this.agentCooldowns.has(spreaderId)) {
            this.agentCooldowns.set(spreaderId, new Map());
          }
          this.agentCooldowns.get(spreaderId)!.set(rumor.id, Date.now());

          // 状态变化
          if (rumor.currentHops >= 2) {
            rumor.status = 'spreading';
          }
          if (rumor.knownBy.length > 10) {
            rumor.status = 'established';
          }

          const spreadEvent: RumorSpreadEvent = {
            rumorId: rumor.id,
            content: distortedContent,
            fromAgentId: spreaderId,
            toAgentId: targetId,
            version: distortedContent,
            timestamp: Date.now(),
            receiverConfidence: confidence,
            distortionApplied: rumor.distortionLevel,
          };

          spreadEvents.push(spreadEvent);
          this.spreadHistory.push(spreadEvent);

          this.eventBus?.emit('rumor:spread', {
            rumorId: rumor.id,
            fromAgentId: spreaderId,
            toAgentId: targetId,
            version: distortedContent,
            confidence,
          });
        }
      }

      // 检查谣言是否过期
      const age = Date.now() - rumor.createdAt;
      if (age > this.config.rumorLifespan) {
        rumor.status = 'dying';
      }
    }

    // 清理过期谣言
    this.cleanup();

    return spreadEvents;
  }

  // ============================================================
  // 扭曲与置信度
  // ============================================================

  /**
   * 计算接收者对谣言的置信度
   */
  private computeReceiverConfidence(rumor: Rumor, trust: number): number {
    // 基础可信度
    let confidence = rumor.baseCredibility;

    // 来源信任度调制
    confidence = confidence * (1 - this.config.trustWeight) + trust * this.config.trustWeight;

    // 扭曲惩罚
    confidence -= rumor.distortionLevel * 0.2;

    // 类型调制
    switch (rumor.type) {
      case 'truth': confidence += 0.1; break;
      case 'misinformation': confidence -= 0.1; break;
      case 'exaggeration': confidence *= 0.8; break;
      case 'speculation': confidence *= 0.6; break;
      case 'malicious_lie': confidence *= 0.4; break;
    }

    return Math.max(0.05, Math.min(0.95, confidence));
  }

  /**
   * 应用信息扭曲
   */
  private applyDistortion(rumor: Rumor): string {
    if (Math.random() > rumor.distortionLevel + this.config.distortionPerHop) {
      return rumor.currentVersion;
    }

    rumor.distortionLevel = Math.min(1, rumor.distortionLevel + this.config.distortionPerHop);

    const content = rumor.currentVersion;
    const distortion = rumor.distortionLevel;

    // 扭曲策略
    const strategies = [
      // 1. 细节丢失
      () => {
        const words = content.split(/[\s,，。、！？]+/);
        const removeCount = Math.floor(words.length * distortion * 0.3);
        return words.slice(0, words.length - removeCount).join(' ');
      },
      // 2. 夸大
      () => {
        const intensifiers = ['非常', '极其', '超级', '前所未有地'];
        const word = intensifiers[Math.floor(Math.random() * intensifiers.length)];
        return `${word}${content}`;
      },
      // 3. 具体化（添加虚假细节）
      () => {
        const details = ['据说', '有人亲眼看到', '大家都说', '内部消息'];
        const detail = details[Math.floor(Math.random() * details.length)];
        return `${content}，${detail}`;
      },
      // 4. 归因转移
      () => {
        const subjects = ['某人', '他们', '上面的人', '知情者'];
        const subject = subjects[Math.floor(Math.random() * subjects.length)];
        return content.replace(/[我他她它]/g, subject);
      },
    ];

    const selected = strategies[Math.floor(Math.random() * strategies.length)];
    return selected();
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取 Agent 已知的谣言
   */
  getRumorsKnownBy(agentId: string): Rumor[] {
    return Array.from(this.rumors.values())
      .filter(r => r.knownBy.includes(agentId) && r.status !== 'extinct');
  }

  /**
   * 获取关于特定 Agent 的谣言
   */
  getRumorsAbout(targetId: string): Rumor[] {
    const lower = targetId.toLowerCase();
    return Array.from(this.rumors.values())
      .filter(r =>
        r.status !== 'extinct' &&
        (r.content.toLowerCase().includes(lower) || r.tags.includes(targetId))
      );
  }

  /**
   * 获取活跃谣言
   */
  getActiveRumors(): Rumor[] {
    return Array.from(this.rumors.values())
      .filter(r => r.status === 'active' || r.status === 'spreading' || r.status === 'established');
  }

  /**
   * 获取特定类型的谣言
   */
  getRumorsByType(type: RumorType): Rumor[] {
    return Array.from(this.rumors.values())
      .filter(r => r.type === type && r.status !== 'extinct');
  }

  /**
   * 获取谣言的传播路径
   */
  getPropagationPath(rumorId: string): Rumor['propagationPath'] {
    return this.rumors.get(rumorId)?.propagationPath ?? [];
  }

  /**
   * 获取 Agent 是否听说过某谣言
   */
  hasHeard(rumorId: string, agentId: string): boolean {
    return this.rumors.get(rumorId)?.knownBy.includes(agentId) ?? false;
  }

  /**
   * 获取某个地点的活跃谣言
   */
  getRumorsAtLocation(
    locationId: string,
    agentLocations: Map<string, string>
  ): Rumor[] {
    const agentsHere = Array.from(agentLocations.entries())
      .filter(([, loc]) => loc === locationId)
      .map(([id]) => id);

    return this.getActiveRumors()
      .filter(r => r.knownBy.some(id => agentsHere.includes(id)));
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 清理过期谣言
   */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, rumor] of this.rumors) {
      if (rumor.status === 'extinct') {
        this.rumors.delete(id);
        continue;
      }
      if (rumor.status === 'dying') {
        const timeSinceLastSpread = now - rumor.lastSpreadAt;
        if (timeSinceLastSpread > this.config.rumorLifespan / 2) {
          rumor.status = 'extinct';
          this.eventBus?.emit('rumor:extinct', {
            rumorId: id,
            content: rumor.content,
          });
        }
      }
    }
  }

  /**
   * 移除最旧的谣言
   */
  private evictOldestRumor(): void {
    let oldest: Rumor | null = null;
    for (const rumor of this.rumors.values()) {
      if (!oldest || rumor.createdAt < oldest.createdAt) {
        oldest = rumor;
      }
    }
    if (oldest) {
      oldest.status = 'extinct';
    }
  }

  // ============================================================
  // 调试/统计
  // ============================================================

  getStats(): RumorEngineStats {
    const all = Array.from(this.rumors.values());
    const active = this.getActiveRumors();
    return {
      totalRumors: all.length,
      activeRumors: active.length,
      extinctRumors: all.filter(r => r.status === 'extinct').length,
      byType: {
        truth: all.filter(r => r.type === 'truth').length,
        misinformation: all.filter(r => r.type === 'misinformation').length,
        exaggeration: all.filter(r => r.type === 'exaggeration').length,
        speculation: all.filter(r => r.type === 'speculation').length,
        malicious_lie: all.filter(r => r.type === 'malicious_lie').length,
      },
      averageDistortion: active.length > 0
        ? active.reduce((s, r) => s + r.distortionLevel, 0) / active.length
        : 0,
      totalSpreadEvents: this.spreadHistory.length,
    };
  }

  reset(): void {
    this.rumors.clear();
    this.spreadHistory = [];
    this.agentCooldowns.clear();
  }
}

export interface RumorEngineStats {
  totalRumors: number;
  activeRumors: number;
  extinctRumors: number;
  byType: Record<string, number>;
  averageDistortion: number;
  totalSpreadEvents: number;
}

export default RumorEngine;
