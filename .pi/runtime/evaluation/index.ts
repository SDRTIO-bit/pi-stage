/**
 * Evaluation Module — Phase 3.5
 *
 * Runtime Validation & Telemetry
 *
 * 统一导出所有评估子系统。
 */

// ============================================================
// Drift Detector
// ============================================================
export { DriftDetector } from './drift-detector';
export type {
  DriftScore,
  DriftItem,
  DriftCheckpoint,
  DriftDimension,
  DriftDetectorConfig,
  DriftStrategy,
  DriftContext,
} from './drift-detector';
export {
  RoleDriftStrategy,
  StyleDriftStrategy,
  InstructionDriftStrategy,
  FormattingDriftStrategy,
} from './drift-detector';

// ============================================================
// Memory Evaluator
// ============================================================
export { MemoryEvaluator } from './memory-evaluator';
export type {
  MemoryEvalResult,
  MemoryEvalDetail,
  MemoryCheckpoint,
  MemoryEvaluatorConfig,
} from './memory-evaluator';

// ============================================================
// Attention Evaluator
// ============================================================
export { AttentionEvaluator } from './attention-evaluator';
export type {
  AttentionEvalResult,
  AttentionEvalDetail,
  AttentionCheckpoint,
  AttentionEvaluatorConfig,
} from './attention-evaluator';

// ============================================================
// Runtime Telemetry
// ============================================================
export { RuntimeTelemetry } from './runtime-telemetry';
export type {
  TelemetryRecord,
  TelemetryEventType,
  TelemetryData,
  TelemetrySnapshot,
  TimelineFrame,
  TokenUsageData,
  AttentionScoreData,
  MemoryRecallData,
  SalienceRankingData,
  GoalActivationData,
  SchedulerActivityData,
} from './runtime-telemetry';

// ============================================================
// Benchmark Runner
// ============================================================
export { BenchmarkRunner, DEFAULT_SCENARIOS } from './benchmark-runner';
export type {
  BenchmarkScenario,
  ScenarioSetup,
  BenchmarkResult,
  BenchmarkMetrics,
  ComparisonResult,
  BenchmarkRunnerConfig,
} from './benchmark-runner';

// ============================================================
// 默认场景列表（从 benchmark-runner 复用）
// ============================================================
// 默认场景通过 DEFAULT_SCENARIOS 导出
// 使用方式：import { DEFAULT_SCENARIOS } from './evaluation'
