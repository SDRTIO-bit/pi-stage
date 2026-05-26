<h1 align="center">🎭 RP Engine · 角色扮演引擎</h1>

<p align="center">
  <strong>基于 pi coding agent 的通用角色扮演引擎</strong>
  <br/>
  多卡片并发 · 多角色状态追踪 · 实时 Web 前端 · SillyTavern 角色卡导入
  <br/><br/>
  <img src="https://img.shields.io/badge/pi-v0.75%2B-blue" alt="pi">
  <img src="https://img.shields.io/badge/node-%3E%3D18-green" alt="node">
  <img src="https://img.shields.io/badge/license-MIT-orange" alt="license">
</p>

---

> **⚠️ 声明**：本项目为个人学习/测试用途，基于 [pi coding agent](https://github.com/earendil-works/pi-coding-agent) 构建。

## 📖 项目简介

RP Engine 是一个运行在 pi coding agent 之上的**通用角色扮演引擎**。不绑定特定世界观——你可以导入任意 SillyTavern 格式的角色卡来扮演。

### 核心特性

| 特性 | 说明 |
|------|------|
| **多卡片并发** | 同时激活多张角色卡，支持跨世界融合叙事 |
| **SillyTavern 兼容** | 支持 V2/V3 PNG 角色卡和 JSON 导出格式导入 |
| **导入自动预处理** | 正则→渲染钩子、酒馆→变量定义、远程 URL 扫描、待办生成 |
| **卡片完全隔离** | 状态、世界书、正则脚本、session 历史均按卡片独立 |
| **动态变量系统** | Zod Schema 提取 → 类型校验 → 值域钳制 → state.json 持久化 |
| **正则全链路** | 引擎层 prompt 剥离 + 前端 display 替换，WebSocket 下发 |
| **卡片 UI 组件** | AI 本地化产物放入 `ui/` 目录，引擎自动扫描下发给前端 |
| **世界书注入** | 关键词匹配 + Token 预算 1500 + 去重 + 优先级排序 |
| **用户轮数计数** | 基于 turn_end 精确统计用户交互次数，避免 steer 消息污染轮数 |
| **state.json 只读模板** | 卡片模板永不被覆盖，动态数据通过 session 快照持久化 |
| **APPEND_SYSTEM 前端附加** | 格式规范拼到用户消息末尾发送，利用 AI 末尾注意力最高特性 |
| **AI Cognitive Runtime Engine (Phase 3)** | 39 文件 / 12,622 行的完整运行时体系 |
| **Context Assembly Engine** | 6 阶段装配管道：collect→prioritize→compress→assemble→reinforce→render |
| **Attention Runtime** | 7 层注意力管理 + Token 预算 + 显著性计算 + 上下文衰减 + 指令强化 |
| **Autonomous Runtime** | 世界持续运行：时间推进、Agent 自主行为、事件触发、后台更新 |
| **Agent 子系统** | 需求系统、情绪演算、日程表、意图生成、Agent 运行时 |
| **DebugDashboard** | 5 类追踪器：runtime/scheduler/agent/memory/attention 全链路可观测 |
| **Runtime Persistence** | 自动保存/恢复、循环覆盖、快照格式化 |
| **Runtime Evaluation System (Phase 3.5)** | 5 模块 / 2,200 行的评估与遥测体系 |
| **DriftDetector** | 4 种漂移检测：角色/风格/指令/格式，滑动平均+告警 |
| **MemoryEvaluator** | 4 项记忆质量指标：精度/相关性/幻觉率/持久性 |
| **AttentionEvaluator** | 4 项注意力指标：Token分配/强化/饱和度/指令保持 |
| **RuntimeTelemetry** | 6 类遥测事件 + 时间点快照 + 时间轴回放 |
| **BenchmarkRunner** | 6 个 Benchmark 场景，Legacy vs Runtime 对比分析 |

---

## 🚀 新手教程（5 分钟上手）

### 准备工作
- **Node.js 18+** — 没装的话去 [nodejs.org](https://nodejs.org/) 下载安装
- **pi coding agent** — 终端运行 `npm install -g @earendil-works/pi-coding-agent`
- **一张角色卡** — SillyTavern 格式的 .png 或 .json 角色卡（去社区找或者自己制作）

---

### 第一步：部署项目

**方式一：一键部署（推荐）**
双击根目录的 **`项目部署.bat`**，自动完成：
```
✔ 检查 Node.js → 安装依赖 → 安装 pi agent
```

**方式二：手动部署**
```bash
npm install                     # 安装项目依赖
npm install -g @earendil-works/pi-coding-agent  # 安装 pi agent
```

---

### 第二步：导入角色卡

拿到一张 .png 角色卡后，导入到引擎：

**方式一：拖拽导入（推荐）**
把 .png 文件拖到 **`ImportCharacterCard.bat`** 上松手即可。

**方式二：命令行导入**
```bash
node setup.mjs --import 角色卡.png
```

导入完成后，终端会显示卡片信息和世界书条目数。想确认有哪些卡片：
```bash
# 启动 pi 后输入：
/card list
```

---

### 第三步：启动引擎

```bash
pi
```

首次启动会加载引擎，看到 `RP模式` 提示表示成功。

---

### 第四步：开始角色扮演

在 pi 中输入以下命令激活你的角色卡：

```
/card activate <卡片id>
```
（卡片 id 在导入时终端有显示，也可以用 `/card list` 查看）

激活后就可以直接对话了！AI 会自动读取角色设定和世界书开始扮演。

> **提示**：首次进入新场景时，AI 会先调用 `load_constant_worldbook` 读取世界观设定，耐心等几轮就好。

---

### 第五步：打开 Web 界面（可选）

浏览器打开 **http://localhost:3012**，可以看到：
- 实时对话界面
- 角色状态面板
- 历史会话管理
- 世界书条目浏览

---

### 常用命令速查

| 命令 | 作用 |
|------|------|
| `/card list` | 查看所有已导入的卡片 |
| `/card activate <id>` | 激活卡片，开始扮演 |
| `/card deactivate <id>` | 休眠卡片 |
| `/reset` | 重置角色数值到初始状态 |
| `/status` | 查看所有角色当前状态 |
| `/rp` | 查看帮助 |

---

### 常见问题

**Q: 提示 "pi 命令不存在"**
A: 确认已执行 `npm install -g @earendil-works/pi-coding-agent`，然后重启终端。

**Q: 导入卡片时报错**
A: 确保角色卡是 SillyTavern V2/V3 格式的 .png 或导出的 .json 文件。

**Q: 怎么切换角色卡？**
A: `/card deactivate <当前id>` 取消激活，再 `/card activate <新id>` 激活新卡，然后重启 pi。

**Q: Web 界面打不开**
A: 确认 pi 正在运行，浏览器访问 http://localhost:3012

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

## 🏗️ 项目结构

```
├── .pi/
│   ├── settings.json               # pi 设置
│   ├── APPEND_SYSTEM.md            # 常驻风格规范（前端附加）
│   ├── state.json                  # 运行时状态（由 session 快照重建）
│   ├── state_history.jsonl         # 状态变更历史
│   ├── sessions/                   # 对话记录（按卡片隔离）
│   ├── cards/                      # 📇 角色卡仓库
│   │   ├── registry.json           #   卡片注册表
│   │   └── <卡名>/                 #   单张卡片目录
│   │       └── state.json          #   ⭐ 只读模板
│   ├── extensions/
│   │   ├── rp-engine/              # 🔧 引擎模块
│   │   │   ├── index.ts              # 入口 + 事件注册
│   │   │   ├── tavern-runner.ts      # SillyTavern JS 兼容层
│   │   │   ├── lifecycle/            # session/turn/message/before-agent
│   │   │   ├── utils/                # json-patch / vector-search / session-cleanup
│   │   │   └── ...
│   │   └── rp-web/                 # 🌐 前端界面
│   ├── runtime/                    # ⚙️ Runtime Engine (Phase 3)
│   │   ├── agent/                  #   Agent 子系统
│   │   ├── attention/              #   注意力运行时
│   │   ├── autonomous/             #   自主运行时
│   │   ├── context/                #   上下文装配引擎
│   │   ├── debug/                  #   调试系统
│   │   └── evaluation/             #   📊 评估与遥测 (Phase 3.5)
│   └── skills/rp/SKILL.md          # RP Skill 指令
├── setup.mjs                       # ⭐ 导入/注册/切换卡片脚本
├── 项目部署.bat                      # 🚀 一键部署
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
| **APPEND_SYSTEM 附加** | 每 5 次用户输入自动拼格式规范到消息末尾 |
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
## 📄 许可

MIT License
