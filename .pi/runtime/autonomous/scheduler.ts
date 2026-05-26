/**
 * scheduler.ts - 运行时调度器核心
 *
 * Autonomous Runtime 的心脏。
 *
 * 调度器负责：
 * - 世界 tick（world_tick）
 * - Agent tick（agent_tick）
 * - 记忆 tick（memory_tick）
 * - 关系 tick（relation_tick）
 * - 目标 tick（goal_tick）
 * - 事件 tick（event_tick）
 * - 后台 tick（background_tick）
 *
 * 支持：
 * - async execution（异步执行）
 * - priority queue（优先级队列）
 * - delayed task（延迟任务）
 * - repeating task（重复任务）
 * - pause/resume（暂停/恢复）
 * - tick interval config（tick 间隔配置）
 * - runtime throttling（运行时节流）
 */

// ============================================================
// 任务类型定义
// ============================================================

export type TickType =
  | 'world_tick'
  | 'agent_tick'
  | 'memory_tick'
  | 'relation_tick'
  | 'goal_tick'
  | 'event_tick'
  | 'background_tick'
  ;

export interface TickTask {
  id: string;
  type: TickType;
  /** 执行优先级 0（最高）- 100（最低） */
  priority: number;
  /** 执行函数 */
  execute: () => Promise<void> | void;
  /** 间隔（毫秒）：0=不重复 */
  interval: number;
  /** 延迟执行（毫秒） */
  delay: number;
  /** 标签 */
  tags: string[];
  /** 最大重试次数 */
  maxRetries: number;
  /** 依赖的其他任务 ID */
  dependencies: string[];
  /** 是否可取消 */
  cancelable: boolean;
  /** 自定义元数据 */
  metadata: Record<string, any>;
}

export interface ScheduledTask extends TickTask {
  /** 下次执行时间 */
  nextRunAt: number;
  /** 上次执行时间 */
  lastRunAt: number;
  /** 执行次数 */
  runCount: number;
  /** 失败次数 */
  failCount: number;
  /** 是否暂停 */
  paused: boolean;
  /** 是否已取消 */
  cancelled: boolean;
}

// ============================================================
// 调度器配置
// ============================================================

export interface SchedulerConfig {
  /** 基础 tick 间隔（毫秒） */
  baseTickInterval: number;
  /** 世界 tick 间隔乘数 */
  worldTickMultiplier: number;
  /** Agent tick 间隔乘数 */
  agentTickMultiplier: number;
  /** 记忆 tick 间隔乘数 */
  memoryTickMultiplier: number;
  /** 关系 tick 间隔乘数 */
  relationTickMultiplier: number;
  /** 目标 tick 间隔乘数 */
  goalTickMultiplier: number;
  /** 事件 tick 间隔乘数 */
  eventTickMultiplier: number;
  /** 后台 tick 间隔乘数 */
  backgroundTickMultiplier: number;
  /** 节流阈值（毫秒内最大 tick 次数） */
  throttleThreshold: number;
  /** 节流窗口（毫秒） */
  throttleWindow: number;
  /** 最大并行任务数 */
  maxConcurrent: number;
}

const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  baseTickInterval: 1000,  // 1 秒
  worldTickMultiplier: 5,   // 每 5 秒
  agentTickMultiplier: 3,   // 每 3 秒
  memoryTickMultiplier: 10, // 每 10 秒
  relationTickMultiplier: 8, // 每 8 秒
  goalTickMultiplier: 6,   // 每 6 秒
  eventTickMultiplier: 4,   // 每 4 秒
  backgroundTickMultiplier: 15, // 每 15 秒
  throttleThreshold: 50,    // 50 次
  throttleWindow: 1000,     // 1 秒内
  maxConcurrent: 5,
};

// ============================================================
// 调度器状态 & 日志
// ============================================================

export interface SchedulerState {
  running: boolean;
  paused: boolean;
  startedAt: number;
  totalTicks: number;
  activeTasks: number;
  queuedTasks: number;
  lastTickAt: number;
  tickRates: Record<TickType, number>;
  errorCount: number;
}

export interface SchedulerLogEntry {
  timestamp: number;
  type: 'task_run' | 'task_complete' | 'task_fail' | 'task_cancel' | 'pause' | 'resume' | 'error';
  taskId?: string;
  taskType?: TickType;
  message: string;
  duration?: number;
}

// ============================================================
// 调度器实现
// ============================================================

export class Scheduler {
  private config: SchedulerConfig;
  private tasks: Map<string, ScheduledTask> = new Map();
  private running: boolean = false;
  private paused: boolean = false;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private startedAt: number = 0;
  private totalTicks: number = 0;
  private logs: SchedulerLogEntry[] = [];
  private readonly MAX_LOG_SIZE = 500;

  // 节流控制
  private tickTimestamps: number[] = [];

  // 默认 tick 任务缓存（构建时生成）
  private defaultTaskFactories: Map<TickType, () => Promise<void>> = new Map();

  constructor(config?: Partial<SchedulerConfig>) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  /**
   * 注册默认 tick 任务工厂
   */
  registerTick(type: TickType, factory: () => Promise<void>): void {
    this.defaultTaskFactories.set(type, factory);
  }

  /**
   * 启动调度器
   */
  start(): void {
    if (this.running) return;

    this.running = true;
    this.paused = false;
    this.startedAt = Date.now();

    // 创建默认 tick 任务
    this.createDefaultTasks();

    // 启动主循环
    this.timerId = setInterval(() => this.mainLoop(), this.config.baseTickInterval);

    this.log('info', 'scheduler_started', '调度器已启动');
  }

  /**
   * 停止调度器
   */
  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.log('info', 'scheduler_stopped', '调度器已停止');
  }

  /**
   * 暂停调度器（当前执行的任务允许完成）
   */
  pause(): void {
    this.paused = true;
    this.log('info', 'pause', '调度器已暂停');
  }

  /**
   * 恢复调度器
   */
  resume(): void {
    this.paused = false;
    this.log('info', 'resume', '调度器已恢复');
  }

  /**
   * 添加任务
   */
  addTask(task: TickTask): string {
    const id = task.id || `task_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const now = Date.now();

    const scheduled: ScheduledTask = {
      ...task,
      id,
      nextRunAt: now + task.delay,
      lastRunAt: 0,
      runCount: 0,
      failCount: 0,
      paused: false,
      cancelled: false,
    };

    this.tasks.set(id, scheduled);
    return id;
  }

  /**
   * 取消任务
   */
  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || !task.cancelable) return false;
    task.cancelled = true;
    this.log('info', 'task_cancel', `任务 ${id} 已取消`, task.type);
    return true;
  }

  /**
   * 清空所有任务
   */
  clearTasks(): void {
    this.tasks.clear();
  }

  /**
   * 获取调度器状态
   */
  getState(): SchedulerState {
    const now = Date.now();
    const rates: Record<string, number> = {};
    const interval = this.config.baseTickInterval;
    rates['world_tick'] = interval * this.config.worldTickMultiplier;
    rates['agent_tick'] = interval * this.config.agentTickMultiplier;
    rates['memory_tick'] = interval * this.config.memoryTickMultiplier;
    rates['relation_tick'] = interval * this.config.relationTickMultiplier;
    rates['goal_tick'] = interval * this.config.goalTickMultiplier;
    rates['event_tick'] = interval * this.config.eventTickMultiplier;
    rates['background_tick'] = interval * this.config.backgroundTickMultiplier;

    const activeTasks = Array.from(this.tasks.values())
      .filter(t => !t.cancelled && !t.paused && t.nextRunAt <= now)
      .length;

    return {
      running: this.running,
      paused: this.paused,
      startedAt: this.startedAt,
      totalTicks: this.totalTicks,
      activeTasks,
      queuedTasks: this.tasks.size,
      lastTickAt: now,
      tickRates: rates as Record<TickType, number>,
      errorCount: this.logs.filter(l => l.type === 'task_fail').length,
    };
  }

  /**
   * 获取日志
   */
  getLogs(): SchedulerLogEntry[] {
    return [...this.logs];
  }

  /**
   * 获取任务列表
   */
  getTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values());
  }

  // ============================================================
  // 内部实现
  // ============================================================

  /**
   * 主循环
   */
  private mainLoop(): void {
    if (this.paused || !this.running) return;

    // 节流检查
    if (!this.checkThrottle()) return;

    const now = Date.now();
    this.totalTicks++;

    // 找出所有到期的任务
    const dueTasks = Array.from(this.tasks.values())
      .filter(t =>
        !t.cancelled &&
        !t.paused &&
        t.nextRunAt <= now &&
        this.checkDependencies(t)
      )
      .sort((a, b) => a.priority - b.priority); // 按优先级排序

    if (dueTasks.length === 0) return;

    // 限制并行数
    const toExecute = dueTasks.slice(0, this.config.maxConcurrent);

    for (const task of toExecute) {
      this.executeTask(task);
    }
  }

  /**
   * 执行单个任务
   */
  private async executeTask(task: ScheduledTask): Promise<void> {
    const startTime = Date.now();
    this.log('task_run', `执行任务 ${task.id} (${task.type})`, task.type, task.id);

    try {
      await task.execute();
      task.runCount++;
      task.lastRunAt = Date.now();

      this.log('task_complete', `任务 ${task.id} 完成 (${Date.now() - startTime}ms)`, task.type, task.id);

      // 如果是重复任务，设置下次执行时间
      if (task.interval > 0) {
        task.nextRunAt = Date.now() + task.interval;
      } else {
        task.cancelled = true; // 一次性任务执行后标记为取消
      }
    } catch (error) {
      task.failCount++;
      this.log('task_fail', `任务 ${task.id} 失败: ${error}`, task.type, task.id);

      if (task.failCount <= task.maxRetries) {
        // 重试：延迟后重试
        task.nextRunAt = Date.now() + 1000 * Math.pow(2, task.failCount); // 指数退避
      } else {
        task.cancelled = true;
        this.log('error', `任务 ${task.id} 超过最大重试次数`, task.type, task.id);
      }
    }
  }

  /**
   * 创建默认 tick 任务
   */
  private createDefaultTasks(): void {
    const tickTypes: TickType[] = [
      'world_tick',
      'agent_tick',
      'memory_tick',
      'relation_tick',
      'goal_tick',
      'event_tick',
      'background_tick',
    ];

    const multipliers: Record<TickType, number> = {
      world_tick: this.config.worldTickMultiplier,
      agent_tick: this.config.agentTickMultiplier,
      memory_tick: this.config.memoryTickMultiplier,
      relation_tick: this.config.relationTickMultiplier,
      goal_tick: this.config.goalTickMultiplier,
      event_tick: this.config.eventTickMultiplier,
      background_tick: this.config.backgroundTickMultiplier,
    };

    const priorities: Record<TickType, number> = {
      world_tick: 10,
      agent_tick: 20,
      memory_tick: 40,
      relation_tick: 35,
      goal_tick: 30,
      event_tick: 15,
      background_tick: 50,
    };

    for (const type of tickTypes) {
      const factory = this.defaultTaskFactories.get(type);
      if (!factory) continue;

      this.addTask({
        id: `scheduler_${type}`,
        type,
        priority: priorities[type],
        execute: factory,
        interval: this.config.baseTickInterval * multipliers[type],
        delay: 0,
        tags: ['scheduler_default', type],
        maxRetries: 3,
        dependencies: [],
        cancelable: false,
        metadata: {},
      });
    }
  }

  /**
   * 检查依赖是否就绪
   */
  private checkDependencies(task: ScheduledTask): boolean {
    for (const depId of task.dependencies) {
      const dep = this.tasks.get(depId);
      if (!dep || dep.cancelled) return false;
      // 依赖任务必须在当前任务之前执行过
      if (dep.lastRunAt === 0) return false;
    }
    return true;
  }

  /**
   * 节流检查
   */
  private checkThrottle(): boolean {
    const now = Date.now();
    this.tickTimestamps.push(now);

    // 清理超时的时间戳
    const cutoff = now - this.config.throttleWindow;
    this.tickTimestamps = this.tickTimestamps.filter(t => t > cutoff);

    if (this.tickTimestamps.length > this.config.throttleThreshold) {
      // 超过阈值，跳过本次 tick
      return false;
    }

    return true;
  }

  /**
   * 记录日志
   */
  private log(
    type: SchedulerLogEntry['type'],
    message: string,
    taskType?: TickType,
    taskId?: string
  ): void {
    this.logs.push({
      timestamp: Date.now(),
      type,
      taskId,
      taskType,
      message,
    });

    if (this.logs.length > this.MAX_LOG_SIZE) {
      this.logs = this.logs.slice(-this.MAX_LOG_SIZE);
    }
  }
}

export default Scheduler;
