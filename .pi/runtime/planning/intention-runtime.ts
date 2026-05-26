/**
 * intention-runtime.ts - 意图运行时
 *
 * Intentions 是更细粒度的"即将执行的动作意图"，直接绑定到行为输出。
 * 介于 Goal（长期/中期）和 Action（即时执行）之间。
 *
 * 意图类型：
 * - Short-term intention：接下来几句话内就要做的事
 * - Hidden intention：不显式表达，但影响内部选择（如欺骗）
 * - Reactive intention：对外部刺激的即时响应意图
 * - Proactive intention：主动发起的意图，源于长期目标
 *
 * 与 Context Assembly 整合：
 * - Collect 阶段：Intentions 作为高优先级记忆项被检索
 * - Assemble 阶段：当前 Intentions 摘要写入 system 或 memory 分区
 * - Reinforce 阶段：Intentions 作为强注意力锚点被注入
 *
 * 与 DecisionEngine 整合：
 * - Intentions 提供"当前最紧迫要做的事"
 * - DecisionEngine 选择具体 Action 时参考 Intentions 排序
 */

import type { EventBus } from '../events/event-bus';

// ============================================================
// 类型定义
// ============================================================

export type IntentionType = 'short_term' | 'hidden' | 'reactive' | 'proactive';
export type IntentionStatus = 'pending' | 'active' | 'executing' | 'completed' | 'failed' | 'superseded';

export interface Intention {
  id: string;
  type: IntentionType;
  description: string;
  status: IntentionStatus;
  /** 强度 0-1 */
  strength: number;
  /** 紧急度 0-1 */
  urgency: number;
  /** 关联目标 ID */
  relatedGoalId?: string;
  /** 关联的计划步骤 ID */
  relatedStepId?: string;
  /** 是否有外部表现（hidden=false 表示应体现在行为中） */
  isExplicit: boolean;
  /** 意图来源 */
  source: 'goal' | 'emotion' | 'event' | 'relation' | 'decision' | 'external';
  /** 过期时间戳 */
  expiresAt?: number;
  /** 创建时间 */
  createdAt: number;
  /** 执行结果摘要 */
  result?: string;
}

export interface IntentionRuntimeConfig {
  /** 最大活跃意图数 */
  maxActiveIntentions: number;
  /** 默认过期时间（毫秒），0 表示永不过期 */
  defaultExpiryMs: number;
  /** 意图强度衰减率（每 tick） */
  decayRate: number;
  /** 是否自动清理过期意图 */
  autoCleanup: boolean;
}

const DEFAULT_INTENTION_CONFIG: IntentionRuntimeConfig = {
  maxActiveIntentions: 10,
  defaultExpiryMs: 60000,  // 1 分钟
  decayRate: 0.05,
  autoCleanup: true,
};

// ============================================================
// IntentionRuntime 实现
// ============================================================

export class IntentionRuntime {
  private intentions: Intention[] = [];
  private config: IntentionRuntimeConfig;
  private eventBus: EventBus | null;
  private idCounter: number = 0;

  constructor(config?: Partial<IntentionRuntimeConfig>, eventBus?: EventBus) {
    this.config = { ...DEFAULT_INTENTION_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
  }

  // ============================================================
  // 意图管理
  // ============================================================

  /**
   * 创建新意图
   */
  createIntention(params: {
    type: IntentionType;
    description: string;
    strength: number;
    urgency: number;
    isExplicit?: boolean;
    source: Intention['source'];
    relatedGoalId?: string;
    relatedStepId?: string;
    expiresAt?: number;
  }): string {
    const id = `intent_${++this.idCounter}_${Date.now()}`;

    const intention: Intention = {
      id,
      type: params.type,
      description: params.description,
      status: 'pending',
      strength: Math.max(0, Math.min(1, params.strength)),
      urgency: Math.max(0, Math.min(1, params.urgency)),
      isExplicit: params.isExplicit ?? true,
      source: params.source,
      relatedGoalId: params.relatedGoalId,
      relatedStepId: params.relatedStepId,
      expiresAt: params.expiresAt ?? (
        this.config.defaultExpiryMs > 0
          ? Date.now() + this.config.defaultExpiryMs
          : undefined
      ),
      createdAt: Date.now(),
    };

    this.intentions.push(intention);

    // 限制数量
    if (this.intentions.length > this.config.maxActiveIntentions) {
      this.evictLowestPriority();
    }

    this.eventBus?.emit('intention:created', {
      intentionId: id,
      type: params.type,
      description: params.description,
      strength: params.strength,
    });

    return id;
  }

  /**
   * 从目标创建意图
   */
  createFromGoal(goalId: string, description: string, priority: number): string {
    return this.createIntention({
      type: 'proactive',
      description,
      strength: priority,
      urgency: priority * 0.8,
      source: 'goal',
      relatedGoalId: goalId,
    });
  }

  /**
   * 从情绪创建意图
   */
  createFromEmotion(emotion: string, intensity: number, description: string): string {
    let type: IntentionType = 'reactive';
    let isExplicit = true;

    if (emotion === 'fearful') {
      type = 'reactive';
      isExplicit = true; // 恐惧反应通常外显
    } else if (emotion === 'angry') {
      type = 'reactive';
      isExplicit = true;
    } else if (emotion === 'sad') {
      type = 'short_term';
      isExplicit = true;
    } else if (emotion === 'happy') {
      type = 'proactive';
      isExplicit = true;
    }

    return this.createIntention({
      type,
      description,
      strength: intensity,
      urgency: intensity > 0.7 ? intensity * 1.2 : intensity,
      isExplicit,
      source: 'emotion',
    });
  }

  /**
   * 从事件创建意图
   */
  createFromEvent(eventType: string, intensity: number, description: string): string {
    return this.createIntention({
      type: 'reactive',
      description,
      strength: intensity * 0.8,
      urgency: intensity,
      source: 'event',
    });
  }

  /**
   * 创建隐藏意图（不显式表达）
   */
  createHiddenIntention(description: string, strength: number, urgency: number): string {
    return this.createIntention({
      type: 'hidden',
      description,
      strength,
      urgency,
      isExplicit: false,
      source: 'goal',
    });
  }

  // ============================================================
  // 意图执行
  // ============================================================

  /**
   * 标记意图为执行中
   */
  markExecuting(intentionId: string): void {
    const intent = this.intentions.find(i => i.id === intentionId);
    if (intent) {
      intent.status = 'executing';
      this.eventBus?.emit('intention:executing', {
        intentionId,
        description: intent.description,
      });
    }
  }

  /**
   * 标记意图为完成
   */
  markCompleted(intentionId: string, result?: string): void {
    const intent = this.intentions.find(i => i.id === intentionId);
    if (intent) {
      intent.status = 'completed';
      intent.result = result;
      this.eventBus?.emit('intention:completed', {
        intentionId,
        description: intent.description,
        result,
      });
    }
  }

  /**
   * 标记意图为失败
   */
  markFailed(intentionId: string, reason?: string): void {
    const intent = this.intentions.find(i => i.id === intentionId);
    if (intent) {
      intent.status = 'failed';
      intent.result = reason;
      this.eventBus?.emit('intention:failed', {
        intentionId,
        description: intent.description,
        reason,
      });
    }
  }

  // ============================================================
  // 主 tick
  // ============================================================

  /**
   * 每 tick 调用：意图衰减、过期清理、状态推进
   */
  tick(): void {
    // 1. 强度衰减
    for (const intent of this.intentions) {
      if (intent.status === 'pending' || intent.status === 'active') {
        intent.strength = Math.max(0, intent.strength - this.config.decayRate);
        // 强度过低自动失败
        if (intent.strength < 0.1) {
          intent.status = 'failed';
          intent.result = '强度衰减至忽略';
        }
      }
    }

    // 2. 过期清理
    if (this.config.autoCleanup) {
      this.cleanup();
    }

    // 3. 激活待处理的意图（强度足够的）
    for (const intent of this.intentions) {
      if (intent.status === 'pending' && intent.strength > 0.3) {
        intent.status = 'active';
      }
    }
  }

  /**
   * 清理过期和已完成的意图
   */
  cleanup(): void {
    const now = Date.now();
    this.intentions = this.intentions.filter(i =>
      i.status !== 'completed' &&
      i.status !== 'failed' &&
      i.status !== 'superseded' &&
      !(i.expiresAt && i.expiresAt < now)
    );
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取最高优先级的意图
   */
  getTopIntention(): Intention | null {
    const active = this.getActiveIntentions();
    if (active.length === 0) return null;
    return active[0];
  }

  /**
   * 获取所有活跃意图（按 urgency * strength 排序）
   */
  getActiveIntentions(): Intention[] {
    return this.intentions
      .filter(i => i.status === 'active' || i.status === 'executing')
      .sort((a, b) => (b.urgency * b.strength) - (a.urgency * a.strength));
  }

  /**
   * 获取显式意图（将有外部表现的）
   */
  getExplicitIntentions(): Intention[] {
    return this.getActiveIntentions().filter(i => i.isExplicit);
  }

  /**
   * 获取隐藏意图
   */
  getHiddenIntentions(): Intention[] {
    return this.getActiveIntentions().filter(i => !i.isExplicit && i.type === 'hidden');
  }

  /**
   * 获取特定目标的意图
   */
  getIntentionsByGoal(goalId: string): Intention[] {
    return this.intentions.filter(i => i.relatedGoalId === goalId);
  }

  /**
   * 获取意图摘要（用于 Context Assembly 注入）
   */
  getIntentionsSummary(): string {
    const active = this.getActiveIntentions();
    if (active.length === 0) return '';

    const explicit = active.filter(i => i.isExplicit);
    const hidden = active.filter(i => !i.isExplicit);

    const lines: string[] = ['## 当前意图'];

    if (explicit.length > 0) {
      lines.push('显式意图:');
      lines.push(...explicit.map((i, idx) =>
        `  ${idx + 1}. ${i.description} [${i.type}]`
      ));
    }

    if (hidden.length > 0) {
      lines.push('（内部倾向）:');
      lines.push(...hidden.map((i, idx) =>
        `  ${idx + 1}. ${i.description}`
      ));
    }

    return lines.join('\n');
  }

  /**
   * 检查是否有某种类型的活跃意图
   */
  hasActiveIntention(type: IntentionType, keyword?: string): boolean {
    return this.intentions.some(i =>
      (i.status === 'active' || i.status === 'executing') &&
      i.type === type &&
      (keyword ? i.description.includes(keyword) : true)
    );
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 移除最低优先级的意图
   */
  private evictLowestPriority(): void {
    const sorted = [...this.intentions]
      .filter(i => i.status === 'pending' || i.status === 'active')
      .sort((a, b) => (a.urgency * a.strength) - (b.urgency * b.strength));

    if (sorted.length > 0) {
      const toRemove = sorted[0];
      toRemove.status = 'superseded';
      this.eventBus?.emit('intention:superseded', {
        intentionId: toRemove.id,
        description: toRemove.description,
      });
    }
  }

  /**
   * 获取统计
   */
  getStats(): IntentionRuntimeStats {
    return {
      total: this.intentions.length,
      byStatus: {
        pending: this.intentions.filter(i => i.status === 'pending').length,
        active: this.intentions.filter(i => i.status === 'active').length,
        executing: this.intentions.filter(i => i.status === 'executing').length,
        completed: this.intentions.filter(i => i.status === 'completed').length,
        failed: this.intentions.filter(i => i.status === 'failed').length,
        superseded: this.intentions.filter(i => i.status === 'superseded').length,
      },
      byType: {
        short_term: this.intentions.filter(i => i.type === 'short_term').length,
        hidden: this.intentions.filter(i => i.type === 'hidden').length,
        reactive: this.intentions.filter(i => i.type === 'reactive').length,
        proactive: this.intentions.filter(i => i.type === 'proactive').length,
      },
    };
  }

  /**
   * 重置
   */
  reset(): void {
    this.intentions = [];
    this.idCounter = 0;
  }
}

export interface IntentionRuntimeStats {
  total: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

export default IntentionRuntime;
