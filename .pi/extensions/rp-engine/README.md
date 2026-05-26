# RP Engine - 角色扮演状态引擎

通用角色扮演核心引擎，管理角色状态、世界书加载、周期事件、正则脚本处理、系统提示注入、RP Web 前端服务。

## 架构

```
rp-engine/
├── index.ts              # 主入口，组合所有模块
├── types.ts              # 共享类型定义
├── utils.ts              # 共享工具函数（旧版）
├── registry.ts           # ToolRegistry & CommandRegistry 可注册式注册表
├── state-store.ts        # StateStore v5 状态存储管理（卡片运行时隔离）
├── card-manager.ts       # CardManager 类（注册/激活/查询/向量目录）
├── worldbook.ts          # WorldbookService 类 + 向量搜索集成
├── regex-processor.ts    # ⭐ 正则脚本处理器（prompt 剥离 + display 替换）
├── author-note.ts        # ⭐ Author Note 作者注注入
├── periodic-events.ts    # 周期事件处理
├── system-prompt.ts      # 系统提示构建（含 Token 预算 + 对话压缩）
├── tui-panels.ts         # TUI 面板（StatusPanel, HistoryPanel）
├── tools.ts              # AI 工具定义（4 个，含向量搜索优先）
├── commands.ts           # 用户命令定义（5 个）
├── rp-web-server.ts      # RP Web 服务器（HTTP + WebSocket）
├── tavern-runner.ts      # SillyTavern JS 脚本 VM 沙箱执行
├── agent-api.ts          # Agent API 桥接
├── config.ts             # 配置管理
├── game-types.ts         # 游戏类型定义（WorldState/CharacterState）
├── runtime-integration.ts # Phase 3 Runtime 桥接（可选依赖）
├── runtime-types.ts      # Runtime 接口类型声明
├── services.ts           # EngineServices 服务容器
├── pi-modules.d.ts       # pi 平台类型声明
├── lifecycle/            # 生命周期处理器
│   ├── session.ts        #   session_start / shutdown
│   ├── turn.ts           #   turn_start / end
│   ├── message.ts        #   message_end
│   └── before-agent.ts   #   before_agent_start
├── persistence/          # 持久化模块
│   └── history-writer.ts #   历史写入器
├── utils/                # 工具函数（模块化）
│   ├── json-patch.ts     #   RFC 6902 JSON Patch 本地实现
│   ├── vector-search.ts  #   本地向量搜索（TF 余弦相似度）
│   └── session-cleanup.ts#   Session 清理
├── tests.test.ts         # 测试
└── README.md             # 本文档
```

## 模块说明

### types.ts

核心类型定义和常量：

- `WorldState` — 世界状态（日期、时间、位置）
- `CharacterState` — 角色状态（归属值、情分值、生理信息等）
- `HistoryRecord` — 历史变更记录
- `CORE_CHARS` — 已弃用，原为回响乐园 6 角色硬编码，现改为空数组（`string[]`）。卡片角色名由卡片管理器动态加载

### utils.ts

纯函数工具，无副作用：

- `clamp(v, min, max)` — 数值钳制
- `deepClone(obj)` — JSON 深拷贝
- `setNested(obj, path, value)` — 按点号路径设置嵌套值
- `getNested(obj, path)` — 按点号路径读取嵌套值

### registry.ts

可扩展的注册表模式：

- `ToolRegistry` — 工具注册表，`register()` / `getAll()` / `registerAll(pi)`
- `CommandRegistry` — 命令注册表，`register()` / `match(input)` / `registerAll(pi)`

加新工具：在 `tools.ts` 中定义并 `registry.register({...})` 即可，核心代码无需修改。

### state-store.ts

状态持久化类 `StateStore`（`new StateStore()`）：

- `loadState()` / `saveState()` — JSON 文件读写
- `appendHistory(record)` — 追加到 jsonl 历史日志
- `saveSessionSnapshot(pi)` — session entry 快照（分支回滚用）
- `reconstructFromSession(ctx)` — 从 session 重建状态
- `cleanupOldSessions(dir)` — 清理旧文件（保留 ≤15 个，总计 ≤15MB）

### worldbook.ts

世界书加载与主动注入模块，提供基于上下文的智能注入机制：

#### 主动注入

- `injectRelevantWorldbook(userMessage, existingContext, worldbookDir)` — 核心注入函数
  1. 从用户消息 + 已有上下文中提取关键词（角色名、世界观概念、地点）
  2. 搜索世界书目录匹配文件名
  3. 过滤已注入条目（去重）
  4. 按命中关键词数降序排列
  5. Token 预算控制：累计 ≤ `MAX_WORLDBOOK_TOKENS`（1500）
  6. 标记为已注入，返回格式化注入文本
- `injectTopWorldbook(userMessage, worldbookDir)` — 精简版，仅注入最高优先级的一条

#### 条目去重

- `InjectedEntriesTracker` — 内部类：`isInjected()` / `mark()` / `markAll()` / `reset()`
- `resetInjectedEntries()` — 清空追踪器（每 20 轮或新场景时调用）
- `getInjectedTracker()` — 获取追踪器实例供外部查询

#### Token 估算

- `estimateTokens(text)` — 中文 1 token ≈ 1.5 字符，英文 1 token ≈ 4 字符
- `MAX_WORLDBOOK_TOKENS = 1500` — 世界书注入硬上限常量

#### 兼容接口

- `findWorldbookFiles(keyword, dir)` — 关键词搜索 `.md` 文件（兼容旧接口）
- `readWorldbookIndex(dir)` — 读取索引

### periodic-events.ts

周期事件（每轮/每日推进时触发）：

- 花开蒂落 — 归属值 ≥60 触发
- 生理结算 — 生理期内触发怀孕
- 情分值自动同步 = 100 - 归属值
- 秘密派对 — 每 7 天

### system-prompt.ts

构建注入到 AI 对话的系统提示，包含 Token 预算管理、对话历史压缩、Author Note 注入功能。

#### Token 预算管理

- 世界书索引硬上限：**1500 token**（通过 `WORLD_BOOK_TOKEN_LIMIT` 常量控制）
- 超出预算时按比例截断，尽量在段落边界处裁剪
- Token 估算：`estimateTokens(text)` — 中文按 1 token ≈ 1.5 字符，英文/数字按 1 token ≈ 4 字符
- 总提示预算约 2000~2180 token：世界书 ≤1500 + 角色状态 ~400~600 + Author Note ~50~80

#### 对话历史压缩

- **最近 10 轮**：完整保留（`FULL_TURNS_KEEP = 10`）
- **10~20 轮**：压缩为简短摘要（`SUMMARY_TURNS_START/END`）
- `buildCompressedHistory(messages)` — 从消息数组构建压缩后的对话历史
- `compressSingleTurn()` — 将单轮对话截取前 200 字符作为摘要

#### 导出函数

| 函数 | 说明 |
|------|------|
| `buildSystemPrompt(state, worldbookDir, authorNote?)` | 完整系统提示（含世界书索引 + 角色状态 + Author Note） |
| `buildCompactSystemPrompt(state, authorNote?)` | 精简系统提示（不含世界书索引，用于周期性注入） |
| `estimateTokens(text)` | 估算文本 token 数 |
| `buildCompressedHistory(messages)` | 压缩对话历史 |

### author-note.ts

Author Note（作者注）模块，用于在每轮对话中向 AI 注入精简系统指令，维持输出质量和一致性。

#### 类：AuthorNote

| 方法 | 说明 |
|------|------|
| `getInjectionText()` | 返回当前的注入文本 |
| `setNote(text?)` | 运行时动态修改注入文本（为空则恢复默认） |
| `reset()` | 重置为环境变量 `RP_AUTHOR_NOTE` 的值或默认值 |

#### 默认值

从环境变量 `RP_AUTHOR_NOTE` 读取，兜底为：

```
[系统指令：请以角色的身份，保持生动详细的描写，关注角色心理活动。回复长度应在800-1200字之间。]
```

#### 注入位置

Author Note 在以下位置被注入：

1. `before_agent_start` — 系统提示末尾（通过 `buildSystemPrompt`）
2. `turn_start` 每 6 轮格式刷新 — 消息末尾追加
3. `turn_start` 每 8 轮状态概览 — 消息末尾追加
4. `turn_start` 轻量提醒 — 消息末尾追加

#### 使用环境变量

```bash
# 设置自定义 Author Note
export RP_AUTHOR_NOTE="[系统指令：保持文风细腻，多用感官描写，每段不超过5行。]"

# 启动 pi
pi
```

### tui-panels.ts

终端 UI 面板：

- `StatusPanel` — `/status` 命令面板，显示世界 + 6 角色状态
- `HistoryPanel` — `/history <名>` 命令面板，显示角色变更记录

### tools.ts

4 个 AI 工具（通过 `createToolRegistry` 创建注册表）：

| 工具 | 功能 |
|------|------|
| `read_state` | 读取角色状态 |
| `update_state` | 更新角色状态（归属值自动钳制 + 情分值同步） |
| `advance_time` | 推进游戏天数（触发周期事件） |
| `load_worldbook` | 按关键词加载世界书条目 |

### commands.ts

4 个用户命令（通过 `createCommandRegistry` 创建注册表）：

| 命令 | 功能 |
|------|------|
| `/status` | 显示 TUI 状态面板 |
| `/history` | 查看角色变更历史 |
| `/rp` | 显示帮助 |
| `/route` | 选择/查看剧情路线 |

### rp-web-server.ts

RP Web 服务器工厂 `createRPWebServer()`：

- HTTP 静态文件服务（`.html` / `.js` / `.css`）
- WebSocket 事件转发（消息、状态同步）
- Token 认证（随机生成，注入到 HTML + WebSocket URL 验证）
- 默认监听 `0.0.0.0`（局域网可访问，通过环境变量 `RP_WEB_HOST` 可改为 `127.0.0.1` 仅本机）
- 服务端 blocked 标签剥离（安全最后防线）

### index.ts

主入口 `export default function(pi)`：

- `session_start` → 初始化存储 + 启动 Web 服务器
- `session_tree` → 分支导航重建状态
- `before_agent_start` → 注入系统提示
- `turn_start` → 世界书注入 + 周期性格式刷新/状态概览/提醒（基于 `userTurnCounter`）
- `turn_end` → **用户轮数 +1** + 状态持久化 + session 清理 + 注入去重重置
- `message_end` → 应用正则钩子（prompt 剥离 + display 替换）
- `session_shutdown` → 关闭 Web 服务器

#### 用户轮数计数（2026-05-23）

`userTurnCounter` 在 `turn_end` 中递增，所有周期事件基于此判断：
- 强制压缩：每 15 次用户交互（原为 7 轮 turn_start）
- 格式刷新：每 6 次用户交互
- 状态概览：每 8 次用户交互
- 世界书注入：每 3 次用户交互
- 轻量提醒：前 30 次每 5 次，之后每 10 次

此举避免 steer 消息污染轮数计数。

#### 三层压缩机制

1. **pi 引擎原生压缩**（兜底）：`.pi/settings.json` 中 `"global": 65`，上下文 token 达 65% 时自动触发
2. **RP Engine 强制压缩**（主动）：`turn_start` 中 `ctx.compact()`，每 15 次用户交互执行，压缩后重置世界书注入标记并注入常开设定
3. **周期性注入**（辅助）：格式刷新每 6 次、状态概览每 8 次、世界书注入每 3 次

#### APPEND_SYSTEM.md 前端附加

APPEND_SYSTEM.md 不再通过引擎系统提示注入。改为前端 Web 页面在发送消息时拼到用户消息末尾，利用 AI 对末尾注意力最高的特性。前端 `rp-web-app.js` 中的 `buildAppendSuffix()` + `chatForm.submit` 拼接逻辑，后端 `rp-web-server.ts` 新增 `get_append_system` 命令支持。

## 配置

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `RP_WEB_PORT` | `3012` | Web 服务器端口 |
| `RP_WEB_HOST` | `0.0.0.0` | 监听地址（局域网访问保留默认，仅本机改 `127.0.0.1`） |
| `RP_AUTHOR_NOTE` | （见上方） | Author Note 注入文本，用于维持 AI 输出质量 |

## 扩展新工具/命令

### 添加新工具

在 `tools.ts` 的 `createToolRegistry()` 中添加：

```typescript
registry.register({
  name: "my_tool",
  label: "我的工具",
  description: "工具说明",
  parameters: Type.Object({ ... }),
  async execute(_callId, params, _signal, _onUpdate, _ctx) {
    // 实现逻辑
    return { content: [{ type: "text", text: "结果" }], details: {} };
  },
});
```

### 添加新命令

在 `commands.ts` 的 `createCommandRegistry()` 中添加：

```typescript
registry.register({
  name: "mycmd",
  description: "命令说明",
  handler: async (args, ctx) => {
    // 实现逻辑
    ctx.ui.notify("结果", "info");
  },
});
```

无需修改 `index.ts`。
