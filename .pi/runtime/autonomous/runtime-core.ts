/**
 * runtime-core.ts - Autonomous Runtime 核心入口
 *
 * 整合所有子系统为统一的 Autonomous Runtime：
 *
 *          ┌─────────────────────────────────────────┐
 *          │          AutonomousRuntime               │
 *          ├─────────────────────────────────────────┤
 *          │  Scheduler   ←  优先级队列调度所有 tick  │
 *          │  WorldLoop   ←  环境时间事件推进        │
 *          │  AgentLoop   ←  NPC 自主行为循环        │
 *          │  Background  ←  离线后台运行            │
 *          │  WorldState  ←  世界状态                │
 *          │  TaskQueue   ←  异步任务队列            │
 *          │  EventBus    ←  事件总线整合            │
 *          └─────────────────────────────────────────┘
 *
 * 生命周期：
 *   boot() → start() → [tick loop] → pause()/resume() → stop()/shutdown()
 *
 * 与 Phase 1/2 整合：
 *   - 调用 ContextAssemblyEngine.assemble() 生成上下文
 *   - 调用 AttentionRuntime.tick() 管理注意力
 *   - 通过 EventBus 与其他模块通信
 *   - 通过 MemoryLayer 存储/检索记忆
 */

import { Scheduler, type TickType, type SchedulerState } from './scheduler';
import { TaskQueue } from './task-queue';
import { WorldLoop, type WorldSpeed, type WorldTickResult } from './world-loop';
import { AgentLoop } from './agent-loop';
import { BackgroundRuntime, type BackgroundMode, type BackgroundStats } from './background-runtime';
import { WorldStateRuntime, type WorldStateSnapshot } from './world-state';
import { AgentRuntimeState, type AgentRuntimeStateSnapshot } from '../agent/agent-runtime';
import type { EventBus } from '../events/event-bus';

// ============================================================
// Runtime 生命周期
// ============================================================

export type RuntimePhase =
  | 'uninitialized'
  | 'booting'
  | 'idle'
  | 'running'
  | 'paused'
  | 'shutting_down'
  | 'shutdown'
  ;

// ============================================================
// Runtime 配置
// ============================================================

export interface AutonomousRuntimeConfig {
  /** 是否在 boot 时自动启动 */
  autoStart: boolean;
  /** 是否启用后台运行 */
  backgroundEnabled: boolean;
  /** 初始后台模式 */
  backgroundMode: BackgroundMode;
  /** 世界速度 */
  worldSpeed: WorldSpeed;
  /** 最大注册 Agent 数 */
  maxAgents: number;
  /** tick 间隔（毫秒） */
  baseTickInterval: number;
}

const DEFAULT_RUNTIME_CONFIG: AutonomousRuntimeConfig = {
  autoStart: true,
  backgroundEnabled: true,
  backgroundMode: 'active',
  worldSpeed: 'normal',
  maxAgents: 20,
  baseTickInterval: 1000,
};

// ============================================================
// Runtime 状态快照
// ============================================================

export interface AutonomousRuntimeSnapshot {
  phase: RuntimePhase;
  uptimeMs: number;
  schedulerState: SchedulerState;
  worldState: WorldStateSnapshot;
  agents: AgentRuntimeStateSnapshot[];
  backgroundStats: BackgroundStats | null;
  taskQueueStats: { total: number; queued: number; running: number; completed: number };
  lastWorldTick: WorldTickResult | null;
}

// ============================================================
// Autonomous Runtime 实现
// ============================================================

export class AutonomousRuntime {
  /** 运行时阶段 */
  private phase: RuntimePhase = 'uninitialized';
  /** 启动时间 */
  private bootedAt: number = 0;

  /** 子系统引用 */
  readonly worldState: WorldStateRuntime;
  readonly worldLoop: WorldLoop;
  readonly agentLoop: AgentLoop;
  readonly scheduler: Scheduler;
  readonly taskQueue: TaskQueue;
  readonly background: BackgroundRuntime;

  /** 外部依赖 */
  private eventBus: EventBus | null;

  /** 配置 */
  private config: AutonomousRuntimeConfig;

  /** 上次世界 tick 结果 */
  private lastWorldTickResult: WorldTickResult | null = null;

  constructor(
    worldState: WorldStateRuntime,
    eventBus?: EventBus,
    config?: Partial<AutonomousRuntimeConfig>
  ) {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...config };
    this.eventBus = eventBus ?? null;
    this.worldState = worldState;

    // 构建子系统
    this.scheduler = new Scheduler();
    this.taskQueue = new TaskQueue(5);
    this.worldLoop = new WorldLoop(worldState, eventBus ?? undefined);
    this.agentLoop = new AgentLoop(worldState, undefined, eventBus ?? undefined);
    this.background = new BackgroundRuntime(
      this.worldLoop, this.agentLoop, eventBus ?? undefined
    );

    this.setupDefaultTicks();
  }

  // ============================================================
  // 生命周期管理
  // ============================================================

  /**
   * 启动 Runtime
   */
  boot(): void {
    if (this.phase !== 'uninitialized') {
      console.warn('[AutonomousRuntime] 已经在运行中，先 shutdown');
      return;
    }

    this.phase = 'booting';
    this.bootedAt = Date.now();

    // 注册 Scheduler tick 任务
    this.registerSchedulerTicks();

    // 启动调度器
    this.scheduler.start();

    // 启动任务队列处理器
    this.startTaskQueueProcessor();

    // 启动后台运行时
    if (this.config.backgroundEnabled) {
      this.background.start();
    }

    // 设置世界速度
    this.worldLoop.setSpeed(this.config.worldSpeed);

    this.phase = 'running';
    this.eventBus?.emit('runtime:booted', {
      startedAt: this.bootedAt,
      config: this.config,
    });
  }

  /**
   * 停止 Runtime
   */
  shutdown(): void {
    if (this.phase === 'shutdown' || this.phase === 'uninitialized') return;

    this.phase = 'shutting_down';
    this.eventBus?.emit('runtime:shutting_down', {});

    // 停止后台
    this.background.stop();

    // 停止调度器
    this.scheduler.stop();

    // 清空任务队列
    this.taskQueue.clear();

    this.phase = 'shutdown';
    this.eventBus?.emit('runtime:shutdown', {
      uptimeMs: Date.now() - this.bootedAt,
    });
  }

  /**
   * 暂停（所有子系统暂停）
   */
  pause(): void {
    if (this.phase !== 'running') return;
    this.phase = 'paused';
    this.scheduler.pause();
    this.background.pause();
    this.eventBus?.emit('runtime:paused', {});
  }

  /**
   * 恢复
   */
  resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'running';
    this.scheduler.resume();
    this.background.resume();
    this.eventBus?.emit('runtime:resumed', {});
  }

  /**
   * 获取当前阶段
   */
  getPhase(): RuntimePhase {
    return this.phase;
  }

  /**
   * 是否正在运行
   */
  isRunning(): boolean {
    return this.phase === 'running';
  }

  // ============================================================
  // Agent 管理
  // ============================================================

  /**
   * 注册 Agent 到运行时
   */
  registerAgent(agent: AgentRuntimeState): boolean {
    if (this.agentLoop.getAgentCount() >= this.config.maxAgents) {
      console.warn(`[AutonomousRuntime] 超过最大 Agent 数 (${this.config.maxAgents})`);
      return false;
    }

    this.agentLoop.registerAgent(agent);
    this.eventBus?.emit('runtime:agent_registered', {
      agentId: agent.agentId,
      name: agent.name,
    });
    return true;
  }

  /**
   * 注销 Agent
   */
  unregisterAgent(agentId: string): void {
    this.agentLoop.unregisterAgent(agentId);
  }

  /**
   * 获取 Agent
   */
  getAgent(agentId: string): AgentRuntimeState | undefined {
    return this.agentLoop.getAgent(agentId);
  }

  /**
   * 获取所有 Agent
   */
  getAllAgents(): AgentRuntimeState[] {
    return this.agentLoop.getAllAgents();
  }

  // ============================================================
  // 世界管理
  // ============================================================

  /**
   * 设置世界速度
   */
  setWorldSpeed(speed: WorldSpeed): void {
    this.worldLoop.setSpeed(speed);
  }

  /**
   * 记录用户交互（重置空闲计时）
   */
  recordUserInteraction(): void {
    this.worldLoop.recordUserInteraction();
    this.background.recordUserInteraction();
  }

  /**
   * 强制世界 tick
   */
  forceWorldTick(): WorldTickResult | null {
    if (this.phase !== 'running') return null;
    const result = this.worldLoop.tick(this.config.baseTickInterval);
    this.lastWorldTickResult = result;
    return result;
  }

  /**
   * 强制 Agent tick
   */
  forceAgentTick(): void {
    if (this.phase !== 'running') return;
    this.agentLoop.tick(10);
  }

  // ============================================================
  // 任务队列
  // ============================================================

  /**
   * 添加异步任务
   */
  addTask(task: Parameters<TaskQueue['add']>[0]): string {
    return this.taskQueue.add(task);
  }

  // ============================================================
  // 状态查询
  // ============================================================

  /**
   * 获取 WorldState 实例（供 PersistenceManager 使用）
   */
  getWorldState(): WorldStateRuntime {
    return this.worldState;
  }

  /**
   * 获取完整快照（用于调试和 UI）
   */
  getSnapshot(): AutonomousRuntimeSnapshot {
    return {
      phase: this.phase,
      uptimeMs: this.bootedAt > 0 ? Date.now() - this.bootedAt : 0,
      schedulerState: this.scheduler.getState(),
      worldState: this.worldState.getSnapshot(),
      agents: this.agentLoop.getAllSnapshots(),
      backgroundStats: this.config.backgroundEnabled ? this.background.getStats() : null,
      taskQueueStats: {
        total: this.taskQueue.getStats().total,
        queued: this.taskQueue.getStats().queued,
        running: this.taskQueue.getStats().running,
        completed: this.taskQueue.getStats().completed,
      },
      lastWorldTick: this.lastWorldTickResult,
    };
  }

  /**
   * 获取世界摘要
   */
  getWorldSummary(): string {
    return this.worldLoop.getWorldSummary();
  }

  /**
   * 打印运行时状态摘要
   */
  printStatus(): string {
    const snap = this.getSnapshot();
    const lines = [
      `=== Autonomous Runtime 状态 ===`,
      `阶段: ${snap.phase}`,
      `运行时间: ${(snap.uptimeMs / 1000).toFixed(1)}s`,
      ``,
      `调度器: ${snap.schedulerState.running ? '✅ 运行中' : '⏹ 已停止'}`,
      `  总 tick: ${snap.schedulerState.totalTicks}`,
      `  队列任务: ${snap.schedulerState.queuedTasks}`,
      `  活跃任务: ${snap.schedulerState.activeTasks}`,
      ``,
      `世界: ${snap.worldState.summary}`,
      `  地点: ${snap.worldState.locationCount} | 势力: ${snap.worldState.factionCount}`,
      `  活跃事件: ${snap.worldState.activeEventCount}`,
      ``,
      `Agent: ${snap.agents.length} 个`,
      `  ${snap.agents.map(a => `${a.name}(${a.state})[${a.location}]`).join(', ')}`,
      ``,
      `后台: ${snap.backgroundStats ? `${snap.backgroundStats.mode} | tick ${snap.backgroundStats.totalBackgroundTicks} | 运行 ${snap.backgroundStats.runTimeMinutes.toFixed(1)}m` : '未启用'}`,
      ``,
      `任务队列: ${snap.taskQueueStats.total} 总 | ${snap.taskQueueStats.queued} 待执行 | ${snap.taskQueueStats.running} 运行中`,
    ];
    return lines.join('\n');
  }

  // ============================================================
  // 序列化
  // ============================================================

  serialize(): AutonomousRuntimeSaveData {
    return {
      config: { ...this.config },
      phase: this.phase,
      bootedAt: this.bootedAt,
    };
  }

  deserialize(data: AutonomousRuntimeSaveData): void {
    this.config = { ...DEFAULT_RUNTIME_CONFIG, ...data.config };
    this.phase = data.phase;
    this.bootedAt = data.bootedAt;

    if (this.phase === 'running') {
      this.boot();
    }
  }

  // ============================================================
  // 内部实现
  // ============================================================

  /**
   * 设置默认 tick 任务
   */
  private setupDefaultTicks(): void {
    // World tick
    this.scheduler.registerTick('world_tick', async () => {
      if (this.phase !== 'running') return;
      const result = this.worldLoop.tick(this.config.baseTickInterval);
      this.lastWorldTickResult = result;
    });

    // Agent tick
    this.scheduler.registerTick('agent_tick', async () => {
      if (this.phase !== 'running') return;
      this.agentLoop.tick(10);
    });

    // Memory tick
    this.scheduler.registerTick('memory_tick', async () => {
      if (this.phase !== 'running') return;
      // 记忆整理：清理过期记忆等（由 MemoryLayer 自行处理）
      this.eventBus?.emit('memory:tick', { timestamp: Date.now() });
    });

    // Relation tick
    this.scheduler.registerTick('relation_tick', async () => {
      if (this.phase !== 'running') return;
      // 关系已经在 agent tick 中处理，这里只做全局检查
      this.eventBus?.emit('relation:tick', { timestamp: Date.now() });
    });

    // Goal tick
    this.scheduler.registerTick('goal_tick', async () => {
      if (this.phase !== 'running') return;
      this.eventBus?.emit('goal:tick', { timestamp: Date.now() });
    });

    // Event tick
    this.scheduler.registerTick('event_tick', async () => {
      if (this.phase !== 'running') return;
      this.eventBus?.emit('event:tick', { timestamp: Date.now() });
    });

    // Background tick
    this.scheduler.registerTick('background_tick', async () => {
      if (this.phase !== 'running') return;
      // 检查空闲状态
      this.worldLoop.checkIdleAcceleration();
    });
  }

  /**
   * 注册调度器任务（在 boot 时调用）
   */
  private registerSchedulerTicks(): void {
    // 调度器会从注册的 factories 自动创建任务
    // 已在 setupDefaultTicks 中注册
  }

  /**
   * 启动任务队列处理器
   */
  private startTaskQueueProcessor(): void {
    setInterval(async () => {
      if (this.phase !== 'running') return;
      try {
        await this.taskQueue.process();
      } catch (error) {
        console.error('[AutonomousRuntime] TaskQueue 处理错误:', error);
      }
    }, 500); // 每 500ms 处理一次
  }
}

// ============================================================
// 序列化数据结构
// ============================================================

export interface AutonomousRuntimeSaveData {
  config: AutonomousRuntimeConfig;
  phase: RuntimePhase;
  bootedAt: number;
}

export default AutonomousRuntime;
