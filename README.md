# PI RP Engine

LLM 无关的角色扮演运行时 — 上下文装配、状态管理、卡片隔离、世界书→Skill 编译。

引擎自身不调用 LLM，作为 pi.dev 扩展运行，在 LLM 调用之前装配最优上下文。同时支持独立 HTTP / WebSocket 模式。

## 核心特性

- **上下文管线** — 5 阶段流水线：Collect → Prioritize → Schedule → Render → Trace，双预算调度
- **世界书→Skill 编译** — 常开设定自动编译为 pi.dev Skill 文件，LLM 以"技能"形式原生理解
- **卡片隔离** — 一个 session = 一张卡，独立历史、变量、技能
- **TF-IDF 检索** — bigram TF-IDF 余弦相似度匹配触发词条，无中文自动 fallback 关键词
- **双模式运行** — pi.dev 扩展嵌入式 / HTTP 独立服务，共享同一 DI 容器
- **观测系统** — 每轮 prompt 完整快照 + 批量分析脚本
- **SillyTavern 兼容** — 支持 PNG/JSON 角色卡导入

## 架构

```
用户 → pi.dev
         │
         ├─ 调 LLM（prompt = 引擎装配的上下文 + Skill 规则）
         │
         └─ pi-rp-engine 扩展 (.pi/extensions/rp-engine/)
              ├─ lifecycle/     → session / input / turn 事件
              ├─ tools/         → read_state / update_state
              ├─ commands/      → /card / /status / /diag
              └─ skill-injector → 世界书→Skill 编译
```

### Collector 注册表

| Collector | 层 | 优先级 | 降级策略 | 内容 |
|-----------|-----|--------|----------|------|
| card-base | L0-survival | 0 | drop | 系统提示词 |
| format-rules | L0-survival | 2 | summarize | 格式规则 |
| rp-skills | L1-stable | 3-8 | summarize | 卡专属 5 个 skill 文件 |
| worldbook-trigger | L2-enhanced | 15 | truncate | TF-IDF/关键词匹配触发条目 |
| state-variables | L1-stable | 90 | compress | 角色状态变量 |

## 快速开始

### 依赖

- Node.js ≥ 18
- pi.dev ≥ v0.75

### 安装

```bash
git clone <repo-url>
cd pi-rp-engine
npm install
```

### 作为 pi.dev 扩展运行

```bash
# 在项目目录下启动 pi.dev（自动加载 .pi/extensions/rp-engine/）
pi
```

### 独立 HTTP 模式

```bash
npx tsx src/server.ts
```

### 角色扮演流程

每次用户发消息，引擎自动执行：

1. **input** → 装配上下文，注入 system prompt
2. **before:agent:start** → 注入世界书编译的 Skill 文件
3. **LLM 生成回复**（使用注入的上下文+技能）
4. **turn:end** → Agent 管线 + 状态持久化 + 世界书重新编译

## 工具

| 工具 | 功能 |
|------|------|
| `read_state` | 读取角色状态变量 |
| `update_state` | 更新角色状态（类型校验+钳制） |
| `advance_time` | 推进游戏内时间 |
| `search_worldbook` | 按关键词搜索触发词条 |

## 命令

| 命令 | 作用 |
|------|------|
| `/card list` | 列出所有已注册卡片 |
| `/card activate <id>` | 激活卡片 |
| `/card deactivate <id>` | 停用卡片 |
| `/status` | 查看引擎状态 |
| `/reset` | 重置当前 session |
| `/diag prompt` | 查看上下文装配 trace |

## 配置 (.rpconfig.json)

首次运行自动生成：

```json
{
  "token_budget": {
    "worldbook_max": 1500,
    "history_max_tokens": 8000,
    "pipeline_target": 102400,
    "pipeline_hard": 163840,
    "output_reserve": 4000
  },
  "retriever": {
    "method": "tfidf",
    "top_k": 3,
    "max_tokens": 4000,
    "context_window": 3
  },
  "model_max_tokens": 128000
}
```

## 项目结构

```
src/
├── composition-root.ts         # DI 容器 — createApp() 唯一装配入口
├── types.ts                    # 核心类型
├── state-store.ts              # session 状态存储
├── card-manager.ts             # 角色卡注册/激活/持久化
├── config.ts                   # .rpconfig.json 加载 + 默认配置合并
├── tools.ts                    # 4 个内置工具
├── skill-generator.ts          # 世界书条目 → 5 个 skill 文件
├── server.ts                   # HTTP 独立服务入口
├── rp-web-server.ts            # RP WebSocket 服务器
├── context/
│   ├── pipeline.ts             # assemble() 主流程
│   ├── scheduler.ts            # 双预算调度器
│   └── prompt-node.ts          # PromptNode 工厂
├── collectors/
│   ├── format-rules.ts         # 格式规则 collector
│   └── state-variables.ts      # 角色状态 collector
├── lifecycle/
│   ├── events.ts               # LifecycleBus 事件总线
│   ├── agent-pipeline.ts       # Agent 中间件管线
│   └── skill-hooks.ts          # Skill collector 工厂
├── worldbook/
│   └── index.ts                # keyword + TF-IDF 双检索
├── cards/
│   ├── types.ts / registry.ts  # 卡片管理
│   ├── importer.ts             # SillyTavern PNG/JSON 导入
│   └── skill-writer.ts         # 卡级 Skill 生成器
├── commands/
│   └── index.ts                # 用户命令
├── observability/
│   └── prompt-snapshot.ts      # 每轮 prompt 快照
├── infrastructure/
│   └── storage-provider.ts     # StorageProvider 抽象
└── presentation/http/routes/   # HTTP 路由
```

## 文档

- [架构文档](docs/architecture.md)
- [开发维护指南](docs/DEVELOPMENT.md)

## License

MIT
