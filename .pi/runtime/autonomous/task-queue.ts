/**
 * task-queue.ts - 运行时任务队列
 *
 * 支持：
 * - task priority（优先级排序）
 * - async task execution（异步执行）
 * - retry（失败重试）
 * - cancellation（取消）
 * - dependency tracking（依赖追踪）
 * - delayed execution（延迟执行）
 * - recurring task（重复性任务）
 *
 * 任务示例：
 * - NPC 行动
 * - 世界事件
 * - 记忆整理
 * - 关系演化
 * - Goal Replanning
 */

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'delayed';

export interface QueueTask {
  id: string;
  type: string;
  description: string;
  priority: number;       // 0（最高）- 100（最低）
  status: TaskStatus;
  createdAt: number;
  scheduledAt: number;     // 计划执行时间
  startedAt?: number;
  completedAt?: number;
  execute: () => Promise<boolean>;
  retryCount: number;
  maxRetries: number;
  retryDelay: number;      // 重试间隔基数（毫秒）
  dependencies: string[];  // 依赖的任务 ID
  tags: string[];
  timeout: number;         // 超时（毫秒），0=不超时
  /** 是否可被其他高优先级任务打断 */
  preemptible: boolean;
  /** 结果数据 */
  result?: any;
  error?: string;
}

export interface QueueStats {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  delayed: number;
  avgCompletionTime: number;
  oldestTaskAge: number;
}

export class TaskQueue {
  private tasks: Map<string, QueueTask> = new Map();
  private completedHistory: QueueTask[] = [];
  private readonly MAX_HISTORY = 200;
  private runningTasks: Set<string> = new Set();
  private maxConcurrent: number = 5;
  private processing: boolean = false;

  constructor(maxConcurrent?: number) {
    this.maxConcurrent = maxConcurrent ?? 5;
  }

  /**
   * 添加任务
   */
  add(task: Omit<QueueTask, 'id' | 'status' | 'createdAt' | 'retryCount'>): string {
    const id = `qtask_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.tasks.set(id, {
      ...task,
      id,
      status: task.scheduledAt > Date.now() ? 'delayed' : 'queued',
      createdAt: Date.now(),
      retryCount: 0,
    });
    return id;
  }

  /**
   * 批量添加任务
   */
  addBatch(tasks: Array<Omit<QueueTask, 'id' | 'status' | 'createdAt' | 'retryCount'>>): string[] {
    return tasks.map(t => this.add(t));
  }

  /**
   * 处理队列（主循环中调用）
   */
  async process(): Promise<void> {
    if (this.processing) return; // 防止重入
    this.processing = true;

    try {
      // 更新延迟任务状态
      const now = Date.now();
      for (const task of this.tasks.values()) {
        if (task.status === 'delayed' && task.scheduledAt <= now) {
          task.status = 'queued';
        }
      }

      // 检查运行中的任务是否超时
      for (const id of this.runningTasks) {
        const task = this.tasks.get(id);
        if (task && task.timeout > 0 && task.startedAt && Date.now() - task.startedAt > task.timeout) {
          task.status = 'failed';
          task.error = '执行超时';
          this.runningTasks.delete(id);
        }
      }

      // 获取可执行的任务
      const executable = this.getExecutableTasks();

      // 限制并发
      const slots = this.maxConcurrent - this.runningTasks.size;
      const toRun = executable.slice(0, Math.max(0, slots));

      if (toRun.length === 0) return;

      // 并行执行
      const promises = toRun.map(task => this.executeTask(task));
      await Promise.allSettled(promises);
    } finally {
      this.processing = false;
    }
  }

  /**
   * 获取可执行的任务（按优先级排序）
   */
  private getExecutableTasks(): QueueTask[] {
    return Array.from(this.tasks.values())
      .filter(t =>
        t.status === 'queued' &&
        !this.runningTasks.has(t.id) &&
        this.checkDependencies(t)
      )
      .sort((a, b) => {
        // 先按优先级，再按创建时间
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: QueueTask): Promise<void> {
    task.status = 'running';
    task.startedAt = Date.now();
    this.runningTasks.add(task.id);

    try {
      const success = await task.execute();

      if (success) {
        task.status = 'completed';
        task.completedAt = Date.now();
        this.runningTasks.delete(task.id);
        this.archiveTask(task);
      } else {
        await this.handleFailure(task);
      }
    } catch (error) {
      task.error = String(error);
      await this.handleFailure(task);
    }
  }

  /**
   * 处理失败（重试逻辑）
   */
  private async handleFailure(task: QueueTask): Promise<void> {
    task.retryCount++;
    this.runningTasks.delete(task.id);

    if (task.retryCount <= task.maxRetries) {
      // 指数退避重试
      const delay = task.retryDelay * Math.pow(2, task.retryCount - 1);
      task.scheduledAt = Date.now() + delay;
      task.status = 'delayed';
    } else {
      task.status = 'failed';
      task.completedAt = Date.now();
      this.archiveTask(task);
    }
  }

  /**
   * 检查依赖
   */
  private checkDependencies(task: QueueTask): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep) return false; // 依赖不存在
      if (dep.status !== 'completed') {
        // 如果依赖失败或取消，跳过
        if (dep.status === 'failed' || dep.status === 'cancelled') {
          // 标记任务为无法执行
          task.status = 'cancelled';
          task.error = `依赖任务 ${depId} 未完成`;
          return false;
        }
        return false;
      }
    }
    return true;
  }

  /**
   * 归档已完成的任务
   */
  private archiveTask(task: QueueTask): void {
    this.tasks.delete(task.id);
    this.completedHistory.unshift(task);
    if (this.completedHistory.length > this.MAX_HISTORY) {
      this.completedHistory.pop();
    }
  }

  /**
   * 取消任务
   */
  cancel(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status === 'running') return false;
    if (task.status === 'completed') return false;
    task.status = 'cancelled';
    task.completedAt = Date.now();
    this.archiveTask(task);
    return true;
  }

  /**
   * 取消所有匹配某个条件的任务
   */
  cancelBy(predicate: (task: QueueTask) => boolean): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (predicate(task) && this.cancel(task.id)) {
        count++;
      }
    }
    return count;
  }

  /**
   * 获取任务
   */
  get(id: string): QueueTask | undefined {
    return this.tasks.get(id);
  }

  /**
   * 获取队列统计
   */
  getStats(): QueueStats {
    const now = Date.now();
    const completed = this.completedHistory;
    const avgCompletionTime = completed.length > 0
      ? completed
          .filter(t => t.completedAt && t.startedAt)
          .reduce((sum, t) => sum + (t.completedAt! - t.startedAt!), 0)
          / completed.filter(t => t.completedAt && t.startedAt).length
      : 0;

    const allTasks = [...this.tasks.values()];
    const oldestQueued = allTasks
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    const oldestTaskAge = oldestQueued ? now - oldestQueued.createdAt : 0;

    return {
      total: allTasks.length + completed.length,
      queued: allTasks.filter(t => t.status === 'queued').length,
      running: allTasks.filter(t => t.status === 'running').length,
      completed: completed.length,
      failed: allTasks.filter(t => t.status === 'failed').length,
      cancelled: allTasks.filter(t => t.status === 'cancelled').length,
      delayed: allTasks.filter(t => t.status === 'delayed').length,
      avgCompletionTime,
      oldestTaskAge,
    };
  }

  /**
   * 获取所有队列中的任务
   */
  getQueuedTasks(): QueueTask[] {
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'queued')
      .sort((a, b) => a.priority - b.priority);
  }

  /**
   * 清空队列
   */
  clear(): void {
    this.tasks.clear();
    this.completedHistory = [];
    this.runningTasks.clear();
  }
}

export default TaskQueue;
