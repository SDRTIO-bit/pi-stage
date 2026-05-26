/**
 * belief-trace.ts — 信念追踪
 *
 * 追踪 BeliefSystem 的所有变化：
 * - 信念形成
 * - 信念强化/削弱
 * - 信念被推翻
 * - 信念冲突
 * - 信念驱动的情感
 *
 * 可观察：
 * - 为什么 Agent 持有某个信念
 * - 信念是怎么改变的
 * - 为什么信念改变
 */

import type { BeliefStatus, BeliefCategory, BeliefSource } from '../../perception/belief-system';

export type BeliefTraceEventType =
  | 'belief:formed'
  | 'belief:strengthened'
  | 'belief:weakened'
  | 'belief:confirmed'
  | 'belief:refuted'
  | 'belief:abandoned'
  | 'belief:conflict_detected'
  | 'belief:emotional_influence'
  ;

export interface BeliefTraceEntry {
  id: string;
  timestamp: number;
  eventType: BeliefTraceEventType;
  beliefId: string;
  content: string;
  category: BeliefCategory;
  oldStrength: number;
  newStrength: number;
  description: string;
  data: Record<string, any>;
}

export class BeliefTracer {
  private entries: BeliefTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  formed(beliefId: string, content: string, category: BeliefCategory, strength: number, source: BeliefSource): void {
    this.addEntry({
      eventType: 'belief:formed',
      beliefId, content, category,
      oldStrength: 0, newStrength: strength,
      description: `信念形成: "${content}" (${category}, 强度: ${(strength * 100).toFixed(0)}%, 来源: ${source})`,
      data: { source },
    });
  }

  strengthened(beliefId: string, content: string, category: BeliefCategory, oldStrength: number, newStrength: number, evidence: string): void {
    this.addEntry({
      eventType: 'belief:strengthened',
      beliefId, content, category,
      oldStrength, newStrength,
      description: `信念强化: "${content.substring(0, 40)}" ${(oldStrength * 100).toFixed(0)}% → ${(newStrength * 100).toFixed(0)}% (证据: ${evidence})`,
      data: { evidence },
    });
  }

  weakened(beliefId: string, content: string, category: BeliefCategory, oldStrength: number, newStrength: number, reason: string): void {
    this.addEntry({
      eventType: 'belief:weakened',
      beliefId, content, category,
      oldStrength, newStrength,
      description: `信念削弱: "${content.substring(0, 40)}" ${(oldStrength * 100).toFixed(0)}% → ${(newStrength * 100).toFixed(0)}% (原因: ${reason})`,
      data: { reason },
    });
  }

  confirmed(beliefId: string, content: string, category: BeliefCategory, strength: number): void {
    this.addEntry({
      eventType: 'belief:confirmed',
      beliefId, content, category,
      oldStrength: strength - 0.1, newStrength: strength,
      description: `信念被证实: "${content.substring(0, 40)}"`,
      data: {},
    });
  }

  refuted(beliefId: string, content: string, category: BeliefCategory, reason: string): void {
    this.addEntry({
      eventType: 'belief:refuted',
      beliefId, content, category,
      oldStrength: 0.5, newStrength: 0.05,
      description: `信念被推翻: "${content.substring(0, 40)}" — ${reason}`,
      data: { reason },
    });
  }

  abandoned(beliefId: string, content: string, category: BeliefCategory, oldStrength: number, reason: string): void {
    this.addEntry({
      eventType: 'belief:abandoned',
      beliefId, content, category,
      oldStrength, newStrength: 0,
      description: `信念放弃: "${content.substring(0, 40)}" — ${reason}`,
      data: { reason },
    });
  }

  conflictDetected(beliefA: string, beliefB: string, conflict: string): void {
    this.addEntry({
      eventType: 'belief:conflict_detected',
      beliefId: 'conflict',
      content: conflict,
      category: 'causal_belief',
      oldStrength: 0, newStrength: 0,
      description: conflict,
      data: { beliefA, beliefB },
    });
  }

  emotionalInfluence(beliefId: string, content: string, category: BeliefCategory, emotion: string, intensity: number, strengthDelta: number): void {
    this.addEntry({
      eventType: 'belief:emotional_influence',
      beliefId, content, category,
      oldStrength: 0, newStrength: strengthDelta,
      description: `情绪影响: ${emotion} (${(intensity * 100).toFixed(0)}%) → "${content.substring(0, 40)}" Δ${(strengthDelta * 100).toFixed(1)}%`,
      data: { emotion, intensity },
    });
  }

  getEntries(filter?: { eventType?: BeliefTraceEventType; beliefId?: string; limit?: number }): BeliefTraceEntry[] {
    let result = [...this.entries];
    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.beliefId) result = result.filter(e => e.beliefId === filter.beliefId);
    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  clear(): void { this.entries = []; }

  private addEntry(data: Omit<BeliefTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({ id: `btrace_${++this.idCounter}`, timestamp: Date.now(), ...data });
    if (this.entries.length > this.MAX_ENTRIES) this.entries.shift();
  }
}

export default BeliefTracer;
