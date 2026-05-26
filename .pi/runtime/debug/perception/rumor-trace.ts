/**
 * rumor-trace.ts — 谣言传播追踪
 *
 * 追踪 RumorEngine 的所有活动：
 * - 谣言创建
 * - 谣言传播
 * - 信息扭曲
 * - 谣言消亡
 *
 * 可观察：
 * - 为什么谣言形成
 * - 信息如何被扭曲
 * - 为什么信息传播到某处
 * - 为什么 belief 改变
 */

import type { RumorType, RumorStatus } from '../../perception/rumor-engine';

export type RumorTraceEventType =
  | 'rumor:created'
  | 'rumor:spread'
  | 'rumor:distorted'
  | 'rumor:established'
  | 'rumor:dying'
  | 'rumor:extinct'
  | 'rumor:misinformation_detected'
  ;

export interface RumorTraceEntry {
  id: string;
  timestamp: number;
  eventType: RumorTraceEventType;
  rumorId: string;
  content: string;
  rumorType: RumorType;
  fromAgentId?: string;
  toAgentId?: string;
  distortionLevel?: number;
  hopCount?: number;
  description: string;
  data: Record<string, any>;
}

export class RumorTracer {
  private entries: RumorTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  created(rumorId: string, content: string, type: RumorType, originatorId: string): void {
    this.addEntry({
      eventType: 'rumor:created',
      rumorId, content, rumorType: type,
      fromAgentId: originatorId,
      description: `谣言创建: "${content.substring(0, 50)}" (${type}) — 来源: ${originatorId}`,
      data: { originatorId, type },
    });
  }

  spread(rumorId: string, content: string, fromAgentId: string, toAgentId: string, confidence: number): void {
    this.addEntry({
      eventType: 'rumor:spread',
      rumorId, content, rumorType: 'speculation',
      fromAgentId, toAgentId,
      description: `谣言传播: "${content.substring(0, 40)}" ${fromAgentId} → ${toAgentId} (置信度: ${(confidence * 100).toFixed(0)}%)`,
      data: { fromAgentId, toAgentId, confidence },
    });
  }

  distorted(rumorId: string, originalContent: string, newContent: string, distortionLevel: number, hopCount: number): void {
    this.addEntry({
      eventType: 'rumor:distorted',
      rumorId, content: newContent, rumorType: 'speculation',
      distortionLevel, hopCount,
      description: `信息扭曲 (第 ${hopCount} 跳, 扭曲度: ${(distortionLevel * 100).toFixed(0)}%): "${originalContent.substring(0, 30)}" → "${newContent.substring(0, 30)}"`,
      data: { originalContent, newContent, distortionLevel, hopCount },
    });
  }

  established(rumorId: string, content: string, knownByCount: number): void {
    this.addEntry({
      eventType: 'rumor:established',
      rumorId, content, rumorType: 'speculation',
      description: `谣言固化: "${content.substring(0, 40)}" — 已被 ${knownByCount} 个 Agent 知晓`,
      data: { knownByCount },
    });
  }

  extinct(rumorId: string, content: string): void {
    this.addEntry({
      eventType: 'rumor:extinct',
      rumorId, content, rumorType: 'speculation',
      description: `谣言消亡: "${content.substring(0, 40)}"`,
      data: {},
    });
  }

  misinformationDetected(rumorId: string, content: string, liarId: string, targetId?: string): void {
    this.addEntry({
      eventType: 'rumor:misinformation_detected',
      rumorId, content, rumorType: 'malicious_lie',
      fromAgentId: liarId,
      description: `恶意信息: "${content.substring(0, 40)}" — 散布者: ${liarId}${targetId ? `, 针对: ${targetId}` : ''}`,
      data: { liarId, targetId },
    });
  }

  getRumorTimeline(rumorId: string): RumorTraceEntry[] {
    return this.entries.filter(e => e.rumorId === rumorId).sort((a, b) => a.timestamp - b.timestamp);
  }

  getEntries(filter?: { eventType?: RumorTraceEventType; rumorId?: string; limit?: number }): RumorTraceEntry[] {
    let result = [...this.entries];
    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.rumorId) result = result.filter(e => e.rumorId === filter.rumorId);
    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  clear(): void { this.entries = []; }

  private addEntry(data: Omit<RumorTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({ id: `rtrace_${++this.idCounter}`, timestamp: Date.now(), ...data });
    if (this.entries.length > this.MAX_ENTRIES) this.entries.shift();
  }
}

export default RumorTracer;
