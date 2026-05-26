/**
 * Agent Runtime System - 统一入口
 *
 * 提供整个 Runtime 的工厂函数和高级 API。
 * 兼容旧 RP Engine：通过适配器桥接新旧状态格式。
 *
 * Phase 3 Autonomous Runtime 整合点：
 * - createAutonomousRuntime() 创建 Autonomous Runtime
 * - AgentRuntime 现在支持挂载 AutonomousRuntime
 * - 通过 eventBus 与 Autonomous 子系统通信
 *
 * 使用方式：
 *   const runtime = createRuntime(config);
 *   const autonomous = createAutonomousRuntime(worldState, eventBus);
 *   runtime.attachAutonomous(autonomous);
 *   autonomous.boot();
 */

import { ContextAssemblyEngine, type RuntimeStateSnapshot } from './context';
import { EventBus } from './events/event-bus';
import { MemoryLayer } from './memory/memory-layer';
import { AutonomousRuntime, type AutonomousRuntimeConfig } from './autonomous/runtime-core';
import { WorldStateRuntime } from './autonomous/world-state';
import { DebugDashboard } from './debug';

// ============================================================
// Runtime 配置
// ============================================================

export interface RuntimeConfig {
  /** 模型上下文窗口大小（token） */
  modelMaxTokens: number;
  /** 安全余量（预留的 token 数） */
  safetyMargin?: number;
  /** 上下文装配模式 */
  contextMode?: 'legacy' | 'runtime' | 'auto';
  /** 是否启用记忆持久化 */
  enableMemory?: boolean;
  /** 是否启用知识层 */
  enableKnowledge?: boolean;
  /** 是否启用 Autonomous Runtime（Phase 3） */
  enableAutonomous?: boolean;
  /** Autonomous Runtime 配置 */
  autonomousConfig?: Partial<AutonomousRuntimeConfig>;
}

// ============================================================
// Runtime 实例
// ============================================================

export class AgentRuntime {
  public readonly contextEngine: ContextAssemblyEngine | null;
  public readonly eventBus: EventBus;
  public readonly memory: MemoryLayer | null;

  /** Phase 3: Autonomous Runtime */
  public autonomous: AutonomousRuntime | null = null;
  /** 调试仪表盘 */
  public debug: DebugDashboard | null = null;

  private config: RuntimeConfig;
  private isInitialized: boolean = false;

  constructor(config: RuntimeConfig) {
    this.config = {
      ...config,
      contextMode: config.contextMode ?? 'auto',
      enableMemory: config.enableMemory ?? true,
      enableKnowledge: config.enableKnowledge ?? true,
      enableAutonomous: config.enableAutonomous ?? false,
    };

    this.eventBus = new EventBus();
    this.memory = this.config.enableMemory ? new MemoryLayer() : null;

    if (this.config.contextMode === 'runtime' || this.config.contextMode === 'auto') {
      this.contextEngine = this.buildContextEngine();
    } else {
      this.contextEngine = null;
    }

    // 初始化调试仪表盘
    this.debug = new DebugDashboard();
  }

  /**
   * 构建 Context Assembly Engine
   */
  private buildContextEngine(): ContextAssemblyEngine {
    if (!this.memory) {
      throw new Error('MemoryLayer 未启用时无法构建 ContextAssemblyEngine');
    }

    return new ContextAssemblyEngine({
      eventBus: this.eventBus,
      memory: this.memory,
      knowledge: {
        query: async () => [],
        index: async () => {},
        updateGraph: async () => {},
        getRelated: async () => [],
      } as any,
      goals: {
        getActiveGoals: async () => [],
        evaluateDrives: async () => [],
        updateGoal: async () => {},
      } as any,
      modelMaxTokens: this.config.modelMaxTokens,
      safetyMargin: this.config.safetyMargin ?? 4000,
      attentionTracer: this.debug?.attention,
      memoryTracer: this.debug?.memory,
    });
  }

  /**
   * 挂载 Autonomous Runtime
   */
  attachAutonomous(autonomous: AutonomousRuntime): void {
    this.autonomous = autonomous;

    // 将调试系统接入 Autonomous Runtime 事件
    this.eventBus.on('runtime:*', (event) => {
      this.debug?.runtime.trace(event.type as any, event.data);
    });
    this.eventBus.on('agent:*', (event) => {
      this.debug?.runtime.trace(event.type as any, event.data);
    });
    this.eventBus.on('world:*', (event) => {
      this.debug?.runtime.trace(event.type as any, event.data);
    });

    this.debug?.runtime.setPhase(autonomous.getPhase());
  }

  /**
   * 初始化 Runtime
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // 如果启用了 Autonomous 但未挂载，自动创建
    if (this.config.enableAutonomous && !this.autonomous) {
      const worldState = new WorldStateRuntime();
      const autonomous = new AutonomousRuntime(
        worldState,
        this.eventBus,
        this.config.autonomousConfig
      );
      this.attachAutonomous(autonomous);
      autonomous.boot();
    }
  }

  /**
   * 核心入口：装配上下文
   */
  async assemble(
    userMessage: string,
    runtimeState: RuntimeStateSnapshot,
    agentId: string
  ): Promise<string> {
    if (!this.contextEngine) {
      throw new Error('ContextEngine 未初始化（当前使用 legacy mode）');
    }

    // 如果 Autonomous Runtime 在运行，记录用户交互
    this.autonomous?.recordUserInteraction();

    return await this.contextEngine.assemble(userMessage, runtimeState, agentId);
  }

  /**
   * 记录用户交互（通知 Autonomous Runtime）
   */
  recordUserInteraction(): void {
    this.autonomous?.recordUserInteraction();
  }

  /**
   * 获取运行时完整状态
   */
  getFullStatus() {
    const base = {
      mode: this.contextEngine ? 'runtime' : 'legacy',
      initialized: this.isInitialized,
      memoryEnabled: !!this.memory,
      autonomousEnabled: !!this.autonomous,
    };

    if (this.autonomous?.isRunning()) {
      return {
        ...base,
        autonomousStatus: this.autonomous.getSnapshot(),
        worldSummary: this.autonomous.getWorldSummary(),
      };
    }

    return base;
  }

  /**
   * 获取 Autonomous Runtime 状态
   */
  getAutonomousStatus() {
    if (!this.autonomous) return null;
    return {
      phase: this.autonomous.getPhase(),
      running: this.autonomous.isRunning(),
      snapshot: this.autonomous.getSnapshot(),
      worldSummary: this.autonomous.getWorldSummary(),
      debugSummary: this.debug?.getFullSummary(),
    };
  }

  /**
   * 获取调试摘要
   */
  getDebugSummary(): string | null {
    return this.debug?.getFullSummary() ?? null;
  }

  /**
   * 关闭 Runtime
   */
  async shutdown(): Promise<void> {
    this.autonomous?.shutdown();
    this.eventBus.clear();
    this.isInitialized = false;
  }
}

// ============================================================
// 工厂函数
// ============================================================

let runtimeInstance: AgentRuntime | null = null;

/**
 * 创建或获取 Runtime 实例
 */
export function createRuntime(config: RuntimeConfig): AgentRuntime {
  if (!runtimeInstance) {
    runtimeInstance = new AgentRuntime(config);
  }
  return runtimeInstance;
}

/**
 * 获取当前 Runtime 实例
 */
export function getRuntime(): AgentRuntime | null {
  return runtimeInstance;
}

/**
 * 创建 Autonomous Runtime 并挂载到主 Runtime
 */
export function createAutonomousRuntime(
  worldState?: WorldStateRuntime,
  config?: Partial<AutonomousRuntimeConfig>
): AutonomousRuntime {
  const ws = worldState ?? new WorldStateRuntime();
  const runtime = getRuntime();
  const autonomous = new AutonomousRuntime(ws, runtime?.eventBus ?? undefined, config);

  if (runtime) {
    runtime.attachAutonomous(autonomous);
  }

  return autonomous;
}

/**
 * 关闭并清除 Runtime 实例
 */
export async function destroyRuntime(): Promise<void> {
  if (runtimeInstance) {
    await runtimeInstance.shutdown();
    runtimeInstance = null;
  }
}

export default AgentRuntime;

// ============================================================
// 重新导出 Autonomous 模块
// ============================================================

export { AutonomousRuntime, WorldStateRuntime, PersistenceManager } from './autonomous';
export { DebugDashboard } from './debug';
