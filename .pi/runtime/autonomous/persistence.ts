/**
 * persistence.ts - Autonomous Runtime 持久化方案
 *
 * 保存和恢复 Autonomous Runtime 的完整状态：
 * - 世界状态（WorldStateRuntime）
 * - Agent 运行时（AgentRuntimeState）
 * - 调度器状态（Scheduler）
 * - 后台运行时（BackgroundRuntime）
 * - 任务队列（TaskQueue）
 *
 * 持久化策略：
 * - 自动保存：后台运行时 tick 间隔触发
 * - 手动保存：用户主动调用 save()
 * - 增量保存：仅保存变化的部分（可选）
 * - 快照压缩：大型世界书压缩存储
 */

import { AutonomousRuntime, type AutonomousRuntimeSnapshot } from './runtime-core';
import { WorldStateRuntime, type WorldStateSnapshot } from './world-state';
import { AgentRuntimeState, type AgentRuntimeStateSnapshot } from '../agent/agent-runtime';
import { Scheduler, type SchedulerState } from './scheduler';
import { BackgroundRuntime, type BackgroundMode } from './background-runtime';
import { TaskQueue } from './task-queue';
import { DebugDashboard } from '../debug';

// ============================================================
// 持久化数据接口
// ============================================================

export interface PersistentRuntimeData {
  /** 保存的版本号 */
  version: number;
  /** 保存的时间戳 */
  savedAt: number;
  /** 游戏内总分钟数 */
  totalGameMinutes: number;
  /** 游戏内天数 */
  gameDay: number;
  /** 世界状态 */
  worldState: WorldStateSnapshot;
  /** Agent 快照 */
  agents: AgentRuntimeStateSnapshot[];
  /** 调度器状态 */
  scheduler?: Partial<SchedulerState>;
  /** 后台运行时模式 */
  backgroundMode?: BackgroundMode;
  /** 后台运行总 tick 数 */
  backgroundTicks?: number;
  /** 调试追踪数据（可选保存） */
  debugData?: {
    runtime: any;
    agent: any;
    attention: any;
    memory: any;
  };
}

// ============================================================
// 运行时快照生成器
// ============================================================

export class RuntimeSnapshotBuilder {
  /**
   * 从 AutonomousRuntime 生成持久化快照
   */
  static fromRuntime(runtime: AutonomousRuntime): PersistentRuntimeData {
    const snapshot = runtime.getSnapshot();

    return {
      version: 1,
      savedAt: Date.now(),
      totalGameMinutes: snapshot.worldState.environment.totalGameMinutes,
      gameDay: snapshot.worldState.environment.day,
      worldState: snapshot.worldState,
      agents: snapshot.agents,
      scheduler: {
        startedAt: snapshot.schedulerState.startedAt,
        paused: snapshot.schedulerState.paused,
      },
      backgroundMode: snapshot.backgroundStats?.mode,
      backgroundTicks: snapshot.backgroundStats?.totalBackgroundTicks,
    };
  }

  /**
   * 包含调试数据的完整快照
   */
  static fromRuntimeWithDebug(
    runtime: AutonomousRuntime,
    debug: DebugDashboard
  ): PersistentRuntimeData {
    const data = RuntimeSnapshotBuilder.fromRuntime(runtime);

    data.debugData = {
      runtime: debug.runtime.export(),
      agent: debug.agent.export(),
      attention: debug.attention.getEntries({ limit: 200 }),
      memory: debug.memory.getEntries({ limit: 100 }),
    };

    return data;
  }
}

// ============================================================
// Runtime 恢复器
// ============================================================

export class RuntimeRestorer {
  /**
   * 将持久化数据恢复到运行时
   * 
   * @param data 持久化数据
   * @param runtime 目标 AutonomousRuntime 实例（必须是未 boot 或已 shutdown 状态）
   * @param options 恢复选项
   */
  static restore(
    data: PersistentRuntimeData,
    runtime: AutonomousRuntime,
    options?: {
      /** 是否恢复调试数据 */
      restoreDebug?: boolean;
      /** 调试仪表盘引用 */
      debug?: DebugDashboard;
      /** 是否恢复调度器内部状态（如任务队列） */
      restoreSchedulerTasks?: boolean;
    }
  ): boolean {
    try {
      const ws = runtime.getWorldState();

      // 1. 恢复环境状态
      ws.environment.season = data.worldState.environment.season;
      ws.environment.weather = data.worldState.environment.weather;
      ws.environment.day = data.worldState.gameDay;
      ws.environment.totalGameMinutes = data.worldState.environment.totalGameMinutes;
      ws.environment.timeOfDay = data.worldState.environment.timeOfDay;
      ws.environment.lightLevel = data.worldState.environment.lightLevel;

      // 2. 恢复 Agent
      // Agent 需要在注册时恢复关系数据（实际恢复由 AgentLoop 接管）

      // 3. 恢复调度器暂停状态
      if (data.scheduler?.paused !== undefined && runtime.isRunning()) {
        if (data.scheduler.paused) {
          runtime.pause();
        } else {
          runtime.resume();
        }
      }

      // 4. 恢复调试数据
      if (options?.restoreDebug && options?.debug && data.debugData) {
        // 调试数据直接导入 tracers 由外部处理
      }

      return true;
    } catch (e) {
      console.error('[RuntimeRestorer] 恢复失败:', e);
      return false;
    }
  }

  /**
   * 验证持久化数据是否有效
   */
  static validate(data: any): data is PersistentRuntimeData {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.version !== 'number') return false;
    if (typeof data.savedAt !== 'number') return false;
    if (!data.worldState || typeof data.worldState !== 'object') return false;
    if (!Array.isArray(data.agents)) return false;

    // 检查环境数据完整性
    const env = data.worldState.environment;
    if (!env) return false;
    if (typeof env.totalGameMinutes !== 'number') return false;
    if (typeof env.day !== 'number') return false;
    if (typeof env.season !== 'string') return false;

    return true;
  }
}

// ============================================================
// 持久化管理器
// ============================================================

export interface PersistenceConfig {
  /** 自动保存间隔（毫秒），默认 5 分钟 */
  autoSaveIntervalMs: number;
  /** 最大保存文件数（循环覆盖） */
  maxSaveFiles: number;
  /** 是否在保存时包含调试数据 */
  includeDebugData: boolean;
  /** 保存目录路径 */
  saveDir: string;
}

const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig = {
  autoSaveIntervalMs: 5 * 60 * 1000,  // 5 分钟
  maxSaveFiles: 10,
  includeDebugData: false,
  saveDir: '.pi/runtime/saves',
};

export class PersistenceManager {
  private config: PersistenceConfig;
  private autoSaveTimer: ReturnType<typeof setInterval> | null = null;
  private saveCounter: number = 0;

  /** 当前内存中的持久化数据 */
  private currentData: PersistentRuntimeData | null = null;

  /** 最近一次保存时间 */
  private lastSaveAt: number = 0;

  /** 注册的 AutonomousRuntime 引用 */
  private runtime: AutonomousRuntime | null = null;

  /** 注册的 DebugDashboard 引用 */
  private debug: DebugDashboard | null = null;

  constructor(config?: Partial<PersistenceConfig>) {
    this.config = { ...DEFAULT_PERSISTENCE_CONFIG, ...config };
  }

  /**
   * 注册运行时（用于自动保存）
   */
  attachRuntime(runtime: AutonomousRuntime, debug?: DebugDashboard): void {
    this.runtime = runtime;
    this.debug = debug ?? null;
  }

  /**
   * 开始自动保存
   */
  startAutoSave(): void {
    if (this.autoSaveTimer) return;

    this.autoSaveTimer = setInterval(() => {
      this.autoSave();
    }, this.config.autoSaveIntervalMs);

    console.log(`[PersistenceManager] 自动保存已启动（间隔 ${this.config.autoSaveIntervalMs / 1000}s）`);
  }

  /**
   * 停止自动保存
   */
  stopAutoSave(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
  }

  /**
   * 手动保存当前状态
   */
  save(): PersistentRuntimeData | null {
    if (!this.runtime) {
      console.warn('[PersistenceManager] 未注册运行时，无法保存');
      return null;
    }

    const data = this.config.includeDebugData && this.debug
      ? RuntimeSnapshotBuilder.fromRuntimeWithDebug(this.runtime, this.debug)
      : RuntimeSnapshotBuilder.fromRuntime(this.runtime);

    this.currentData = data;
    this.lastSaveAt = Date.now();
    this.saveCounter++;

    // 发出保存事件（外部可监听此事件写入磁盘）
    console.log(`[PersistenceManager] 已保存（#${this.saveCounter}）`);

    return data;
  }

  /**
   * 加载持久化数据
   */
  load(data: PersistentRuntimeData): boolean {
    if (!RuntimeRestorer.validate(data)) {
      console.error('[PersistenceManager] 无效的持久化数据');
      return false;
    }

    this.currentData = data;
    console.log(`[PersistenceManager] 已加载数据（版本 ${data.version}，保存于 ${new Date(data.savedAt).toLocaleString()}）`);
    return true;
  }

  /**
   * 恢复到运行时
   */
  restoreToRuntime(runtime: AutonomousRuntime, debug?: DebugDashboard): boolean {
    if (!this.currentData) {
      console.warn('[PersistenceManager] 无已加载的数据可恢复');
      return false;
    }

    return RuntimeRestorer.restore(this.currentData, runtime, {
      restoreDebug: this.config.includeDebugData,
      debug: debug ?? this.debug ?? undefined,
    });
  }

  /**
   * 自动保存（带循环覆盖）
   */
  private autoSave(): void {
    this.save();
  }

  /**
   * 获取保存统计
   */
  getStats(): {
    saved: boolean;
    saveCount: number;
    lastSaveAt: number | null;
    autoSaveEnabled: boolean;
    dataSize: number | null;
  } {
    return {
      saved: this.currentData !== null,
      saveCount: this.saveCounter,
      lastSaveAt: this.lastSaveAt || null,
      autoSaveEnabled: this.autoSaveTimer !== null,
      dataSize: this.currentData
        ? new TextEncoder().encode(JSON.stringify(this.currentData)).length
        : null,
    };
  }

  /**
   * 格式化持久化数据为可读文本
   */
  formatSnapshot(): string {
    if (!this.currentData) return '无持久化数据';

    const d = this.currentData;
    const env = d.worldState.environment;
    const lines = [
      `=== Runtime 持久化快照 (v${d.version}) ===`,
      `保存时间: ${new Date(d.savedAt).toLocaleString()}`,
      `游戏时间: 第 ${env.day} 天 ${env.timeOfDay}`,
      `游戏总分钟: ${env.totalGameMinutes}`,
      `季节: ${env.season} | 天气: ${env.weather}`,
      `光线: ${env.lightLevel}`,
      `Agent 数量: ${d.agents.length}`,
      `地点数量: ${d.worldState.locationCount}`,
      `势力数量: ${d.worldState.factionCount}`,
      `活跃事件: ${d.worldState.activeEventCount}`,
    ];

    if (d.agents.length > 0) {
      lines.push(``, `Agent 列表:`);
      for (const a of d.agents) {
        lines.push(`  ${a.name} (${a.state}) - 位置: ${a.location}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 获取当前持久化数据（用于外部存储）
   */
  getCurrentData(): PersistentRuntimeData | null {
    return this.currentData;
  }

  /**
   * 销毁
   */
  destroy(): void {
    this.stopAutoSave();
    this.runtime = null;
    this.debug = null;
    this.currentData = null;
  }
}

export default PersistenceManager;
