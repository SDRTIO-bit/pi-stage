/**
 * agent-loop.ts - Agent 自主循环
 *
 * 每个 Agent 周期性执行：
 * - evaluate goals（评估目标）
 * - retrieve memories（检索记忆）
 * - update emotions（更新情绪）
 * - update relations（更新关系）
 * - generate intentions（生成意图）
 * - schedule actions（安排行动）
 * - react to events（响应事件）
 *
 * 支持：
 * - per-agent runtime state（每个 Agent 独立运行时状态）
 * - agent isolation（Agent 隔离）
 * - dynamic attention allocation（动态注意力分配）
 * - autonomous behavior（自主行为）
 */

import { AgentRuntimeState, type AgentTickResult } from '../agent/agent-runtime';
import type { AgentRelation } from '../agent/agent-runtime';
import type { Intention } from '../agent/agent-intentions';
import { WorldStateRuntime } from './world-state';
import type { MemoryLayer, MemoryQuery } from '../memory/memory-layer';
import type { EventBus } from '../events/event-bus';

export interface AgentLoopConfig {
  /** Agent 每次 tick 推进的游戏分钟数 */
  minutesPerTick: number;
  /** 意图冷却（填写 tick 数，执行后必须等待才能生成同类型意图） */
  intentionCooldownTicks: number;
  /** 关系变化衰减率 */
  relationDecayRate: number;
  /** 是否启用自适应 tick 率（根据 Agent 活跃度调整） */
  adaptiveTickRate: boolean;
  /** 最小 tick 间隔（毫秒） */
  minTickInterval: number;
  /** 最大 tick 间隔（毫秒） */
  maxTickInterval: number;
}

const DEFAULT_AGENT_LOOP_CONFIG: AgentLoopConfig = {
  minutesPerTick: 10,
  intentionCooldownTicks: 3,
  relationDecayRate: 0.001,
  adaptiveTickRate: true,
  minTickInterval: 2000,
  maxTickInterval: 10000,
};

export class AgentLoop {
  private agents: Map<string, AgentRuntimeState> = new Map();
  private worldState: WorldStateRuntime;
  private memory: MemoryLayer | null;
  private eventBus: EventBus | null;
  private config: AgentLoopConfig;

  /** Agent 意图冷却跟踪 */
  private intentionCooldowns: Map<string, Map<string, number>> = new Map();

  /** 总计 tick 数 */
  private totalAgentTicks: number = 0;

  constructor(
    worldState: WorldStateRuntime,
    memory?: MemoryLayer,
    eventBus?: EventBus,
    config?: Partial<AgentLoopConfig>
  ) {
    this.worldState = worldState;
    this.memory = memory ?? null;
    this.eventBus = eventBus ?? null;
    this.config = { ...DEFAULT_AGENT_LOOP_CONFIG, ...config };
  }

  /**
   * 注册 Agent
   */
  registerAgent(agent: AgentRuntimeState): void {
    this.agents.set(agent.agentId, agent);
    this.intentionCooldowns.set(agent.agentId, new Map());
    this.eventBus?.emit('agent:registered', { agentId: agent.agentId, name: agent.name });
  }

  /**
   * 注销 Agent
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
    this.intentionCooldowns.delete(agentId);
    this.eventBus?.emit('agent:unregistered', { agentId });
  }

  /**
   * 获取 Agent
   */
  getAgent(agentId: string): AgentRuntimeState | undefined {
    return this.agents.get(agentId);
  }

  /**
   * 获取所有 Agent
   */
  getAllAgents(): AgentRuntimeState[] {
    return Array.from(this.agents.values());
  }

  /**
   * 主 tick：对所有 Agent 执行一次自主循环
   */
  tick(deltaMinutes: number = 10): Map<string, AgentTickResult> {
    this.totalAgentTicks++;
    const results = new Map<string, AgentTickResult>();

    for (const [agentId, agent] of this.agents) {
      const result = this.tickAgent(agent, deltaMinutes);
      results.set(agentId, result);
    }

    // 更新所有 Agent 之间的关系（自然衰减）
    this.decayRelations(deltaMinutes);

    return results;
  }

  /**
   * 对单个 Agent 执行自主循环
   */
  private tickAgent(agent: AgentRuntimeState, deltaMinutes: number): AgentTickResult {
    // 1. 基础 tick（需求 + 情绪 + 日程）
    const baseResult = agent.tick(deltaMinutes);

    // 2. 评估目标
    this.evaluateGoals(agent);

    // 3. 检索相关记忆
    this.retrieveMemories(agent);

    // 4. 生成意图
    this.generateIntentions(agent);

    // 5. 检查事件响应
    this.checkEventReaction(agent);

    // 6. 清理已过期的意图
    agent.intentions.cleanup();

    this.eventBus?.emit('agent:tick', {
      agentId: agent.agentId,
      result: baseResult,
    });

    return baseResult;
  }

  /**
   * 评估目标
   */
  private evaluateGoals(agent: AgentRuntimeState): void {
    const needs = agent.needs.getAllNeeds();
    const dominantDrive = agent.needs.getDominantDrive();

    // 如果需求很强烈，检查是否有对应目标
    if (dominantDrive && dominantDrive.strength > 0.6) {
      // 记录到意图系统
      const needRelatedIntentions = agent.intentions.generateFromNeeds(needs, 0.5);
      agent.intentions.addIntentions(needRelatedIntentions);
    }
  }

  /**
   * 检索记忆
   */
  private retrieveMemories(agent: AgentRuntimeState): void {
    if (!this.memory) return;

    // 根据当前情绪和位置检索相关记忆
    const emotion = agent.emotions.getDominantEmotion();
    const location = agent.location;

    // 用情绪词和位置作为关键词
    const query: MemoryQuery = {
      keywords: [emotion, location].filter(Boolean),
      limit: 5,
    };

    // 异步执行但不阻塞
    this.memory.retrieve(query).catch(() => {});
  }

  /**
   * 生成意图
   */
  private generateIntentions(agent: AgentRuntimeState): void {
    // 检查冷却
    const cooldowns = this.intentionCooldowns.get(agent.agentId);
    if (!cooldowns) return;

    // 根据当前情绪状态生成社交意图
    const emotion = agent.emotions.getDominantEmotion();
    if (emotion === 'lonely' || emotion === 'sad') {
      const existingSocial = agent.intentions.getActiveIntentions()
        .some(i => i.type === 'socialize');
      if (!existingSocial && !this.isOnCooldown(agent.agentId, 'socialize')) {
        agent.intentions.addIntention({
          type: 'socialize',
          description: '想找人聊聊',
          strength: 0.6,
          urgency: 0.5,
          source: 'emotion',
          relatedNeed: 'social',
        });
        this.setCooldown(agent.agentId, 'socialize');
      }
    }

    // 好奇心：如果在一个新地点
    const location = agent.location;
    if (location && Math.random() < 0.3) {
      const existingExplore = agent.intentions.getActiveIntentions()
        .some(i => i.type === 'explore');
      if (!existingExplore && !this.isOnCooldown(agent.agentId, 'explore')) {
        agent.intentions.addIntention({
          type: 'explore',
          description: `四处看看周围的情况`,
          strength: 0.4,
          urgency: 0.3,
          source: 'curiosity',
        });
        this.setCooldown(agent.agentId, 'explore');
      }
    }

    // 休息需求
    const relaxation = agent.needs.getNeed('relaxation');
    if (relaxation && relaxation.current > 0.6) {
      const existingRest = agent.intentions.getActiveIntentions()
        .some(i => i.type === 'rest');
      if (!existingRest && !this.isOnCooldown(agent.agentId, 'rest')) {
        agent.intentions.addIntention({
          type: 'rest',
          description: '有点累了，想休息一下',
          strength: relaxation.current,
          urgency: relaxation.current * 0.8,
          source: 'need',
          relatedNeed: 'relaxation',
        });
        this.setCooldown(agent.agentId, 'rest');
      }
    }
  }

  /**
   * 检查是否需要响应当前世界事件
   */
  private checkEventReaction(agent: AgentRuntimeState): void {
    const activeEvents = this.worldState.getActiveEvents()
      .filter(e => e.affectedAgents.includes(agent.agentId) ||
                   e.affectedLocations.includes(agent.location));

    for (const event of activeEvents) {
      agent.applyEvent({
        type: event.type,
        intensity: event.scale === 'catastrophic' ? 0.9
                  : event.scale === 'major' ? 0.7
                  : event.scale === 'moderate' ? 0.5
                  : 0.3,
        source: event.id,
        description: event.description,
      });

      this.eventBus?.emit('agent:react_to_event', {
        agentId: agent.agentId,
        eventId: event.id,
        eventName: event.name,
      });
    }
  }

  /**
   * 关系自然衰减
   */
  private decayRelations(deltaMinutes: number): void {
    const decay = this.config.relationDecayRate * deltaMinutes;

    for (const agent of this.agents.values()) {
      for (const [charId, relation] of agent.relations) {
        // 关系随时间缓慢回归中性
        if (relation.value > 0) {
          relation.value = Math.max(0, relation.value - decay);
        } else if (relation.value < 0) {
          relation.value = Math.min(0, relation.value + decay);
        }
        relation.trust = relation.value > 0
          ? Math.max(0.2, relation.trust - decay * 0.5)
          : Math.min(0.5, relation.trust + decay * 0.5);
      }
    }
  }

  /**
   * 两个 Agent 之间的互动（由外部调用触发）
   */
  interact(agentIdA: string, agentIdB: string, interactionType: string, intensity: number): void {
    const agentA = this.agents.get(agentIdA);
    const agentB = this.agents.get(agentIdB);
    if (!agentA || !agentB) return;

    // 更新关系
    const delta = interactionType === 'friendly' ? 0.1
                : interactionType === 'hostile' ? -0.2
                : interactionType === 'helpful' ? 0.15
                : 0.05;

    agentA.updateRelation(agentIdB, delta * intensity);
    agentB.updateRelation(agentIdA, delta * intensity);

    // 应用行为到需求
    agentA.needs.applyBehavior('conversation', intensity);
    agentB.needs.applyBehavior('conversation', intensity);

    // 生成事件
    agentA.applyEvent({ type: interactionType, intensity, source: agentIdB });
    agentB.applyEvent({ type: interactionType, intensity, source: agentIdA });

    this.eventBus?.emit('agent:interact', {
      agentA: agentIdA, agentB: agentIdB,
      type: interactionType, intensity,
    });
  }

  /**
   * 获取 Agent 的总数
   */
  getAgentCount(): number {
    return this.agents.size;
  }

  /**
   * 获取所有 Agent 的快照
   */
  getAllSnapshots() {
    return Array.from(this.agents.values()).map(a => a.getSnapshot());
  }

  /**
   * 获取特定位置的 Agent
   */
  getAgentsAtLocation(locationId: string): AgentRuntimeState[] {
    return Array.from(this.agents.values())
      .filter(a => a.location === locationId);
  }

  /**
   * 冷却管理
   */
  private isOnCooldown(agentId: string, intentionType: string): boolean {
    const cooldowns = this.intentionCooldowns.get(agentId);
    if (!cooldowns) return false;
    const remaining = cooldowns.get(intentionType);
    if (!remaining) return false;
    return remaining > 0;
  }

  private setCooldown(agentId: string, intentionType: string): void {
    const cooldowns = this.intentionCooldowns.get(agentId);
    if (cooldowns) {
      cooldowns.set(intentionType, this.config.intentionCooldownTicks);
    }
  }

  private tickCooldowns(agentId: string): void {
    const cooldowns = this.intentionCooldowns.get(agentId);
    if (!cooldowns) return;
    for (const [type, remaining] of cooldowns) {
      if (remaining > 0) {
        cooldowns.set(type, remaining - 1);
      }
    }
  }

  /**
   * 重置
   */
  reset(): void {
    this.agents.clear();
    this.intentionCooldowns.clear();
    this.totalAgentTicks = 0;
  }
}

export default AgentLoop;
