/**
 * token-budget.ts - Token 预算运行时
 *
 * Token 是 attention resource。
 * 不再"全部发送"，而是"动态分配"。
 *
 * 功能：
 * - system rules 保底
 * - runtime memory 按需
 * - goals 按优先级
 * - active knowledge 按相关性
 * - scene memory 按场景
 * - dialogue history 按注意力
 * - long-term memory 按显著性
 *
 * 支持：
 * - adaptive truncation（自适应截断）
 * - weighted allocation（加权分配）
 * - overflow handling（溢出处理）
 * - hard reserve area（系统规则硬性保底）
 * - memory compression fallback（记忆压缩回退）
 */

import { AttentionManager, AttentionPriority, DEFAULT_ATTENTION_LAYERS } from './attention-manager';

// ============================================================
// 预算分配结果
// ============================================================

export interface BudgetAllocation {
  /** 各层分配的 token 预算 */
  layers: Map<AttentionPriority, number>;
  /** 总预算 */
  total: number;
  /** 剩余未分配 token */
  unallocated: number;
  /** 被溢出压缩的层 */
  overflowed: AttentionPriority[];
  /** 是否启用了压缩回退 */
  compressionFallbackUsed: boolean;
  /** 保底保留区消耗 */
  reservedUsed: number;
}

export interface TokenBudgetConfig {
  /** 模型最大上下文 token 数 */
  modelMaxTokens: number;
  /** 安全余量（保留给 LLM 输出） */
  safetyMargin: number;
  /** 硬性保底 token（分配给 system rules 的最小值） */
  hardReserve: number;
  /** 是否启用溢出处理 */
  enableOverflowHandling: boolean;
  /** 是否启用压缩回退 */
  enableCompressionFallback: boolean;
  /** 各层自定义权重覆盖（可选） */
  customWeights?: Partial<Record<AttentionPriority, number>>;
}

/** 默认配置 */
export const DEFAULT_TOKEN_BUDGET_CONFIG: TokenBudgetConfig = {
  modelMaxTokens: 128000,
  safetyMargin: 4000,
  hardReserve: 2000,         // 系统规则保底 2000 token
  enableOverflowHandling: true,
  enableCompressionFallback: true,
};

// ============================================================
// TokenBudget Runtime
// ============================================================

export class TokenBudget {
  private config: TokenBudgetConfig;
  private attentionManager: AttentionManager;

  /** 各层的当前预算 */
  private allocations: Map<AttentionPriority, number> = new Map();
  /** 各层的实际消耗 */
  private consumption: Map<AttentionPriority, number> = new Map();

  constructor(
    attentionManager: AttentionManager,
    config?: Partial<TokenBudgetConfig>
  ) {
    this.attentionManager = attentionManager;
    this.config = { ...DEFAULT_TOKEN_BUDGET_CONFIG, ...config };
  }

  /**
   * 核心方法：重新计算所有层的预算分配
   * 每轮调用一次
   */
  allocate(): BudgetAllocation {
    const totalBudget = this.config.modelMaxTokens - this.config.safetyMargin;
    const layers = new Map<AttentionPriority, number>();
    const overflowed: AttentionPriority[] = [];

    // ── 阶段 1: 硬性保底 ──
    // 硬规则层（L0）获取硬性保底
    const hardReserveLayer = DEFAULT_ATTENTION_LAYERS.find(
      l => l.priority === AttentionPriority.HARD_RULES
    );
    let reservedUsed = 0;
    if (hardReserveLayer) {
      const reserve = Math.max(
        hardReserveLayer.minimumTokens,
        this.config.hardReserve
      );
      layers.set(AttentionPriority.HARD_RULES, reserve);
      reservedUsed = reserve;
    }

    // ── 阶段 2: 按注意力加权分配 ──
    const remainingAfterReserve = totalBudget - reservedUsed;
    let totalWeightedScore = 0;
    const layerScores: Array<{
      priority: AttentionPriority;
      score: number;
      minimum: number;
    }> = [];

    for (const layer of DEFAULT_ATTENTION_LAYERS) {
      if (layer.priority === AttentionPriority.HARD_RULES) continue; // 已分配

      const attention = this.attentionManager.getAttention(layer.priority);
      const customWeight = this.config.customWeights?.[layer.priority] ?? layer.baseWeight;
      const score = customWeight * attention; // 加权 = 权重 × 当前注意力
      totalWeightedScore += score;

      layerScores.push({
        priority: layer.priority,
        score,
        minimum: layer.minimumTokens,
      });
    }

    // ── 阶段 3: 按比例分配 ──
    for (const { priority, score, minimum } of layerScores) {
      let allocated = Math.floor(remainingAfterReserve * (score / totalWeightedScore));
      // 确保不低于最小保底
      allocated = Math.max(allocated, minimum);
      layers.set(priority, allocated);
    }

    // ── 阶段 4: 检查总和不溢出 ──
    let totalAllocated = 0;
    for (const [, amount] of layers) {
      totalAllocated += amount;
    }

    let unallocated = totalBudget - totalAllocated;

    // 如果有剩余，按比例分配到所有层
    if (unallocated > 0 && layerScores.length > 0) {
      for (const { priority } of layerScores) {
        const current = layers.get(priority) ?? 0;
        const proportion = current / totalAllocated;
        const extra = Math.floor(unallocated * proportion);
        layers.set(priority, current + extra);
      }
    }

    // ── 阶段 5: 溢出处理 ──
    if (this.config.enableOverflowHandling) {
      totalAllocated = 0;
      for (const [, amount] of layers) {
        totalAllocated += amount;
      }
      if (totalAllocated > totalBudget) {
        overflowed.push(...this.handleOverflow(layers, totalBudget));
      }
    }

    // 重新计算最终值
    let finalTotal = 0;
    for (const [, amount] of layers) {
      finalTotal += amount;
    }
    const finalUnallocated = totalBudget - finalTotal;

    this.allocations = layers;

    return {
      layers,
      total: totalBudget,
      unallocated: finalUnallocated,
      overflowed,
      compressionFallbackUsed: false,
      reservedUsed,
    };
  }

  /**
   * 溢出处理：超出总预算时收窄
   * 策略：按优先级从低到高削减，确保 L0/L1 不受影响
   */
  private handleOverflow(
    layers: Map<AttentionPriority, number>,
    maxTotal: number
  ): AttentionPriority[] {
    let total = 0;
    for (const [, amount] of layers) {
      total += amount;
    }
    let excess = total - maxTotal;
    if (excess <= 0) return [];

    const overflowed: AttentionPriority[] = [];

    // 按优先级从低到高排序
    const sortedLayers = [...DEFAULT_ATTENTION_LAYERS]
      .sort((a, b) => b.priority - a.priority) // 低优先级在前
      .filter(l => l.priority !== AttentionPriority.HARD_RULES); // 保护 L0

    for (const layer of sortedLayers) {
      if (excess <= 0) break;

      const current = layers.get(layer.priority) ?? 0;
      const minimum = layer.minimumTokens;
      const reducible = current - minimum;

      if (reducible <= 0) continue;

      const cut = Math.min(reducible, excess);
      layers.set(layer.priority, current - cut);
      excess -= cut;
      overflowed.push(layer.priority);
    }

    return overflowed;
  }

  /**
   * 获取某层的分配预算
   */
  getAllocation(priority: AttentionPriority): number {
    return this.allocations.get(priority) ?? 0;
  }

  /**
   * 获取所有层的预算分配
   */
  getAllAllocations(): Map<AttentionPriority, number> {
    return new Map(this.allocations);
  }

  /**
   * 记录某层的实际消耗
   */
  recordConsumption(priority: AttentionPriority, tokens: number): void {
    this.consumption.set(priority, tokens);
  }

  /**
   * 获取给定层的预算利用率 (0-1)
   * 用于判断是否需要压缩
   */
  getUtilization(priority: AttentionPriority): number {
    const allocated = this.allocations.get(priority) ?? 0;
    const consumed = this.consumption.get(priority) ?? 0;
    if (allocated <= 0) return 1;
    return Math.min(1, consumed / allocated);
  }

  /**
   * 检查某层是否需要压缩回退
   */
  needsCompressionFallback(priority: AttentionPriority): boolean {
    if (!this.config.enableCompressionFallback) return false;
    return this.getUtilization(priority) > 1.0;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<TokenBudgetConfig>): void {
    Object.assign(this.config, config);
  }

  /**
   * 当前预算快照（用于监控/调试）
   */
  getSnapshot(): {
    modelMaxTokens: number;
    safetyMargin: number;
    effectiveBudget: number;
    hardReserve: number;
    allocations: Array<{
      priority: string;
      tokens: number;
      consumption: number;
      utilization: number;
    }>;
  } {
    const effectiveBudget = this.config.modelMaxTokens - this.config.safetyMargin;
    const allocations = DEFAULT_ATTENTION_LAYERS.map(l => {
      const tokens = this.allocations.get(l.priority) ?? 0;
      const consumption = this.consumption.get(l.priority) ?? 0;
      return {
        priority: l.name,
        tokens,
        consumption,
        utilization: tokens > 0 ? consumption / tokens : 0,
      };
    });

    return {
      modelMaxTokens: this.config.modelMaxTokens,
      safetyMargin: this.config.safetyMargin,
      effectiveBudget,
      hardReserve: this.config.hardReserve,
      allocations,
    };
  }
}

export default TokenBudget;
