/**
 * visibility-engine.ts — 世界可见性系统
 *
 * 控制世界中的信息可见性，确保信息不对称：
 * - 哪些事件谁能看到
 * - 哪些地点谁知道
 * - 哪些 Agent 互相感知
 * - 哪些世界状态可被发现
 *
 * 核心概念：
 * - visibility level：公开/受限/私密/秘密 四级
 * - detection check：基于 Agent 能力的感知检定
 * - stealth system：潜行对抗感知
 * - delayed propagation：信息延迟传播
 * - private memories：只有特定 Agent 知道的记忆
 *
 * 整合：
 * - PerceptionFilter：查询可见性规则来过滤信息
 * - WorldState：标记世界实体的可见性
 * - Agent Runtime：Agent 的潜行状态
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 可见性级别
// ============================================================

export type VisibilityLevel = 'public' | 'restricted' | 'private' | 'secret';

export interface VisibilityRule {
  /** 规则 ID */
  id: string;
  /** 目标类型 */
  targetType: 'event' | 'location' | 'agent_presence' | 'world_state' | 'conversation';
  /** 目标 ID */
  targetId: string;
  /** 可见性级别 */
  level: VisibilityLevel;
  /** 可感知此目标的条件 */
  conditions: VisibilityCondition[];
  /** 此规则的优先级（高优先级覆盖低优先级） */
  priority: number;
  /** 有效期（可选） */
  expiresAt?: number;
}

export interface VisibilityCondition {
  type: 'location' | 'relation' | 'faction' | 'ability' | 'item' | 'tag' | 'custom';
  /** 条件参数 */
  params: Record<string, any>;
  /** 满足条件时的可见性提升级别 */
  grantsVisibility?: VisibilityLevel;
}

// ============================================================
// 潜行状态
// ============================================================

export interface StealthState {
  /** Agent ID */
  agentId: string;
  /** 是否处于潜行模式 */
  isStealthed: boolean;
  /** 潜行技能 0-1 */
  stealthSkill: number;
  /** 被发现的风险 0-1 */
  detectionRisk: number;
  /** 当前掩体 */
  cover: CoverType;
  /** 最后被发现的时间 */
  lastDetectedAt?: number;
}

export type CoverType = 'none' | 'partial' | 'full' | 'invisible';

// ============================================================
// 信息传播
// ============================================================

export interface PropagationState {
  /** 信息 ID */
  informationId: string;
  /** 信息内容 */
  content: string;
  /** 信息源 */
  sourceAgentId: string;
  /** 传播范围（地点 ID 列表） */
  propagatedLocations: string[];
  /** 已知道的 Agent ID 列表 */
  knownByAgents: string[];
  /** 传播速度 */
  propagationSpeed: 'instant' | 'fast' | 'normal' | 'slow';
  /** 信息扭曲程度 0-1 */
  distortion: number;
  /** 创建时间 */
  createdAt: number;
}

// ============================================================
// VisibilityEngine 配置
// ============================================================

export interface VisibilityEngineConfig {
  /** 默认可见性级别 */
  defaultVisibility: VisibilityLevel;
  /** 是否启用严格的视线检查 */
  enableStrictLineOfSight: boolean;
  /** 潜行检测的基础难度 */
  baseStealthDetectionDC: number;
  /** 信息传播速度因子 */
  propagationSpeedFactor: number;
  /** 最大传播跳数 */
  maxPropagationHops: number;
}

const DEFAULT_VISIBILITY_CONFIG: VisibilityEngineConfig = {
  defaultVisibility: 'public',
  enableStrictLineOfSight: true,
  baseStealthDetectionDC: 0.5,
  propagationSpeedFactor: 1.0,
  maxPropagationHops: 5,
};

// ============================================================
// VisibilityEngine 实现
// ============================================================

export class VisibilityEngine {
  private rules: Map<string, VisibilityRule> = new Map();
  private stealthStates: Map<string, StealthState> = new Map();
  private propagations: Map<string, PropagationState> = new Map();
  private config: VisibilityEngineConfig;
  private eventBus: EventBus | null;

  constructor(config?: Partial<VisibilityEngineConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_VISIBILITY_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 可见性规则管理
  // ============================================================

  /**
   * 添加可见性规则
   */
  addRule(rule: VisibilityRule): void {
    this.rules.set(rule.id, rule);
  }

  /**
   * 批量添加规则
   */
  addRules(rules: VisibilityRule[]): void {
    for (const rule of rules) this.rules.set(rule.id, rule);
  }

  /**
   * 移除规则
   */
  removeRule(ruleId: string): void {
    this.rules.delete(ruleId);
  }

  /**
   * 获取目标的可见性
   */
  getVisibility(
    targetType: VisibilityRule['targetType'],
    targetId: string,
    observerId: string,
    observerLocation: string,
    context: VisibilityCheckContext
  ): { level: VisibilityLevel; reasons: string[] } {
    // 1. 获取所有适用的规则
    const applicableRules = Array.from(this.rules.values())
      .filter(r => r.targetType === targetType && r.targetId === targetId)
      .sort((a, b) => b.priority - a.priority);

    // 2. 默认可见性
    let currentLevel: VisibilityLevel = this.config.defaultVisibility;
    const reasons: string[] = [`默认: ${currentLevel}`];

    // 3. 逐规则评估
    for (const rule of applicableRules) {
      if (rule.expiresAt && Date.now() > rule.expiresAt) continue;

      // 检查是否满足任何条件
      let conditionsMet = false;
      for (const condition of rule.conditions) {
        if (this.evaluateCondition(condition, observerId, observerLocation, context)) {
          conditionsMet = true;
          if (condition.grantsVisibility) {
            currentLevel = condition.grantsVisibility;
            reasons.push(`规则 ${rule.id}: 条件满足 → ${condition.grantsVisibility}`);
          }
          break;
        }
      }

      if (!conditionsMet) {
        currentLevel = rule.level;
        reasons.push(`规则 ${rule.id}: 条件不满足 → ${rule.level}`);
      }
    }

    return { level: currentLevel, reasons };
  }

  /**
   * 评估条件
   */
  private evaluateCondition(
    condition: VisibilityCondition,
    observerId: string,
    observerLocation: string,
    context: VisibilityCheckContext
  ): boolean {
    switch (condition.type) {
      case 'location':
        return condition.params.locationIds?.includes(observerLocation) ?? false;

      case 'relation': {
        const targetChar = condition.params.characterId;
        const minValue = condition.params.minValue ?? 0;
        const relation = context.relations?.find(r => r.characterId === targetChar);
        return (relation?.value ?? -1) >= minValue;
      }

      case 'faction': {
        const factionId = condition.params.factionId;
        return context.agentFactions?.includes(factionId) ?? false;
      }

      case 'ability': {
        const abilityName = condition.params.ability;
        const minLevel = condition.params.minLevel ?? 0;
        const abilityLevel = context.sensoryCapabilities?.[abilityName as keyof typeof context.sensoryCapabilities] ?? 0;
        return abilityLevel >= minLevel;
      }

      case 'tag':
        return condition.params.tags?.some((t: string) =>
          context.agentTags?.includes(t)
        ) ?? false;

      case 'item':
        return context.agentInventory?.includes(condition.params.itemId) ?? false;

      case 'custom':
        // 自定义条件由外部提供评估函数
        return condition.params.evaluator?.({
          observerId,
          observerLocation,
          context,
        }) ?? false;

      default:
        return false;
    }
  }

  // ============================================================
  // 潜行系统
  // ============================================================

  /**
   * 设置 Agent 潜行状态
   */
  setStealth(agentId: string, isStealthed: boolean, stealthSkill?: number): void {
    let state = this.stealthStates.get(agentId);
    if (!state) {
      state = {
        agentId,
        isStealthed,
        stealthSkill: stealthSkill ?? 0.3,
        detectionRisk: 0,
        cover: 'none',
      };
      this.stealthStates.set(agentId, state);
    } else {
      state.isStealthed = isStealthed;
      if (stealthSkill !== undefined) state.stealthSkill = stealthSkill;
    }

    this.eventBus?.emit('visibility:stealth_changed', {
      agentId,
      isStealthed,
    });
  }

  /**
   * 执行潜行检测
   */
  performStealthCheck(
    stealthedAgentId: string,
    observerId: string,
    observerSight: number,
    observerIntuition: number,
    distance: number
  ): { detected: boolean; detectionChance: number } {
    const state = this.stealthStates.get(stealthedAgentId);
    if (!state || !state.isStealthed) {
      return { detected: true, detectionChance: 1 };
    }

    // 检测难度 = 基础DC + 潜行技能 - 观察者能力 - 距离惩罚
    const dc = this.config.baseStealthDetectionDC
      + state.stealthSkill * 0.5
      - observerSight * 0.3
      - observerIntuition * 0.2
      + distance * 0.1;

    // 掩体加成
    const coverBonus = state.cover === 'full' ? 0.3
      : state.cover === 'partial' ? 0.15
      : 0;

    const detectionChance = Math.max(0.05, Math.min(0.95, 1 - dc + coverBonus));
    const detected = Math.random() < detectionChance;

    if (detected) {
      state.lastDetectedAt = Date.now();
      state.detectionRisk = 1;
    } else {
      state.detectionRisk = Math.max(0, state.detectionRisk - 0.1);
    }

    return { detected, detectionChance };
  }

  /**
   * 获取 Agent 是否对观察者可见
   */
  isAgentVisible(
    targetAgentId: string,
    observerId: string,
    observerLocation: string,
    context: VisibilityCheckContext
  ): { visible: boolean; reasons: string[] } {
    const state = this.stealthStates.get(targetAgentId);

    // 不在潜行状态 → 可见
    if (!state || !state.isStealthed) {
      return { visible: true, reasons: ['目标未潜行'] };
    }

    // 同地点近距离检测
    if (context.targetLocation === observerLocation) {
      const check = this.performStealthCheck(
        targetAgentId, observerId,
        context.sensoryCapabilities?.sight ?? 0.5,
        context.sensoryCapabilities?.intuition ?? 0.3,
        0
      );
      return {
        visible: check.detected,
        reasons: check.detected ? ['潜行被识破'] : ['目标处于潜行状态'],
      };
    }

    // 远距离默认不可见
    return { visible: false, reasons: ['目标不在同一地点'] };
  }

  // ============================================================
  // 信息传播
  // ============================================================

  /**
   * 创建信息传播条目
   */
  createPropagation(
    content: string,
    sourceAgentId: string,
    sourceLocation: string,
    speed: PropagationState['propagationSpeed'],
    distortion?: number
  ): string {
    const id = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const prop: PropagationState = {
      informationId: id,
      content,
      sourceAgentId,
      propagatedLocations: [sourceLocation],
      knownByAgents: [sourceAgentId],
      propagationSpeed: speed,
      distortion: distortion ?? 0,
      createdAt: Date.now(),
    };

    this.propagations.set(id, prop);
    return id;
  }

  /**
   * 推进信息传播
   */
  tickPropagation(
    locationConnections: Map<string, string[]>,
    agentLocations: Map<string, string>
  ): PropagationUpdate[] {
    const updates: PropagationUpdate[] = [];

    for (const [id, prop] of this.propagations) {
      // 计算本次传播的跳数
      const hops = this.getPropagationHops(prop.propagationSpeed);

      for (let h = 0; h < hops; h++) {
        // 从已传播的位置向外扩散
        const newLocations: string[] = [];
        for (const loc of prop.propagatedLocations) {
          const neighbors = locationConnections.get(loc) ?? [];
          for (const neighbor of neighbors) {
            if (!prop.propagatedLocations.includes(neighbor)) {
              newLocations.push(neighbor);
            }
          }
        }

        // 添加新位置
        for (const nl of newLocations) {
          prop.propagatedLocations.push(nl);

          // 找到该位置的 Agent
          for (const [agentId, agentLoc] of agentLocations) {
            if (agentLoc === nl && !prop.knownByAgents.includes(agentId)) {
              prop.knownByAgents.push(agentId);

              // 信息扭曲：每次传播都有一定失真
              let receivedContent = prop.content;
              if (Math.random() < prop.distortion) {
                receivedContent = this.applyDistortion(prop.content, prop.distortion);
              }

              updates.push({
                propagationId: id,
                agentId,
                originalContent: prop.content,
                receivedContent,
                sourceLocation: prop.propagatedLocations[0],
                hopCount: prop.propagatedLocations.length - 1,
              });
            }
          }
        }

        // 限制传播范围
        if (prop.propagatedLocations.length > this.config.maxPropagationHops) break;
      }
    }

    return updates;
  }

  /**
   * 获取传播速度对应的跳数
   */
  private getPropagationHops(speed: PropagationState['propagationSpeed']): number {
    const factor = this.config.propagationSpeedFactor;
    switch (speed) {
      case 'instant': return 100; // 瞬间全图
      case 'fast': return Math.ceil(3 * factor);
      case 'normal': return Math.ceil(1 * factor);
      case 'slow': return Math.ceil(0.3 * factor);
    }
  }

  /**
   * 应用信息扭曲
   */
  private applyDistortion(original: string, distortion: number): string {
    // 扭曲类型：信息丢失、添油加醋、张冠李戴
    const distortions = [
      () => original.substring(0, Math.floor(original.length * (1 - distortion * 0.5))), // 丢失
      () => `${original}（据说情况更严重）`, // 夸大
      () => original.replace(/说/g, '喊').replace(/告诉/g, '警告'), // 语气变化
    ];

    return distortions[Math.floor(Math.random() * distortions.length)]();
  }

  // ============================================================
  // 私密信息管理
  // ============================================================

  /**
   * 标记一条信息为私密（仅特定 Agent 可知）
   */
  markAsPrivate(informationId: string, allowedAgentIds: string[]): void {
    const prop = this.propagations.get(informationId);
    if (prop) {
      prop.knownByAgents = prop.knownByAgents.filter(id => allowedAgentIds.includes(id));
    }
  }

  /**
   * 检查 Agent 是否有权访问某信息
   */
  canAccess(informationId: string, agentId: string): boolean {
    const prop = this.propagations.get(informationId);
    if (!prop) return false;
    return prop.knownByAgents.includes(agentId);
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取 Agent 当前位置可见的实体列表
   */
  getVisibleEntities(
    observerId: string,
    observerLocation: string,
    context: VisibilityCheckContext
  ): VisibleEntities {
    const visible: VisibleEntities = {
      events: [],
      agents: [],
      locations: [],
      conversations: [],
    };

    // 事件
    for (const rule of this.rules.values()) {
      if (rule.targetType === 'event') {
        const { level, reasons } = this.getVisibility(
          'event', rule.targetId, observerId, observerLocation, context
        );
        if (level !== 'secret') {
          visible.events.push({ targetId: rule.targetId, visibility: level, reasons });
        }
      }
    }

    // Agent 可见性
    for (const [agentId, state] of this.stealthStates) {
      if (agentId === observerId) continue;
      const { visible: isVisible } = this.isAgentVisible(
        agentId, observerId, observerLocation, context
      );
      if (isVisible) {
        visible.agents.push(agentId);
      }
    }

    return visible;
  }

  /**
   * 清除过期规则
   */
  cleanup(): void {
    const now = Date.now();
    for (const [id, rule] of this.rules) {
      if (rule.expiresAt && now > rule.expiresAt) {
        this.rules.delete(id);
      }
    }

    // 清理旧的传播记录
    for (const [id, prop] of this.propagations) {
      const age = now - prop.createdAt;
      if (age > 3600000) { // 1小时
        this.propagations.delete(id);
      }
    }
  }

  // ============================================================
  // 统计/调试
  // ============================================================

  /**
   * 获取统计
   */
  getStats(): VisibilityEngineStats {
    return {
      totalRules: this.rules.size,
      rulesByLevel: {
        public: Array.from(this.rules.values()).filter(r => r.level === 'public').length,
        restricted: Array.from(this.rules.values()).filter(r => r.level === 'restricted').length,
        private: Array.from(this.rules.values()).filter(r => r.level === 'private').length,
        secret: Array.from(this.rules.values()).filter(r => r.level === 'secret').length,
      },
      stealthedAgents: Array.from(this.stealthStates.values()).filter(s => s.isStealthed).length,
      activePropagations: this.propagations.size,
    };
  }

  reset(): void {
    this.rules.clear();
    this.stealthStates.clear();
    this.propagations.clear();
  }
}

// ============================================================
// 辅助类型
// ============================================================

export interface VisibilityCheckContext {
  relations?: Array<{ characterId: string; value: number; trust: number }>;
  agentFactions?: string[];
  sensoryCapabilities?: Record<string, number>;
  agentTags?: string[];
  agentInventory?: string[];
  targetLocation?: string;
}

export interface VisibleEntities {
  events: Array<{ targetId: string; visibility: VisibilityLevel; reasons: string[] }>;
  agents: string[];
  locations: string[];
  conversations: string[];
}

export interface PropagationUpdate {
  propagationId: string;
  agentId: string;
  originalContent: string;
  receivedContent: string;
  sourceLocation: string;
  hopCount: number;
}

export interface VisibilityEngineStats {
  totalRules: number;
  rulesByLevel: Record<string, number>;
  stealthedAgents: number;
  activePropagations: number;
}

export default VisibilityEngine;
