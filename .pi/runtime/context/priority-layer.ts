/**
 * Context Assembly Engine - 上下文优先级分层
 *
 * 定义了 8 层优先级结构，每层有独立的：
 * - 权重（token 分配比例）
 * - 衰减率（注意力随轮次衰减）
 * - 压缩策略（何时/如何压缩）
 * - 强化间隔（何时需要重复注入）
 */

import { ContextPriority } from './context-controller';

// ============================================================
// 优先级层定义
// ============================================================

export interface PriorityLayer {
  /** 优先级编号 */
  priority: ContextPriority;
  /** 层级名称 */
  name: string;
  /** Token 分配权重（占总预算的比例） */
  weight: number;
  /** 最小保留 token，即使压缩也不能低于此值 */
  minimumTokens: number;
  /** 每轮注意力衰减率（0=不衰减，1=全衰减） */
  attentionDecayRate: number;
  /** 强化注入周期（0=不自动强化） */
  reinforceInterval: number; // 轮数
  /** 压缩策略 */
  compression: CompressionStrategy;
  /** 是否允许从下层借用 token */
  canBorrowDown: boolean;
  /** 是否允许被上层借用 token */
  canBeBorrowedByUp: boolean;
  /** 来源标识 */
  source: string;
}

export type CompressionStrategy =
  /** 不压缩 */
  | 'none'
  /** 截断（从尾部切） */
  | 'truncate'
  /** 摘要（AI 生成摘要替代） */
  | 'summarize'
  /** 选择（保留最重要部分） */
  | 'select'
  /** 替换为占位符 */
  | 'placeholder';

// ============================================================
// 8 层优先级定义
// ============================================================

export const PRIORITY_LAYERS: ReadonlyArray<PriorityLayer> = [
  // ─── Layer 0: 系统规则 ───
  {
    priority: ContextPriority.SYSTEM_RULES,
    name: 'system_rules',
    weight: 0.08,
    minimumTokens: 200,
    attentionDecayRate: 0,       // 永不衰减
    reinforceInterval: 20,       // 每 20 轮强化一次
    compression: 'none',         // 永不压缩
    canBorrowDown: true,         // 可以借用下层
    canBeBorrowedByUp: false,    // 不能被上层借用
    source: 'agent_blueprint_identity',
  },
  // ─── Layer 1: 运行时状态 ───
  {
    priority: ContextPriority.RUNTIME_STATE,
    name: 'runtime_state',
    weight: 0.10,
    minimumTokens: 300,
    attentionDecayRate: 0.1,     // 缓慢衰减
    reinforceInterval: 10,
    compression: 'truncate',
    canBorrowDown: true,
    canBeBorrowedByUp: false,
    source: 'agent_state_world_state',
  },
  // ─── Layer 2: 当前目标/需求 ───
  {
    priority: ContextPriority.ACTIVE_GOALS,
    name: 'active_goals',
    weight: 0.07,
    minimumTokens: 150,
    attentionDecayRate: 0.15,
    reinforceInterval: 15,
    compression: 'select',       // 只保留最重要的目标
    canBorrowDown: true,
    canBeBorrowedByUp: false,
    source: 'goal_system',
  },
  // ─── Layer 3: 活跃世界知识 ───
  {
    priority: ContextPriority.ACTIVE_KNOWLEDGE,
    name: 'active_knowledge',
    weight: 0.20,
    minimumTokens: 500,
    attentionDecayRate: 0.2,
    reinforceInterval: 15,
    compression: 'summarize',    // 世界书条目可摘要
    canBorrowDown: true,
    canBeBorrowedByUp: true,     // 可被上层借用
    source: 'knowledge_layer',
  },
  // ─── Layer 4: 短期记忆 ───
  {
    priority: ContextPriority.SHORT_TERM_MEMORY,
    name: 'short_term_memory',
    weight: 0.25,
    minimumTokens: 800,
    attentionDecayRate: 0.3,     // 较快衰减
    reinforceInterval: 0,        // 不自动强化
    compression: 'truncate',
    canBorrowDown: true,
    canBeBorrowedByUp: true,
    source: 'episodic_memory_recent',
  },
  // ─── Layer 5: 长期记忆 ───
  {
    priority: ContextPriority.LONG_TERM_MEMORY,
    name: 'long_term_memory',
    weight: 0.15,
    minimumTokens: 0,
    attentionDecayRate: 0.4,
    reinforceInterval: 0,
    compression: 'summarize',
    canBorrowDown: false,
    canBeBorrowedByUp: true,
    source: 'semantic_memory_episodic_old',
  },
  // ─── Layer 6: 历史摘要 ───
  {
    priority: ContextPriority.HISTORY_SUMMARY,
    name: 'history_summary',
    weight: 0.10,
    minimumTokens: 0,
    attentionDecayRate: 0.5,     // 快速衰减
    reinforceInterval: 0,
    compression: 'placeholder',  // 可用占位符替代
    canBorrowDown: false,
    canBeBorrowedByUp: true,
    source: 'compress_history',
  },
  // ─── Layer 7: 用户输入 ───
  {
    priority: ContextPriority.USER_INPUT,
    name: 'user_input',
    weight: 0.05,
    minimumTokens: 100,
    attentionDecayRate: 0,       // 用户输入始终新鲜
    reinforceInterval: 0,
    compression: 'none',
    canBorrowDown: false,
    canBeBorrowedByUp: false,
    source: 'user_message',
  },
];

// ============================================================
// 注意力衰减计算
// ============================================================

export class AttentionManager {
  /** 各层的注意力权重（初始值 = 1.0） */
  private attentions: Map<ContextPriority, number> = new Map();
  /** 自上次强化以来的轮次计数 */
  private turnsSinceReinforce: Map<ContextPriority, number> = new Map();

  constructor() {
    for (const layer of PRIORITY_LAYERS) {
      this.attentions.set(layer.priority, 1.0);
      this.turnsSinceReinforce.set(layer.priority, 0);
    }
  }

  /**
   * 每轮调用：衰减所有层级的注意力
   */
  tick(): void {
    for (const layer of PRIORITY_LAYERS) {
      const current = this.attentions.get(layer.priority) ?? 1.0;
      const decayed = current * (1 - layer.attentionDecayRate);
      this.attentions.set(layer.priority, decayed);

      const turns = (this.turnsSinceReinforce.get(layer.priority) ?? 0) + 1;
      this.turnsSinceReinforce.set(layer.priority, turns);
    }
  }

  /**
   * 获取某层的当前注意力权重
   * 注意力越低，该层在最终 prompt 中的可见比例越低
   */
  getAttention(priority: ContextPriority): number {
    return this.attentions.get(priority) ?? 1.0;
  }

  /**
   * 检查某层是否需要强化注入
   */
  needsReinforce(priority: ContextPriority): boolean {
    const layer = PRIORITY_LAYERS.find(l => l.priority === priority);
    if (!layer || layer.reinforceInterval === 0) return false;

    const turns = this.turnsSinceReinforce.get(priority) ?? 0;
    return turns >= layer.reinforceInterval;
  }

  /**
   * 标记某层已强化
   */
  markReinforced(priority: ContextPriority): void {
    this.turnsSinceReinforce.set(priority, 0);
    // 强化后注意力恢复到 1.0
    this.attentions.set(priority, 1.0);
  }

  /**
   * 获取所有需要强化的层
   */
  getLayersNeedingReinforce(): ContextPriority[] {
    const result: ContextPriority[] = [];
    for (const layer of PRIORITY_LAYERS) {
      if (this.needsReinforce(layer.priority)) {
        result.push(layer.priority);
      }
    }
    return result;
  }

  /**
   * 重置所有注意力
   */
  reset(): void {
    for (const layer of PRIORITY_LAYERS) {
      this.attentions.set(layer.priority, 1.0);
      this.turnsSinceReinforce.set(layer.priority, 0);
    }
  }
}

// ============================================================
// 预算计算器
// ============================================================

export class BudgetCalculator {
  /**
   * 根据当前注意力分配实际 token 预算
   * 
   * 核心逻辑：
   * 1. 基础分配 = 权重 × 总预算
   * 2. 注意力调整 = 基础分配 × 当前注意力
   * 3. 注意力释放的 token 重新分配给高注意力层
   */
  static calculate(
    totalBudget: number,
    attentionManager: AttentionManager
  ): Map<ContextPriority, number> {
    const baseAllocations = new Map<ContextPriority, number>();
    let totalWeight = 0;

    // 第一步：基础分配
    for (const layer of PRIORITY_LAYERS) {
      totalWeight += layer.weight;
    }

    for (const layer of PRIORITY_LAYERS) {
      const base = Math.floor(totalBudget * (layer.weight / totalWeight));
      baseAllocations.set(layer.priority, base);
    }

    // 第二步：注意力调整
    const adjusted = new Map<ContextPriority, number>();
    let freedTokens = 0;

    for (const layer of PRIORITY_LAYERS) {
      const base = baseAllocations.get(layer.priority) ?? 0;
      const attention = attentionManager.getAttention(layer.priority);
      const adjustedAmount = Math.floor(base * attention);

      adjusted.set(layer.priority, adjustedAmount);

      // 注意力衰减释放的 token
      if (attention < 1.0) {
        freedTokens += base - adjustedAmount;
      }
    }

    // 第三步：将释放的 token 重新分配给注意力高的层
    if (freedTokens > 0) {
      const highAttentionLayers = PRIORITY_LAYERS
        .filter(l => attentionManager.getAttention(l.priority) >= 0.8)
        .sort((a, b) => a.priority - b.priority);

      const totalHighAttentionWeight = highAttentionLayers.reduce(
        (sum, l) => sum + l.weight, 0
      );

      if (totalHighAttentionWeight > 0) {
        for (const layer of highAttentionLayers) {
          const current = adjusted.get(layer.priority) ?? 0;
          const extra = Math.floor(freedTokens * (layer.weight / totalHighAttentionWeight));
          adjusted.set(layer.priority, current + extra);
        }
      }
    }

    // 第四步：确保不低于最小保留
    for (const layer of PRIORITY_LAYERS) {
      const current = adjusted.get(layer.priority) ?? 0;
      if (current < layer.minimumTokens) {
        adjusted.set(layer.priority, layer.minimumTokens);
      }
    }

    return adjusted;
  }
}

export default PRIORITY_LAYERS;
