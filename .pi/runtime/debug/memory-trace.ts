/**
 * memory-trace.ts - 记忆系统追踪
 *
 * 追踪 MemoryLayer 的所有活动：
 * - 记忆存储（store）
 * - 记忆检索（retrieve）
 * - 记忆压缩（compress）
 * - 记忆衰减（decay）
 * - 记忆合并（merge）
 * - 记忆清理（cleanup）
 *
 * 可观察：
 * - 为什么某条记忆被召回
 * - 为什么某条记忆被压缩/丢弃
 * - 检索结果的排序原因
 */

import type { MemoryEntry, MemoryType, MemoryQuery } from '../memory/memory-layer';

export type MemoryTraceEventType =
  | 'memory_stored'
  | 'memory_retrieved'
  | 'memory_recalled'
  | 'memory_compressed'
  | 'memory_decayed'
  | 'memory_merged'
  | 'memory_archived'
  | 'memory_deleted'
  | 'memory_consolidated'
  ;

export interface MemoryTraceEntry {
  id: string;
  timestamp: number;
  eventType: MemoryTraceEventType;
  agentId?: string;
  memoryId?: string;
  memoryType?: MemoryType;
  description: string;
  /** 检索时的查询 */
  query?: MemoryQuery;
  /** 检索结果数量 */
  resultCount?: number;
  /** 排序得分（如果是检索） */
  scores?: Record<string, number>;
  /** 压缩前后对比 */
  beforeSize?: number;
  afterSize?: number;
  /** 衰减原因 */
  decayReason?: string;
  data: Record<string, any>;
}

export class MemoryTracer {
  private entries: MemoryTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  /**
   * 记录记忆存储
   */
  memoryStored(agentId: string | undefined, memoryId: string, memoryType: MemoryType, content: string): void {
    this.addEntry({
      eventType: 'memory_stored',
      agentId, memoryId, memoryType,
      description: `存储 ${memoryType} 记忆: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`,
      data: { contentLength: content.length },
    });
  }

  /**
   * 记录记忆检索
   */
  memoryRetrieved(agentId: string | undefined, query: MemoryQuery, resultCount: number, scores?: Record<string, number>): void {
    this.addEntry({
      eventType: 'memory_retrieved',
      agentId,
      query,
      resultCount,
      scores,
      description: `检索记忆 (keywords: ${query.keywords?.join(',') ?? 'none'}, limit: ${query.limit}) → ${resultCount} 条结果`,
      data: { query },
    });
  }

  /**
   * 记录单条记忆被召回（被选中进入上下文）
   */
  memoryRecalled(agentId: string | undefined, memoryId: string, score: number, reason: string): void {
    this.addEntry({
      eventType: 'memory_recalled',
      agentId, memoryId,
      description: `召回记忆 ${memoryId} (得分: ${score.toFixed(3)}) — ${reason}`,
      data: { score, reason },
    });
  }

  /**
   * 记录记忆压缩
   */
  memoryCompressed(memoryId: string, beforeSize: number, afterSize: number): void {
    this.addEntry({
      eventType: 'memory_compressed',
      memoryId,
      description: `压缩记忆 ${memoryId}: ${beforeSize} → ${afterSize} 字符`,
      data: { beforeSize, afterSize },
    });
  }

  /**
   * 记录记忆衰减
   */
  memoryDecayed(memoryId: string, decayFactor: number, reason: string): void {
    this.addEntry({
      eventType: 'memory_decayed',
      memoryId,
      description: `记忆 ${memoryId} 衰减 (因子: ${decayFactor.toFixed(3)}) — ${reason}`,
      data: { decayFactor, reason },
    });
  }

  /**
   * 记录记忆合并
   */
  memoryMerged(targetId: string, sourceIds: string[]): void {
    this.addEntry({
      eventType: 'memory_merged',
      memoryId: targetId,
      description: `合并 ${sourceIds.length} 条记忆到 ${targetId}: ${sourceIds.join(', ')}`,
      data: { sourceIds },
    });
  }

  /**
   * 记录记忆归档
   */
  memoryArchived(memoryId: string, reason: string): void {
    this.addEntry({
      eventType: 'memory_archived',
      memoryId,
      description: `归档记忆 ${memoryId} — ${reason}`,
      data: { reason },
    });
  }

  /**
   * 记录记忆删除
   */
  memoryDeleted(memoryId: string, reason: string): void {
    this.addEntry({
      eventType: 'memory_deleted',
      memoryId,
      description: `删除记忆 ${memoryId} — ${reason}`,
      data: { reason },
    });
  }

  /**
   * 获取追踪条目
   */
  getEntries(filter?: {
    eventType?: MemoryTraceEventType;
    agentId?: string;
    memoryId?: string;
    limit?: number;
  }): MemoryTraceEntry[] {
    let result = [...this.entries];

    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.agentId) result = result.filter(e => e.agentId === filter.agentId);
    if (filter?.memoryId) result = result.filter(e => e.memoryId === filter.memoryId);

    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  /**
   * 获取统计
   */
  getStats(): string {
    const byType: Record<string, number> = {};
    for (const e of this.entries) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

    const totalRetrievals = byType['memory_retrieved'] ?? 0;
    const totalStores = byType['memory_stored'] ?? 0;
    const totalRecalls = byType['memory_recalled'] ?? 0;
    const recallRate = totalRetrievals > 0
      ? ((totalRecalls / totalRetrievals) * 100).toFixed(1)
      : 'N/A';

    return [
      `=== Memory Trace 摘要 ===`,
      `总追踪条目: ${this.entries.length}`,
      `存储: ${totalStores} | 检索: ${totalRetrievals} | 召回: ${totalRecalls}`,
      `召回率: ${recallRate}%`,
      ``,
      `事件分布:`,
      ...Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `  ${t}: ${c} 次`),
      ``,
      `最近 5 条:`,
      ...this.entries.slice(-5).map(e =>
        `  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.description}`
      ),
    ].join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
  }

  private addEntry(data: Omit<MemoryTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({
      id: `mtrace_${++this.idCounter}`,
      timestamp: Date.now(),
      ...data,
    });

    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(-this.MAX_ENTRIES);
    }
  }
}

export default MemoryTracer;
