/**
 * agent-trace.ts - Agent 行为追踪系统
 *
 * 可观察 Agent 的：
 * - 行动原因（为什么做 A 而不是 B）
 * - Goal 改变原因（为什么切换目标）
 * - 关系变化原因（为什么对某人态度改变）
 * - 情绪变化原因
 * - 意图生成原因
 * - 需求变化轨迹
 *
 * 这是调试"Agent 为什么这样做"的关键工具。
 */

import type { NeedType } from '../agent/agent-needs';
import type { IntentionType } from '../agent/agent-intentions';

export type AgentTraceEventType =
  | 'need_changed'
  | 'emotion_changed'
  | 'intention_generated'
  | 'intention_consumed'
  | 'goal_set'
  | 'goal_updated'
  | 'goal_abandoned'
  | 'goal_completed'
  | 'relation_changed'
  | 'action_taken'
  | 'schedule_changed'
  | 'event_reacted'
  | 'location_changed'
  | 'state_changed'
  ;

export interface AgentTraceEntry {
  id: string;
  timestamp: number;
  agentId: string;
  agentName: string;
  eventType: AgentTraceEventType;
  description: string;
  /** 变更前值 */
  before?: any;
  /** 变更后值 */
  after?: any;
  /** 触发原因 */
  reason?: string;
  data: Record<string, any>;
}

export class AgentTracer {
  private entries: AgentTraceEntry[] = [];
  private readonly MAX_ENTRIES_PER_AGENT = 500;
  private idCounter: number = 0;

  /**
   * 记录 Agent 事件
   */
  trace(
    agentId: string,
    agentName: string,
    eventType: AgentTraceEventType,
    description: string,
    data: Record<string, any> = {},
    before?: any,
    after?: any,
    reason?: string
  ): string {
    const id = `atrace_${++this.idCounter}_${Date.now()}`;

    const entry: AgentTraceEntry = {
      id,
      timestamp: Date.now(),
      agentId,
      agentName,
      eventType,
      description,
      before,
      after,
      reason,
      data,
    };

    this.entries.push(entry);

    // 按 Agent 限制条目数
    const agentEntries = this.entries.filter(e => e.agentId === agentId);
    if (agentEntries.length > this.MAX_ENTRIES_PER_AGENT) {
      // 删除该 Agent 最早的条目
      const firstAgentEntry = agentEntries[0];
      const idx = this.entries.indexOf(firstAgentEntry);
      if (idx >= 0) this.entries.splice(idx, 1);
    }

    return id;
  }

  /**
   * 记录需求变化
   */
  needChanged(
    agentId: string, agentName: string,
    needType: NeedType, before: number, after: number, reason: string
  ): void {
    this.trace(agentId, agentName, 'need_changed',
      `需求 ${needType}: ${(before * 100).toFixed(0)}% → ${(after * 100).toFixed(0)}%`,
      { needType, before, after },
      before, after, reason
    );
  }

  /**
   * 记录情绪变化
   */
  emotionChanged(
    agentId: string, agentName: string,
    before: string, after: string, reason: string
  ): void {
    this.trace(agentId, agentName, 'emotion_changed',
      `情绪: ${before} → ${after}`,
      { beforeEmotion: before, afterEmotion: after },
      before, after, reason
    );
  }

  /**
   * 记录意图生成
   */
  intentionGenerated(
    agentId: string, agentName: string,
    intentionType: IntentionType, description: string,
    strength: number, source: string
  ): void {
    this.trace(agentId, agentName, 'intention_generated',
      `意图 [${intentionType}] ${description} (强度: ${strength.toFixed(2)}, 来源: ${source})`,
      { intentionType, strength, source }
    );
  }

  /**
   * 记录关系变化
   */
  relationChanged(
    agentId: string, agentName: string,
    targetId: string, targetName: string,
    before: number, after: number, reason: string
  ): void {
    this.trace(agentId, agentName, 'relation_changed',
      `对 ${targetName} 的关系: ${(before * 100).toFixed(0)} → ${(after * 100).toFixed(0)}`,
      { targetId, targetName, beforeValue: before, afterValue: after },
      before, after, reason
    );
  }

  /**
   * 记录行动
   */
  actionTaken(
    agentId: string, agentName: string,
    action: string, reason: string
  ): void {
    this.trace(agentId, agentName, 'action_taken',
      `行动: ${action}`,
      { action },
      undefined, undefined, reason
    );
  }

  /**
   * 获取指定 Agent 的跟踪数据
   */
  getAgentTrace(agentId: string, limit?: number): AgentTraceEntry[] {
    const result = this.entries
      .filter(e => e.agentId === agentId)
      .sort((a, b) => b.timestamp - a.timestamp);

    return limit ? result.slice(0, limit) : result;
  }

  /**
   * 获取所有 Agent 的跟踪数据
   */
  getAllEntries(filter?: {
    agentId?: string;
    eventType?: AgentTraceEventType;
    from?: number;
    to?: number;
    limit?: number;
  }): AgentTraceEntry[] {
    let result = [...this.entries];

    if (filter?.agentId) {
      result = result.filter(e => e.agentId === filter.agentId);
    }
    if (filter?.eventType) {
      result = result.filter(e => e.eventType === filter.eventType);
    }
    if (filter?.from) {
      result = result.filter(e => e.timestamp >= filter.from!);
    }
    if (filter?.to) {
      result = result.filter(e => e.timestamp <= filter.to!);
    }

    result.sort((a, b) => b.timestamp - a.timestamp);

    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  /**
   * 获取 Agent 行为摘要
   */
  getAgentSummary(agentId: string): string {
    const agentEntries = this.entries.filter(e => e.agentId === agentId);
    if (agentEntries.length === 0) return '无追踪数据';

    const latest = agentEntries.slice(-20).sort((a, b) => b.timestamp - a.timestamp);
    const byType: Record<string, number> = {};
    for (const e of agentEntries) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

    const lastAction = agentEntries.findLast(e => e.eventType === 'action_taken');
    const lastEmotion = agentEntries.findLast(e => e.eventType === 'emotion_changed');
    const lastRelation = agentEntries.findLast(e => e.eventType === 'relation_changed');

    const lines = [
      `=== Agent ${agentEntries[0]?.agentName ?? agentId} 追踪摘要 ===`,
      `总事件: ${agentEntries.length}`,
      `事件分布: ${Object.entries(byType).map(([t, c]) => `${t}(${c})`).join(', ')}`,
      ``,
      lastAction ? `最后行动: ${lastAction.description}` : '尚无行动',
      lastEmotion ? `最后情绪变化: ${lastEmotion.description}` : '',
      lastRelation ? `最后关系变化: ${lastRelation.description}` : '',
      ``,
      `最近事件 (Top 10):`,
      ...latest.slice(0, 10).map(e =>
        `  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.description}${e.reason ? ` | 原因: ${e.reason}` : ''}`
      ),
    ];

    return lines.filter(l => l).join('\n');
  }

  /**
   * 获取全局摘要
   */
  getGlobalSummary(): string {
    const agents = new Set(this.entries.map(e => e.agentId));
    const totalActions = this.entries.filter(e => e.eventType === 'action_taken').length;
    const totalIntentions = this.entries.filter(e => e.eventType === 'intention_generated').length;
    const totalRelations = this.entries.filter(e => e.eventType === 'relation_changed').length;
    const totalEmotions = this.entries.filter(e => e.eventType === 'emotion_changed').length;

    const byType: Record<string, number> = {};
    for (const e of this.entries) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

    return [
      `=== Agent 全局追踪摘要 ===`,
      `追踪 Agent: ${agents.size} 个`,
      `总追踪条目: ${this.entries.length}`,
      `行动: ${totalActions} | 意图: ${totalIntentions} | 关系: ${totalRelations} | 情绪: ${totalEmotions}`,
      ``,
      `事件分布:`,
      ...Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `  ${t}: ${c} 次`),
    ].join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * 导出
   */
  export(): AgentTraceEntry[] {
    return [...this.entries];
  }
}

export default AgentTracer;
