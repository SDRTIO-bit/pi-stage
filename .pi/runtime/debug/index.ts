/**
 * debug/index.ts - 调试系统统一导出
 *
 * 整合所有 Trace 模块，提供 DebugDashboard：
 * - 统一的追踪入口
 * - 跨系统搜索
 * - 实时状态快照
 * - 性能分析
 */

import { RuntimeTracer } from './runtime-trace';
import { SchedulerTracer } from './scheduler-trace';
import { AgentTracer } from './agent-trace';
import { MemoryTracer } from './memory-trace';
import { AttentionTracer } from './attention-trace';

export { RuntimeTracer } from './runtime-trace';
export { SchedulerTracer } from './scheduler-trace';
export { AgentTracer } from './agent-trace';
export { MemoryTracer } from './memory-trace';
export { AttentionTracer } from './attention-trace';

/**
 * DebugDashboard - 调试仪表盘
 *
 * 整合所有 tracer 的查询。
 * 提供人类可读的状态摘要。
 */
export class DebugDashboard {
  readonly runtime: RuntimeTracer;
  readonly scheduler: SchedulerTracer;
  readonly agent: AgentTracer;
  readonly memory: MemoryTracer;
  readonly attention: AttentionTracer;

  constructor() {
    this.runtime = new RuntimeTracer();
    this.scheduler = new SchedulerTracer();
    this.agent = new AgentTracer();
    this.memory = new MemoryTracer();
    this.attention = new AttentionTracer();
  }

  /**
   * 跨系统搜索
   */
  search(query: string): {
    runtime: any[];
    scheduler: any[];
    agent: any[];
    memory: any[];
    attention: any[];
  } {
    return {
      runtime: this.runtime.search(query),
      scheduler: this.scheduler.getEntries(),
      agent: this.agent.getAllEntries(),
      memory: this.memory.getEntries(),
      attention: this.attention.getEntries(),
    };
  }

  /**
   * 获取完整状态摘要
   */
  getFullSummary(): string {
    const lines = [
      '╔══════════════════════════════════════════════════╗',
      '║          Autonomous Runtime Debug Dashboard      ║',
      '╚══════════════════════════════════════════════════╝',
      '',
      '--- Runtime ---',
      this.runtime.getPerformanceSummary(),
      '',
      '--- Scheduler ---',
      this.scheduler.getSummary(),
      '',
      '--- Agent ---',
      this.agent.getGlobalSummary(),
      '',
      '--- Memory ---',
      this.memory.getStats(),
      '',
      '--- Attention ---',
      this.attention.getAttentionSummary(),
    ];

    return lines.join('\n');
  }

  /**
   * 获取 Agent 追踪摘要
   */
  getAgentSummary(agentId: string): string {
    return this.agent.getAgentSummary(agentId);
  }

  /**
   * 清空所有追踪数据
   */
  clearAll(): void {
    this.runtime.clear();
    this.scheduler.clear();
    this.agent.clear();
    this.memory.clear();
    this.attention.clear();
  }

  /**
   * 导出所有追踪数据
   */
  exportAll() {
    return {
      runtime: this.runtime.export(),
      scheduler: this.scheduler.getEntries(),
      agent: this.agent.export(),
      memory: this.memory.getEntries(),
      attention: this.attention.getEntries(),
    };
  }
}

export default DebugDashboard;
