/**
 * world-loop.ts - 世界主循环
 *
 * 世界能够：
 * - 持续推进时间
 * - 处理世界事件
 * - 更新地点状态
 * - 更新 faction 状态
 * - 推进环境变化
 *
 * 支持：
 * - runtime speed（运行速度控制）
 * - accelerated time（加速时间）
 * - idle simulation（空闲模拟）
 * - background progression（后台推进）
 */

import { WorldStateRuntime, type EnvironmentChange, type WorldEventProcessResult } from './world-state';
import type { EventBus } from '../events/event-bus';

export type WorldSpeed = 'paused' | 'normal' | 'accelerated_2x' | 'accelerated_5x' | 'accelerated_10x' | 'accelerated_60x';

export interface WorldLoopConfig {
  /** 每次 tick 推进的真实世界秒数 */
  tickDurationSeconds: number;
  /** 游戏时间 vs 真实时间的倍率 */
  timeMultiplier: number;
  /** 默认速度 */
  defaultSpeed: WorldSpeed;
  /** 空闲时是否自动加速 */
  idleAcceleration: boolean;
  /** 空闲阈值（无用户输入多少秒后加速） */
  idleThresholdSeconds: number;
  /** 最大空闲加速倍率 */
  maxIdleMultiplier: number;
  /** 每次 tick 推进的游戏分钟数（由 speed 决定） */
  minutesPerTick: number;
}

const DEFAULT_WORLD_LOOP_CONFIG: WorldLoopConfig = {
  tickDurationSeconds: 1,
  timeMultiplier: 1,
  defaultSpeed: 'normal',
  idleAcceleration: true,
  idleThresholdSeconds: 60,  // 1 分钟后加速
  maxIdleMultiplier: 10,
  minutesPerTick: 5,         // 每次 tick 推进 5 分钟游戏时间
};

export class WorldLoop {
  private worldState: WorldStateRuntime;
  private eventBus: EventBus | null;
  private config: WorldLoopConfig;

  /** 当前速度 */
  private speed: WorldSpeed = 'normal';
  /** 实际每分钟推进的游戏分钟数 */
  private effectiveMinutesPerTick: number = 5;

  /** 上次用户交互时间 */
  private lastUserInteraction: number = Date.now();
  /** 累计 tick 数 */
  private totalTicks: number = 0;
  /** 累计推进的游戏时间（分钟） */
  private totalGameMinutes: number = 0;

  /** 上次环境变化缓存 */
  private lastEnvironmentChange: EnvironmentChange | null = null;
  /** 上次事件处理结果缓存 */
  private lastEventResults: WorldEventProcessResult[] = [];

  /** 世界循环回调（供外部监听） */
  private onTickCallbacks: Array<(result: WorldTickResult) => void> = [];

  constructor(
    worldState: WorldStateRuntime,
    eventBus?: EventBus,
    config?: Partial<WorldLoopConfig>
  ) {
    this.worldState = worldState;
    this.eventBus = eventBus ?? null;
    this.config = { ...DEFAULT_WORLD_LOOP_CONFIG, ...config };
    this.updateEffectiveSpeed();
  }

  /**
   * 每次 tick 调用
   */
  tick(realDeltaMs: number): WorldTickResult {
    this.totalTicks++;

    // 1. 计算本次推进的游戏时间
    const gameMinutes = this.calculateGameMinutes(realDeltaMs);
    this.totalGameMinutes += gameMinutes;

    // 2. 推进环境时间
    const environmentChange = this.worldState.advanceTime(gameMinutes);

    // 3. 推进事件
    const eventResults = this.worldState.advanceEvents(gameMinutes);

    // 4. 更新地点状态（随机变化）
    this.updateLocations();

    // 5. 更新 faction 状态
    this.updateFactions();

    // 6. 更新光线条件
    this.worldState.advanceTime(0); // 触发 light level 更新

    // 缓存结果
    this.lastEnvironmentChange = environmentChange;
    this.lastEventResults = eventResults;

    // 构建结果
    const result: WorldTickResult = {
      totalTicks: this.totalTicks,
      gameMinutesElapsed: gameMinutes,
      totalGameMinutes: this.totalGameMinutes,
      environmentChange,
      eventResults,
      speed: this.speed,
      timeString: this.worldState.getTimeString(),
      worldSummary: this.worldState.getWorldSummary(),
    };

    // 通知回调
    for (const cb of this.onTickCallbacks) {
      try { cb(result); } catch { /* ignore */ }
    }

    // 发送事件
    this.eventBus?.emit('world:tick', result);

    return result;
  }

  /**
   * 记录用户交互（用于空闲检测）
   */
  recordUserInteraction(): void {
    this.lastUserInteraction = Date.now();
    if (this.config.idleAcceleration) {
      this.speed = 'normal';
      this.updateEffectiveSpeed();
    }
  }

  /**
   * 设置世界速度
   */
  setSpeed(speed: WorldSpeed): void {
    this.speed = speed;
    this.updateEffectiveSpeed();
    this.eventBus?.emit('world:speed_change', { speed, minutesPerTick: this.effectiveMinutesPerTick });
  }

  /**
   * 获取当前速度
   */
  getSpeed(): WorldSpeed {
    return this.speed;
  }

  /**
   * 检查是否需要空闲加速
   */
  checkIdleAcceleration(): void {
    if (!this.config.idleAcceleration) return;

    const idleSeconds = (Date.now() - this.lastUserInteraction) / 1000;
    if (idleSeconds > this.config.idleThresholdSeconds) {
      const idleMinutes = (idleSeconds - this.config.idleThresholdSeconds) / 60;
      // 空闲越久加速越快，但有限度
      const multiplier = Math.min(
        this.config.maxIdleMultiplier,
        1 + idleMinutes * 0.5
      );

      if (multiplier >= 2) {
        this.speed = 'accelerated_2x';
      }
      if (multiplier >= 5) {
        this.speed = 'accelerated_5x';
      }
      if (multiplier >= 10) {
        this.speed = 'accelerated_10x';
      }

      this.updateEffectiveSpeed();
    }
  }

  /**
   * 注册 tick 回调
   */
  onTick(callback: (result: WorldTickResult) => void): void {
    this.onTickCallbacks.push(callback);
  }

  /**
   * 获取世界状态引用
   */
  getWorldState(): WorldStateRuntime {
    return this.worldState;
  }

  /**
   * 获取总游戏时间
   */
  getTotalGameMinutes(): number {
    return this.totalGameMinutes;
  }

  /**
   * 获取世界摘要（用于上下文注入）
   */
  getWorldSummary(): string {
    return this.worldState.getWorldSummary();
  }

  /**
   * 记录日志
   */
  getLastTickResult(): WorldTickResult | null {
    if (this.totalTicks === 0) return null;
    return {
      totalTicks: this.totalTicks,
      gameMinutesElapsed: 0,
      totalGameMinutes: this.totalGameMinutes,
      environmentChange: this.lastEnvironmentChange ?? {
        timeChanged: false, dayChanged: false,
        seasonChanged: false, weatherChanged: false, newTime: '',
      },
      eventResults: this.lastEventResults,
      speed: this.speed,
      timeString: this.worldState.getTimeString(),
      worldSummary: this.worldState.getWorldSummary(),
    };
  }

  // ============================================================
  // 内部实现
  // ============================================================

  private calculateGameMinutes(realDeltaMs: number): number {
    const baseMinutes = (realDeltaMs / 1000) * this.config.minutesPerTick;
    return Math.max(0.1, baseMinutes * this.getTimeMultiplier());
  }

  private getTimeMultiplier(): number {
    switch (this.speed) {
      case 'paused': return 0;
      case 'normal': return 1;
      case 'accelerated_2x': return 2;
      case 'accelerated_5x': return 5;
      case 'accelerated_10x': return 10;
      case 'accelerated_60x': return 60;
      default: return 1;
    }
  }

  private updateEffectiveSpeed(): void {
    const multiplier = this.getTimeMultiplier();
    this.effectiveMinutesPerTick = this.config.minutesPerTick * multiplier;
  }

  private updateLocations(): void {
    // 随机更新一些地点的状态
    if (Math.random() < 0.05) {
      const locs = Array.from(this.worldState.locations.values());
      if (locs.length > 0) {
        const loc = locs[Math.floor(Math.random() * locs.length)];
        // 小概率改变状态
        const states: WorldLocation['state'][] = ['normal', 'busy', 'quiet'];
        if (Math.random() < 0.1) {
          loc.state = states[Math.floor(Math.random() * states.length)];
          loc.updatedAt = Date.now();
        }
      }
    }
  }

  private updateFactions(): void {
    // faction 影响力缓慢波动
    for (const faction of this.worldState.factions.values()) {
      const delta = (Math.random() - 0.5) * 0.01;
      faction.influence = Math.max(0, Math.min(1, faction.influence + delta));
      faction.updatedAt = Date.now();
    }
  }
}

export interface WorldTickResult {
  totalTicks: number;
  gameMinutesElapsed: number;
  totalGameMinutes: number;
  environmentChange: EnvironmentChange;
  eventResults: WorldEventProcessResult[];
  speed: WorldSpeed;
  timeString: string;
  worldSummary: string;
}

// 避免循环引用
import type { WorldLocation } from './world-state';

export default WorldLoop;
