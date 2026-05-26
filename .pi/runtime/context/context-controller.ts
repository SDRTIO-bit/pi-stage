/**
 * Context Assembly Engine - 上下文控制器
 *
 * 核心控制器，管理整个上下文的生命周期：
 * - 每轮/tick 触发装配
 * - 维护上下文优先级分层
 * - 协调各个装配阶段
 */

import type { EventBus } from '../events/event-bus';
import type { MemoryLayer } from '../memory/memory-layer';
import type { KnowledgeLayer } from '../knowledge/knowledge-layer';
import type { GoalSystem } from '../agent/goal-system';

// ============================================================
// 上下文优先级层（从高到低）
// ============================================================

export enum ContextPriority {
  /** 最高优先级：不可稀释的系统规则 */
  SYSTEM_RULES = 0,
  /** 运行时状态：当前位置/时间/角色属性 */
  RUNTIME_STATE = 1,
  /** 当前目标/需求 */
  ACTIVE_GOALS = 2,
  /** 活跃世界知识 */
  ACTIVE_KNOWLEDGE = 3,
  /** 短期记忆（最近 3-5 轮） */
  SHORT_TERM_MEMORY = 4,
  /** 长期记忆（按需检索） */
  LONG_TERM_MEMORY = 5,
  /** 历史摘要（压缩对话） */
  HISTORY_SUMMARY = 6,
  /** 用户输入 */
  USER_INPUT = 7,
}

// ============================================================
// Token 预算分配
// ============================================================

export interface TokenBudget {
  total: number;
  layers: Map<ContextPriority, LayerBudget>;
  safetyMargin: number;
}

export interface LayerBudget {
  allocated: number;
  used: number;
  canBorrowDown: boolean;
  minimum: number;
}

// ============================================================
// 上下文分段
// ============================================================

export interface ContextSegment {
  priority: ContextPriority;
  content: string;
  tokenCount: number;
  isCompressed: boolean;
  compressionRatio?: number;
  metadata: {
    source: string;
    timestamp: number;
    importance: number;
    tags: string[];
  };
}

// ============================================================
// 装配输出
// ============================================================

export interface AssembledContext {
  system: ContextSegment[];
  memory: ContextSegment[];
  world: ContextSegment[];
  request: ContextSegment[];

  metadata: {
    totalTokens: number;
    budgetUsed: number;
    compressionApplied: boolean;
    assemblyTimestamp: number;
    segmentsCount: number;
  };
}

// ============================================================
// 上下文控制器
// ============================================================

export class ContextController {
  private eventBus: EventBus;
  private memory: MemoryLayer;
  private knowledge: KnowledgeLayer;
  private goals: GoalSystem;

  private budget: TokenBudget;
  private currentContext: AssembledContext | null = null;
  private attentionDecay: Map<ContextPriority, number> = new Map();

  constructor(
    eventBus: EventBus,
    memory: MemoryLayer,
    knowledge: KnowledgeLayer,
    goals: GoalSystem,
    config: { modelMaxTokens: number; safetyMargin?: number }
  ) {
    this.eventBus = eventBus;
    this.memory = memory;
    this.knowledge = knowledge;
    this.goals = goals;

    const margin = config.safetyMargin ?? 4000;
    this.budget = this.initializeBudget(config.modelMaxTokens - margin);
  }

  /**
   * 初始化 Token 预算分配
   *
   * 分配策略：
   * - 高优先级层获得更大份额 + 不可被下层借用
   * - 低优先级层获得更小份额 + 可被上层借用
   */
  private initializeBudget(total: number): TokenBudget {
    const layers = new Map<ContextPriority, LayerBudget>();

    const allocations = [
      { priority: ContextPriority.SYSTEM_RULES, ratio: 0.08, min: 200 },
      { priority: ContextPriority.RUNTIME_STATE, ratio: 0.10, min: 300 },
      { priority: ContextPriority.ACTIVE_GOALS, ratio: 0.07, min: 150 },
      { priority: ContextPriority.ACTIVE_KNOWLEDGE, ratio: 0.20, min: 500 },
      { priority: ContextPriority.SHORT_TERM_MEMORY, ratio: 0.25, min: 800 },
      { priority: ContextPriority.LONG_TERM_MEMORY, ratio: 0.15, min: 0 },
      { priority: ContextPriority.HISTORY_SUMMARY, ratio: 0.10, min: 0 },
      { priority: ContextPriority.USER_INPUT, ratio: 0.05, min: 100 },
    ];

    for (const { priority, ratio, min } of allocations) {
      layers.set(priority, {
        allocated: Math.floor(total * ratio),
        used: 0,
        canBorrowDown: priority < ContextPriority.HISTORY_SUMMARY,
        minimum: min,
      });
    }

    return { total, layers, safetyMargin: 4000 };
  }

  /**
   * 核心入口：装配上下文
   */
  async assemble(): Promise<AssembledContext> {
    const collected = await this.collectAll();
    const prioritized = this.prioritize(collected);
    const compressed = await this.compress(prioritized);
    const assembled = this.assembleSegments(compressed);
    const reinforced = this.reinforce(assembled);
    const rendered = this.render(reinforced);

    this.currentContext = rendered;
    return rendered;
  }

  private async collectAll(): Promise<ContextSegment[]> {
    const segments: ContextSegment[] = [];
    segments.push(...await this.collectSystemRules());
    segments.push(...await this.collectRuntimeState());
    segments.push(...await this.collectActiveGoals());
    segments.push(...await this.collectActiveKnowledge());
    segments.push(...await this.collectShortTermMemory());
    segments.push(...await this.collectLongTermMemory());
    segments.push(...await this.collectHistorySummary());
    return segments;
  }

  private async collectSystemRules(): Promise<ContextSegment[]> {
    return [];
  }

  private async collectRuntimeState(): Promise<ContextSegment[]> {
    return [];
  }

  private async collectActiveGoals(): Promise<ContextSegment[]> {
    return [];
  }

  private async collectActiveKnowledge(): Promise<ContextSegment[]> {
    return [];
  }

  private async collectShortTermMemory(): Promise<ContextSegment[]> {
    return [];
  }

  private async collectLongTermMemory(): Promise<ContextSegment[]> {
    return [];
  }

  private async collectHistorySummary(): Promise<ContextSegment[]> {
    return [];
  }

  private prioritize(segments: ContextSegment[]): ContextSegment[] {
    return segments.sort((a, b) => a.priority - b.priority);
  }

  private async compress(segments: ContextSegment[]): Promise<ContextSegment[]> {
    const result: ContextSegment[] = [];
    let totalTokens = 0;

    for (const segment of segments) {
      const layerBudget = this.budget.layers.get(segment.priority);
      if (!layerBudget) continue;

      if (layerBudget.used >= layerBudget.allocated) {
        if (layerBudget.canBorrowDown) {
          // 借用逻辑：找下一个可借的低优先级层
        } else {
          continue;
        }
      }

      const compressed = await this.compressSegment(segment, layerBudget);
      result.push(compressed);
      totalTokens += compressed.tokenCount;
      layerBudget.used += compressed.tokenCount;
    }

    return result;
  }

  private async compressSegment(
    segment: ContextSegment,
    budget: LayerBudget
  ): Promise<ContextSegment> {
    const remaining = Math.min(
      segment.tokenCount,
      budget.allocated - budget.used
    );

    if (remaining >= segment.tokenCount ||
        remaining >= segment.metadata.importance * segment.tokenCount) {
      return segment;
    }

    const ratio = remaining / segment.tokenCount;
    const truncatedContent = segment.content.slice(
      0, Math.floor(segment.content.length * ratio)
    );

    return {
      ...segment,
      content: truncatedContent + '\n... (已压缩)',
      tokenCount: remaining,
      isCompressed: true,
      compressionRatio: ratio,
    };
  }

  private assembleSegments(segments: ContextSegment[]): AssembledContext {
    const result: AssembledContext = {
      system: [],
      memory: [],
      world: [],
      request: [],
      metadata: {
        totalTokens: 0,
        budgetUsed: 0,
        compressionApplied: false,
        assemblyTimestamp: Date.now(),
        segmentsCount: segments.length,
      },
    };

    for (const segment of segments) {
      if (segment.priority <= ContextPriority.ACTIVE_GOALS) {
        result.system.push(segment);
      } else if (segment.priority <= ContextPriority.SHORT_TERM_MEMORY) {
        result.memory.push(segment);
      } else if (segment.priority === ContextPriority.ACTIVE_KNOWLEDGE) {
        result.world.push(segment);
      } else {
        result.request.push(segment);
      }
      result.metadata.totalTokens += segment.tokenCount;
    }

    return result;
  }

  private reinforce(context: AssembledContext): AssembledContext {
    return context;
  }

  private render(context: AssembledContext): AssembledContext {
    return context;
  }

  getCurrentContext(): AssembledContext | null {
    return this.currentContext;
  }

  resetBudget(): void {
    for (const [, layer] of this.budget.layers) {
      layer.used = 0;
    }
  }
}

export default ContextController;
