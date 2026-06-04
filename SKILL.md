---
name: pi-rp-engine
description: LLM-neutral roleplay engine as pi.dev extension — context assembly, card management, worldbook → Skill compilation
version: 1.0.0
---

# PI RP Engine — pi.dev 扩展版

一个 pi.dev 扩展，提供角色扮演上下文装配、卡片管理、世界书→Skill 编译能力。
**引擎本身不调 LLM**，专注给 LLM 准备最优上下文。

## 安装

确保已安装 pi.dev (≥ v0.75)，然后在项目目录下：

```bash
# 1. 安装依赖
cd pi-rp-engine
npm install

# 2. 启动 pi.dev（自动加载 .pi/extensions/rp-engine/）
pi
```

## 工作原理

### 生命周期集成

```
pi.dev 事件                  pi-rp-engine 扩展
──────────────────────────────────────────────────
session:start     → 初始化 StateStore + Collector
input             → 装配上下文，注入 system prompt
before:agent:start → 注入编译好的 Skill 文件
turn:end          → Agent 管线 + 持久化 + 世界书→Skill
session:shutdown  → 持久化 + 清理
```

### 世界书→Skill 编译（核心创新）

常开设定不直接拼入 prompt，而是编译为 **pi.dev Skill 文件**：

```
世界书 [常开]设定/
├── 规则类 → .pi/skills/rp-engine/00-core-rules.md
├── 文风类 → .pi/skills/rp-engine/style-protocol.md
├── 判定类 → .pi/skills/rp-engine/judgment-system.md
└── 变量类 → .pi/skills/rp-engine/variable-protocol.md
```

每轮 `turn:end` 自动重新编译，`before:agent:start` 注入。LLM 以"技能"形式原生理解这些规则，而非被动接收数据文本。

## 可用工具

| 工具               | 触发方式     | 作用                             |
| ------------------ | ------------ | -------------------------------- |
| `read_state`       | LLM 自动调用 | 读取角色状态变量                 |
| `update_state`     | LLM 自动调用 | 更新角色状态（类型校验+钳制）    |
| `advance_time`     | LLM 自动调用 | 推进游戏内时间                   |
| `search_worldbook` | LLM 自动调用 | 按关键词搜索触发词条（兼容旧式） |

## 可用命令

| 命令                    | 作用                 |
| ----------------------- | -------------------- |
| `/card list`            | 列出所有已注册卡片   |
| `/card activate <id>`   | 激活卡片             |
| `/card deactivate <id>` | 停用卡片             |
| `/status`               | 查看引擎状态         |
| `/reset`                | 重置当前 session     |
| `/diag prompt`          | 查看上下文装配 trace |

## 角色扮演流程

每次用户发消息，pi.dev 自动执行以下步骤（无需手动操作）：

1. **input 事件** → 引擎装配上下文，注入 system prompt
2. **before:agent:start** → 注入世界书编译的 Skill 文件
3. **LLM 生成回复**（使用注入的上下文+技能）
4. **turn:end** → Agent 管线 + 状态持久化 + 世界书重新编译

引擎全程自动运行，无需手动调 HTTP API。

## 架构

```
用户 → pi.dev
         │
         ├─ 调 LLM（prompt = 引擎装配的上下文 + Skill 规则）
         │
         └─ pi-rp-engine 扩展（.pi/extensions/rp-engine/）
              ├─ lifecycle/     → session / input / turn 事件
              ├─ tools/         → read_state / update_state
              ├─ commands/      → /card / /status / /diag
              └─ skill-injector → 世界书→Skill 编译

引擎层不调 LLM，专注上下文装配 + 状态管理 + 世界书→Skill。
```
