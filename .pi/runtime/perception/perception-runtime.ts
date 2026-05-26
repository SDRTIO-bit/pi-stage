/**
 * perception-runtime.ts — Perception Runtime 统一入口
 *
 * 整合所有感知子系统为统一的 PerceptionRuntime：
 *
 *          ┌─────────────────────────────────────────┐
 *          │          PerceptionRuntime               │
 *          ├─────────────────────────────────────────┤
 *          │  PerceptionFilter    ← 感知过滤器       │
 *          │  AwarenessRuntime    ← 认知运行时       │
 *          │  BeliefSystem        ← 信念系统         │
 *          │  VisibilityEngine    ← 可见性引擎       │
 *          │  RumorEngine         ← 谣言引擎         │
 *          │  KnowledgeBoundary   ← 知识边界         │
 *          └─────────────────────────────────────────┘
 *
 * 认知链：
 *   World State → Perception Filter → Awareness → Belief → Memory Encoding
 *                                                                 ↓
 *   Action ← Planning ← Goal Update ← Context Assembly ← Knowledge Boundary
 *
 * 与现有 Runtime 的整合点：
 * - AutonomousRuntime.tick() 中调用 perceptionRuntime.tick()
 * - ContextAssemblyEngine 中调用 knowledgeBoundary.buildBoundedContext()
 * - GoalRuntime 中调用 awarenessRuntime 生成认知驱动的目标
 * - AttentionRuntime 与 perceptionFilter 共享注意力焦点
 */

import { PerceptionFilter, type PerceptionContext, type PerceivedWorldState, type RawWorldInput } from './perception-filter';
import { AwarenessRuntime, type AwarenessFact, type AwarenessRuntimeConfig } from './awareness-runtime';
import { BeliefSystem, type Belief, type BeliefSystemConfig } from './belief-system';
import { VisibilityEngine, type VisibilityRule, type VisibilityEngineConfig } from './visibility-engine';
import { RumorEngine, type Rumor, type RumorEngineConfig, type RumorSpreadEvent } from './rumor-engine';
import { KnowledgeBoundary, type BoundedKnowledge, type KnowledgeBoundaryConfig } from './knowledge-boundary';
import type { EventBus } from '../events/event-bus';

// ============================================================
// PerceptionRuntime 配置
// ============================================================

export interface PerceptionRuntimeConfig {
  perceptionFilter?: Partial<import('./perception-filter').PerceptionFilterConfig>;
  awareness?: Partial<AwarenessRuntimeConfig>;
  beliefSystem?: Partial<BeliefSystemConfig>;
  visibility?: Partial<VisibilityEngineConfig>;
  rumorEngine?: Partial<RumorEngineConfig>;
  knowledgeBoundary?: Partial<KnowledgeBoundaryConfig>;
  /** 是否启用完整感知链 */
  enableFullChain?: boolean;
  /** 是否启用谣言系统 */
  enableRumorEngine?: boolean;
}

// ============================================================
// PerceptionRuntime 快照
// ============================================================

export interface PerceptionRuntimeSnapshot {
  awarenessStats: {
    totalFacts: number;
    knownFacts: number;
    suspected: number;
    misunderstandings: number;
  };
  beliefStats: {
    total: number;
    active: number;
    strong: number;
    conflicts: number;
  };
  visibilityStats: {
    rules: number;
    stealthedAgents: number;
  };
  rumorStats: {
    active: number;
    totalSpreadEvents: number;
  };
}

// ============================================================
// PerceptionRuntime 实现
// ============================================================

export class PerceptionRuntime {
  readonly perceptionFilter: PerceptionFilter;
  readonly awareness: AwarenessRuntime;
  readonly beliefSystem: BeliefSystem;
  readonly visibility: VisibilityEngine;
  readonly rumorEngine: RumorEngine;
  readonly knowledgeBoundary: KnowledgeBoundary;

  private config: PerceptionRuntimeConfig;
  private eventBus: EventBus | null;
  private initialized: boolean = false;

  constructor(config?: PerceptionRuntimeConfig, eventBus?: EventBus) {
    this.config = {
      enableFullChain: true,
      enableRumorEngine: true,
      ...config,
    };
    this.eventBus = eventBus ?? null;

    this.perceptionFilter = new PerceptionFilter(this.config.perceptionFilter, this.eventBus ?? undefined);
    this.awareness = new AwarenessRuntime(this.config.awareness, this.eventBus ?? undefined);
    this.beliefSystem = new BeliefSystem(this.config.beliefSystem, this.eventBus ?? undefined);
    this.visibility = new VisibilityEngine(this.config.visibility, this.eventBus ?? undefined);
    this.rumorEngine = new RumorEngine(this.config.rumorEngine, this.eventBus ?? undefined);
    this.knowledgeBoundary = new KnowledgeBoundary(this.config.knowledgeBoundary, this.eventBus ?? undefined);
  }

  /**
   * 初始化：绑定事件监听
   */
  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (this.eventBus) {
      this.setupEventListeners();
    }
  }

  private setupEventListeners(): void {
    if (!this.eventBus) return;

    // 谣言传播 → 更新 Awareness
    this.eventBus.on('rumor:spread', (data: any) => {
      if (!this.config.enableRumorEngine) return;
      this.awareness.ingestPerception(
        data.version,
        'knowledge',
        data.confidence,
        'communication',
        data.fromAgentId,
        ['rumor'],
      );
    });

    // 感知过滤完成 → 更新 Awareness
    this.eventBus.on('perception:filtered', (data: any) => {
      // 由外部在 tick 中处理
    });
  }

  // ============================================================
  // 核心感知链
  // ============================================================

  /**
   * 主 tick：完整感知链执行
   *
   * 1. 谣言传播
   * 2. Awareness 衰减
   * 3. Belief 衰减
   * 4. 可见性清理
   */
  tick(
    agentRelations: Map<string, Array<{ characterId: string; value: number; trust: number }>>,
    agentLocations: Map<string, string>,
    locationConnections: Map<string, string[]>
  ): PerceptionTickResult {
    const result: PerceptionTickResult = {
      rumorSpreads: [],
      awarenessUpdates: 0,
      beliefChanges: 0,
    };

    // 1. 谣言传播
    if (this.config.enableRumorEngine) {
      const spreads = this.rumorEngine.tick(agentRelations, agentLocations, locationConnections);
      result.rumorSpreads = spreads;
    }

    // 2. Awareness 衰减
    this.awareness.tick();

    // 3. Belief 衰减
    this.beliefSystem.tick();

    // 4. 可见性清理
    this.visibility.cleanup();

    return result;
  }

  /**
   * 对单个 Agent 执行完整感知过滤
   *
   * 流程：
   *   RawWorld → PerceptionFilter → Awareness → Belief Update → Memory Encoding
   */
  processAgentPerception(
    agentId: string,
    rawWorld: RawWorldInput,
    perceptionContext: PerceptionContext,
    locationConnections: Map<string, string[]>,
    emotions?: Record<string, number>
  ): ProcessedPerception {
    // 1. 可见性检查：过滤掉 Agent 无权看到的信息
    const visibleWorld = this.applyVisibilityFilter(agentId, rawWorld, perceptionContext);

    // 2. 感知过滤
    const perceived = this.perceptionFilter.filterWorld(
      visibleWorld,
      perceptionContext,
      locationConnections
    );

    // 3. 将感知结果摄入 Awareness
    const newFacts: AwarenessFact[] = [];
    for (const event of perceived.perceivedEvents) {
      const fact = this.awareness.ingestPerception(
        event.description,
        'event',
        event.confidence,
        'direct_observation',
        undefined,
        event.biases,
      );
      newFacts.push(fact);
    }

    for (const agent of perceived.perceivedAgents) {
      if (agent.identityConfirmed) {
        this.awareness.ingestPerception(
          `${agent.name} 在 ${agent.perceivedLocation}，看起来 ${agent.perceivedEmotion}`,
          'agent',
          agent.accuracy,
          'direct_observation',
          undefined,
          ['observed'],
        );
      }
    }

    // 4. 情绪影响信念
    if (emotions && Object.keys(emotions).length > 0) {
      this.beliefSystem.applyEmotionalInfluence(emotions);
    }

    // 5. 新感知可能形成信念
    this.updateBeliefsFromPerception(perceived, emotions);

    return {
      perceived,
      newFacts,
      awarenessSnapshot: this.awareness.getStats(),
      beliefSnapshot: this.beliefSystem.getStats(),
    };
  }

  /**
   * 应用可见性过滤
   */
  private applyVisibilityFilter(
    agentId: string,
    rawWorld: RawWorldInput,
    context: PerceptionContext
  ): RawWorldInput {
    const filteredEvents = rawWorld.events.filter(event => {
      const { level } = this.visibility.getVisibility(
        'event', event.id, agentId, context.agentLocation, {
          relations: context.relations,
          sensoryCapabilities: context.sensoryCapabilities as any,
        }
      );
      return level !== 'secret';
    });

    const filteredLocations = rawWorld.locations.filter(loc => {
      // 隐藏地点检查
      return !loc.hasSecret || loc.visitedBy?.includes(agentId);
    });

    const filteredAgents = rawWorld.agents.filter(agent => {
      if (agent.id === agentId) return false;
      const { visible } = this.visibility.isAgentVisible(
        agent.id, agentId, context.agentLocation, {
          targetLocation: agent.location,
          sensoryCapabilities: context.sensoryCapabilities as any,
        }
      );
      return visible;
    });

    return {
      ...rawWorld,
      events: filteredEvents,
      locations: filteredLocations,
      agents: filteredAgents,
    };
  }

  /**
   * 从感知更新信念
   */
  private updateBeliefsFromPerception(
    perceived: PerceivedWorldState,
    emotions?: Record<string, number>
  ): void {
    // 反复感知到类似事件 → 形成因果信念
    const eventPatterns = perceived.perceivedEvents.map(e => e.perceivedType);
    const uniqueTypes = [...new Set(eventPatterns)];

    for (const type of uniqueTypes) {
      const count = eventPatterns.filter(t => t === type).length;
      if (count >= 3) {
        this.beliefSystem.formOrUpdateBelief({
          content: `最近 ${type} 类事件频繁发生`,
          category: 'causal_belief',
          strength: Math.min(0.8, 0.3 + count * 0.1),
          source: 'direct_experience',
          sourceDetail: `观察到 ${count} 次 ${type} 事件`,
        });
      }
    }

    // 感知到他人情绪 → 形成对他人的信念
    for (const agent of perceived.perceivedAgents) {
      if (agent.perceivedEmotion === 'angry' && agent.accuracy > 0.5) {
        this.beliefSystem.formOrUpdateBelief({
          content: `${agent.name} 现在情绪不好`,
          category: 'other_perception',
          strength: agent.accuracy * 0.6,
          source: 'direct_experience',
          sourceDetail: `观察到 ${agent.name} 表现出 ${agent.perceivedEmotion}`,
        });
      }
    }
  }

  // ============================================================
  // 知识边界（供 Context Assembly 调用）
  // ============================================================

  /**
   * 构建 Agent 的知识边界上下文
   * 由 ContextAssemblyEngine 在 Collect 阶段调用
   */
  buildAgentContext(
    agentId: string,
    perception: PerceivedWorldState | null,
    memorySummary: string
  ): BoundedKnowledge {
    return this.knowledgeBoundary.buildBoundedContext(
      agentId,
      this.awareness,
      this.beliefSystem,
      perception,
      memorySummary
    );
  }

  /**
   * 生成 LLM 上下文字符串
   */
  toContextString(bounded: BoundedKnowledge): string {
    return this.knowledgeBoundary.toContextString(bounded);
  }

  // ============================================================
  // 主动信息注入
  // ============================================================

  /**
   * Agent 主动探索获取信息
   */
  exploreLocation(
    agentId: string,
    locationId: string,
    perceptionContext: PerceptionContext
  ): BoundedKnowledge['currentPerception'] {
    // 模拟 Agent 探索某个地点，获取感知信息
    // 实际实现中会调用 WorldState 获取地点详情，然后过滤
    return {
      time: '',
      weather: '',
      location: locationId,
      occupants: [],
      events: [],
      nearbyAgents: [],
    };
  }

  /**
   * Agent 与他人交谈获取信息
   */
  receiveInformation(
    agentId: string,
    speakerId: string,
    content: string,
    speakerTrust: number,
    category?: AwarenessFact['category']
  ): AwarenessFact {
    return this.awareness.ingestCommunication(
      content,
      category ?? 'knowledge',
      speakerId,
      speakerTrust,
    );
  }

  /**
   * 查询 Agent 是否知道某事
   */
  knows(agentId: string, content: string, minConfidence?: number): boolean {
    return this.awareness.knows(content, minConfidence);
  }

  /**
   * 获取 Agent 关于某事的置信度
   */
  getConfidence(agentId: string, content: string): number {
    return this.awareness.getConfidence(content);
  }

  // ============================================================
  // 状态快照
  // ============================================================

  getSnapshot(): PerceptionRuntimeSnapshot {
    const awarenessStats = this.awareness.getStats();
    const beliefStats = this.beliefSystem.getStats();
    const visibilityStats = this.visibility.getStats();
    const rumorStats = this.rumorEngine.getStats();

    return {
      awarenessStats: {
        totalFacts: awarenessStats.totalFacts,
        knownFacts: awarenessStats.byStatus.known ?? 0,
        suspected: awarenessStats.byStatus.suspected ?? 0,
        misunderstandings: awarenessStats.byStatus.misunderstood ?? 0,
      },
      beliefStats: {
        total: beliefStats.totalBeliefs,
        active: (beliefStats.byStatus.held ?? 0) + (beliefStats.byStatus.strong ?? 0),
        strong: beliefStats.byStatus.strong ?? 0,
        conflicts: beliefStats.conflictCount,
      },
      visibilityStats: {
        rules: visibilityStats.totalRules,
        stealthedAgents: visibilityStats.stealthedAgents,
      },
      rumorStats: {
        active: rumorStats.activeRumors,
        totalSpreadEvents: rumorStats.totalSpreadEvents,
      },
    };
  }

  /**
   * 打印状态摘要
   */
  printStatus(): string {
    const snap = this.getSnapshot();
    return [
      '=== Perception Runtime 状态 ===',
      '',
      `认知空间:`,
      `  总事实: ${snap.awarenessStats.totalFacts}`,
      `  已知: ${snap.awarenessStats.knownFacts}`,
      `  怀疑: ${snap.awarenessStats.suspected}`,
      `  误解: ${snap.awarenessStats.misunderstandings}`,
      '',
      `信念系统:`,
      `  总信念: ${snap.beliefStats.total}`,
      `  活跃: ${snap.beliefStats.active}`,
      `  深信: ${snap.beliefStats.strong}`,
      `  冲突: ${snap.beliefStats.conflicts}`,
      '',
      `可见性:`,
      `  规则: ${snap.visibilityStats.rules}`,
      `  潜行中: ${snap.visibilityStats.stealthedAgents}`,
      '',
      `谣言:`,
      `  活跃: ${snap.rumorStats.active}`,
      `  传播事件: ${snap.rumorStats.totalSpreadEvents}`,
    ].join('\n');
  }

  /**
   * 重置
   */
  reset(): void {
    this.awareness.reset();
    this.beliefSystem.reset();
    this.visibility.reset();
    this.rumorEngine.reset();
  }
}

export interface PerceptionTickResult {
  rumorSpreads: RumorSpreadEvent[];
  awarenessUpdates: number;
  beliefChanges: number;
}

export interface ProcessedPerception {
  perceived: PerceivedWorldState;
  newFacts: AwarenessFact[];
  awarenessSnapshot: any;
  beliefSnapshot: any;
}

export default PerceptionRuntime;
