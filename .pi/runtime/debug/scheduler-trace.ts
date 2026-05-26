/**
 * scheduler-trace.ts - 调度器追踪系统
 *
 * 追踪 Scheduler 的所有活动：
 * - 任务执行记录
 * - tick 调度情况
 * - 优先级执行顺序
 * - 延迟/重试/取消
 * - 性能数据
 *
 * 可观察：
 * - 哪些任务被执行了
 * - 为什么某任务被推迟
 * - 优先级队列是如何排序的
 * - 重试和失败的原因
 */

import type { TickType, SchedulerLogEntry } from '../autonomous/scheduler';

export interface SchedulerTraceEntry {
  id: string;
  timestamp: number;
  type: 'task_scheduled' | 'task_executed' | 'task_completed' | 'task_failed'
       | 'task_retried' | 'task_cancelled' | 'task_deferred' | 'tick_cycle'
       | 'priority_queue' | 'dependency_wait' | 'throttle_skip';
  taskId?: string;
  taskType?: TickType;
  priority?: number;
  duration?: number;
  message: string;
  data: Record<string, any>;
}

export class SchedulerTracer {
  private entries: SchedulerTraceEntry[] = [];
  private readonly MAX_ENTRIES = 1000;
  private idCounter: number = 0;

  /** 统计 */
  private taskStats: Map<string, {
    executed: number;
    completed: number;
    failed: number;
    retried: number;
    totalDuration: number;
  }> = new Map();

  /**
   * 记录任务调度
   */
  taskScheduled(taskId: string, taskType: TickType, priority: number, scheduledAt: number): void {
    this.addEntry({
      type: 'task_scheduled',
      taskId, taskType, priority,
      message: `任务 ${taskId} (${taskType}) 已调度，优先级 ${priority}，计划执行 ${new Date(scheduledAt).toLocaleTimeString()}`,
      data: { scheduledAt },
    });
  }

  /**
   * 记录任务执行开始
   */
  taskExecuted(taskId: string, taskType: TickType, priority: number): void {
    this.addEntry({
      type: 'task_executed',
      taskId, taskType, priority,
      message: `开始执行任务 ${taskId} (${taskType})`,
      data: {},
    });

    // 更新统计
    if (!this.taskStats.has(taskType)) {
      this.taskStats.set(taskType, { executed: 0, completed: 0, failed: 0, retried: 0, totalDuration: 0 });
    }
    this.taskStats.get(taskType)!.executed++;
  }

  /**
   * 记录任务完成
   */
  taskCompleted(taskId: string, taskType: TickType, duration: number): void {
    this.addEntry({
      type: 'task_completed',
      taskId, taskType,
      duration,
      message: `任务 ${taskId} 完成，耗时 ${duration}ms`,
      data: {},
    });

    this.taskStats.get(taskType)!.completed++;
    this.taskStats.get(taskType)!.totalDuration += duration;
  }

  /**
   * 记录任务失败
   */
  taskFailed(taskId: string, taskType: TickType, error: string, retryCount: number): void {
    this.addEntry({
      type: 'task_failed',
      taskId, taskType,
      message: `任务 ${taskId} 失败（第 ${retryCount} 次）: ${error}`,
      data: { retryCount, error },
    });

    this.taskStats.get(taskType)!.failed++;
  }

  /**
   * 记录任务重试
   */
  taskRetried(taskId: string, taskType: TickType, retryCount: number, delay: number): void {
    this.addEntry({
      type: 'task_retried',
      taskId, taskType,
      message: `任务 ${taskId} 将重试（第 ${retryCount} 次），延迟 ${delay}ms`,
      data: { retryCount, delay },
    });

    this.taskStats.get(taskType)!.retried++;
  }

  /**
   * 记录任务取消
   */
  taskCancelled(taskId: string, taskType: TickType, reason: string): void {
    this.addEntry({
      type: 'task_cancelled',
      taskId, taskType,
      message: `任务 ${taskId} 已取消: ${reason}`,
      data: { reason },
    });
  }

  /**
   * 记录任务因依赖等待
   */
  dependencyWait(taskId: string, taskType: TickType, depId: string): void {
    this.addEntry({
      type: 'dependency_wait',
      taskId, taskType,
      message: `任务 ${taskId} 等待依赖任务 ${depId} 完成`,
      data: { depId },
    });
  }

  /**
   * 记录优先级队列排序
   */
  priorityQueue(tasks: Array<{ id: string; type: TickType; priority: number }>): void {
    this.addEntry({
      type: 'priority_queue',
      message: `优先级队列排序: ${tasks.map(t => `${t.id}(${t.type},p${t.priority})`).join(' → ')}`,
      data: { taskCount: tasks.length, topPriority: tasks[0]?.priority },
    });
  }

  /**
   * 记录节流跳过
   */
  throttleSkip(taskId: string, taskType: TickType): void {
    this.addEntry({
      type: 'throttle_skip',
      taskId, taskType,
      message: `任务 ${taskId} 因节流被跳过`,
      data: {},
    });
  }

  /**
   * 记录 tick 周期
   */
  tickCycle(tickCount: number, executedTasks: number, skippedTasks: number): void {
    this.addEntry({
      type: 'tick_cycle',
      message: `Tick #${tickCount}: 执行 ${executedTasks} 个任务，跳过 ${skippedTasks} 个`,
      data: { tickCount, executedTasks, skippedTasks },
    });
  }

  /**
   * 获取所有追踪条目
   */
  getEntries(filter?: { type?: string; taskType?: TickType; limit?: number }): SchedulerTraceEntry[] {
    let result = [...this.entries];

    if (filter?.type) {
      result = result.filter(e => e.type === filter.type);
    }
    if (filter?.taskType) {
      result = result.filter(e => e.taskType === filter.taskType);
    }
    if (filter?.limit) {
      result = result.slice(-filter.limit);
    }

    return result;
  }

  /**
   * 获取任务类型统计
   */
  getTaskStats(): Record<string, { executed: number; completed: number; failed: number; retried: number; avgDuration: number }> {
    const result: Record<string, any> = {};
    for (const [type, stats] of this.taskStats) {
      result[type] = {
        ...stats,
        avgDuration: stats.completed > 0 ? stats.totalDuration / stats.completed : 0,
      };
    }
    return result;
  }

  /**
   * 获取调度器性能摘要
   */
  getSummary(): string {
    const stats = this.getTaskStats();
    const totalEntries = this.entries.length;
    const totalExecuted = Object.values(stats).reduce((s, t) => s + t.executed, 0);
    const totalFailed = Object.values(stats).reduce((s, t) => s + t.failed, 0);

    const lines = [
      `=== Scheduler Trace 摘要 ===`,
      `总追踪条目: ${totalEntries}`,
      `总执行: ${totalExecuted} | 失败: ${totalFailed}`,
      ``,
      `各任务类型统计:`,
    ];

    for (const [type, s] of Object.entries(stats)) {
      lines.push(`  ${type}: 执行 ${s.executed} | 完成 ${s.completed} | 失败 ${s.failed} | 重试 ${s.retried} | 平均耗时 ${s.avgDuration.toFixed(1)}ms`);
    }

    const latest = this.entries.slice(-10);
    lines.push(``, `最近 10 条:`, ...latest.map(e =>
      `  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.message}`
    ));

    return lines.join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
    this.taskStats.clear();
  }

  private addEntry(data: Omit<SchedulerTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({
      id: `strace_${++this.idCounter}`,
      timestamp: Date.now(),
      ...data,
    });

    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries = this.entries.slice(-this.MAX_ENTRIES);
    }
  }
}

export default SchedulerTracer;
