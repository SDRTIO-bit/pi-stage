/**
 * perception-trace.ts — 感知追踪
 *
 * 追踪 PerceptionFilter 的所有活动：
 * - 原始世界输入 → 感知输出
 * - 哪些信息被过滤掉及原因
 * - 感知偏差的来源
 * - 感知精度变化
 *
 * 可观察：
 * - 为什么 Agent 看到了/没看到某件信息
 * - 情绪如何扭曲了感知
 * - 注意力如何影响了感知
 */

import type { PerceivedEvent, PerceivedLocation, PerceivedAgent } from '../../perception/perception-filter';

export type PerceptionTraceEventType =
  | 'perception:raw_input'
  | 'perception:filtered'
  | 'perception:event_seen'
  | 'perception:event_missed'
  | 'perception:agent_seen'
  | 'perception:agent_missed'
  | 'perception:location_known'
  | 'perception:location_hidden'
  | 'perception:bias_applied'
  | 'perception:confidence_changed'
  ;

export interface PerceptionTraceEntry {
  id: string;
  timestamp: number;
  eventType: PerceptionTraceEventType;
  agentId: string;
  /** 目标实体 ID */
  targetId?: string;
  /** 目标描述 */
  targetDescription?: string;
  /** 感知置信度 */
  confidence?: number;
  /** 感知偏差 */
  biases?: string[];
  /** 过滤原因 */
  filterReason?: string;
  description: string;
  data: Record<string, any>;
}

export class PerceptionTracer {
  private entries: PerceptionTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  rawInput(agentId: string, eventCount: number, agentCount: number, locationCount: number): void {
    this.addEntry({
      eventType: 'perception:raw_input',
      agentId,
      description: `原始输入: ${eventCount} 事件, ${agentCount} Agent, ${locationCount} 地点`,
      data: { eventCount, agentCount, locationCount },
    });
  }

  filtered(agentId: string, rawCount: number, filteredCount: number, filterReason: string): void {
    this.addEntry({
      eventType: 'perception:filtered',
      agentId,
      filterReason,
      description: `过滤: ${rawCount} → ${filteredCount} (${filterReason})`,
      data: { rawCount, filteredCount, filterReason },
    });
  }

  eventSeen(agentId: string, event: PerceivedEvent): void {
    this.addEntry({
      eventType: 'perception:event_seen',
      agentId,
      targetId: event.rawEventId,
      targetDescription: event.description,
      confidence: event.confidence,
      biases: event.biases,
      description: `感知到事件: "${event.name}" (置信度: ${(event.confidence * 100).toFixed(0)}%)`,
      data: { biases: event.biases, requiresVerification: event.requiresVerification },
    });
  }

  eventMissed(agentId: string, eventId: string, eventName: string, reason: string): void {
    this.addEntry({
      eventType: 'perception:event_missed',
      agentId,
      targetId: eventId,
      targetDescription: eventName,
      filterReason: reason,
      description: `错过事件: "${eventName}" — ${reason}`,
      data: { reason },
    });
  }

  agentSeen(agentId: string, agent: PerceivedAgent): void {
    this.addEntry({
      eventType: 'perception:agent_seen',
      agentId,
      targetId: agent.agentId,
      targetDescription: agent.name,
      confidence: agent.accuracy,
      description: `感知到Agent: "${agent.name}" — 情绪: ${agent.perceivedEmotion} (精度: ${(agent.accuracy * 100).toFixed(0)}%)`,
      data: { perceivedEmotion: agent.perceivedEmotion, identityConfirmed: agent.identityConfirmed },
    });
  }

  agentMissed(agentId: string, targetId: string, targetName: string, reason: string): void {
    this.addEntry({
      eventType: 'perception:agent_missed',
      agentId,
      targetId,
      targetDescription: targetName,
      filterReason: reason,
      description: `未感知到Agent: "${targetName}" — ${reason}`,
      data: { reason },
    });
  }

  biasApplied(agentId: string, biasType: string, targetDescription: string): void {
    this.addEntry({
      eventType: 'perception:bias_applied',
      agentId,
      targetDescription,
      biases: [biasType],
      description: `感知偏差: ${biasType} — 影响对 "${targetDescription}" 的判断`,
      data: { biasType },
    });
  }

  getEntries(filter?: { eventType?: PerceptionTraceEventType; agentId?: string; limit?: number }): PerceptionTraceEntry[] {
    let result = [...this.entries];
    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.agentId) result = result.filter(e => e.agentId === filter.agentId);
    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  getAgentPerceptionSummary(agentId: string): string {
    const agentEntries = this.entries.filter(e => e.agentId === agentId);
    const seen = agentEntries.filter(e => e.eventType === 'perception:event_seen').length;
    const missed = agentEntries.filter(e => e.eventType === 'perception:event_missed').length;
    const biases = agentEntries.filter(e => e.eventType === 'perception:bias_applied').length;

    return [
      `=== ${agentId} 感知摘要 ===`,
      `总追踪: ${agentEntries.length}`,
      `事件: ${seen} 感知 / ${missed} 错过`,
      `偏差: ${biases} 次`,
    ].join('\n');
  }

  clear(): void { this.entries = []; }

  private addEntry(data: Omit<PerceptionTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({ id: `ptrace_${++this.idCounter}`, timestamp: Date.now(), ...data });
    if (this.entries.length > this.MAX_ENTRIES) this.entries.shift();
  }
}

export default PerceptionTracer;
