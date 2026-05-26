/**
 * autonomous/index.ts - Autonomous Runtime 统一导出
 *
 * Phase 3 的核心：世界独立于用户输入持续运行。
 *
 * 导出：
 * - AutonomousRuntime（主入口）
 * - Scheduler（任务调度器）
 * - WorldLoop（世界循环）
 * - AgentLoop（Agent 循环）
 * - BackgroundRuntime（后台运行时）
 * - WorldStateRuntime（世界状态）
 * - TaskQueue（任务队列）
 *
 * 与 Phase 1/2 的整合点在 runtime-core.ts
 */

export { AutonomousRuntime, default as RuntimeCore } from './runtime-core';
export type {
  AutonomousRuntimeConfig,
  AutonomousRuntimeSnapshot,
  RuntimePhase,
} from './runtime-core';

export { Scheduler, default as SchedulerEngine } from './scheduler';
export type {
  TickType,
  TickTask,
  ScheduledTask,
  SchedulerConfig,
  SchedulerState,
  SchedulerLogEntry,
} from './scheduler';

export { WorldLoop, default as WorldLoopEngine } from './world-loop';
export type {
  WorldSpeed,
  WorldLoopConfig,
  WorldTickResult,
} from './world-loop';

export { AgentLoop, default as AgentLoopEngine } from './agent-loop';
export type { AgentLoopConfig } from './agent-loop';

export { BackgroundRuntime, default as BackgroundEngine } from './background-runtime';
export type {
  BackgroundMode,
  BackgroundRuntimeConfig,
  BackgroundTickEvent,
  BackgroundStats,
} from './background-runtime';

export { WorldStateRuntime, default as WorldStateEngine } from './world-state';
export type {
  WorldLocation,
  WorldFaction,
  WorldEvent,
  WorldEventStatus,
  WorldEventScale,
  EventStage,
  EventConsequence,
  EnvironmentState,
  WorldStateSnapshot,
  EnvironmentChange,
  WorldEventProcessResult,
} from './world-state';

export { TaskQueue, default as TaskQueueEngine } from './task-queue';
export type {
  QueueTask,
  TaskStatus,
  QueueStats,
} from './task-queue';

export { PersistenceManager, RuntimeSnapshotBuilder, RuntimeRestorer } from './persistence';
export type {
  PersistentRuntimeData,
  PersistenceConfig,
} from './persistence';
