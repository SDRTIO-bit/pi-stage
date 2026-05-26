/**
 * RP Engine - Runtime 模块类型声明
 *
 * runtime/ 是可选依赖，用户可能未编译/部署。
 * 此文件定义 Runtime API 的类型，使集成层有类型信息可用，
 * 同时保持 try-catch 安全网（运行时模块可能不存在）。
 */

// ============================================================
// AgentRuntime
// ============================================================

export interface RuntimeMemory {
  store(entry: any): Promise<any>;
}

export interface AutonomousRuntime {
  boot(): void;
  isRunning(): boolean;
  getPhase(): string;
  shutdown(): void;
  forceWorldTick(): any;
  registerAgent(agent: any): void;
  getAllAgents(): any[];
}

export interface RuntimeDebug {
  runtime: {
    getStats(): Record<string, any>;
  };
}

export interface AgentRuntimeInstance {
  initialize(): Promise<void>;
  assemble(userMsg: string, snapshot: any, agentId: string): Promise<string>;
  memory: RuntimeMemory | null;
  autonomous: AutonomousRuntime | null;
  debug: RuntimeDebug | null;
}

// ============================================================
// PersistenceManager
// ============================================================

export interface PersistenceManagerConfig {
  autoSaveIntervalMs: number;
  maxSaveFiles: number;
  includeDebugData: boolean;
  saveDir: string;
}

export interface PersistenceManagerInstance {
  attachRuntime(autonomous: AutonomousRuntime, debug: any): void;
  save(): any;
  startAutoSave(): void;
  stopAutoSave(): void;
}

// ============================================================
// AgentRuntimeState（单个 Agent 状态）
// ============================================================

export interface AgentRuntimeStateConstructor {
  new (id: string, name: string, location: string): any;
}

// ============================================================
// WorldStateRuntime（NPC 自主 Agent）
// ============================================================

export interface WorldStateRuntimeInstance {
  // 未使用时暂不定义详细接口
}

// ============================================================
// 适配器
// ============================================================

export interface RuntimeSnapshot {
  // 由 stateToRuntimeSnapshot 返回的结构
  [key: string]: any;
}

// ============================================================
// 模块导出接口
// ============================================================

export interface RuntimeModule {
  AgentRuntime: new (config: any) => AgentRuntimeInstance;
  PersistenceManager: new (config: PersistenceManagerConfig) => PersistenceManagerInstance;
}

export interface AutonomousModule {
  WorldStateRuntime: new () => WorldStateRuntimeInstance;
}

export interface AgentModule {
  AgentRuntimeState: AgentRuntimeStateConstructor;
}

export interface CompatModule {
  stateToRuntimeSnapshot(
    state: Record<string, any>,
    activeCardIds: string[],
    extra: any[]
  ): RuntimeSnapshot;
}
