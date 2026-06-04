# PI RP Engine — 开发维护指南

## 项目概览

LLM-neutral roleplay runtime。TypeScript，ESM 模块，`npx tsx` 直接运行。

两种运行模式共用同一 DI 容器：HTTP 独立服务 / PI 扩展嵌入式。

## 当前状态

| 阶段 | 内容 | 关键产出 |
|------|------|----------|
| Phase 1 | DI 容器 + 消除全局单例 | `composition-root.ts` — createApp() |
| Phase 2 | 统一双 API | tools/commands/worldbook/card-manager |
| Phase 3 | StorageProvider + 路由拆分 + 前端 | presentation/http/routes/ |
| Phase 4 | 测试加固 | 12 文件 / 134 测试 |
| Phase 5 | 卡隔离（独立存储 + 专属 Skill） | cards/skill-writer.ts + session-store.ts |
| Phase 6 | PI 集成加固 | lazy init / system prompt 替换 / 格式检查 |
| Phase 7 | Prompt Snapshot + Budget 配置化 | observability/ + .rpconfig.json |
| Phase 8 | TF-IDF 检索 + Collector 拆分 | worldbook TF-IDF + collectors/format-rules + state-variables |

**当前**: 观测期 — 收集真实对话数据，暂不新增功能。

## 架构分层

```
┌──────────────────────────────────────┐
│    HTTP Layer (独立模式)              │  presentation/http/routes/
│    server.ts → routes                │  → 只做请求解析/响应序列化
├──────────────────────────────────────┤
│    PI Extension (嵌入式)             │  .pi/extensions/rp-engine/
│    pi.on(event) → app.services      │  → 生命周期钩子 + 工具/命令
├──────────────────────────────────────┤
│    Composition Root                  │  composition-root.ts
│    createApp()                       │  → 唯一的对象组装入口
├──────────────────────────────────────┤
│    Domain                            │  context/ lifecycle/ collectors/
│    (pipeline, cards, skills)         │  → 核心业务逻辑，不依赖 HTTP 或 PI
├──────────────────────────────────────┤
│    State                             │  state-store.ts card-manager.ts
│    (session + card storage)          │  cards/skill-writer.ts cards/session-store.ts
├──────────────────────────────────────┤
│    Infrastructure                    │  infrastructure/storage-provider.ts
│    (I/O abstraction)                 │  → FileSystemStorage / MemoryStorage
└──────────────────────────────────────┘
```

## 核心模式

### 1. 依赖注入（组合根）

唯一入口 `composition-root.ts` 的 `createApp()`：

```typescript
// ✅ 正确：通过 createApp() 获取服务
const app = createApp()
app.stateStore.createSession(sid)

// ❌ 错误：模块级单例（已全部标记 @deprecated）
import { stateStore } from "./state-store.js"
```

### 2. 一对一卡隔离模型

一个 session = 一张卡片。每张卡拥有独立的历史、变量、Skills。

**Skill 生命周期**：
1. 首次激活卡 → 从卡 worldbook 加载常开设定 → `generateSkills()` → 写入 `skills/rp-engine/*.md`（5 文件）
2. 再次激活同一张卡 → `hasCardSkills()` 检查 → 直接读取，不重新生成

**注意**：Skills 生成后为静态快照，世界书条目更新不会触发重新生成。如需刷新，手动删除 `skills/rp-engine/` 目录后重启。

### 3. ContextPipeline + Collector 模式

所有上下文内容通过 Collector 接口申报：

```typescript
interface Collector {
  name: string
  collect(sessionId: string): Promise<PromptNode[]>
}
```

管线流程：`collect → prioritize → schedule → render → trace`

当前注册的 5 个 Collector（按优先级）：

| Collector | 层 | 优先级 | 降级策略 | 内容来源 |
|-----------|-----|--------|----------|----------|
| card-base | L0-survival | 0 | drop | composeCardBase() 生成 |
| format-rules | L0-survival | 2 | summarize | 卡目录 FORMAT_RULES.md |
| rp-skills | L1-stable | 3-8 | summarize | 卡目录 skills/rp-engine/*.md |
| worldbook-trigger | L2-enhanced | 15 | truncate | TF-IDF/关键词 检索触发条目 |
| state-variables | L1-stable | 90 | compress | session.activatedCards 变量 |

### 4. PI 扩展事件流

```
session_start        → 懒初始化兜底 + RP Web 启动
before_agent_start   → ★ 核心：rpGuard + pipeline.assemble() + PI 指令
input                → 用户消息记录到 history
message_end          → 格式纪律检查（判定块闭合/星号配对/过短回复）
turn_end             → Agent 管线 + 持久化 + 双写（中心 + 卡目录）
session_before_compact → 角色状态变量保护
session_shutdown     → 最终持久化
```

**懒初始化策略**：不依赖 `session_start`（PI 可能不触发），在 `before_agent_start` 首次调用时初始化。

**Card 优先级**：用户指定 → registry active → 导入卡（排除种子卡）→ 种子卡 → "hero"

**System Prompt 组装**（`before_agent_start`）：
```
rpGuard（最高优先级角色扮演指令 — 硬编码）
  + result.prompt（ContextPipeline.assemble() 输出 — 动态）
  + "---\n## PI 系统指令"
  + ev.systemPrompt（PI 原始系统指令 — 含工具声明）
```

### 5. 格式纪律检查（message_end）

检查项：
1. `<判定>` 与 `</判定>` 闭合配对
2. `*` 星号动作标注配对
3. 回复长度 < 10 字符 → 警告

发现问题后以 `system: [格式警告] ...` 追加到 history。

### 6. 配置系统

`.rpconfig.json` — 首次运行自动生成，支持字段：

| 配置路径 | 默认值 | 说明 |
|----------|--------|------|
| `token_budget.pipeline_target` | 24576 | Pipeline 舒适区 (bytes) |
| `token_budget.pipeline_hard` | 40960 | Pipeline 硬上限 (bytes) |
| `token_budget.output_reserve` | 4000 | LLM 输出预留 (tokens) |
| `retriever.method` | "tfidf" | 检索方法: "keyword" \| "tfidf" |
| `retriever.top_k` | 3 | 最多返回条目数 |
| `retriever.max_tokens` | 4000 | 返回条目总 token 上限 |
| `retriever.context_window` | 3 | 检索上下文窗口（最近 N 轮） |
| `features.tfidf_retriever` | true | 启用 TF-IDF（false → keyword） |
| `features.format_rules_collector` | true | 启用独立格式规则 collector |
| `features.state_collector` | true | 启用独立状态变量 collector |
| `rp_web_port` | 3012 | RP Web 服务端口 |
| `rp_web_host` | "0.0.0.0" | RP Web 绑定地址 |

### 7. 观测系统

- **快照写入**：`src/observability/prompt-snapshot.ts` — 每轮 `before_agent_start` 后调用 `logSnapshot(dir, sessionId, pipelinePhase)`，写入 `.pi/snapshots/{sid}/{ts}.json`
- **批量分析**：`node scripts/analyze-snapshots.mjs [--session=sid]` — 统计 token 分布、collector 占比、世界书命中率、降级次数
- **快照结构**：`{ timestamp, sessionId, pipelinePhase: { phase, prompt, displayPrompt, status, collectorBytes } }`

### 8. 世界书双检索

`searchByKeywords(query)` — 子串匹配，支持 AND/OR

`searchBySimilarity(query, opts)` — bigram TF-IDF 余弦相似度：
- 中文 bigram 分词
- 最近 N 轮用户消息作为查询上下文（不是单条消息）
- `topK` + `maxTokens` 双限制
- 查询无中文时自动 fallback 到关键词匹配

## 目录结构

```
src/
├── composition-root.ts        # DI 容器 — createApp()
├── types.ts                   # 核心类型（SessionState 含 cardId）
├── state-store.ts             # session CRUD + StorageProvider 接口
├── card-manager.ts            # 角色卡注册/激活/持久化
├── config.ts                  # .rpconfig.json 加载
├── tools.ts                   # createPiTools() DI 注入 + HTTP 适配器
├── skill-writer.ts            # 全局 SkillWriter（@deprecated）
├── skill-generator.ts         # 世界书条目 → 5 个 skill 分类
├── server.ts                  # HTTP 独立服务入口
├── rp-web-server.ts           # RP WebSocket 服务器
│
├── context/
│   ├── pipeline.ts            # assemble() + collectorBytes 报告
│   ├── scheduler.ts           # 双预算调度器
│   └── prompt-node.ts         # PromptNode 工厂
│
├── collectors/                # 独立 Collector
│   ├── format-rules.ts        # 格式规则
│   └── state-variables.ts     # 角色状态变量
│
├── lifecycle/
│   ├── events.ts              # LifecycleBus
│   ├── agent-pipeline.ts      # Agent 中间件管线
│   └── skill-hooks.ts         # createSkillCollector() 工厂
│
├── worldbook/
│   └── index.ts               # keyword + TF-IDF 双检索
│
├── cards/
│   ├── types.ts
│   ├── registry.ts
│   ├── importer.ts            # SillyTavern 卡片导入
│   ├── skill-writer.ts        # 卡级 Skill 生成器
│   └── session-store.ts       # 卡级 Session 存储
│
├── observability/
│   └── prompt-snapshot.ts     # 每轮 prompt 快照
│
├── commands/
│   └── index.ts               # 用户命令
│
├── infrastructure/
│   └── storage-provider.ts    # FileSystemStorage / MemoryStorage
│
├── presentation/http/
│   └── routes/                # session-routes, turn-routes, tool-routes
│
└── regex/
    └── hooks.ts               # prompt/display 双阶段正则

.pi/
├── extensions/rp-engine/
│   └── index.ts               # PI 扩展入口
├── cards/{name}/
│   ├── config.json
│   ├── state.json
│   ├── worldbook/
│   │   ├── [常开]设定/
│   │   └── [触发]关键词/
│   ├── skills/rp-engine/      # 卡专属 Skills（首次激活生成）
│   │   ├── 00-core-rules.md
│   │   ├── style-protocol.md
│   │   ├── judgment-system.md
│   │   ├── variable-protocol.md
│   │   └── world-context.md
│   └── sessions/
├── snapshots/{sid}/           # 观测快照
└── sessions/

scripts/
└── analyze-snapshots.mjs      # 快照批量分析

tests/                          # Vitest (12 文件 / 134 测试)
docs/                           # 开发文档
```

## 如何添加功能

### 加一个 Collector

在 `collectors/` 下新建文件，实现 `Collector` 接口，在 `composition-root.ts` 中 `contextPipeline.registerCollector()` 注册。

### 加一个工具

修改 `src/tools.ts` 中的 `buildCoreTools()` 函数，添加工具定义。PI 适配器自动获得。

注意：`createPiTools(sessionIdRef, stateStore, lifecycleBus)` 需要三个参数 — stateStore 和 lifecycleBus 通过 DI 注入。

### 加一个命令

在 `commands/index.ts` 中写命令函数，通过 `deps` 参数获取服务（`deps.stateStore` / `deps.cardManager` / `deps.contextPipeline`）。

### 加一个 HTTP API 端点

在 `presentation/http/routes/` 新建文件，导出 `register(ctx, req, res, pathname, method, body)`，在 `server.ts` 注册。

### 添加配置项

在 `config.ts` 的 `RPConfig` 接口和 `DEFAULT_CONFIG` 中添加字段。`.rpconfig.json` 缺失字段时使用默认值。

## 测试

```bash
npm test              # 全部 134 测试
npx vitest run        # 等价
npx tsc --noEmit      # 类型检查
```

- 优先用 `MemoryStorage` + 构造函数注入，避免文件系统依赖
- 路由测试用 `stubReq()` / `stubRes()` 手写桩

## 验证清单

1. `npx tsc --noEmit` — 零类型错误
2. `npm test` — 全部通过
3. HTTP 模式：`npx tsx src/server.ts` → localhost:3001 — 选卡 → 对话
4. PI 模式：`pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high`
5. 观测：检查 `.pi/snapshots/` 下有快照文件 → 运行 `node scripts/analyze-snapshots.mjs`

## 已知问题

### Skill Budget 不匹配

卡专属 5 个 skill 文件合计 ~380KB，但 pipeline budget hard 仅 40KB。调度器会严重截断 skill 内容，导致 AI 缺乏世界观上下文。详见 `docs/skill-problem-report.md`。

### AI 读文件

rpGuard 的"禁止读文件"是 prompt 层软约束，coding agent 底层的探索行为难以完全抑制。`read_state` 返回空数据时会加剧此问题（已修复）。
