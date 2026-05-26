/**
 * awareness-trace.ts — 认知追踪
 *
 * 追踪 AwarenessRuntime 的所有变化：
 * - 新事实的加入
 * - 置信度变化
 * - 状态迁移（known→forgotten, suspected→known）
 * - 误解的形成和纠正
 *
 * 可观察：
 * - 为什么 Agent 知道某件事
 * - 信息是如何被遗忘的
 * - 误解是如何形成的
 */

import type { FactStatus, AwarenessUpdate } from '../../perception/awareness-runtime';

export type AwarenessTraceEventType =
  | 'awareness:new_fact'
  | 'awareness:confidence_changed'
  | 'awareness:status_changed'
  | 'awareness:fact_forgotten'
  | 'awareness:fact_recalled'
  | 'awareness:misunderstanding_formed'
  | 'awareness:misunderstanding_corrected'
  | 'awareness:knowledge_gap_identified'
  ;

export interface AwarenessTraceEntry {
  id: string;
  timestamp: number;
  eventType: AwarenessTraceEventType;
  factId?: string;
  content: string;
  oldStatus?: FactStatus;
  newStatus?: FactStatus;
  oldConfidence?: number;
  newConfidence?: number;
  description: string;
  data: Record<string, any>;
}

export class AwarenessTracer {
  private entries: AwarenessTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  newFact(factId: string, content: string, category: string, confidence: number, source: string): void {
    this.addEntry({
      eventType: 'awareness:new_fact',
      factId, content,
      newConfidence: confidence,
      description: `新事实: "${content.substring(0, 60)}" (${category}, 置信度: ${(confidence * 100).toFixed(0)}%, 来源: ${source})`,
      data: { category, source },
    });
  }

  confidenceChanged(factId: string, content: string, oldConfidence: number, newConfidence: number, reason: string): void {
    this.addEntry({
      eventType: 'awareness:confidence_changed',
      factId, content,
      oldConfidence, newConfidence,
      description: `置信度变化: "${content.substring(0, 40)}" ${(oldConfidence * 100).toFixed(0)}% → ${(newConfidence * 100).toFixed(0)}% (${reason})`,
      data: { reason },
    });
  }

  statusChanged(factId: string, content: string, oldStatus: FactStatus, newStatus: FactStatus, reason: string): void {
    this.addEntry({
      eventType: 'awareness:status_changed',
      factId, content,
      oldStatus, newStatus,
      description: `状态变化: "${content.substring(0, 40)}" ${oldStatus} → ${newStatus} (${reason})`,
      data: { reason },
    });
  }

  forgotten(factId: string, content: string): void {
    this.addEntry({
      eventType: 'awareness:fact_forgotten',
      factId, content,
      newStatus: 'forgotten',
      description: `遗忘: "${content.substring(0, 50)}"`,
      data: {},
    });
  }

  misunderstandingFormed(factId: string, content: string, groundTruth: string, misunderstanding: string): void {
    this.addEntry({
      eventType: 'awareness:misunderstanding_formed',
      factId, content,
      description: `误解形成: 认为 "${content}" — 事实: "${groundTruth}" — 误解: "${misunderstanding}"`,
      data: { groundTruth, misunderstanding },
    });
  }

  misunderstandingCorrected(factId: string, content: string, correctedContent: string): void {
    this.addEntry({
      eventType: 'awareness:misunderstanding_corrected',
      factId, content,
      description: `误解纠正: "${content}" → "${correctedContent}"`,
      data: { correctedContent },
    });
  }

  knowledgeGapIdentified(topic: string): void {
    this.addEntry({
      eventType: 'awareness:knowledge_gap_identified',
      content: topic,
      description: `知识缺口: "${topic}" — Agent 不知道此事`,
      data: { topic },
    });
  }

  getEntries(filter?: { eventType?: AwarenessTraceEventType; factId?: string; limit?: number }): AwarenessTraceEntry[] {
    let result = [...this.entries];
    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.factId) result = result.filter(e => e.factId === filter.factId);
    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  clear(): void { this.entries = []; }

  private addEntry(data: Omit<AwarenessTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({ id: `awtrace_${++this.idCounter}`, timestamp: Date.now(), ...data });
    if (this.entries.length > this.MAX_ENTRIES) this.entries.shift();
  }
}

export default AwarenessTracer;
