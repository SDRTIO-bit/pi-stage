# Attention Runtime - Phase 2

## 核心哲学

Context 不再平权。Token = attention resource。

Phase 1 实现了"上下文动态装配"（collect → compress → assemble）。
Phase 2 实现了"注意力管理运行时"（score → prioritize → reinforce → budget → decay）。

## 目录结构

```
.pi/runtime/attention/
├── README.md                          # 本文件
├── index.ts                           # 统一导出 + AttentionRuntime 高级接口
├── attention-manager.ts               # 核心运行时注意力管理器
├── token-budget.ts                    # Token 预算运行时
├── salience-engine.ts                 # 显著性计算引擎
├── instruction-reinforcement.ts       # 指令强化系统
└── context-decay.ts                   # 上下文衰减模型
```

## 架构设计

### 数据流

```
每轮开始
    │
    ▼
SalienceEngine.score()
  - 对记忆条目按 8 个维度评分
  - 输出: SalienceSignals (情绪/目标加成)
    │
    ▼
AttentionManager.tick(signals)
  - 基础衰减 (L0-L7 各有衰减率)
  - 显著性注入 (情绪/目标加成)
  - 近因校正
  - 强化保护 (被保护层只升不降)
    │
    ▼
TokenBudget.allocate()
  - 硬性保底 (L0 优先)
  - 按注意力加权分配
  - 溢出处理 (削低优保高优)
  - 压缩回退检测
    │
    ▼
ContextDecay.evaluateBatch()
  - 时间衰减 (半衰期模型)
  - 叙事衰减 (弧关闭后加速)
  - 情感持久性 (高情绪衰减慢)
  - 目标持久性 (目标相关衰减慢)
  - 强化保护 (强化后保护 N 轮)
  - 输出: keep_full / keep_summary / move_to_long_term / archive
    │
    ▼
InstructionReinforcement.reinforce(prompt)
  - 检查需要强化的规则 (间隔/阈值/快速衰减)
  - 语义变体选择 (避免重复)
  - 注意力锚定注入 (⚠️ 标记)
  - 自适应频率 (衰减越快 → 强化越频繁)
    │
    ▼
渲染输出
```

### 注意力分层 (L0-L7)

| 层 | 名称 | 基础权重 | 衰减率 | 强化间隔 | 情感加持 | 目标加持 |
|----|------|---------|--------|---------|---------|---------|
| L0 | hard_rules | 10% | 0.0 | 15 | ❌ | ❌ |
| L1 | current_goals | 8% | 0.1 | 12 | ❌ | ✅ |
| L2 | current_scene | 12% | 0.1 | 8 | ✅ | ✅ |
| L3 | working_memory | 15% | 0.2 | 0 | ✅ | ✅ |
| L4 | short_term_memory | 20% | 0.25 | 0 | ✅ | ✅ |
| L5 | active_knowledge | 15% | 0.15 | 10 | ❌ | ✅ |
| L6 | long_term_memory | 12% | 0.35 | 0 | ✅ | ✅ |
| L7 | history_summary | 8% | 0.4 | 0 | ❌ | ❌ |

### 显著性评分维度 (SalienceEngine)

| 维度 | 权重 | 描述 |
|------|------|------|
| emotional | 15% | 情感效价绝对值 × 情感强度，带时间衰减 |
| relation | 15% | 涉及活跃角色的比例，多角色事件加成 |
| goal | 20% | 内容匹配当前活跃目标，冲突事件加成 |
| conflict | 10% | 冲突标记，多角色冲突升级 |
| narrative | 10% | 叙事转折点标记，高情绪转折加成 |
| repetition | 10% | 被提及频率（log 曲线） |
| location | 10% | 地点匹配度，同区域/同类型 |
| event | 10% | 事件匹配度，事件链关联 |

### Token Budget 分配策略

```
总预算 = modelMaxTokens - safetyMargin

阶段1: 硬性保底（L0 获取 hardReserve token）
阶段2: 按权重 × 当前注意力 加权分配
阶段3: 检查总和不溢出
阶段4: 溢出处理（从低优层削起，确保 L0/L1 不受影响）
阶段5: 压缩回退检测（利用率 > 100% 时触发）
```

### 衰减模型 (ContextDecay)

```
综合保留率 = 时间保留 × 叙事保留 + 情感加成 + 目标加成 + 强化加成

时间保留 = minRetention + (1 - minRetention) × 0.5^(time / halfLife)
叙事保留 = 弧关闭? (1 - 0.5) : 0.9
情感加成 = 强度 > 阈值? 强度 × 0.5 : 0
目标加成 = 相关性 > 阈值? 相关性 × 0.4 : 0
强化加成 = 在保护期内? 0.95 : 0

决策（基于保留率 × 当前注意力）:
  ≥ 0.7 → keep_full
  ≥ 0.4 → keep_summary
  ≥ 0.2 → move_to_long_term
  < 0.2 → archive
```

## 与 Phase 1 的整合

### 管道升级

```
Phase 1 管道:
  collect → prioritize → compress → assemble → reinforce → render

Phase 2 管道（升级后）:
  collect → score → prioritize → reinforce → budget → compress → decay → assemble → inject
```

### 整合方案

1. `AttentionManager` 替代 Phase 1 的 `priority-layer.ts` 中的 `AttentionManager`（提供了更多功能如 salience 注入、近因校正、强化保护）
2. `TokenBudget` 替代 `priority-layer.ts` 中的 `BudgetCalculator`（提供了动态分配 + 溢出处理 + 压缩回退）
3. `SalienceEngine` 弥补 Phase 1 缺失的显著性计算（替代简单的关键词匹配）
4. `InstructionReinforcement` 替代 Phase 1 的 `reinforcement-layer.ts`（提供了语义变体 + 注意力锚定 + 自适应频率）
5. `ContextDecay` 弥补 Phase 1 缺失的衰减模型（替代单一时间衰减率）

### 集成进现有管道的过渡方案

```
方式A: 逐步替换（推荐）
  Phase 2.1: SalienceEngine → ActiveMemoryRetriever.scoreAndSort 替换
  Phase 2.2: TokenBudget → BudgetCalculator 替换
  Phase 2.3: InstructionReinforcement → ReinforcementLayer 替换
  Phase 2.4: ContextDecay 作为 CompressStage 的前置阶段

方式B: 整体替换
  Phase 2 的 AttentionRuntime 作为独立调度器
  pipeline-executor 的 execute() 内部调用 AttentionRuntime.tick()
  作为 collect 阶段的前置预处理
```

## 与 Context Assembly Engine 的整合

Context Assembly Engine (`context/index.ts`) 的 `pipeline-executor.ts` 在 Phase 2 中可以升级为：

```typescript
// Phase 2 升级后的管道执行
async execute(...): Promise<AssembledContext> {
  // 0. 前置注意力预处理
  const attentionResult = attentionRuntime.tick(memories, context);

  // 1. 收集 (collect) - 使用 attention 过滤
  const segments = await collect(input, attentionResult);

  // 2. 评分 (score) - 使用 salience 重排序
  const scored = salienceEngine.score(memories, context);

  // 3. 优先排序 (prioritize) - 使用 attention 加权
  const prioritized = prioritize(segments, attentionResult);

  // 4. 强化 (reinforce) - 注入需要强化的规则
  const reinforced = instructionReinforcement.reinforce(prioritized);

  // 5. 预算 (budget) - 动态分配 token
  const budgeted = applyBudget(reinforced, attentionResult.budget);

  // 6. 压缩 (compress) - 使用 decay 结果决定压缩策略
  const compressed = compress(budgeted, attentionResult.decayResults);

  // 7. 衰减 (decay) - 标记需要归档的内容
  const decayed = applyDecay(compressed);

  // 8. 装配 (assemble) - 最终组装
  const assembled = assemble(decayed);

  // 9. 注入 (inject) - 最终强化注入
  return instructionReinforcement.reinforce(assembled);
}
```

## 后续可扩展路线 (Phase 3+)

1. **情绪记忆轨迹**：跟踪角色间情绪变化曲线（不只是单点情感效价）
2. **叙事弧检测**：自动识别叙事弧的开始/结束/转折点
3. **角色知识图谱**：基于关系的知识图谱，替代简单的关键词匹配
4. **多 Agent 注意力共享**：多个 Agent 之间的注意力状态同步
5. **注意力可视化工具**：实时调试界面显示各层的注意力/预算/衰减
6. **学习型衰减参数**：基于用户反馈自动调整衰减率和权重
7. **长上下文桥接**：在 context window 边界处自动生成摘要桥接
8. **记忆 Consolidation**：从短期到长期的自动 consolidate 引擎
