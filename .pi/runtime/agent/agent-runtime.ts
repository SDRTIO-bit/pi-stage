/**
 * agent-runtime.ts - Agent 运行时状态
 *
 * 每个 Agent 的完整运行时状态。
 * Agent 不再只在用户输入时"存在"，
 * 他们在世界中持续存活：
 * - 有需求（需要被满足）
 * - 有情绪（随事件变化）
 * - 有日程（何时何地在做什么）
 * - 有意图（下一步想做什么）
 * - 有目标（长期追求）
 * - 有记忆（记住经历）
 * - 有关系（对其他人有看法）
 * - 有状态（当前在做什么）
 */

import type { Goal } from './goal-system';
import { AgentNeeds } from './agent-needs';
import { AgentEmotions } from './agent-emotions';
import { AgentSchedule } from './agent-schedule';
import { AgentIntentions, type Intention } from './agent-intentions';
import { MemoryLayer } from '../memory/memory-layer';

export type AgentState = 'idle' | 'active' | 'scheduled' | 'responding' | 'resting' | 'exploring' | 'socializing' | 'working';

export interface AgentRelation {
  characterId: string;
  /** 关系值 -1 ~ 1 */
  value: number;
  /** 信任度 0-1 */
  trust: number;
  /** 熟悉度 0-1 */
  familiarity: number;
  /** 最后互动时间 */
  lastInteraction: number;
  /** 互动次数 */
  interactionCount: number;
  /** 情感标签 */
  emotionalTag: string;
  /** 关系历史摘要 */
  summary: string;
}

export interface AgentRuntimeStateSnapshot {
  agentId: string;
  name: string;
  state: AgentState;
  location: string;
  currentActivity: string | null;
  dominantEmotion: string;
  topNeed: string;
  topIntention: string | null;
  relations: Array<{ characterId: string; value: number; trust: number }>;
  goalCount: number;
  memoryCount: number;
}

export class AgentRuntimeState {
  readonly agentId: string;
  name: string;
  state: AgentState = 'idle';
  location: string;
  description: string;

  /** 核心子系统 */
  needs: AgentNeeds;
  emotions: AgentEmotions;
  schedule: AgentSchedule;
  intentions: AgentIntentions;

  /** 关系网 */
  relations: Map<string, AgentRelation> = new Map();

  /** 活跃目标 ID 列表 */
  activeGoalIds: string[] = [];

  /** 内存引用（非拥有，共享 MemoryLayer） */
  private memory: MemoryLayer | null = null;

  /** 最后 tick 时间 */
  lastTickAt: number = Date.now();

  /** 累计 tick 数 */
  totalTicks: number = 0;

  /** Agent 上下文摘要（供 Context Assembly 使用） */
  contextSummary: string = '';

  constructor(
    agentId: string,
    name: string,
    location: string,
    description: string = '',
    memory?: MemoryLayer
  ) {
    this.agentId = agentId;
    this.name = name;
    this.location = location;
    this.description = description;
    this.memory = memory ?? null;

    this.needs = new AgentNeeds();
    this.emotions = new AgentEmotions();
    this.schedule = new AgentSchedule();
    this.intentions = new AgentIntentions();
  }

  /**
   * 每 tick 调用：推进所有子系统
   */
  tick(deltaMinutes: number = 10): AgentTickResult {
    this.lastTickAt = Date.now();
    this.totalTicks++;

    // 1. 需求增长
    this.needs.tick(deltaMinutes);

    // 2. 情绪衰减
    this.emotions.tick();

    // 3. 日程推进
    const scheduleResult = this.schedule.tick(
      this.getCurrentMinute(),
      this.getCurrentDay(),
      this.getCurrentDayOfWeek()
    );

    // 4. 从需求生成意图
    const needs = this.needs.getAllNeeds();
    const dominantDrive = this.needs.getDominantDrive();
    if (dominantDrive) {
      const needIntentions = this.intentions.generateFromNeeds(needs, 0.5);
      this.intentions.addIntentions(needIntentions);

      // 需求不满 → 情绪影响
      this.emotions.applyNeedFrustration(dominantDrive.type, dominantDrive.strength);
    }

    // 5. 更新状态
    if (scheduleResult.activityChanged) {
      this.state = this.currentActivity ? 'scheduled' : 'idle';
    }

    return {
      scheduleResult,
      dominantNeed: dominantDrive,
      dominantEmotion: this.emotions.getDominantEmotion(),
      topIntention: this.intentions.getTopIntention(),
      scheduleChanged: scheduleResult.activityChanged,
    };
  }

  /**
   * 应用事件到 Agent
   */
  applyEvent(event: {
    type: string;
    intensity: number;
    source?: string;
    description?: string;
  }): void {
    // 情绪影响
    this.emotions.applyEvent({
      type: event.type,
      intensity: event.intensity,
      target: event.source,
      description: event.description,
    });

    // 生成意图
    const eventIntentions = this.intentions.generateFromEvent(
      event.type, event.intensity, event.description
    );
    this.intentions.addIntentions(eventIntentions);

    // 需求影响（特定事件类型）
    if (event.type === 'socialize' || event.type === 'conversation') {
      this.needs.applyBehavior('conversation', event.intensity);
    } else if (event.type === 'conflict') {
      this.needs.applyBehavior('conflict', event.intensity);
    }
  }

  /**
   * 更新关系
   */
  updateRelation(characterId: string, delta: number): void {
    let relation = this.relations.get(characterId);
    if (!relation) {
      relation = {
        characterId,
        value: 0,
        trust: 0.3,
        familiarity: 0,
        lastInteraction: Date.now(),
        interactionCount: 0,
        emotionalTag: 'neutral',
        summary: '',
      };
      this.relations.set(characterId, relation);
    }

    relation.value = Math.max(-1, Math.min(1, relation.value + delta));
    relation.trust = Math.max(0, Math.min(1, relation.trust + delta * 0.3));
    relation.familiarity = Math.min(1, relation.familiarity + Math.abs(delta) * 0.1);
    relation.lastInteraction = Date.now();
    relation.interactionCount++;

    // 情绪影响
    this.emotions.applySocialEffect(delta);

    // 生成意图
    const relIntentions = this.intentions.generateFromRelation(characterId, delta);
    this.intentions.addIntentions(relIntentions);
  }

  /**
   * 获取关系
   */
  getRelation(characterId: string): AgentRelation | undefined {
    return this.relations.get(characterId);
  }

  /**
   * 获取所有关系摘要
   */
  getRelationSummary(): Array<{ characterId: string; value: number; trust: number; familiarity: number }> {
    return Array.from(this.relations.values()).map(r => ({
      characterId: r.characterId,
      value: r.value,
      trust: r.trust,
      familiarity: r.familiarity,
    }));
  }

  /**
   * 获取运行时快照（用于调试/序列化）
   */
  getSnapshot(): AgentRuntimeStateSnapshot {
    return {
      agentId: this.agentId,
      name: this.name,
      state: this.state,
      location: this.location,
      currentActivity: this.schedule.getCurrentActivity()?.activity ?? null,
      dominantEmotion: this.emotions.getDominantEmotion(),
      topNeed: this.needs.getDominantDrive()?.type ?? 'none',
      topIntention: this.intentions.getTopIntention()?.description ?? null,
      relations: Array.from(this.relations.values()).map(r => ({
        characterId: r.characterId,
        value: r.value,
        trust: r.trust,
      })),
      goalCount: this.activeGoalIds.length,
      memoryCount: 0,
    };
  }

  // ============================================================
  // 辅助函数
  // ============================================================

  private getCurrentMinute(): number {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }

  private getCurrentDay(): number {
    return Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  }

  private getCurrentDayOfWeek(): number {
    return new Date().getDay();
  }

  private get currentActivity(): boolean {
    return this.schedule.getCurrentActivity() !== null;
  }
}

export interface AgentTickResult {
  scheduleResult: import('./agent-schedule').ScheduleTickResult;
  dominantNeed: { type: string; strength: number } | null;
  dominantEmotion: string;
  topIntention: Intention | null;
  scheduleChanged: boolean;
}

export default AgentRuntimeState;
