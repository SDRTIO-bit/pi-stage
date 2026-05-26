/**
 * Attention Runtime - 统一导出
 *
 * 组成：
 * - attention-manager.ts   核心运行时注意力管理器
 * - token-budget.ts        Token 预算运行时
 * - salience-engine.ts     显著性计算引擎（独立升级）
 * - instruction-reinforcement.ts 指令强化系统（独立升级）
 * - context-decay.ts       上下文衰减模型（独立升级）
 *
 * Phase 2 与 Phase 1 的关系：
 * Phase 1（.pi/runtime/context/）提供了基础上下文装配管道。
 * Phase 2（.pi/runtime/attention/）提供注意力管理运行时。
 *
 * 使用示例：
 *   import { AttentionRuntime } from '../attention';
 *   const runtime = new AttentionRuntime(config);
 *   runtime.tick();   // 每轮调用
 *   runtime.assemble(); // 装配注意力感知的上下文
 */

export { AttentionManager, AttentionPriority, DEFAULT_ATTENTION_LAYERS } from './attention-manager';
export type {
  SalienceSignals,
  AttentionLayerConfig,
  AttentionSnapshot,
} from './attention-manager';

export { TokenBudget, DEFAULT_TOKEN_BUDGET_CONFIG } from './token-budget';
export type { BudgetAllocation, TokenBudgetConfig } from './token-budget';

export { SalienceEngine, DEFAULT_SALIENCE_CONFIG } from './salience-engine';
export type {
  SalienceScore,
  SalienceConfig,
  SalienceMemoryEntry,
  ContextSnapshot,
} from './salience-engine';

export { InstructionReinforcement } from './instruction-reinforcement';
export type { ReinforceRule, ReinforceStatus, ReinforceLogEntry, ReinforceResult } from './instruction-reinforcement';

export { ContextDecay, DEFAULT_DECAY_CONFIG } from './context-decay';
export type {
  DecayEntry,
  DecayResult,
  DecayConfig,
  DecayDecision,
} from './context-decay';

// ============================================================
// AttentionRuntime - 高级运行时接口
// ============================================================

import { AttentionManager, type SalienceSignals } from './attention-manager';
import { TokenBudget, type TokenBudgetConfig } from './token-budget';
import { SalienceEngine, type SalienceMemoryEntry, type ContextSnapshot } from './salience-engine';
import { InstructionReinforcement, type ReinforceRule } from './instruction-reinforcement';
import { ContextDecay, type DecayEntry } from './context-decay';

export interface AttentionRuntimeConfig {
  modelMaxTokens: number;
  safetyMargin?: number;
  customRules?: ReinforceRule[];
  decayConfig?: Partial<import('./context-decay').DecayConfig>;
  salienceConfig?: Partial<import('./salience-engine').SalienceConfig>;
  budgetConfig?: Partial<TokenBudgetConfig>;
}

/**
 * AttentionRuntime - 注意力运行时
 * 
 * 整合所有注意力子模块，提供统一每轮接口。
 */
export class AttentionRuntime {
  attentionManager: AttentionManager;
  tokenBudget: TokenBudget;
  salienceEngine: SalienceEngine;
  instructionReinforcement: InstructionReinforcement;
  contextDecay: ContextDecay;

  /** Phase 3: 调试追踪器引用（可选注入） */
  private attentionTracer: import('../debug/attention-trace').AttentionTracer | null = null;

  constructor(config: AttentionRuntimeConfig) {
    this.attentionManager = new AttentionManager();
    this.tokenBudget = new TokenBudget(this.attentionManager, {
      modelMaxTokens: config.modelMaxTokens,
      safetyMargin: config.safetyMargin ?? 4000,
      ...config.budgetConfig,
    });
    this.salienceEngine = new SalienceEngine(config.salienceConfig);
    this.instructionReinforcement = new InstructionReinforcement(this.attentionManager);
    this.contextDecay = new ContextDecay(this.attentionManager, config.decayConfig);

    // 添加自定义规则
    if (config.customRules) {
      for (const rule of config.customRules) {
        this.instructionReinforcement.addRule(rule);
      }
    }
  }

  /**
   * 注入调试追踪器
   */
  attachTracer(tracer: import('../debug/attention-trace').AttentionTracer): void {
    this.attentionTracer = tracer;
  }

  /**
   * 每轮调用：执行完整的注意力周期
   * 
   * 流程：
   * 1. salienceEngine.score() → SalienceSignals
   * 2. attentionManager.tick(signals) → 衰减 + 注入
   * 3. tokenBudget.allocate() → 预算重新分配
   * 4. contextDecay.evaluateBatch() → 评估保留率
   */
  tick(
    memories: SalienceMemoryEntry[],
    context: ContextSnapshot
  ): {
    budget: import('./token-budget').BudgetAllocation;
    decayResults: import('./context-decay').DecayResult[];
    attentionSnapshot: import('./attention-manager').AttentionSnapshot;
  } {
    const tracer = this.attentionTracer;

    // 1. Salience 评分（带 trace）
    const scored = this.salienceEngine.score(memories, context);
    const signals = this.salienceEngine.toSalienceSignals(scored, context);

    if (tracer && signals.length > 0) {
      const byLayer = new Map<number, import('./salience-engine').SalienceSignal[]>();
      for (const sig of signals) {
        const layer = sig.targetLayer ?? 4;
        if (!byLayer.has(layer)) byLayer.set(layer, []);
        byLayer.get(layer)!.push(sig);
      }
      for (const [layer, layerSignals] of byLayer) {
        tracer.salienceInjected(layer as any, 0, layerSignals);
      }
    }

    // 2. 注意力衰减 + 显著性注入（带 trace）
    const beforeSnapshot = tracer ? this.attentionManager.getSnapshot() : null;
    this.attentionManager.tick(signals);
    const afterSnapshot = tracer ? this.attentionManager.getSnapshot() : null;

    if (tracer && beforeSnapshot && afterSnapshot) {
      for (const layer of Object.keys(afterSnapshot)) {
        const layerNum = Number(layer.replace('L', ''));
        const b = (beforeSnapshot as any)[layer] ?? 1.0;
        const a = (afterSnapshot as any)[layer] ?? 1.0;
        const delta = a - b;
        if (Math.abs(delta) > 0.01) {
          if (delta > 0) {
            tracer.attentionScored(layerNum as any, b, a, 'tick_injected');
          } else {
            tracer.attentionDecayed(layerNum as any, b, a, 0.1);
          }
        }
      }
    }

    // 3. Token 预算重分配（带 trace）
    const budget = this.tokenBudget.allocate();
    if (tracer) {
      const allocationArray = Array.from(budget.layers.entries()).map(([layer, tokens]) => ({
        layer: layer as number,
        tokens,
        priority: layer,
        before: budget.total,
        after: budget.total - budget.unallocated,
      }));
      tracer.budgetAllocated(allocationArray);
    }

    // 4. 上下文衰减评估（带 trace）
    const decayEntries: DecayEntry[] = memories.map((m, i) => ({
      id: m.id,
      content: m.content,
      priority: AttentionPriority.SHORT_TERM_MEMORY,
      createdAt: m.timestamp,
      lastAccessAt: m.timestamp,
      tokenCount: this.estimateTokens(m.content),
      narrativeArcClosed: !m.isNarrativeTurn,
      emotionalIntensity: m.emotionalIntensity,
      goalRelevance: scored[i]?.score.goalRelevance ?? 0,
      reinforced: false,
      tags: [m.location, m.event].filter(Boolean),
    }));
    const decayResults = this.contextDecay.evaluateBatch(decayEntries);

    if (tracer) {
      for (const result of decayResults) {
        const decision = result.decision ?? {
          action: result.suggestion,
          confidence: result.retentionRate,
          retentionRate: result.retentionRate,
          reasons: [`temporal:${result.breakdown.temporal}`, `narrative:${result.breakdown.narrative}`],
        };
        tracer.decisionMade(decision, result.entryId);
      }
    }

    return {
      budget,
      decayResults,
      attentionSnapshot: this.attentionManager.getSnapshot(),
    };
  }

  /**
   * 强化当前 prompt
   */
  reinforce(prompt: string): string {
    const result = this.instructionReinforcement.reinforce(prompt);

    if (this.attentionTracer) {
      this.attentionTracer.instructionReinforced({
        ruleId: 'batch_reinforce',
        variantIndex: 0,
        triggerReason: 'explicit_reinforce',
        attentionBefore: 0.8,
        attentionAfter: 1.0,
        anchorApplied: true,
      });
    }

    return result;
  }

  /**
   * 获取完整的运行时快照（用于监控/调试）
   */
  getFullSnapshot(): object {
    return {
      attention: this.attentionManager.getSnapshot(),
      budget: this.tokenBudget.getSnapshot(),
      reinforce: this.instructionReinforcement.getReinforceStatus(),
      healthIndex: this.attentionManager.getHealthIndex(),
    };
  }

  /**
   * 获取注意力追踪摘要（仅当 attachTracer 时可用）
   */
  getAttentionTraceSummary(): string {
    return this.attentionTracer?.getAttentionSummary() ?? '追踪器未连接';
  }

  /**
   * Token 估算（与 Phase 1 保持一致）
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const cnChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - cnChars;
    return Math.ceil(cnChars / 1.5 + otherChars / 4);
  }

  /**
   * 重置所有状态
   */
  reset(): void {
    this.attentionManager.reset();
    this.contextDecay.reset();
    this.instructionReinforcement.clearLogs();
  }
}

export default AttentionRuntime;
