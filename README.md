<h1 align="center">🎭 RP Engine · 角色扮演引擎</h1>

<p align="center">
  <strong>基于 pi coding agent 的通用角色扮演引擎</strong>
  <br/>
  多卡片并发 · 多角色状态追踪 · 实时 Web 前端 · SillyTavern 角色卡导入
  <br/><br/>
  <img src="https://img.shields.io/badge/pi-v0.75%2B-blue" alt="pi">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="node">
  <img src="https://img.shields.io/badge/version-v3-red" alt="v3">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="license">
</p>

---

> **⚠️ 声明**：本项目为个人学习/测试用途，基于 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 构建。

## 📖 项目简介

RP Engine 是一个运行在 pi coding agent 之上的**通用角色扮演引擎**。不绑定特定世界观——你可以导入任意 SillyTavern 格式的角色卡来扮演。

---

## 🎯 核心架构：双 Agent 叙事引擎

RP Engine v3 的核心是一套**双 Agent 协同时序架构**，将"世界推演"与"叙事生成"分离为两个独立层，通过延迟一轮的舞台指示机制协作：

```
  turn_end                             下一轮 input                        下一轮 agent
     │                                      │                                  │
     ▼                                      ▼                                  ▼
┌─────────────┐                    ┌──────────────┐                  ┌──────────────────┐
│  World Agent │── 并行 4 路 ──→   │  input.ts     │── 拼入 ──→      │ Narrative Agent  │
│  (规则驱动)   │  事件生成          │  上下文舞台指示  │  用户消息前缀     │  (LLM 驱动)       │
│              │ 场景转折检测        │               │                  │  生成叙事内容      │
│              │ round_summary      │  状态摘要      │                  │  角色对话          │
│              │                    │  世界动态      │                  │  场景描写          │
│              │                    │  记忆检索      │                  │  情感表达          │
└──────┬───────┘                    └──────────────┘                  └──────────────────┘
       │                                      ▲
       │    ┌──────────────────┐              │
       └───→│  SceneScheduler  │── 场景名 ────┘
            │  ("导演")         │  切换冷却
            │  地点提取          │  情感阶段
            └──────────────────┘
```

### 三个角色

| 角色 | 实现 | 驱动方式 | 职责 |
|------|------|----------|------|
| **World Agent** | `prototypes/world-agent.ts` | 规则驱动（4 路并行） | 每轮推演环境/剧情/角色事件，检测场景转折，生成 round_summary |
| **SceneScheduler** | `prototypes/scene-scheduler.ts` | 规则驱动 | 场景生命周期管理，40+ 地点词 + 15 情感阶段自动命名，强制 3 轮切换冷却 |
| **Narrative Agent** | pi agent 主模型（LLM） | LLM 驱动 | 消费舞台指示，生成隐式融合 4 维度叙事（心理/身体/环境/对话） |

### 时序

1. **第 N 轮 turn_end** → World Agent 并行推演，事件存入 MemoryStore，场景转折检测结果写入
2. **第 N+1 轮 input** → input.ts 读取 MemoryStore + SceneScheduler，拼装舞台指示到用户消息前
3. **第 N+1 轮 agent** → Narrative Agent（AI 模型）感知舞台指示，生成包含 4 维度的叙事回复

这种"延迟一轮"的设计保证了 World Agent 的事件总在下一轮被 AI 感知，推演不会干扰当前轮的对话流。同时 World Agent 为纯规则驱动，零 LLM 调用开销。

---

### v3 核心特性

| 特性 | 说明 |
|------|------|
| **多卡片并发** | 同时激活多张角色卡，支持跨世界融合叙事 |
| **SillyTavern 兼容** | 支持 V2/V3 PNG 角色卡和 JSON 导出格式导入 |
| **隐式融合写作** | 4 维度叙事（心理/身体/环境/对话）自然融入行文，无标记符号 |
| **场景调度器** | 规则驱动的场景生命周期管理，40+ 地点词 + 15 情感阶段自动命名 |
| **World Agent** | 每轮并行推演：事件生成 + 场景转折检测 + round_summary 持久化 |
| **MemoryStore** | 3 层记忆架构（event / summary / global），自动检索与持久化 |
| **上下文舞台指示** | input 事件在用户消息前拼入状态摘要 + 世界动态 + 场景上下文 |
| **卡片完全隔离** | 状态、世界书、正则脚本、session 历史均按卡片独立 |
| **动态变量系统** | Zod Schema 提取 → 类型校验 → 值域钳制 → state.json 持久化 |
| **正则全链路** | 引擎层 prompt 剥离 + 前端 display 替换，WebSocket 下发 |
| **世界书注入** | 关键词匹配 + Token 预算 1500 + 去重 + 优先级排序，每 3 轮触发 |
| **场景切换冷却** | 规则路径 + 调度器路径均强制 3 轮冷却，避免频繁切景 |
| **state.json 只读模板** | 卡片模板永不被覆盖，动态数据通过 session 快照持久化 |
| **用户轮数计数** | 基于 turn_end 精确统计用户交互次数，不受 steer 污染 |

---

## 🚀 快速开始

```bash
# 1. 进入项目
cd your-project

# 2. 安装依赖
npm install

# 3. 导入角色卡（SillyTavern PNG/JSON）
node setup.mjs --character path/to/character.png

# 4. 启动 pi
pi

# 5. 浏览器打开 http://localhost:3012
```

---

## 📇 角色卡管理

### 导入角色卡

```bash
node setup.mjs --character path/to/character.png
node setup.mjs --character path/to/card.png --target ./my-cards
node setup.mjs --scan
```

每张卡片生成独立目录 `.pi/cards/<卡名>/`：

```
.pi/cards/<卡名>/
├── worldbook/               # 角色描述 + character_book 条目
├── state.json               # ⭐ 只读模板（永不覆盖）
├── config.json              # 卡片配置
├── APPEND_SYSTEM.md          # 常驻风格规范
├── regex_hooks.json         # 渲染钩子
└── variable_schema.json     # 角色变量定义
```

### 卡片命令

| 命令 | 说明 |
|------|------|
| `/card list` | 列出所有已导入卡片 |
| `/card activate <id>` | 激活卡片（支持多张并发） |
| `/card deactivate <id>` | 休眠卡片 |
| `/card set <id>` | 仅激活单张（清空其他） |
| `/reset` | 从卡片模板重置所有角色数值到初始状态 |
| `/status` | TUI 状态面板 |
| `/history <角色名>` | 查看角色数值变更历史 |
| `/route [路线]` | 选择/查看剧情路线 |
| `/rp` | 帮助 |

---

## 🏗️ 项目结构 (v3)

```
├── .pi/
│   ├── settings.json               # pi 设置
│   ├── APPEND_SYSTEM.md            # 常驻风格规范（前端附加）
│   ├── state.json                  # 运行时状态
│   ├── state_history.jsonl         # 状态变更历史
│   ├── sessions/                   # 对话记录（按卡片隔离）
│   ├── cards/                      # 📇 角色卡仓库
│   │   ├── registry.json           #   卡片注册表
│   │   └── <卡名>/                 #   单张卡片目录
│   ├── extensions/
│   │   ├── rp-engine/              # 🔧 引擎模块
│   │   │   ├── index.ts              # 入口 + 事件注册
│   │   │   ├── lifecycle/            # 生命周期：input / turn / message / before-agent / session
│   │   │   │   ├── input.ts          #   ⭐ 上下文舞台指示（状态摘要 + World Agent + 世界书）
│   │   │   │   ├── turn.ts           #   场景切换冷却 + generateSceneName + MemoryStore 记录
│   │   │   │   ├── message.ts        #   正则钩子（prompt 剥离 + display 替换）
│   │   │   │   ├── before-agent.ts   #   system prompt 装配（含隐式 4 通道叙事要求）
│   │   │   │   ├── session.ts        #   session 持久化
│   │   │   │   └── tool-events.ts    #   工具调用事件
│   │   │   ├── prototypes/           # ⭐ 原型模块
│   │   │   │   ├── scene-scheduler.ts #   场景调度器（地点/情感命名 + 切换冷却）
│   │   │   │   ├── world-agent.ts     #   World Agent（事件推演 + 场景转折检测）
│   │   │   │   └── memory-store.ts    #   3 层记忆存储
│   │   │   ├── tavern-runner.ts      # SillyTavern JS 兼容层
│   │   │   ├── runtime-integration.ts # Runtime 桥接
│   │   │   ├── card-manager.ts       # 卡片管理
│   │   │   ├── commands.ts           # 命令系统
│   │   │   ├── config.ts             # 配置类型
│   │   │   ├── state-store.ts        # 状态管理
│   │   │   ├── system-prompt.ts      # 系统提示词
│   │   │   ├── worldbook.ts          # 世界书搜索注入
│   │   │   ├── regex-processor.ts    # 正则编译器
│   │   │   ├── tools.ts              # AI 工具定义
│   │   │   ├── utils/                # json-patch / vector-search / session-cleanup
│   │   │   └── persistence/          # 持久化扩展
│   │   └── rp-web/                 # 🌐 前端界面
│   │       ├── rp-web-app.js          # 主应用逻辑
│   │       ├── rp-web-message-renderer.js # 4 通道格式渲染（含副视角折叠）
│   │       ├── rp-web-style.css       # 4 通道 + 副视角 + 选项按钮样式
│   │       ├── rp-web-xml.js          # 结构化 XML 解析
│   │       └── ...
│   ├── runtime/                    # ⚙️ Runtime Engine (Phase 3)
│   │   ├── agent/
│   │   ├── attention/
│   │   ├── autonomous/
│   │   ├── context/
│   │   ├── debug/
│   │   └── evaluation/
│   └── skills/rp/SKILL.md          # RP Skill 指令
├── setup.mjs                       # ⭐ 导入/注册/切换卡片脚本
├── tsconfig.json
├── tsconfig.rp-engine.json
├── 项目部署.bat
├── .rpconfig.json                  # 运行时配置
└── README.md
```

---

## 📡 核心功能

### 角色状态系统

| 属性 | 范围 | 说明 |
|------|------|------|
| 归属值 | 0~100 | 角色对玩家的情感偏向 |
| 情分值 | 0~100 | 自动同步 = 100 - 归属值 |
| 背德值/欲望值 | 0~200 | 卡片自定义数值，分阶段驱动角色行为 |
| 生理状态 | 动态 | 生理期、安全期、怀孕状态追踪 |
| 特殊事件 | 布尔 | 花开蒂落、告白、结婚等里程碑标记 |

### AI 工具（4 个）

| 工具 | 功能 |
|------|------|
| `read_state` | 读取角色当前状态 |
| `update_state` | 更新归属值/背德值/欲望值/内心想法等 |
| `advance_time` | 推进游戏天数 |
| `load_worldbook` | 按关键词加载世界书条目 |

### v3 新增机制

| 机制 | 说明 |
|------|------|
| **隐式融合写作** | 心理/身体/环境/对话 4 维度无标记融入叙事，system prompt 自然约束 |
| **input.ts 上下文舞台指示** | 每轮在用户消息前拼状态摘要 + World Agent 场景描述 + 记忆检索结果 |
| **场景调度器** | SceneScheduler 管理场景生命周期，40+ 地点词 + 15 情感阶段自动命名场景 |
| **场景切换冷却** | 规则路径和调度器路径均强制 >= 3 轮冷却，避免频繁切换 |
| **World Agent 并行推演** | 每轮在 turn_end 并行执行：事件生成 + 场景转折检测 + round_summary 清洗 |
| **MemoryStore 3 层架构** | event 层记录轮次摘要，summary 层定期合并，global 层存全局事实 |
| **4 通道前端渲染** | `<<Environment>>` / `[Thought]` / `(Action)` / Speech 分别样式化显示（含副视角折叠卡片） |

### state.json 只读模板机制

- `cards/<卡名>/state.json` 是**只读模板**，存储角色初始设定
- 运行时动态数据通过 session 历史中的 `rp-state` 快照持久化
- `saveState()` 不再写回卡片目录，保护模板不被污染
- `loadState()` 启动时从卡片模板加载初始值
- **`/reset` 命令**：从卡片模板重建，一键重置所有数值

### 上下文管理

| 机制 | 说明 |
|------|------|
| **对话压缩** | 每 15 次用户交互强制压缩（AI 回复后触发，用户无感知） |
| **世界书注入** | 每 3 次用户交互关键词匹配注入（前端不可见） |
| **上下文舞台指示** | 每轮拼入状态摘要 + 场景上下文（input 事件，零额外消息开销） |
| **用户轮数计数** | 基于 `turn_end` 精确计数，不受 steer 污染 |

---

## ⚙️ 配置

### .rpconfig.json

```json
{
  "token_budget": {
    "worldbook_max": 1500,
    "history_max_tokens": 8000
  },
  "model_max_tokens": 128000,
  "rp_web_port": 3012,
  "rp_web_host": "127.0.0.1"
}
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `RP_WEB_PORT` | `3012` | Web 前端端口 |
| `RP_WEB_HOST` | `127.0.0.1` | 监听地址（局域网改 `0.0.0.0`） |
| `RP_AUTHOR_NOTE` | — | Author Note 注入文本 |

---

## 🚀 部署

### 前置条件

- pi ≥ v0.75
- Node.js ≥ 18

### 启动方式

```bash
# 方式一：命令行
pi
# 浏览器打开 http://localhost:3012

# 方式二：双击 项目部署.bat 自动完成环境检查和依赖安装
```

---

## 📚 文档索引

| 文档 | 说明 |
|------|------|
| [rp-engine/README.md](.pi/extensions/rp-engine/README.md) | 引擎模块详细文档 |
| [Phase 3 架构文档](.pi/runtime/PHASE3-ARCHITECTURE.md) | Runtime 引擎完整架构 |

---

## 📄 许可

MIT License
