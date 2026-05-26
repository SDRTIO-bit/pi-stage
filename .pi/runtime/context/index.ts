/**
 * Context Assembly Engine - 统一导出
 *
 * 模块构成：
 * - context-controller.ts: 核心控制器，上下文生命周期
 * - priority-layer.ts: 8 层优先级定义 + 注意力管理 + 预算计算
 * - active-memory.ts: 主动记忆检索（相关性/情感/目标）
 * - compression-engine.ts: 多层压缩引擎（截断/摘要/选择/占位符）
 * - reinforcement-layer.ts: 指令强化层（防稀释/漂移）
 * - pipeline-executor.ts: 6 阶段管道执行器
 *
 * 使用示例：
 *   const engine = new ContextAssemblyEngine(config);
 *   const prompt = await engine.assemble(userMessage, runtimeState);
 */

export { ContextController, ContextPriority } from './context-controller';
export type {
  TokenBudget,
  LayerBudget,
  ContextSegment,
  AssembledContext,
} from './context-controller';

export {
  PRIORITY_LAYERS,
  AttentionManager,
  BudgetCalculator,
} from './priority-layer';
export type {
  PriorityLayer,
  CompressionStrategy,
} from './priority-layer';

export { ActiveMemoryRetriever, MemoryEntryTokenEstimate } from './active-memory';
export type { MemoryQuery, RetrievedMemory, MemoryRetrievalMode } from './active-memory';

export { CompressionEngine, MultiLayerSummarizer } from './compression-engine';
export type { CompressionResult, Summaries } from './compression-engine';

export { ReinforcementLayer } from './reinforcement-layer';
export type { ReinforceRule, ReinforceStatus } from './reinforcement-layer';

export {
  PipelineExecutor,
  CollectStage,
  PrioritizeStage,
  CompressStage,
  AssembleStage,
  ReinforceStage,
  RenderStage,
} from './pipeline-executor';
export type {
  CollectInput,
  RuntimeStateSnapshot,
  CharacterBrief,
  CompressInput,
  PipelineLog,
} from './pipeline-executor';

// ============================================================
// 高级接口：一次性配置 + 使用
// ============================================================

import { EventBus } from '../events/event-bus';
import { MemoryLayer } from '../memory/memory-layer';
import { KnowledgeLayer } from '../knowledge/knowledge-layer';
import { GoalSystem } from '../agent/goal-system';
import {
  PipelineExecutor as Executor,
  CollectStage,
  PrioritizeStage,
  CompressStage,
  AssembleStage,
  ReinforceStage,
  RenderStage,
} from './pipeline-executor';
import type { RuntimeStateSnapshot } from './pipeline-executor';
import { AttentionManager, PRIORITY_LAYERS, BudgetCalculator } from './priority-layer';
import { CompressionEngine } from './compression-engine';
import { ReinforcementLayer } from './reinforcement-layer';
import { ActiveMemoryRetriever } from './active-memory';

export class ContextAssemblyEngine {
  private pipeline: Executor;
  private attentionManager: AttentionManager;
  private compressionEngine: CompressionEngine;
  private reinforcement: ReinforcementLayer;
  private memoryRetriever: ActiveMemoryRetriever;

  /** 总 token 预算（模型上下文窗口 - 安全余量） */
  private totalBudget: number;

  /** Phase 3: 调试追踪器引用（可选注入） */
  private attentionTracer: import('../debug/attention-trace').AttentionTracer | null = null;
  private memoryTracer: import('../debug/memory-trace').MemoryTracer | null = null;

  constructor(config: {
    eventBus: EventBus;
    memory: MemoryLayer;
    knowledge: KnowledgeLayer;
    goals: GoalSystem;
    modelMaxTokens: number;
    safetyMargin?: number;
    /** 可选注入 AttentionTracer 用于调试 */
    attentionTracer?: import('../debug/attention-trace').AttentionTracer;
    memoryTracer?: import('../debug/memory-trace').MemoryTracer;
  }) {
    this.attentionManager = new AttentionManager();
    this.compressionEngine = new CompressionEngine();
    this.reinforcement = new ReinforcementLayer(this.attentionManager);
    this.memoryRetriever = new ActiveMemoryRetriever(config.memory);

    this.attentionTracer = config.attentionTracer ?? null;
    this.memoryTracer = config.memoryTracer ?? null;

    const margin = config.safetyMargin ?? 4000;
    this.totalBudget = config.modelMaxTokens - margin;

    // 构建管道（传入 tracer）
    this.pipeline = new Executor(
      new CollectStage(),
      new PrioritizeStage(),
      new CompressStage(),
      new AssembleStage(),
      new ReinforceStage(this.reinforcement),
      new RenderStage(),
      {
        attentionTracer: this.attentionTracer,
        memoryTracer: this.memoryTracer,
      }
    );
  }

  /**
   * 核心接口：每轮对话调用一次
   * 
   * @param userMessage 当前用户输入
   * @param runtimeState 当前运行时状态快照
   * @param agentId 当前 Agent ID
   * @returns 最终 prompt 字符串
   */
  async assemble(
    userMessage: string,
    runtimeState: RuntimeStateSnapshot,
    agentId: string
  ): Promise<string> {
    const result = await this.pipeline.execute(
      userMessage,
      runtimeState,
      agentId,
      this.memoryRetriever,
      this.attentionManager,
      this.compressionEngine,
      this.totalBudget
    );

    // Tick 注意力衰减（含 trace）
    const beforeSnapshot = this.attentionTracer
      ? this.attentionManager.getSnapshot()
      : null;

    this.attentionManager.tick();

    // 记录注意力变化
    if (this.attentionTracer && beforeSnapshot) {
      const afterSnapshot = this.attentionManager.getSnapshot();
      for (const layer of Object.keys(afterSnapshot)) {
        const before = (beforeSnapshot as any)[layer] ?? 1.0;
        const after = (afterSnapshot as any)[layer] ?? 1.0;
        if (Math.abs(after - before) > 0.01) {
          this.attentionTracer.attentionDecayed(
            Number(layer.replace('L', '')),
            before, after, 0.1
          );
        }
      }
    }

    return result.prompt;
  }

  /**
   * 获取强化状态（用于调试）
   */
  getReinforceStatus() {
    return this.reinforcement.getReinforceStatus();
  }

  /**
   * 获取各层当前注意力
   */
  getAttentionStatus() {
    const result: Record<string, number> = {};
    for (const layer of PRIORITY_LAYERS) {
      result[layer.name] = this.attentionManager.getAttention(layer.priority);
    }
    return result;
  }

  /**
   * 手动强化某条规则
   */
  manuallyReinforce(ruleId: string): void {
    // 通过注入强化层来实现
    const status = this.reinforcement.getReinforceStatus();
    const rule = status.find(s => s.ruleId === ruleId);
    if (rule) {
      // 重置注意力
      // 实际强化在下次 assemble 时通过 ReinforceStage 执行
    }
  }

  /**
   * 注入调试追踪器（运行中注入）
   */
  attachTracers(tracers: {
    attention?: import('../debug/attention-trace').AttentionTracer;
    memory?: import('../debug/memory-trace').MemoryTracer;
  }): void {
    if (tracers.attention) this.attentionTracer = tracers.attention;
    if (tracers.memory) this.memoryTracer = tracers.memory;
  }
}

export default ContextAssemblyEngine;
