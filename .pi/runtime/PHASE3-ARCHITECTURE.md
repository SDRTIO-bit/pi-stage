# Phase 3 — Autonomous Runtime 架构文档

> 最后更新: 2026-05-23

---

## 一、架构概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                    AgentRuntime (runtime/index.ts)                   │
│  入口: createRuntime() → getRuntime() → destroyRuntime()            │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────────┐   │
│  │ Context    │ │ Memory     │ │ EventBus   │ │ Autonomous     │   │
│  │ Assembly   │ │ Layer      │ │            │ │ Runtime        │   │
│  │ Engine     │ │            │ │            │ │ (可选挂载)      │   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────────┘   │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ DebugDashboard (可选挂载)                                      │   │
│  │ runtime · scheduler · agent · memory · attention 追踪器       │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 子系统分层

| 层 | 模块 | 路径 | 职责 |
|---|---|---|---|
| **Phase 1** | Context Assembly Engine | `context/` | 6 阶段装配管道、记忆检索、压缩、强化 |
| **Phase 2** | Attention Runtime | `attention/` | 注意力分层、衰减、显著性、Token Budget |
| **Phase 3** | Agent Subsystems | `agent/` | 需求/情绪/日程/意图/运行时 |
| **Phase 3** | Autonomous Core | `autonomous/` | 调度器/世界循环/Agent 循环/后台/持久化 |
| **Phase 3** | Debug System | `debug/` | 5 类追踪器 + DebugDashboard |

---

## 二、完整文件树

```
.pi/runtime/
├── index.ts                          # AgentRuntime 入口（统一导出）
├── PHASE3-ARCHITECTURE.md            # 本文档
│
├── agent/                            # Phase 3 — Agent 子系统
│   ├── agent-needs.ts                #   需求系统（6 种需求）
│   ├── agent-emotions.ts             #   情绪演算（PAD 三维模型）
│   ├── agent-schedule.ts             #   日程表（5 种类型）
│   ├── agent-intentions.ts           #   意图生成（11 种意图）
│   ├── agent-runtime.ts              #   Agent 运行时状态
│   └── goal-system.ts                #   目标系统（占位）
│
├── attention/                        # Phase 2 — 注意力运行时
│   ├── index.ts                      #   AttentionRuntime 入口
│   ├── attention-manager.ts          #   注意力管理器（L0-L7）
│   ├── token-budget.ts               #   Token 预算分配
│   ├── salience-engine.ts            #   显著性计算引擎
│   ├── instruction-reinforcement.ts  #   指令强化系统
│   └── context-decay.ts              #   上下文衰减模型
│
├── autonomous/                       # Phase 3 — Autonomous Runtime 核心
│   ├── index.ts                      #   模块统一导出
│   ├── runtime-core.ts               #   AutonomousRuntime 核心入口
│   ├── scheduler.ts                  #   运行时调度器
│   ├── task-queue.ts                 #   任务队列
│   ├── world-state.ts                #   世界状态运行时
│   ├── world-loop.ts                 #   世界主循环
│   ├── agent-loop.ts                 #   Agent 自主循环
│   ├── background-runtime.ts         #   后台 Runtime
│   └── persistence.ts                #   持久化模块
│
├── compat/                           # Phase 1 — 兼容适配
│   └── runtime-adapter.ts            #   旧 state ↔ Runtime 适配
│
├── context/                          # Phase 1 — 上下文装配引擎
│   ├── index.ts                      #   ContextAssemblyEngine 入口
│   ├── context-controller.ts         #   上下文控制器
│   ├── priority-layer.ts             #   优先级层
│   ├── active-memory.ts              #   主动记忆检索
│   ├── compression-engine.ts         #   多层压缩引擎
│   ├── pipeline-executor.ts          #   6 阶段管道执行器
│   └── reinforcement-layer.ts        #   指令强化层
│
├── debug/                            # Phase 3 — 调试系统
│   ├── index.ts                      #   DebugDashboard 入口
│   ├── runtime-trace.ts              #   Runtime 生命周期追踪
│   ├── scheduler-trace.ts            #   调度器追踪
│   ├── agent-trace.ts                #   Agent 行为追踪
│   ├── memory-trace.ts               #   记忆系统追踪
│   └── attention-trace.ts            #   注意力系统追踪
│
├── events/
│   └── event-bus.ts                  # 事件总线
│
├── knowledge/
│   └── knowledge-layer.ts            # 知识层（占位）
│
└── memory/
    └── memory-layer.ts               # 三层记忆存储
```

---

## 三、数据流

### 3.1 Autonomous Runtime 生命周期

```
runtime_boot
    │
    ▼
world_tick ────────────────────────────────────────┐
    │                                                │
    ▼                                                │
scheduler_tick (调度 tick 类型)                       │
    │                                                │
    ├── agent_tick → 所有 Agent 逐一轮询             │
    │   ├── 需求增长                                  │
    │   ├── 情绪衰减                                  │
    │   ├── 日程推进                                  │
    │   ├── 意图生成（需求/事件/目标/关系 驱动）      │
    │   └── 目标评估                                  │
    │                                                │
    ├── memory_tick → 记忆衰减/压缩/归档              │
    ├── goal_tick → 目标进度更新                      │
    ├── event_dispatch → 世界事件阶段推进             │
    └── background_update → 环境状态更新              │
                                                        │
    ▼                                                  │
context_assembly ────────────────────────────────────┘
    │  (用户交互时才触发)
    ▼
response_generation
    │
    ▼
runtime_persist (定时自动保存)
```

### 3.2 Trace 注入路径

```
AgentRuntime.createRuntime()
    │
    ├── create AutonomousRuntime ───→ 自动桥接 runtime:* 事件到 RuntimeTracer
    ├── create DebugDashboard
    │   ├── RuntimeTracer    ← 监听 runtime:* 事件
    │   ├── SchedulerTracer  ← 监听 scheduler:* 事件
    │   ├── AgentTracer      ← 监听 agent:* 事件
    │   ├── MemoryTracer     ← 注入 MemoryLayer
    │   └── AttentionTracer  ← 注入 ContextAssemblyEngine
    │
    └── create ContextAssemblyEngine ← 传入 attentionTracer + memoryTracer
            │
            ├── PipelineExecutor
            │   ├── collect   → memoryTracer.memoryRetrieved
            │   ├── compress  → memoryTracer.memoryCompressed
            │   ├── reinforce → attentionTracer.instructionReinforced
            │   └── render    → attentionTracer.instructionReinforced
            │
            └── assemble()
                ├── attentionManager.tick() 前后对比 → attentionTracer.attentionScored/Decayed
                └── reinforce() → attentionTracer.instructionReinforced
```

---

## 四、核心类参考

### 4.1 AgentRuntime (runtime/index.ts)

```typescript
class AgentRuntime {
  constructor(config: RuntimeConfig);
  assemble(userMessage, runtimeState, agentId): Promise<string>;
  attachAutonomous(autonomous: AutonomousRuntime): void;
  getFullStatus(): RuntimeFullStatus;
  getAutonomousStatus(): AutonomousRuntimeSnapshot | null;
  getDebugSummary(): string;
  recordUserInteraction(type, content): void;
  destroy(): void;
}
```

### 4.2 AutonomousRuntime (autonomous/runtime-core.ts)

```typescript
class AutonomousRuntime {
  constructor(config: AutonomousRuntimeConfig);
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  pause(): void;
  resume(): void;
  getSnapshot(): AutonomousRuntimeSnapshot;
  getWorldState(): WorldStateRuntime;
  getScheduler(): Scheduler;
  getAgentLoop(): AgentLoop;
  getBackground(): BackgroundRuntime;
}
```

### 4.3 PersistenceManager (autonomous/persistence.ts)

```typescript
class PersistenceManager {
  constructor(config?: Partial<PersistenceConfig>);
  attachRuntime(runtime: AutonomousRuntime, debug?: DebugDashboard): void;
  startAutoSave(): void;
  stopAutoSave(): void;
  save(): Promise<PersistentRuntimeData>;
  load(data: PersistentRuntimeData): Promise<boolean>;
  restoreToRuntime(data: PersistentRuntimeData, runtime: AutonomousRuntime): Promise<void>;
  getStats(): PersistenceStats;
  formatSnapshot(data: PersistentRuntimeData): string;
  getCurrentData(): PersistentRuntimeData | null;
  destroy(): void;
}
```

### 4.4 DebugDashboard (debug/index.ts)

```typescript
class DebugDashboard {
  readonly runtime: RuntimeTracer;
  readonly scheduler: SchedulerTracer;
  readonly agent: AgentTracer;
  readonly memory: MemoryTracer;
  readonly attention: AttentionTracer;
  getFullSummary(): DebugSummary;
  getAgentSummary(agentId: string): string;
  searchAll(query: string): any[];
  clearAll(): void;
  exportAll(): DebugExport;
}
```

---

## 五、Trace 注入点完整清单

### AttentionRuntime (attention/index.ts)
- `tick()`: salienceInjected → attentionScored → attentionDecayed → budgetAllocated → decisionMade
- `reinforce()`: instructionReinforced
- `attachTracer()`: 运行中注入

### ContextAssemblyEngine (context/index.ts)
- `assemble()`: attentionManager.tick() 前后对比 → attentionDecayed
- `attachTracers()`: 运行中注入 attention + memory

### PipelineExecutor (context/pipeline-executor.ts)
- `collect` 阶段: memoryTracer.memoryRetrieved
- `compress` 阶段: memoryTracer.memoryCompressed
- `reinforce` 阶段: attentionTracer.instructionReinforced
- `render` 阶段: attentionTracer.instructionReinforced
- `attachTracers()`: 运行中注入

### AgentRuntime (runtime/index.ts)
- `createRuntime()`: DebugDashboard 自动创建 + tracer 注入 ContextAssemblyEngine
- `attachAutonomous()`: AutonomousRuntime 事件自动桥接 → RuntimeTracer
- `recordUserInteraction()`: → RuntimeTracer

---

## 六、持久化方案

### 数据结构

```typescript
interface PersistentRuntimeData {
  version: string;        // "1.0"
  savedAt: number;        // 时间戳
  totalGameMinutes: number;
  gameDay: number;
  worldState: {           // 环境快照
    season: string;
    weather: string;
    day: number;
    timeOfDay: string;
    lightLevel: string;
    totalGameMinutes: number;
  };
  agents: AgentRuntimeStateSnapshot[];  // Agent 状态快照
  scheduler: {           // 调度器暂停状态
    paused: boolean;
    tickCounts: Record<string, number>;
  };
  backgroundMode: string;
  backgroundTicks: number;
  debugData?: DebugExport;  // 可选
}
```

### 存储策略
- 自动保存间隔：5 分钟（可配置）
- 循环覆盖：最多保留 10 个文件
- 保存目录：`.pi/runtime/saves/`（可配置）
- PersistenceManager 自身不处理文件 IO——外部存储实现通过 `getCurrentData()` 获取数据

---

## 七、配置项

```typescript
interface RuntimeConfig {
  enableAutonomous?: boolean;          // 是否启用 Autonomous Runtime
  modelMaxTokens: number;
  safetyMargin?: number;               // 默认 4000
  
  autonomousConfig?: {
    worldTickInterval?: number;        // ms，默认 1000
    agentTickInterval?: number;        // ms，默认 2000
    backgroundTickInterval?: number;   // ms，默认 500
    autoSaveInterval?: number;         // ms，默认 300000 (5min)
    idleThreshold?: number;            // 分钟，默认 30
    maxRuntimeMinutes?: number;        // 最大运行时间
  };
}
```

---

## 八、Phase 3.5 — Runtime Validation & Telemetry

### 8.1 定位

在 Phase 3 Runtime 引擎基础上建立**可量化的质量评估体系**，解决"换了引擎感觉好没好的问题"。

### 8.2 目录结构

```
evaluation/
├── index.ts                   # 统一导出入口
├── drift-detector.ts          # 漂移检测（4 种策略）
├── memory-evaluator.ts        # 记忆质量评估（4 项指标）
├── attention-evaluator.ts     # 注意力评估（4 项指标）
├── runtime-telemetry.ts       # 运行时遥测（6 类事件）
├── benchmark-runner.ts        # 基准测试（6 场景，Legacy vs Runtime）
└── __test__.mjs               # 冒烟测试
```

### 8.3 设计原则

1. **模块独立性**：所有 evaluation 模块使用内联类型定义，不依赖运行时模块的具体实现
2. **可组合**：BenchmarkRunner 聚合 4 个子评估模块的结果
3. **可对比**：Legacy vs Runtime 双模式运行，输出 deltas + winner
4. **可观测**：RuntimeTelemetry 提供完整时间轴回放

### 8.4 模块详情

#### DriftDetector

策略模式实现 4 种漂移检测：

| 策略 | 检测目标 | 算法 |
|------|----------|------|
| RoleDriftStrategy | 角色一致性 | 关键词覆盖 + N-gram 余弦相似度 |
| StyleDriftStrategy | 语气风格 | 标点/句子长度分布 + 语气词频率 |
| InstructionDriftStrategy | 指令遵守 | 关键词覆盖率 |
| FormattingStrategy | 格式遵守 | 结构标记完整性 |

支持滑动窗口（默认 5 轮）和告警阈值（>0.6）。

#### MemoryEvaluator

4 项记忆质量指标：

| 指标 | 计算方式 |
|------|----------|
| precision | 召回记忆中与 groundTruth 匹配的比例 |
| relevance | 召回记忆的平均相关性分数 |
| hallucinationRate | 召回记忆中与 criticalMemories 冲突的比例 |
| persistence | 跨轮次一致保留的关键记忆比例 |

#### AttentionEvaluator

4 项注意力指标：

| 指标 | 计算方式 |
|------|----------|
| tokenAllocEffectiveness | 实际分配 vs 期望权重的 KL 散度倒数 |
| reinforceEffectiveness | 各层注意力变化幅度（before vs after） |
| contextSaturation | 实际 Token 用量 / 预算上限 |
| instructionPreservation | 跨轮次指令关键词保持率 |

#### RuntimeTelemetry

6 种遥测事件 + 时间轴回放：

- `token_usage` — 每次上下文装配的 Token 消耗
- `attention_score` — 注意力分配快照
- `memory_recall` — 记忆查询结果
- `salience_ranking` — 显著性排序
- `goal_activation` — Agent 目标激活
- `scheduler_activity` — 调度器 Tick

#### BenchmarkRunner

6 个预设 Benchmark 场景：

| 场景 | 描述 | 轮数 |
|------|------|------|
| short_context | 短上下文稳定性 | 5 |
| medium_context | 中等上下文质量保持 | 15 |
| long_context | 长上下文抗漂移 | 40 |
| xlong_context | 超长上下文极限 | 60 |
| worldbook_heavy | 世界书密集场景 | 15 |
| multi_char | 多角色互动 | 20 |

每条场景包含完整剧本（用户输入 + 期望回复特征），双模式运行后 `compare()` 输出 deltas 和 winner，`generateReport()` 输出可读报告。

### 8.5 类型检查与测试

- 所有 6 个 .ts 文件通过 `tsc --noEmit --strict`（0 错误）
- 冒烟测试覆盖独立模块的核心逻辑
- Runtime 占比：2,205 行 / 14,495 行（15.2%）

### 8.6 使用方式

```typescript
import { DriftDetector, MemoryEvaluator, BenchmarkRunner, DEFAULT_SCENARIOS } from './evaluation/index.js';

const runner = new BenchmarkRunner();
const report = await runner.generateReport();
console.log(report);
```

---

## 九、已修复的问题清单

| 问题 | 文件 | 修复 |
|---|---|---|
| `ReinforceResult` 类型缺失 | `attention/instruction-reinforcement.ts` | 新增接口定义 |
| `DecayDecision` 类型缺失 | `attention/context-decay.ts` | 新增接口定义，`DecayResult` 增加 `decision?` |
| `budgetAllocated()` 参数类型不匹配 | `attention/index.ts` | Map→Array 转换 |
| `decisionMade()` 迭代类型错误 | `attention/index.ts` | `Object.entries`→直接访问 `entryId`/`decision` |
| `PipelineExecutor` 缺少 tracer 注入 | `context/pipeline-executor.ts` | 构造函数 + `attachTracers()` + 各阶段 trace |
| `buildContextEngine()` 未传入 tracer | `runtime/index.ts` | 传入 `debug?.attention` 和 `debug?.memory` |
| `PersistenceManager` 缺少导出 | `autonomous/index.ts`、`runtime/index.ts` | 添加导出 |
| `addRule()`/`addRules()` 方法缺失 | `attention/instruction-reinforcement.ts` | 新增 |
| 括号不平衡 | 全局 | 逐文件验证通过 |
