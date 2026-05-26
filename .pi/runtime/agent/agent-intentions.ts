/**
 * agent-intentions.ts - Agent 意图生成系统
 *
 * 意图 = 需求 × 情绪 × 目标 × 关系 × 环境
 * 意图 → 行动
 *
 * Agent 的自主行为链：
 * Needs → Drives → Intentions → Actions → Consequences → Memory
 *
 * 支持：
 * - 需求驱动的意图生成
 * - 目标驱动的意图生成
 * - 事件响应的意图生成
 * - 关系驱动的意图生成
 * - 意图优先级排序
 * - 意图冲突检测
 */

import type { NeedType } from './agent-needs';

export type IntentionType =
  | 'socialize'       // 社交：找人对话
  | 'explore'         // 探索：去新地点
  | 'rest'            // 休息
  | 'pursue_goal'     // 追目标
  | 'react_event'     // 回应事件
  | 'maintain_relation' // 维系关系
  | 'confront'        // 对峙
  | 'avoid'           // 回避
  | 'help'            // 帮助
  | 'observe'         // 观察
  | 'work'            // 工作
  | 'wander'          // 闲逛
  ;

export interface Intention {
  id: string;
  type: IntentionType;
  /** 描述 */
  description: string;
  /** 强度 0-1 */
  strength: number;
  /** 紧急度（高紧急度的意图需要更快执行） */
  urgency: number;
  /** 目标对象（Agent/地点/物品） */
  target?: string;
  /** 驱动源 */
  source: 'need' | 'goal' | 'event' | 'relation' | 'schedule' | 'curiosity';
  /** 关联的需求类型 */
  relatedNeed?: NeedType;
  /** 关联的目标 ID */
  relatedGoalId?: string;
  /** 关联事件 */
  relatedEvent?: string;
  /** 过期时间戳 */
  expiresAt?: number;
  /** 是否已被消费 */
  consumed: boolean;
}

export interface IntentionConfig {
  /** 各类型意图的最小强度门槛 */
  strengthThresholds: Record<IntentionType, number>;
  /** 需求到意图的映射 */
  needToIntentions: Record<NeedType, Array<{
    type: IntentionType;
    baseStrength: number;
    description: string;
  }>>;
  /** 事件到意图的映射 */
  eventToIntentions: Record<string, Array<{
    type: IntentionType;
    baseStrength: number;
    description: string;
  }>>;
}

const DEFAULT_INTENTION_CONFIG: IntentionConfig = {
  strengthThresholds: {
    socialize: 0.3,
    explore: 0.3,
    rest: 0.3,
    pursue_goal: 0.2,
    react_event: 0.1,
    maintain_relation: 0.3,
    confront: 0.4,
    avoid: 0.3,
    help: 0.3,
    observe: 0.2,
    work: 0.3,
    wander: 0.2,
  },
  needToIntentions: {
    social: [
      { type: 'socialize', baseStrength: 0.6, description: '找人聊天' },
      { type: 'maintain_relation', baseStrength: 0.4, description: '维系关系' },
    ],
    survival: [
      { type: 'avoid', baseStrength: 0.8, description: '寻找安全环境' },
      { type: 'observe', baseStrength: 0.3, description: '观察周围环境' },
    ],
    curiosity: [
      { type: 'explore', baseStrength: 0.7, description: '探索新地点' },
      { type: 'observe', baseStrength: 0.4, description: '观察周围情况' },
    ],
    achievement: [
      { type: 'pursue_goal', baseStrength: 0.8, description: '推进当前目标' },
      { type: 'work', baseStrength: 0.5, description: '继续手上的事' },
    ],
    power: [
      { type: 'confront', baseStrength: 0.5, description: '彰显存在感' },
      { type: 'socialize', baseStrength: 0.3, description: '建立社交影响' },
    ],
    relaxation: [
      { type: 'rest', baseStrength: 0.7, description: '休息一下' },
      { type: 'wander', baseStrength: 0.4, description: '随便走走' },
    ],
  },
  eventToIntentions: {
    conflict: [
      { type: 'confront', baseStrength: 0.7, description: '当面解决冲突' },
      { type: 'avoid', baseStrength: 0.5, description: '避开冲突现场' },
    ],
    compliment: [
      { type: 'socialize', baseStrength: 0.5, description: '继续对话' },
    ],
    danger: [
      { type: 'avoid', baseStrength: 0.9, description: '逃离危险' },
      { type: 'observe', baseStrength: 0.4, description: '观察危险来源' },
    ],
    surprise: [
      { type: 'observe', baseStrength: 0.6, description: '搞清楚发生了什么事' },
      { type: 'explore', baseStrength: 0.5, description: '去查看源头' },
    ],
    goal_fail: [
      { type: 'pursue_goal', baseStrength: 0.6, description: '换个方式继续尝试' },
      { type: 'rest', baseStrength: 0.3, description: '先休息缓一缓' },
    ],
    goal_complete: [
      { type: 'socialize', baseStrength: 0.4, description: '分享好消息' },
      { type: 'rest', baseStrength: 0.3, description: '好好放松一下' },
    ],
  },
};

export class AgentIntentions {
  private intentions: Intention[] = [];
  private config: IntentionConfig;
  private idCounter: number = 0;

  constructor(config?: Partial<IntentionConfig>) {
    this.config = { ...DEFAULT_INTENTION_CONFIG, ...config };
  }

  /**
   * 从需求生成意图
   */
  generateFromNeeds(needs: Record<NeedType, number>, driveThreshold: number): Intention[] {
    const generated: Intention[] = [];

    for (const [needType, strength] of Object.entries(needs)) {
      if (strength < driveThreshold) continue;

      const mappings = this.config.needToIntentions[needType as NeedType];
      if (!mappings) continue;

      for (const mapping of mappings) {
        const intentionStrength = mapping.baseStrength * strength;
        if (intentionStrength >= this.config.strengthThresholds[mapping.type]) {
          generated.push(this.createIntention({
            type: mapping.type,
            description: mapping.description,
            strength: intentionStrength,
            urgency: strength, // 需求越强越紧急
            source: 'need',
            relatedNeed: needType as NeedType,
          }));
        }
      }
    }

    return generated;
  }

  /**
   * 从事件生成意图
   */
  generateFromEvent(eventType: string, intensity: number, description?: string): Intention[] {
    const generated: Intention[] = [];
    const mappings = this.config.eventToIntentions[eventType];

    if (!mappings) return generated;

    for (const mapping of mappings) {
      const intentionStrength = mapping.baseStrength * intensity;
      if (intentionStrength >= this.config.strengthThresholds[mapping.type]) {
        generated.push(this.createIntention({
          type: mapping.type,
          description: description ?? mapping.description,
          strength: intentionStrength,
          urgency: intensity, // 高冲击事件高紧急
          source: 'event',
          relatedEvent: eventType,
        }));
      }
    }

    return generated;
  }

  /**
   * 从目标生成意图
   */
  generateFromGoal(goal: { id: string; name: string; priority: number }): Intention {
    return this.createIntention({
      type: 'pursue_goal',
      description: `推进目标：${goal.name}`,
      strength: Math.min(1, goal.priority / 10),
      urgency: goal.priority / 10,
      source: 'goal',
      relatedGoalId: goal.id,
    });
  }

  /**
   * 从关系变化生成意图
   */
  generateFromRelation(characterId: string, relationChange: number): Intention[] {
    const generated: Intention[] = [];

    if (relationChange > 0.3) {
      generated.push(this.createIntention({
        type: 'socialize',
        description: `和 ${characterId} 进一步加深关系`,
        strength: relationChange * 0.6,
        urgency: relationChange * 0.4,
        source: 'relation',
        target: characterId,
      }));
    } else if (relationChange < -0.3) {
      generated.push(this.createIntention({
        type: 'confront',
        description: `找 ${characterId} 把话说清楚`,
        strength: Math.abs(relationChange) * 0.5,
        urgency: Math.abs(relationChange) * 0.5,
        source: 'relation',
        target: characterId,
      }));
    }

    return generated;
  }

  /**
   * 添加外部意图
   */
  addIntention(intention: Omit<Intention, 'id' | 'consumed'>): string {
    const id = `int_${++this.idCounter}_${Date.now()}`;
    this.intentions.push({
      ...intention,
      id,
      consumed: false,
    });
    this.sortByUrgency();
    return id;
  }

  /**
   * 批量添加意图
   */
  addIntentions(intentions: Array<Omit<Intention, 'id' | 'consumed'>>): void {
    for (const int of intentions) {
      this.addIntention(int);
    }
  }

  /**
   * 获取当前最高优先级的意图（未被消费的）
   */
  getTopIntention(): Intention | null {
    const active = this.intentions.filter(i => !i.consumed && !this.isExpired(i));
    if (active.length === 0) return null;

    // 按强度 × 紧急度排序
    active.sort((a, b) => (b.strength * b.urgency) - (a.strength * a.urgency));
    return active[0];
  }

  /**
   * 获取所有活跃意图（按优先级排序）
   */
  getActiveIntentions(): Intention[] {
    const active = this.intentions.filter(i => !i.consumed && !this.isExpired(i));
    active.sort((a, b) => (b.strength * b.urgency) - (a.strength * a.urgency));
    return active;
  }

  /**
   * 消费意图
   */
  consume(id: string): void {
    const intention = this.intentions.find(i => i.id === id);
    if (intention) {
      intention.consumed = true;
    }
  }

  /**
   * 清理已过期和被消费的意图
   */
  cleanup(): void {
    const now = Date.now();
    this.intentions = this.intentions.filter(i =>
      !i.consumed && !(i.expiresAt && i.expiresAt < now)
    );
  }

  /**
   * 各类型意图的计数（用于调试）
   */
  getCountsByType(): Record<IntentionType, number> {
    const counts: Record<string, number> = {};
    for (const int of this.intentions.filter(i => !i.consumed)) {
      counts[int.type] = (counts[int.type] ?? 0) + 1;
    }
    return counts as Record<IntentionType, number>;
  }

  /**
   * 清空
   */
  clear(): void {
    this.intentions = [];
  }

  private createIntention(data: Omit<Intention, 'id' | 'consumed'>): Intention {
    return {
      ...data,
      id: `int_${++this.idCounter}_${Date.now()}`,
      consumed: false,
    };
  }

  private isExpired(intention: Intention): boolean {
    if (!intention.expiresAt) return false;
    return Date.now() > intention.expiresAt;
  }

  private sortByUrgency(): void {
    this.intentions.sort((a, b) => b.urgency - a.urgency);
  }
}

export default AgentIntentions;
