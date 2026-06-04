# Skill 系统问题报告

**日期**: 2026-06-04
**状态**: 待决策

---

## 1. 当前架构

### 1.1 旧系统（已删除）

`.agents/skills/` — Claude Code agent 模板文件，与 RP 引擎无关，已全部删除（git status 标记 D）。

### 1.2 新系统

```
世界书条目 (.pi/cards/{name}/worldbook/)
  → Worldbook.loadFromFiles()  加载到内存
    → generateCardSkills()     拆分为 5 个 skill 文件
      → SkillCollector         读文件 → 5 个 PromptNode
        → ContextPipeline      collect → prioritize → schedule → render
          → 注入 system prompt → 发给 LLM
```

**5 个 skill 文件**（以「诡秘剧场」为例）：

| 文件 | 大小 | 分类来源 |
|------|------|----------|
| `00-core-rules.md` | 127 KB | 常开设定中的核心规则 |
| `judgment-system.md` | 114 KB | 判定系统、DC、骰子 |
| `variable-protocol.md` | 62 KB | 变量列表、更新规则、输出格式 |
| `style-protocol.md` | 44 KB | 格式要求、沉浸感叙事 |
| `world-context.md` | 30 KB | 世界观、物价、地理等 |
| **合计** | **~380 KB** (~190K tokens) | |

### 1.3 Pipeline 流程

```
Collectors (5 个同时运行):
  card-base          → 系统提示词          (优先级 0, L0)
  format-rules       → 格式规则            (优先级 2, L0)
  rp-skills          → 5 个 skill 文件     (优先级 3-8, L1) ← 380KB
  worldbook-trigger  → TF-IDF 触发条目      (优先级 15, L2) ← ≤3 条
  state-variables    → 角色状态变量         (优先级 90, L1)

Scheduler:
  target = 24,576 bytes (~12K tokens)
  hard   = 40,960 bytes (~20K tokens)

  380,000 bytes → 塞进 40,960 bytes 的预算
  → 所有 skill 节点被严重截断/丢弃
```

---

## 2. 核心问题

### 2.1 Budget 完全不匹配

5 个 skill 文件合计 380KB，pipeline 硬上限 40KB。

**调度器实际行为**：
- `00-core-rules.md` 127KB → 即使只保留这一个文件也超出预算 3 倍
- 按优先级排序后，调度器从优先级最低的开始填充
- 填到 budget hard 后，剩余全部标记为 dropped
- **AI 实际收到的 skill 内容可能只有几百字节的标头**

### 2.2 AI 缺上下文 → 读文件

因为 skill 内容被截断，AI 缺乏世界观信息，本能地使用 `ls`/`find`/`read` 探索项目目录。rpGuard 的"禁止读文件"是 prompt 层软约束，对抗 coding agent 的底层训练行为效果有限。

### 2.3 生成时机问题

`generateCardSkills()` 在 `ensureSession()` 中调用，每次首次激活生成。但 `worldbook.loadFromFiles()` 也在同一个函数中加载。生成后的 skill 文件是静态的快照，不会随世界书条目更新而自动刷新。

---

## 3. 可能的解决方向

### 方向 A：增大 Budget（最小改动）

将 `pipeline_hard` 从 40KB 提升到 80-120KB。

- **优点**：一行配置改动
- **缺点**：token 消耗急剧上升；LLM 上下文窗口压力大；只是推迟问题，不是解决问题

### 方向 B：Skill 分层注入（中等改动）

不再把所有 skill 作为 PromptNode 注入，改为：
- **L0（必入）**：核心规则摘要（从 00-core-rules 提取 ~2KB）
- **L1（按需）**：通过 `search_worldbook` 工具按需检索详细规则
- **L2（常驻）**：世界书常开设定留在 system prompt 底部

- **优点**：token 精准投放；AI 通过工具调用获取详细规则时更可能遵守
- **缺点**：需要提取摘要逻辑；AI 需要主动调工具

### 方向 C：Skill 不进 Pipeline，走 PI Agent 定义

利用 PI 的 agent 定义文件（`.pi/agents/rp.md`）或 PI memory 系统注入 skill 内容，绕过 pipeline budget。

- **优点**：pipeline 只负责动态内容（世界书触发 + 状态），静态规则由 PI 注入
- **缺点**：PI agent 文件有大小限制；与 pipeline 解耦可能造成两套注入逻辑

### 方向 D：世界书条目直接注入 + 弃用 Skill 文件

不生成独立的 skill 文件。常开设定条目直接作为 PromptNode 注入 pipeline，每条一个节点，让调度器按条目粒度决策。

- **优点**：调度粒度更细（每条 ~2KB 而不是一个文件 127KB）→ 更多条目能通过 budget
- **缺点**：放弃 skill 文件的组织结构；需要重写 collector 逻辑

---

## 4. 当前观测数据（待收集）

在决策前需要收集以下数据（通过 `scripts/analyze-snapshots.mjs`）：

- [ ] 每轮 rp-skills 节点实际字节数（截断前 vs 截断后）
- [ ] 哪些 skill 文件被完全 dropped，哪些保留
- [ ] skill 截断对 AI 回答质量的量化影响
- [ ] worldbook-trigger 的命中率和平均注入量

---

## 5. 建议

**短期（观测期内）**：不改变架构。手动调大 `pipeline_hard` 到 81920，跑 50-100 轮真实对话，收集快照数据。

**数据充分后**：方向 B（分层注入）最可行 — 投入适中，不破坏 pipeline 架构，利用已有的 `search_worldbook` 工具做按需检索。

**如果方向 B 不满足**：方向 D 是更彻底的方案，但需要重写 SkillCollector。
