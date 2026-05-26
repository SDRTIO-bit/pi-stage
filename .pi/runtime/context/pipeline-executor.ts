/**
 * Context Assembly Engine - 管道执行器
 *
 * 实现 6 阶段装配管道：
 * collect → prioritize → compress → assemble → reinforce → render
 *
 * 将 ContextController 中的分散逻辑整合为可组合/可观测的管道。
 */

import type { AssembledContext, ContextSegment, TokenBudget } from './context-controller';
import { ContextPriority, ContextController } from './context-controller';
import type { AttentionManager } from './priority-layer';
import { PRIORITY_LAYERS, BudgetCalculator } from './priority-layer';
import type { CompressionEngine, CompressionResult } from './compression-engine';
import type { ReinforcementLayer } from './reinforcement-layer';
import type { ActiveMemoryRetriever } from './active-memory';
import type { AttentionTracer } from '../debug/attention-trace';
import type { MemoryTracer } from '../debug/memory-trace';

// ============================================================
// 管道阶段定义
// ============================================================

export interface PipelineStage<T, R> {
  name: string;
  execute(input: T): Promise<R>;
}

// ============================================================
// 阶段 1: 收集 (Collect)
// ============================================================

export interface CollectInput {
  userMessage: string;
  agentId: string;
  memoryRetriever: ActiveMemoryRetriever;
  runtimeState: RuntimeStateSnapshot;
}

export interface RuntimeStateSnapshot {
  worldDate: string;
  worldTime: string;
  location: string;
  characters: CharacterBrief[];
  activeGoals: string[];
  relationships: Map<string, number>;
}

export interface CharacterBrief {
  name: string;
  belonging: number;
  affection: number;
  location: string;
  status: string;
}

export class CollectStage implements PipelineStage<CollectInput, ContextSegment[]> {
  async execute(input: CollectInput): Promise<ContextSegment[]> {
    const segments: ContextSegment[] = [];

    // 1.1 收集系统规则
    segments.push(...await this.collectSystemRules());

    // 1.2 收集运行时状态
    segments.push(...this.collectRuntimeState(input.runtimeState));

    // 1.3 收集当前目标
    segments.push(...this.collectActiveGoals(input.runtimeState.activeGoals));

    // 1.4 收集活跃世界知识（从 Knowledge Layer）
    // 由 KnowledgeLayer 提供
    segments.push(...this.collectKnowledge(input.userMessage));

    // 1.5 收集短期记忆
    const shortTermMemories = await input.memoryRetriever.retrieve({
      userMessage: input.userMessage,
      sceneContext: input.runtimeState.location,
      activeGoals: input.runtimeState.activeGoals,
      agentId: input.agentId,
      mode: 'balanced',
      maxResults: 5,
      tokenBudget: 1500,
    });
    segments.push(...shortTermMemories);

    // 1.6 收集长期记忆
    const longTermMemories = await input.memoryRetriever.retrieve({
      userMessage: input.userMessage,
      sceneContext: input.runtimeState.location,
      activeGoals: input.runtimeState.activeGoals,
      agentId: input.agentId,
      mode: 'salience_first',
      maxResults: 3,
      tokenBudget: 800,
    });
    segments.push(...longTermMemories);

    // 1.7 收集历史摘要
    segments.push(this.collectHistorySummary());

    return segments;
  }

  private async collectSystemRules(): Promise<ContextSegment[]> {
    return [{
      priority: ContextPriority.SYSTEM_RULES,
      content: `## 核心身份规则
- 你必须始终以当前角色的身份进行互动
- 角色的记忆、性格、认知水平决定了ta的言行
- 禁止跳出角色进行元评论或道歉

## 世界一致性原则
- 维护世界观内部逻辑一致性
- 行为应有合理后果
- 所有角色只能基于已经历的事件行动
- 绝对信息隔离：角色不能知道未亲眼所见的事

## 对 {{user}} 的权限限制
- 可以写物理反应、表情变化、可观察的外在行为
- 可以写基于上下文的最小动作衔接
- 不能写内心想法、主观感受、情绪判断
- 不能擅自替 {{user}} 做选择
- 不能写 {{user}} 的大段对话
- 写到决策节点时停下来交给用户`,
      tokenCount: 350,
      isCompressed: false,
      metadata: {
        source: 'agent_blueprint_identity',
        timestamp: Date.now(),
        importance: 1.0,
        tags: ['system', 'identity', 'rules'],
      },
    }];
  }

  private collectRuntimeState(state: RuntimeStateSnapshot): ContextSegment[] {
    const charLines = state.characters.map(c =>
      `  - ${c.name}: 归属=${c.belonging} 情分=${c.affection} 📍${c.location}`
    ).join('\n');

    return [{
      priority: ContextPriority.RUNTIME_STATE,
      content: `## 当前世界状态
- 日期: ${state.worldDate}
- 时间: ${state.worldTime}
- 位置: ${state.location}

## 角色状态
${charLines}`,
      tokenCount: 150 + charLines.length,
      isCompressed: false,
      metadata: {
        source: 'agent_state',
        timestamp: Date.now(),
        importance: 0.8,
        tags: ['state', 'location', 'characters'],
      },
    }];
  }

  private collectActiveGoals(goals: string[]): ContextSegment[] {
    if (goals.length === 0) return [];

    return [{
      priority: ContextPriority.ACTIVE_GOALS,
      content: `## 当前目标\n${goals.map((g, i) => `${i + 1}. ${g}`).join('\n')}`,
      tokenCount: 50 + goals.reduce((s, g) => s + g.length, 0),
      isCompressed: false,
      metadata: {
        source: 'goal_system',
        timestamp: Date.now(),
        importance: 0.85,
        tags: ['goals', 'drives'],
      },
    }];
  }

  private collectKnowledge(userMessage: string): ContextSegment[] {
    // 知识收集由 KnowledgeLayer 完成
    // 这里仅做占位，实际由 KnowledgeAssembler 填充
    return [];
  }

  private collectHistorySummary(): ContextSegment {
    return {
      priority: ContextPriority.HISTORY_SUMMARY,
      content: '## 历史摘要\n（由历史压缩引擎生成）',
      tokenCount: 30,
      isCompressed: true,
      metadata: {
        source: 'history_compressor',
        timestamp: Date.now(),
        importance: 0.3,
        tags: ['history', 'summary'],
      },
    };
  }
}

// ============================================================
// 阶段 2: 优先排序 (Prioritize)
// ============================================================

export class PrioritizeStage implements PipelineStage<ContextSegment[], ContextSegment[]> {
  async execute(input: ContextSegment[]): Promise<ContextSegment[]> {
    return input.sort((a, b) => a.priority - b.priority);
  }
}

// ============================================================
// 阶段 3: 压缩 (Compress)
// ============================================================

export interface CompressInput {
  segments: ContextSegment[];
  totalBudget: number;
  attentionManager: AttentionManager;
  compressionEngine: CompressionEngine;
}

export class CompressStage implements PipelineStage<CompressInput, ContextSegment[]> {
  async execute(input: CompressInput): Promise<ContextSegment[]> {
    const result: ContextSegment[] = [];
    const budget = BudgetCalculator.calculate(
      input.totalBudget,
      input.attentionManager
    );

    for (const segment of input.segments) {
      const layer = PRIORITY_LAYERS.find(l => l.priority === segment.priority);
      if (!layer) {
        result.push(segment);
        continue;
      }

      const allocated = budget.get(segment.priority) ?? 0;
      const attention = input.attentionManager.getAttention(segment.priority);

      // 目标 token = 分配预算 × 注意力
      const targetTokens = Math.max(
        layer.minimumTokens,
        Math.floor(allocated * attention)
      );

      if (segment.tokenCount <= targetTokens && targetTokens > 0) {
        result.push(segment);
        continue;
      }

      // 需要压缩
      const compressed = await input.compressionEngine.compress(
        segment,
        targetTokens,
        layer.compression,
        layer
      );
      result.push(compressed.segment);
    }

    return result;
  }
}

// ============================================================
// 阶段 4: 装配 (Assemble)
// ============================================================

export interface AssembleInput {
  segments: ContextSegment[];
}

export class AssembleStage implements PipelineStage<AssembleInput, AssembledContext> {
  async execute(input: AssembleInput): Promise<AssembledContext> {
    const result: AssembledContext = {
      system: [],
      memory: [],
      world: [],
      request: [],
      metadata: {
        totalTokens: 0,
        budgetUsed: 0,
        compressionApplied: input.segments.some(s => s.isCompressed),
        assemblyTimestamp: Date.now(),
        segmentsCount: input.segments.length,
      },
    };

    for (const segment of input.segments) {
      switch (segment.priority) {
        case ContextPriority.SYSTEM_RULES:
        case ContextPriority.RUNTIME_STATE:
        case ContextPriority.ACTIVE_GOALS:
          result.system.push(segment);
          break;
        case ContextPriority.ACTIVE_KNOWLEDGE:
          result.world.push(segment);
          break;
        case ContextPriority.SHORT_TERM_MEMORY:
        case ContextPriority.LONG_TERM_MEMORY:
        case ContextPriority.HISTORY_SUMMARY:
          result.memory.push(segment);
          break;
        case ContextPriority.USER_INPUT:
          result.request.push(segment);
          break;
      }

      result.metadata.totalTokens += segment.tokenCount;
    }

    return result;
  }
}

// ============================================================
// 阶段 5: 强化 (Reinforce)
// ============================================================

export class ReinforceStage implements PipelineStage<AssembledContext, AssembledContext> {
  private reinforcement: ReinforcementLayer;

  constructor(reinforcement: ReinforcementLayer) {
    this.reinforcement = reinforcement;
  }

  async execute(input: AssembledContext): Promise<AssembledContext> {
    return this.reinforcement.reinforce(input);
  }
}

// ============================================================
// 阶段 6: 渲染 (Render)
// ============================================================

export class RenderStage implements PipelineStage<AssembledContext, string> {
  /**
   * 将装配好的上下文渲染为 LLM 可用的 prompt 格式
   * 
   * 渲染策略：
   * - 先 system（最高优先级，固化区）
   * - 再 world（世界知识）
   * - 再 memory（记忆 + 历史摘要）
   * - 最后 request（用户输入）
   */
  async execute(input: AssembledContext): Promise<string> {
    const parts: string[] = [];

    // System 区：所有不可稀释的规则
    if (input.system.length > 0) {
      const systemText = input.system
        .map(s => s.content)
        .join('\n\n');
      parts.push(systemText);
    }

    // World 区：世界知识（如有）
    if (input.world.length > 0) {
      const worldText = input.world
        .map(s => s.content)
        .join('\n\n');
      parts.push(`\n\n## 世界知识\n${worldText}`);
    }

    // Memory 区：记忆 + 摘要
    if (input.memory.length > 0) {
      const memoryText = input.memory
        .map(s => s.content)
        .join('\n\n');
      parts.push(`\n\n## 记忆与历史\n${memoryText}`);
    }

    // User 区：用户输入
    if (input.request.length > 0) {
      const requestText = input.request
        .map(s => s.content)
        .join('\n\n');
      parts.push(`\n\n## 用户输入\n${requestText}`);
    }

    return parts.join('\n');
  }
}

// ============================================================
// 管道执行器
// ============================================================

export class PipelineExecutor {
  private stages: PipelineStage<any, any>[];
  private attentionTracer: AttentionTracer | null = null;
  private memoryTracer: MemoryTracer | null = null;

  constructor(
    collectStage: CollectStage,
    prioritizeStage: PrioritizeStage,
    compressStage: CompressStage,
    assembleStage: AssembleStage,
    reinforceStage: ReinforceStage,
    renderStage: RenderStage,
    tracers?: {
      attentionTracer?: AttentionTracer | null;
      memoryTracer?: MemoryTracer | null;
    }
  ) {
    this.stages = [
      collectStage,
      prioritizeStage,
      compressStage,
      assembleStage,
      reinforceStage,
      renderStage,
    ];
    if (tracers) {
      this.attentionTracer = tracers.attentionTracer ?? null;
      this.memoryTracer = tracers.memoryTracer ?? null;
    }
  }

  /**
   * 运行中注入 tracer
   */
  attachTracers(tracers: { attentionTracer?: AttentionTracer | null; memoryTracer?: MemoryTracer | null }): void {
    if (tracers.attentionTracer !== undefined) this.attentionTracer = tracers.attentionTracer;
    if (tracers.memoryTracer !== undefined) this.memoryTracer = tracers.memoryTracer;
  }

  /**
   * 执行完整管道
   */
  async execute(
    userMessage: string,
    runtimeState: RuntimeStateSnapshot,
    agentId: string,
    memoryRetriever: ActiveMemoryRetriever,
    attentionManager: AttentionManager,
    compressionEngine: CompressionEngine,
    totalBudget: number
  ): Promise<{
    prompt: string;
    assembledContext: AssembledContext;
    pipelineLog: PipelineLog[];
  }> {
    const pipelineLog: PipelineLog[] = [];
    let currentInput: any = {
      userMessage,
      agentId,
      memoryRetriever,
      runtimeState,
    };

    // trace: collect 阶段前 — 记录检索事件
    const memoryTracer = this.memoryTracer;
    const attentionTracer = this.attentionTracer;

    for (const stage of this.stages) {
      const startTime = Date.now();

      // trace: 阶段执行前
      if (memoryTracer && stage.name === 'collect') {
        memoryTracer.memoryRetrieved(
          agentId,
          { keywords: [userMessage.substring(0, 50)], limit: 20, minRelevance: 0.1 },
          0
        );
      }

      const output = await stage.execute(currentInput);
      const duration = Date.now() - startTime;

      pipelineLog.push({
        stageName: stage.name,
        inputSize: this.measureSize(currentInput),
        outputSize: this.measureSize(output),
        durationMs: duration,
      });

      // trace: 阶段执行后
      if (stage.name === 'compress' && memoryTracer) {
        const compressInput = currentInput as CompressInput;
        if (compressInput?.segments) {
          for (const seg of compressInput.segments) {
            if (seg.isCompressed) {
              memoryTracer.memoryCompressed(
                seg.id || seg.content.substring(0, 20),
                seg.tokenCount * 2,
                seg.tokenCount
              );
            }
          }
        }
      }

      if (stage.name === 'reinforce' && attentionTracer) {
        const assembled = output as AssembledContext;
        if (assembled?.system) {
          attentionTracer.instructionReinforced({
            ruleId: 'pipeline_reinforce',
            variantIndex: 0,
            triggerReason: 'pipeline_execution',
            attentionBefore: 1.0,
            attentionAfter: 1.0,
            anchorApplied: true,
          });
        }
      }

      if (stage.name === 'render' && attentionTracer) {
        const promptStr = output as string;
        attentionTracer.instructionReinforced({
          ruleId: 'pipeline_render',
          variantIndex: 0,
          triggerReason: 'final_render',
          attentionBefore: 1.0,
          attentionAfter: 1.0,
          anchorApplied: true,
        });
      }

      currentInput = output;
    }

    // 最终输出：渲染后的 prompt
    const prompt = currentInput as string;
    const assembledContext = (await new AssembleStage().execute({
      segments: [], // 已在前序阶段处理
    }));

    return {
      prompt,
      assembledContext: this.extractAssembledContext(currentInput),
      pipelineLog,
    };
  }

  private measureSize(input: any): number {
    if (Array.isArray(input)) return input.length;
    if (typeof input === 'string') return input.length;
    if (typeof input === 'object') {
      try {
        return JSON.stringify(input).length;
      } catch {
        return 0;
      }
    }
    return 0;
  }

  private extractAssembledContext(input: any): AssembledContext {
    // 从 AssembleStage 输出提取
    if (input && input.system) return input;
    // fallback
    return {
      system: [],
      memory: [],
      world: [],
      request: [],
      metadata: {
        totalTokens: 0,
        budgetUsed: 0,
        compressionApplied: false,
        assemblyTimestamp: Date.now(),
        segmentsCount: 0,
      },
    };
  }
}

export interface PipelineLog {
  stageName: string;
  inputSize: number;
  outputSize: number;
  durationMs: number;
}

export default PipelineExecutor;
