/**
 * background-runtime.ts - 后台运行时
 *
 * 当用户离线时，世界仍然继续运转：
 * - 时间推移
 * - NPC 活动
 * - 事件演化
 * - 关系变化
 * - 环境变化
 * - 需求变动
 *
 * 支持：
 * - low-power mode（低功耗模式：降低 tick 率、减少记忆存储、跳过非必要计算）
 * - adaptive tick rate（自适应 tick 率：根据 Agent 数量、事件量、内存使用动态调整）
 * - idle optimization（空闲优化：无事件/无 Agent 时深度休眠）
 * - runtime persistence（运行时持久化，支持保存/恢复）
 * - pause/resume（暂停/恢复）
 * - max background runtime（最大后台运行时间，防止无限空转）
 */

import { WorldLoop, type WorldSpeed, type WorldTickResult } from './world-loop';
import { AgentLoop, type AgentLoopConfig } from './agent-loop';
import { WorldStateRuntime } from './world-state';
import { AgentRuntimeState } from '../agent/agent-runtime';
import type { EventBus } from '../events/event-bus';

// ============================================================
// 后台运行模式
// ============================================================

export type BackgroundMode = 'active' | 'low_power' | 'deep_sleep' | 'paused';

export interface BackgroundRuntimeConfig {
  /** 初始模式 */
  defaultMode: BackgroundMode;
  /** 活跃模式 tick 间隔（毫秒） */
  activeTickInterval: number;
  /** 低功耗模式 tick 间隔（毫秒） */
  lowPowerTickInterval: number;
  /** 深度睡眠 tick 间隔（毫秒）——基本只检查是否需要唤醒 */
  deepSleepTickInterval: number;
  /** 低功耗触发条件：空闲时间（秒） */
  lowPowerAfterSeconds: number;
  /** 深度睡眠触发条件：空闲时间（秒） */
  deepSleepAfterSeconds: number;
  /** 最大后台运行时间（分钟），超过后自动暂停 */
  maxBackgroundMinutes: number;
  /** 低功耗模式下的游戏推进减速比 */
  lowPowerTimeMultiplier: number;
  /** 深度睡眠模式下的游戏推进减速比（0=不推进） */
  deepSleepTimeMultiplier: number;
  /** 是否启用持久化 */
  persistenceEnabled: boolean;
  /** 持久化间隔（分钟） */
  persistenceIntervalMinutes: number;
}

const DEFAULT_BACKGROUND_CONFIG: BackgroundRuntimeConfig = {
  defaultMode: 'active',
  activeTickInterval: 3000,         // 3 秒
  lowPowerTickInterval: 10000,       // 10 秒
  deepSleepTickInterval: 30000,      // 30 秒
  lowPowerAfterSeconds: 120,        // 2 分钟空闲
  deepSleepAfterSeconds: 600,       // 10 分钟空闲
  maxBackgroundMinutes: 60,         // 最多后台跑 1 小时
  lowPowerTimeMultiplier: 0.5,      // 减速一半
  deepSleepTimeMultiplier: 0,       // 不推进时间
  persistenceEnabled: true,
  persistenceIntervalMinutes: 5,
};

// ============================================================
// 后台运行时事件
// ============================================================

export interface BackgroundTickEvent {
  mode: BackgroundMode;
  tickCount: number;
  gameMinutesElapsed: number;
  activeAgents: number;
  activeEvents: number;
  worldSummary: string;
  runTimeMinutes: number;
}

// ============================================================
// 后台运行时实现
// ============================================================

export class BackgroundRuntime {
  private worldLoop: WorldLoop;
  private agentLoop: AgentLoop;
  private eventBus: EventBus | null;
  private config: BackgroundRuntimeConfig;

  /** 当前模式 */
  private mode: BackgroundMode;
  /** 定时器引用 */
  private timerId: ReturnType<typeof setInterval> | null = null;
  /** 运行状态 */
  private running: boolean = false;
  /** 开始运行时间 */
  private startedAt: number = 0;
  /** 上次用户交互时间 */
  private lastUserInteraction: number = Date.now();
  /** 累计后台 tick 数 */
  private totalBackgroundTicks: number = 0;
  /** 累计后台推进的游戏分钟数 */
  private totalGameMinutesBackground: number = 0;
  /** 上次持久化时间 */
  private lastPersistAt: number = Date.now();
  /** 世界 tick 结果缓存 */
  private lastWorldTickResult: WorldTickResult | null = null;

  /** 后台 tick 回调 */
  private onTickCallbacks: Array<(event: BackgroundTickEvent) => void> = [];

  constructor(
    worldLoop: WorldLoop,
    agentLoop: AgentLoop,
    eventBus?: EventBus,
    config?: Partial<BackgroundRuntimeConfig>
  ) {
    this.worldLoop = worldLoop;
    this.agentLoop = agentLoop;
    this.eventBus = eventBus ?? null;
    this.config = { ...DEFAULT_BACKGROUND_CONFIG, ...config };
    this.mode = this.config.defaultMode;
  }

  /**
   * 启动后台运行时
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = Date.now();
    this.lastUserInteraction = Date.now();
    this.totalBackgroundTicks = 0;

    // 设置世界速度为 accelerated（后台时加速推进）
    this.worldLoop.setSpeed('accelerated_5x');

    this.startTimer(this.config.activeTickInterval);
    this.eventBus?.emit('background:started', { mode: this.mode });
  }

  /**
   * 停止后台运行时
   */
  stop(): void {
    this.running = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    // 恢复世界速度为 normal
    this.worldLoop.setSpeed('normal');
    this.eventBus?.emit('background:stopped', { totalTicks: this.totalBackgroundTicks });
  }

  /**
   * 暂停
   */
  pause(): void {
    this.mode = 'paused';
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.worldLoop.setSpeed('paused');
    this.eventBus?.emit('background:paused', {});
  }

  /**
   * 恢复
   */
  resume(): void {
    if (!this.running) {
      this.start();
      return;
    }
    this.mode = this.config.defaultMode;
    this.lastUserInteraction = Date.now();
    this.worldLoop.setSpeed('accelerated_5x');
    this.startTimer(this.getCurrentInterval());
    this.eventBus?.emit('background:resumed', { mode: this.mode });
  }

  /**
   * 记录用户交互（重置空闲计时）
   */
  recordUserInteraction(): void {
    this.lastUserInteraction = Date.now();
    this.worldLoop.recordUserInteraction();
  }

  /**
   * 获取当前模式
   */
  getMode(): BackgroundMode {
    return this.mode;
  }

  /**
   * 设置后台模式
   */
  setMode(mode: BackgroundMode): void {
    this.mode = mode;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.startTimer(this.getCurrentInterval());
    this.eventBus?.emit('background:mode_change', { mode });
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * 注册回调
   */
  onTick(callback: (event: BackgroundTickEvent) => void): void {
    this.onTickCallbacks.push(callback);
  }

  /**
   * 获取运行统计
   */
  getStats(): BackgroundStats {
    const runTimeMinutes = (Date.now() - this.startedAt) / 60000;

    return {
      running: this.running,
      mode: this.mode,
      runTimeMinutes,
      totalBackgroundTicks: this.totalBackgroundTicks,
      totalGameMinutesBackground: this.totalGameMinutesBackground,
      activeAgentCount: this.agentLoop.getAgentCount(),
      activeEventCount: this.worldLoop.getWorldState().getActiveEvents().length,
      currentTime: this.worldLoop.getWorldState().getTimeString(),
      currentDay: this.worldLoop.getWorldState().environment.day,
    };
  }

  // ============================================================
  // 内部实现
  // ============================================================

  /**
   * 主循环（定时器触发）
   */
  private async backgroundTick(): Promise<void> {
    if (!this.running) return;

    // 检查最大运行时间
    const runTimeMinutes = (Date.now() - this.startedAt) / 60000;
    if (runTimeMinutes > this.config.maxBackgroundMinutes) {
      this.stop();
      this.eventBus?.emit('background:time_limit_reached', {
        maxMinutes: this.config.maxBackgroundMinutes,
      });
      return;
    }

    this.totalBackgroundTicks++;

    // 1. 自适应模式切换
    this.adaptiveModeSwitch();

    // 2. 检查持久化
    if (this.config.persistenceEnabled) {
      const minutesSincePersist = (Date.now() - this.lastPersistAt) / 60000;
      if (minutesSincePersist >= this.config.persistenceIntervalMinutes) {
        this.lastPersistAt = Date.now();
        this.eventBus?.emit('background:persist', {
          tickCount: this.totalBackgroundTicks,
        });
      }
    }

    // 3. 推进世界
    const interval = this.getCurrentInterval();
    const worldResult = this.worldLoop.tick(interval);
    this.lastWorldTickResult = worldResult;

    // 4. 推进 Agent
    if (this.mode !== 'deep_sleep') {
      const agentDeltaMinutes = this.mode === 'low_power'
        ? this.config.lowPowerTimeMultiplier * this.worldLoop.getTotalGameMinutes()
        : this.worldLoop.getTotalGameMinutes();

      this.agentLoop.tick(10);
    }

    this.totalGameMinutesBackground += worldResult.gameMinutesElapsed;

    // 5. 检查是否需要唤醒（事件触发）
    if (this.mode === 'deep_sleep') {
      const activeEvents = this.worldLoop.getWorldState().getActiveEvents();
      if (activeEvents.length > 0) {
        // 有事件发生，提升到 low_power
        this.setMode('low_power');
      }
    }

    // 6. 通知回调
    const bgEvent: BackgroundTickEvent = {
      mode: this.mode,
      tickCount: this.totalBackgroundTicks,
      gameMinutesElapsed: worldResult.gameMinutesElapsed,
      activeAgents: this.agentLoop.getAgentCount(),
      activeEvents: this.worldLoop.getWorldState().getActiveEvents().length,
      worldSummary: worldResult.worldSummary,
      runTimeMinutes: runTimeMinutes,
    };

    for (const cb of this.onTickCallbacks) {
      try { cb(bgEvent); } catch { /* ignore */ }
    }

    this.eventBus?.emit('background:tick', bgEvent);
  }

  /**
   * 自适应模式切换
   */
  private adaptiveModeSwitch(): void {
    const idleSeconds = (Date.now() - this.lastUserInteraction) / 1000;

    if (idleSeconds > this.config.deepSleepAfterSeconds) {
      if (this.mode !== 'deep_sleep') {
        this.mode = 'deep_sleep';
        this.restartTimer();
      }
    } else if (idleSeconds > this.config.lowPowerAfterSeconds) {
      if (this.mode === 'active') {
        this.mode = 'low_power';
        this.restartTimer();
      }
    }
  }

  /**
   * 重启定时器（模式切换时）
   */
  private restartTimer(): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.startTimer(this.getCurrentInterval());
  }

  /**
   * 启动定时器
   */
  private startTimer(interval: number): void {
    if (this.timerId !== null) {
      clearInterval(this.timerId);
    }
    this.timerId = setInterval(() => this.backgroundTick(), interval);
  }

  /**
   * 获取当前模式对应的 tick 间隔
   */
  private getCurrentInterval(): number {
    switch (this.mode) {
      case 'active': return this.config.activeTickInterval;
      case 'low_power': return this.config.lowPowerTickInterval;
      case 'deep_sleep': return this.config.deepSleepTickInterval;
      case 'paused': return 60000; // 暂停时每分钟检查一次
      default: return this.config.activeTickInterval;
    }
  }

  // ============================================================
  // 序列化支持
  // ============================================================

  serialize(): BackgroundRuntimeSaveData {
    return {
      mode: this.mode,
      running: this.running,
      startedAt: this.startedAt,
      totalBackgroundTicks: this.totalBackgroundTicks,
      totalGameMinutesBackground: this.totalGameMinutesBackground,
      lastUserInteraction: this.lastUserInteraction,
      config: { ...this.config },
    };
  }

  deserialize(data: BackgroundRuntimeSaveData): void {
    this.mode = data.mode;
    this.running = data.running;
    this.startedAt = data.startedAt;
    this.totalBackgroundTicks = data.totalBackgroundTicks;
    this.totalGameMinutesBackground = data.totalGameMinutesBackground;
    this.lastUserInteraction = data.lastUserInteraction;
    this.config = { ...DEFAULT_BACKGROUND_CONFIG, ...data.config };

    if (this.running) {
      this.start();
    }
  }
}

export interface BackgroundStats {
  running: boolean;
  mode: BackgroundMode;
  runTimeMinutes: number;
  totalBackgroundTicks: number;
  totalGameMinutesBackground: number;
  activeAgentCount: number;
  activeEventCount: number;
  currentTime: string;
  currentDay: number;
}

export interface BackgroundRuntimeSaveData {
  mode: BackgroundMode;
  running: boolean;
  startedAt: number;
  totalBackgroundTicks: number;
  totalGameMinutesBackground: number;
  lastUserInteraction: number;
  config: BackgroundRuntimeConfig;
}

export default BackgroundRuntime;
