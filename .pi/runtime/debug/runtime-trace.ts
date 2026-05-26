/**
 * runtime-trace.ts - Runtime 全局追踪器
 *
 * 追踪 Autonomous Runtime 的所有活动：
 * - Runtime 生命周期事件
 * - 各子系统状态变化
 * - 异常和错误
 * - 性能指标
 */

import type { RuntimePhase } from '../autonomous/runtime-core';

export type RuntimeTraceEventType =
  | 'runtime:boot'
  | 'runtime:shutdown'
  | 'runtime:pause'
  | 'runtime:resume'
  | 'runtime:error'
  | 'runtime:warning'
  | 'world:tick'
  | 'world:speed_change'
  | 'agent:registered'
  | 'agent:unregistered'
  | 'agent:tick'
  | 'agent:interact'
  | 'agent:react_to_event'
  | 'event:triggered'
  | 'event:resolved'
  | 'memory:store'
  | 'memory:retrieve'
  | 'scheduler:tick'
  | 'task:execute'
  | 'task:complete'
  | 'task:fail'
  | 'background:mode_change'
  | 'background:tick'
  ;

export interface RuntimeTraceEntry {
  id: string;
  timestamp: number;
  type: RuntimeTraceEventType;
  phase: RuntimePhase;
  data: Record<string, any>;
  duration?: number;  // 执行耗时（毫秒）
  source?: string;     // 触发源
}

export interface RuntimeTraceStats {
  totalEntries: number;
  byType: Record<string, number>;
  byPhase: Record<string, number>;
  errorCount: number;
  warningCount: number;
  timeRange: { from: number; to: number };
  avgEventDuration: number;
}

export class RuntimeTracer {
  private entries: RuntimeTraceEntry[] = [];
  private readonly MAX_ENTRIES = 2000;
  private idCounter: number = 0;
  private currentPhase: RuntimePhase = 'uninitialized';

  /** 性能指标 */
  private phaseDuration: Record<string, number> = {};
  private lastPhaseChange: number = Date.now();

  /**
   * 记录追踪条目
   */
  trace(
    type: RuntimeTraceEventType,
    data: Record<string, any> = {},
    duration?: number,
    source?: string
  ): string {
    const id = `trace_${++this.idCounter}_${Date.now()}`;
    const entry: RuntimeTraceEntry = {
      id,
      timestamp: Date.now(),
      type,
      phase: this.currentPhase,
      data: this.sanitizeData(data),
      duration,
      source,
    };

    this.entries.push(entry);

    // 限制条目数
    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(-this.MAX_ENTRIES);
    }

    return id;
  }

  /**
   * 记录错误
   */
  error(message: string, data: Record<string, any> = {}, source?: string): string {
    return this.trace('runtime:error', { message, ...data }, undefined, source);
  }

  /**
   * 记录警告
   */
  warn(message: string, data: Record<string, any> = {}, source?: string): string {
    return this.trace('runtime:warning', { message, ...data }, undefined, source);
  }

  /**
   * 更新当前阶段
   */
  setPhase(phase: RuntimePhase): void {
    const now = Date.now();
    if (this.currentPhase !== 'uninitialized') {
      const elapsed = now - this.lastPhaseChange;
      this.phaseDuration[this.currentPhase] =
        (this.phaseDuration[this.currentPhase] ?? 0) + elapsed;
    }

    this.currentPhase = phase;
    this.lastPhaseChange = now;
  }

  /**
   * 获取当前阶段
   */
  getCurrentPhase(): RuntimePhase {
    return this.currentPhase;
  }

  /**
   * 获取所有追踪条目
   */
  getEntries(filter?: {
    type?: RuntimeTraceEventType | RuntimeTraceEventType[];
    phase?: RuntimePhase;
    from?: number;
    to?: number;
    limit?: number;
  }): RuntimeTraceEntry[] {
    let result = [...this.entries];

    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      result = result.filter(e => types.includes(e.type));
    }

    if (filter?.phase) {
      result = result.filter(e => e.phase === filter.phase);
    }

    if (filter?.from) {
      result = result.filter(e => e.timestamp >= filter.from!);
    }

    if (filter?.to) {
      result = result.filter(e => e.timestamp <= filter.to!);
    }

    if (filter?.limit) {
      result = result.slice(-filter.limit);
    }

    result.sort((a, b) => a.timestamp - b.timestamp);
    return result;
  }

  /**
   * 按类型分组获取最新条目
   */
  getLatestByType(count: number = 5): Record<string, RuntimeTraceEntry[]> {
    const grouped: Record<string, RuntimeTraceEntry[]> = {};

    for (const entry of this.entries) {
      if (!grouped[entry.type]) {
        grouped[entry.type] = [];
      }
      grouped[entry.type].push(entry);
    }

    // 每个类型只取最新的 count 条
    for (const type of Object.keys(grouped)) {
      grouped[type].sort((a, b) => b.timestamp - a.timestamp);
      grouped[type] = grouped[type].slice(0, count);
    }

    return grouped;
  }

  /**
   * 获取统计信息
   */
  getStats(): RuntimeTraceStats {
    const byType: Record<string, number> = {};
    const byPhase: Record<string, number> = {};

    for (const entry of this.entries) {
      byType[entry.type] = (byType[entry.type] ?? 0) + 1;
      byPhase[entry.phase] = (byPhase[entry.phase] ?? 0) + 1;
    }

    const errorCount = byType['runtime:error'] ?? 0;
    const warningCount = byType['runtime:warning'] ?? 0;

    const durations = this.entries
      .filter(e => e.duration !== undefined)
      .map(e => e.duration!);
    const avgEventDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    return {
      totalEntries: this.entries.length,
      byType,
      byPhase,
      errorCount,
      warningCount,
      timeRange: {
        from: this.entries.length > 0 ? this.entries[0].timestamp : Date.now(),
        to: this.entries.length > 0 ? this.entries[this.entries.length - 1].timestamp : Date.now(),
      },
      avgEventDuration,
    };
  }

  /**
   * 获取性能摘要
   */
  getPerformanceSummary(): string {
    const stats = this.getStats();
    const lines = [
      `=== Runtime Trace 性能摘要 ===`,
      `总追踪条目: ${stats.totalEntries}`,
      `错误: ${stats.errorCount} | 警告: ${stats.warningCount}`,
      `平均事件耗时: ${stats.avgEventDuration.toFixed(2)}ms`,
      `时间跨度: ${new Date(stats.timeRange.from).toLocaleTimeString()} - ${new Date(stats.timeRange.to).toLocaleTimeString()}`,
      ``,
      `各阶段耗时:`,
      ...Object.entries(this.phaseDuration).map(
        ([phase, ms]) => `  ${phase}: ${(ms / 1000).toFixed(1)}s`
      ),
      ``,
      `事件分布 (Top 10):`,
      ...Object.entries(stats.byType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([type, count]) => `  ${type}: ${count} 次`),
    ];
    return lines.join('\n');
  }

  /**
   * 搜索追踪条目
   */
  search(query: string): RuntimeTraceEntry[] {
    const q = query.toLowerCase();
    return this.entries.filter(e =>
      e.type.toLowerCase().includes(q) ||
      JSON.stringify(e.data).toLowerCase().includes(q) ||
      e.source?.toLowerCase().includes(q)
    );
  }

  /**
   * 格式化追踪条目为可读文本
   */
  formatEntry(entry: RuntimeTraceEntry): string {
    const time = new Date(entry.timestamp).toLocaleTimeString();
    const dur = entry.duration ? ` (${entry.duration}ms)` : '';
    const src = entry.source ? ` [${entry.source}]` : '';
    const dataStr = Object.keys(entry.data).length > 0
      ? ` | ${JSON.stringify(entry.data)}`
      : '';

    return `[${time}][${entry.type}]${src}${dur}${dataStr}`;
  }

  /**
   * 格式化所有条目为可读文本
   */
  formatAll(limit?: number): string {
    const entries = limit
      ? this.entries.slice(-limit)
      : this.entries;
    return entries.map(e => this.formatEntry(e)).join('\n');
  }

  /**
   * 清空追踪
   */
  clear(): void {
    this.entries = [];
    this.phaseDuration = {};
  }

  /**
   * 导出追踪数据
   */
  export(): { entries: RuntimeTraceEntry[]; stats: RuntimeTraceStats } {
    return {
      entries: [...this.entries],
      stats: this.getStats(),
    };
  }

  /**
   * 数据脱敏（防止大量数据导致内存爆炸）
   */
  private sanitizeData(data: Record<string, any>): Record<string, any> {
    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === 'string' && value.length > 500) {
        sanitized[key] = value.substring(0, 500) + '... [truncated]';
      } else if (Array.isArray(value) && value.length > 20) {
        sanitized[key] = value.slice(0, 20) + `... [${value.length} items]`;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}

export default RuntimeTracer;
