/**
 * attention-trace.ts - 注意力系统追踪
 *
 * 追踪 AttentionManager 的所有活动：
 * - 注意力分数变化
 * - 注意力衰减
 * - 显著性注入
 * - 注意力分配
 * - Token Budget 分配
 * - 指令强化触发
 * - 上下文衰减决策
 *
 * 可观察：
 * - 为什么某条信息获得高注意力
 * - 为什么注意力被重新分配
 * - Token 预算为何如此分配
 * - 为什么某条上下文被压缩/保留
 */

import type { AttentionLayer } from '../attention/attention-manager';
import type { SalienceSignal } from '../attention/salience-engine';
import type { BudgetAllocation } from '../attention/token-budget';
import type { DecayDecision } from '../attention/context-decay';
import type { ReinforceResult } from '../attention/instruction-reinforcement';

export type AttentionTraceEventType =
  | 'attention_scored'
  | 'attention_decayed'
  | 'salience_injected'
  | 'recency_corrected'
  | 'reinforcement_protected'
  | 'attention_rebalanced'
  | 'budget_allocated'
  | 'budget_overflow'
  | 'budget_borrowed'
  | 'instruction_reinforced'
  | 'decision_made'
  | 'layer_stats'
  ;

export interface AttentionTraceEntry {
  id: string;
  timestamp: number;
  eventType: AttentionTraceEventType;
  layer?: AttentionLayer;
  /** 注意力变化值 */
  attentionDelta?: number;
  /** 变化前注意力 */
  before?: number;
  /** 变化后注意力 */
  after?: number;
  description: string;
  data: Record<string, any>;
}

export class AttentionTracer {
  private entries: AttentionTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  /**
   * 记录注意力评分
   */
  attentionScored(layer: AttentionLayer, before: number, after: number, reason: string): void {
    this.addEntry({
      eventType: 'attention_scored',
      layer, before, after,
      attentionDelta: after - before,
      description: `L${layer} 注意力: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}% (${reason})`,
      data: { reason },
    });
  }

  /**
   * 记录注意力衰减
   */
  attentionDecayed(layer: AttentionLayer, before: number, after: number, decayRate: number): void {
    this.addEntry({
      eventType: 'attention_decayed',
      layer, before, after,
      attentionDelta: after - before,
      description: `L${layer} 衰减: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}% (速率: ${decayRate})`,
      data: { decayRate },
    });
  }

  /**
   * 记录显著性注入
   */
  salienceInjected(layer: AttentionLayer, before: number, signals: SalienceSignal[]): void {
    const totalBoost = signals.reduce((s, sig) => s + sig.score, 0);
    this.addEntry({
      eventType: 'salience_injected',
      layer, before,
      after: Math.min(1, before + totalBoost),
      attentionDelta: totalBoost,
      description: `L${layer} 显著性注入 +${(totalBoost * 100).toFixed(0)}% (${signals.length} 个信号)`,
      data: { signalCount: signals.length, signals: signals.map(s => ({ type: s.type, score: s.score })) },
    });
  }

  /**
   * 记录近因校正
   */
  recencyCorrected(layer: AttentionLayer, before: number, after: number): void {
    this.addEntry({
      eventType: 'recency_corrected',
      layer, before, after,
      attentionDelta: after - before,
      description: `L${layer} 近因校正: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%`,
      data: {},
    });
  }

  /**
   * 记录强化保护
   */
  reinforcementProtected(layer: AttentionLayer, before: number, ruleId: string): void {
    this.addEntry({
      eventType: 'reinforcement_protected',
      layer, before, after: before,
      description: `L${layer} 受规则 ${ruleId} 保护，阻止衰减`,
      data: { ruleId },
    });
  }

  /**
   * 记录注意力重平衡
   */
  attentionRebalanced(allocations: Array<{ layer: AttentionLayer; before: number; after: number }>): void {
    this.addEntry({
      eventType: 'attention_rebalanced',
      description: `注意力重平衡: ${allocations.map(a => `L${a.layer} ${(a.before * 100).toFixed(0)}→${(a.after * 100).toFixed(0)}%`).join(', ')}`,
      data: { allocations },
    });
  }

  /**
   * 记录 Token Budget 分配
   */
  budgetAllocated(allocation: BudgetAllocation[]): void {
    this.addEntry({
      eventType: 'budget_allocated',
      description: `Token 预算分配: ${allocation.map(a => `L${a.layer} ${a.tokens}t`).join(', ')}`,
      data: { allocation },
    });
  }

  /**
   * 记录 Budget 溢出处理
   */
  budgetOverflow(layer: AttentionLayer, overflow: number, strategy: string): void {
    this.addEntry({
      eventType: 'budget_overflow',
      layer,
      description: `L${layer} Token 溢出 ${overflow}，策略: ${strategy}`,
      data: { overflow, strategy },
    });
  }

  /**
   * 记录 Budget 借用
   */
  budgetBorrowed(fromLayer: AttentionLayer, toLayer: AttentionLayer, tokens: number): void {
    this.addEntry({
      eventType: 'budget_borrowed',
      description: `L${fromLayer} 借出 ${tokens} Token 给 L${toLayer}`,
      data: { fromLayer, toLayer, tokens },
    });
  }

  /**
   * 记录指令强化
   */
  instructionReinforced(result: ReinforceResult): void {
    this.addEntry({
      eventType: 'instruction_reinforced',
      description: `强化规则 ${result.ruleId} (变体: ${result.variantIndex}) — ${result.triggerReason}`,
      data: result,
    });
  }

  /**
   * 记录上下文衰减决策
   */
  decisionMade(decision: DecayDecision, contentId: string): void {
    this.addEntry({
      eventType: 'decision_made',
      description: `决策 [${contentId}]: ${decision.action} (置信度: ${(decision.confidence * 100).toFixed(0)}%)`,
      data: { contentId, decision },
    });
  }

  /**
   * 记录层统计
   */
  layerStats(layer: AttentionLayer, attention: number, tokenCount: number, contentCount: number): void {
    this.addEntry({
      eventType: 'layer_stats',
      layer,
      description: `L${layer}: attention=${(attention * 100).toFixed(0)}%, tokens=${tokenCount}, contents=${contentCount}`,
      data: { attention, tokenCount, contentCount },
    });
  }

  /**
   * 获取追踪条目
   */
  getEntries(filter?: {
    eventType?: AttentionTraceEventType;
    layer?: AttentionLayer;
    limit?: number;
  }): AttentionTraceEntry[] {
    let result = [...this.entries];

    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.layer !== undefined) result = result.filter(e => e.layer === filter.layer);

    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  /**
   * 获取注意力追踪摘要
   */
  getAttentionSummary(): string {
    const byLayer: Record<number, { count: number; totalDelta: number }> = {};
    for (const e of this.entries) {
      if (e.layer === undefined) continue;
      if (!byLayer[e.layer]) byLayer[e.layer] = { count: 0, totalDelta: 0 };
      byLayer[e.layer].count++;
      byLayer[e.layer].totalDelta += e.attentionDelta ?? 0;
    }

    const lines = [
      `=== Attention Trace 摘要 ===`,
      `总追踪条目: ${this.entries.length}`,
      ``,
      `各层注意力变化:`,
    ];

    for (let l = 0; l <= 7; l++) {
      const s = byLayer[l];
      if (s) {
        const avgDelta = s.totalDelta / s.count;
        lines.push(`  L${l}: ${s.count} 次变化 | 平均 Δ${(avgDelta * 100).toFixed(1)}%`);
      }
    }

    const reinforced = this.entries.filter(e => e.eventType === 'instruction_reinforced');
    if (reinforced.length > 0) {
      lines.push(``, `指令强化: ${reinforced.length} 次`);
      lines.push(...reinforced.slice(-5).map(e =>
        `  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.description}`
      ));
    }

    return lines.join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
  }

  private addEntry(data: Omit<AttentionTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({
      id: `attrace_${++this.idCounter}`,
      timestamp: Date.now(),
      ...data,
    });

    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(-this.MAX_ENTRIES);
    }
  }
}

export default AttentionTracer;
