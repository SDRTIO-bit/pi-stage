/**
 * attention-manager.ts - 核心运行时注意力管理器
 *
 * Context 不再平权。
 * Token = attention resource。
 *
 * 功能：
 * - attention priority (L0-L7 分层)
 * - salience scoring 集成
 * - context weighting (动态权重调整)
 * - reinforcement control (强化触发)
 * - recency correction (近因校正)
 * - runtime context balancing (运行态平衡)
 *
 * 整合 Phase 1 AttentionManager，升级为：
 * - 情绪显著性注入（emotional salience boost）
 * - 目标显著性注入（goal salience boost）
 * - 强化保护层（reinforcement protection：被保护层只升不降）
 * - 注意力轨迹追踪（attention trace for debug）
 */

export enum AttentionPriority {
  /** 硬规则 - 绝对最高 */
  HARD_RULES = 0,
  /** 当前目标 */
  CURRENT_GOALS = 1,
  /** 当前场景 */
  CURRENT_SCENE = 2,
  /** 工作记忆 */
  WORKING_MEMORY = 3,
  /** 短期记忆 */
  SHORT_TERM_MEMORY = 4,
  /** 活跃知识 */
  ACTIVE_KNOWLEDGE = 5,
  /** 长期记忆 */
  LONG_TERM_MEMORY = 6,
  /** 历史摘要 */
  HISTORY_SUMMARY = 7,
}

/** 注意力层配置 */
export interface AttentionLayerConfig {
  priority: AttentionPriority;
  name: string;
  /** 基础权重（占总 token 预算比例） */
  baseWeight: number;
  /** 最小保留 token */
  minimumTokens: number;
  /** 每轮基础衰减率 */
  baseDecayRate: number;
  /** 是否受强化保护（被保护层注意力只升不降） */
  reinforcementProtected: boolean;
  /** 强化注入间隔（轮数，0=不自动强化） */
  reinforceInterval: number;
  /** 可获得情绪显著性加持 */
  emotionalBoostEnabled: boolean;
  /** 可获得目标显著性加持 */
  goalBoostEnabled: boolean;
  /** 近因校正强度 (0-1) */
  recencyCorrection: number;
}

/** 默认注意力层配置 */
export const DEFAULT_ATTENTION_LAYERS: AttentionLayerConfig[] = [
  {
    priority: AttentionPriority.HARD_RULES,
    name: 'hard_rules',
    baseWeight: 0.10,
    minimumTokens: 300,
    baseDecayRate: 0.0,       // 永不衰减
    reinforcementProtected: true,
    reinforceInterval: 15,
    emotionalBoostEnabled: false,
    goalBoostEnabled: false,
    recencyCorrection: 0.0,
  },
  {
    priority: AttentionPriority.CURRENT_GOALS,
    name: 'current_goals',
    baseWeight: 0.08,
    minimumTokens: 150,
    baseDecayRate: 0.1,       // 缓慢衰减
    reinforcementProtected: true,
    reinforceInterval: 12,
    emotionalBoostEnabled: false,
    goalBoostEnabled: true,   // 受目标显著性加持
    recencyCorrection: 0.1,
  },
  {
    priority: AttentionPriority.CURRENT_SCENE,
    name: 'current_scene',
    baseWeight: 0.12,
    minimumTokens: 300,
    baseDecayRate: 0.1,
    reinforcementProtected: false,
    reinforceInterval: 8,
    emotionalBoostEnabled: true,  // 高强度场景获得加持
    goalBoostEnabled: true,
    recencyCorrection: 0.3,       // 场景有较强近因校正
  },
  {
    priority: AttentionPriority.WORKING_MEMORY,
    name: 'working_memory',
    baseWeight: 0.15,
    minimumTokens: 400,
    baseDecayRate: 0.2,
    reinforcementProtected: false,
    reinforceInterval: 0,
    emotionalBoostEnabled: true,
    goalBoostEnabled: true,
    recencyCorrection: 0.4,       // 工作记忆有最强近因校正
  },
  {
    priority: AttentionPriority.SHORT_TERM_MEMORY,
    name: 'short_term_memory',
    baseWeight: 0.20,
    minimumTokens: 500,
    baseDecayRate: 0.25,
    reinforcementProtected: false,
    reinforceInterval: 0,
    emotionalBoostEnabled: true,
    goalBoostEnabled: true,
    recencyCorrection: 0.3,
  },
  {
    priority: AttentionPriority.ACTIVE_KNOWLEDGE,
    name: 'active_knowledge',
    baseWeight: 0.15,
    minimumTokens: 300,
    baseDecayRate: 0.15,
    reinforcementProtected: false,
    reinforceInterval: 10,
    emotionalBoostEnabled: false,
    goalBoostEnabled: true,
    recencyCorrection: 0.1,
  },
  {
    priority: AttentionPriority.LONG_TERM_MEMORY,
    name: 'long_term_memory',
    baseWeight: 0.12,
    minimumTokens: 0,
    baseDecayRate: 0.35,
    reinforcementProtected: false,
    reinforceInterval: 0,
    emotionalBoostEnabled: true,
    goalBoostEnabled: true,
    recencyCorrection: 0.1,
  },
  {
    priority: AttentionPriority.HISTORY_SUMMARY,
    name: 'history_summary',
    baseWeight: 0.08,
    minimumTokens: 0,
    baseDecayRate: 0.4,
    reinforcementProtected: false,
    reinforceInterval: 0,
    emotionalBoostEnabled: false,
    goalBoostEnabled: false,
    recencyCorrection: 0.1,
  },
];

// ============================================================
// Salience 信号接口（外部注入）
// ============================================================

export interface SalienceSignals {
  /** 各优先级层的情感显著性加成 (0-2, 1=无加成) */
  emotionalBoosts: Partial<Record<AttentionPriority, number>>;
  /** 各优先级层的目标相关性加成 (0-2, 1=无加成) */
  goalBoosts: Partial<Record<AttentionPriority, number>>;
}

// ============================================================
// 注意力状态快照（用于调试/监控/日志）
// ============================================================

export interface AttentionSnapshot {
  turn: number;
  layers: Array<{
    name: string;
    priority: AttentionPriority;
    baseAttention: number;
    finalAttention: number;
    salienceBoosts: {
      emotional: number;
      goal: number;
    };
    recencyCorrection: number;
    turnsSinceReinforce: number;
  }>;
}

// ============================================================
// AttentionManager - 核心运行时注意力管理器
// ============================================================

export class AttentionManager {
  /** 各层当前注意力 (0.0 - 1.0) */
  private attentions: Map<AttentionPriority, number> = new Map();
  /** 各层自上次强化以来的轮次计数 */
  private turnsSinceReinforce: Map<AttentionPriority, number> = new Map();
  /** 各层最终注意力 (包含 salience boost 后的值) */
  private finalAttentions: Map<AttentionPriority, number> = new Map();
  /** 当前轮次 */
  private turnCounter: number = 0;

  /** Salience 信号缓存（每次 tick 时更新） */
  private currentSalienceSignals: SalienceSignals = {
    emotionalBoosts: {},
    goalBoosts: {},
  };

  /** 注意力历史轨迹（用于调试） */
  private attentionHistory: Map<AttentionPriority, number[]> = new Map();
  /** 最大历史轨迹长度 */
  private readonly MAX_HISTORY = 50;

  constructor() {
    this.reset();
  }

  /**
   * 重置所有注意力到初始状态
   */
  reset(): void {
    this.attentions.clear();
    this.finalAttentions.clear();
    this.turnsSinceReinforce.clear();
    this.attentionHistory.clear();
    this.turnCounter = 0;

    for (const layer of DEFAULT_ATTENTION_LAYERS) {
      this.attentions.set(layer.priority, 1.0);
      this.finalAttentions.set(layer.priority, 1.0);
      this.turnsSinceReinforce.set(layer.priority, 0);
      this.attentionHistory.set(layer.priority, []);
    }
  }

  /**
   * 每轮调用：执行注意力衰减 + salience 注入 + 近因校正
   * 
   * @param salienceSignals 外部注入的显著性信号（可选）
   */
  tick(salienceSignals?: SalienceSignals): void {
    this.turnCounter++;

    if (salienceSignals) {
      this.currentSalienceSignals = salienceSignals;
    }

    for (const layer of DEFAULT_ATTENTION_LAYERS) {
      // 1. 基础衰减
      const current = this.attentions.get(layer.priority) ?? 1.0;
      let decayed = current * (1 - layer.baseDecayRate);

      // 2. 强化保护：被保护层只升不降
      if (layer.reinforcementProtected) {
        decayed = Math.max(decayed, current); // 保底不降
      }

      // 3. 目标显著性注入
      if (layer.goalBoostEnabled) {
        const goalBoost = this.currentSalienceSignals.goalBoosts[layer.priority] ?? 1.0;
        decayed *= goalBoost;
      }

      // 4. 情绪显著性注入
      if (layer.emotionalBoostEnabled) {
        const emotionalBoost = this.currentSalienceSignals.emotionalBoosts[layer.priority] ?? 1.0;
        decayed *= emotionalBoost;
      }

      // 5. 近因校正 (recency correction)
      // 近因校正 = (1 - recencyCorrection) + recencyCorrection * (当前轮次新鲜度)
      // 新鲜度 = 轮次越近越高
      if (layer.recencyCorrection > 0) {
        const freshness = 1.0; // 默认为当前轮
        decayed += (1 - layer.recencyCorrection) + layer.recencyCorrection * freshness - decayed;
      }

      // 6. 钳制到 [0.1, 1.0]
      decayed = Math.max(0.1, Math.min(1.0, decayed));

      this.attentions.set(layer.priority, decayed);
      this.finalAttentions.set(layer.priority, decayed);

      // 更新强化计数
      const turns = (this.turnsSinceReinforce.get(layer.priority) ?? 0) + 1;
      this.turnsSinceReinforce.set(layer.priority, turns);

      // 记录历史
      const history = this.attentionHistory.get(layer.priority);
      if (history) {
        history.push(decayed);
        if (history.length > this.MAX_HISTORY) {
          history.shift();
        }
      }
    }
  }

  /**
   * 获取某层的基础注意力（不含 salience）
   */
  getBaseAttention(priority: AttentionPriority): number {
    return this.attentions.get(priority) ?? 1.0;
  }

  /**
   * 获取某层的最终注意力（含所有加成）
   */
  getAttention(priority: AttentionPriority): number {
    return this.finalAttentions.get(priority) ?? 1.0;
  }

  /**
   * 获取所有层的最终注意力
   */
  getAllAttentions(): Map<AttentionPriority, number> {
    return new Map(this.finalAttentions);
  }

  /**
   * 检查某层是否需要强化
   */
  needsReinforce(priority: AttentionPriority): boolean {
    const layer = DEFAULT_ATTENTION_LAYERS.find(l => l.priority === priority);
    if (!layer || layer.reinforceInterval === 0) return false;

    const turns = this.turnsSinceReinforce.get(priority) ?? 0;

    // 检查1：是否到了间隔
    if (turns >= layer.reinforceInterval) return true;

    // 检查2：注意力是否低于 0.5（快速衰减触发）
    const attention = this.getAttention(priority);
    if (attention < 0.4) return true;

    // 检查3：检测注意力快速下降（3轮内降幅 > 30%）
    const history = this.attentionHistory.get(priority);
    if (history && history.length >= 3) {
      const recent = history.slice(-3);
      const declineRate = (recent[0] - recent[2]) / Math.max(recent[0], 0.1);
      if (declineRate > 0.3 && turns >= Math.ceil(layer.reinforceInterval / 2)) {
        return true;
      }
    }

    return false;
  }

  /**
   * 获取所有需要强化的层
   */
  getLayersNeedingReinforce(): AttentionPriority[] {
    return DEFAULT_ATTENTION_LAYERS
      .filter(l => this.needsReinforce(l.priority))
      .map(l => l.priority);
  }

  /**
   * 标记某层已强化（恢复注意力到 1.0）
   */
  markReinforced(priority: AttentionPriority): void {
    this.turnsSinceReinforce.set(priority, 0);
    this.attentions.set(priority, 1.0);
    this.finalAttentions.set(priority, 1.0);
  }

  /**
   * 注入显著性信号（在 tick 前调用）
   */
  injectSalienceSignals(signals: SalienceSignals): void {
    this.currentSalienceSignals = signals;
  }

  /**
   * 获取当前注意力快照（用于监控/调试）
   */
  getSnapshot(): AttentionSnapshot {
    return {
      turn: this.turnCounter,
      layers: DEFAULT_ATTENTION_LAYERS.map(l => ({
        name: l.name,
        priority: l.priority,
        baseAttention: this.getBaseAttention(l.priority),
        finalAttention: this.getAttention(l.priority),
        salienceBoosts: {
          emotional: this.currentSalienceSignals.emotionalBoosts[l.priority] ?? 1.0,
          goal: this.currentSalienceSignals.goalBoosts[l.priority] ?? 1.0,
        },
        recencyCorrection: l.recencyCorrection,
        turnsSinceReinforce: this.turnsSinceReinforce.get(l.priority) ?? 0,
      })),
    };
  }

  /**
   * 获取某层的注意力历史轨迹
   */
  getAttentionHistory(priority: AttentionPriority): number[] {
    return [...(this.attentionHistory.get(priority) ?? [])];
  }

  /**
   * 注意力衰减指数（用于评估整体健康度）
   * 返回所有层注意力的加权平均值
   */
  getHealthIndex(): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const layer of DEFAULT_ATTENTION_LAYERS) {
      const attention = this.getAttention(layer.priority);
      weightedSum += attention * layer.baseWeight;
      totalWeight += layer.baseWeight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }
}

export default AttentionManager;
