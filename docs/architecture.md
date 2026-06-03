# PI RP Engine — 架构文档

LLM 无关的角色扮演运行时，专注上下文装配、状态管理、世界书→Skill 编译。

## 系统定位 (C4 Context)

引擎自身不调用 LLM，而是作为 pi.dev 扩展运行，在 LLM 调用之前准备最优上下文。

```mermaid
flowchart TB
    User[👤 用户] -->|消息| PiDev[pi.dev CLI/Web]

    subgraph External["外部系统"]
        LLM[🤖 LLM Provider<br/>Claude / GPT / 本地模型]
    end

    subgraph Boundary["PI RP Engine 边界"]
        Engine[RP Engine 扩展<br/>上下文装配 + 状态管理<br/>世界书→Skill 编译]
    end

    PiDev -->|input 事件| Engine
    Engine -->|注入 System Prompt + Skill| PiDev
    PiDev -->|装配后的 Context| LLM
    LLM -->|生成回复| PiDev
    Engine -->|持久化| Disk[(sessions/)]
    Engine -->|Skill 文件| Skills[(.pi/skills/rp-engine/)]
```

## 内部架构 (C4 Container)

```mermaid
flowchart TB
    subgraph Core["核心模块"]
        direction TB
        Pipeline[ContextPipeline<br/>collect→prioritize→schedule→render]
        StateStore[StateStore<br/>session 管理 + 持久化]
        CardManager[CardManager<br/>卡片注册/激活/隔离]
        Worldbook[Worldbook<br/>常开设定 + 触发关键词]
        SkillGen[SkillGenerator<br/>世界书→Skill 分类]
        Tools[ToolRegistry<br/>read_state/update_state<br/>advance_time/search_worldbook]
        Commands[CommandRegistry<br/>/card /status /reset<br/>/diag /history]
        Lifecycle[LifecycleBus<br/>事件总线 + Agent 管线]
        RegexEngine[RegexEngine<br/>prompt/display 双阶段钩子]
    end

    subgraph External["对外接口"]
        HTTPServer[HTTP Server :3001<br/>REST API + 静态文件]
        PiExt[pi.dev 扩展适配<br/>createPiTools / createPiCommands]
        RPWebServer[RP Web Server :3012<br/>WebSocket + 前端]
    end

    PiExt --> Tools
    PiExt --> Commands
    HTTPServer --> Pipeline
    HTTPServer --> StateStore
    HTTPServer --> CardManager
    HTTPServer --> Worldbook
    HTTPServer --> Tools
    HTTPServer --> Lifecycle

    Pipeline --> StateStore
    Pipeline --> RegexEngine
    Lifecycle --> StateStore
    Tools --> StateStore
    Tools --> Worldbook
    CardManager --> StateStore
    SkillGen --> Worldbook
```

## 核心管线 (Context Pipeline)

上下文装配是引擎的核心流程，5 阶段流水线：

```mermaid
flowchart LR
    A["1. Collect<br/>各模块申报 Node"] --> B["2. Prioritize<br/>按 priority + attentionWeight 排序"]
    B --> C["3. Schedule<br/>双预算调度"]
    C --> D["4. Render<br/>组装 prompt + display 两个版本"]
    D --> E["5. Trace<br/>记录全过程，同步 RuntimeStatus"]

    C -->|"超出预算"| F["降级策略"]
    F --> F1["drop: 丢弃"]
    F --> F2["compress: 合并空行"]
    F --> F3["truncate: 按位截断"]
    F --> F4["summarize: 提取式摘要"]
```

### 双预算调度

```mermaid
flowchart TB
    Start[Node 进入调度] --> Hard{totalBytes + nodeSize<br/>超出 hard?}

    Hard -->|否| Target{totalBytes + nodeSize<br/>超出 target?}
    Hard -->|是| CheckStrategy{策略是<br/>summarize?}
    CheckStrategy -->|是| TrySummary[尝试摘要降级]
    CheckStrategy -->|否| Drop[丢弃]

    TrySummary --> SummaryOK{降级后<br/>≤ hard?}
    SummaryOK -->|是| Include[纳入]
    SummaryOK -->|否| Drop

    Target -->|否| Include
    Target -->|是| Degrade[应用降级策略]

    Degrade --> DegradeOK{降级成功?}
    DegradeOK -->|是| Include
    DegradeOK -->|否| Drop
```

预算模型：`target` = 舒适区（追求不触发降级），`hard` = 硬上限（绝对不能超过）。

## 生命周期事件

```mermaid
stateDiagram-v2
    [*] --> session_start
    session_start --> idle
    idle --> input: 用户发消息
    input --> context_assembly: Engine 装配上下文
    context_assembly --> before_agent_start: 注入 Skill 文件
    before_agent_start --> llm_call: pi.dev 调用 LLM
    llm_call --> message_end: 收到回复
    message_end --> turn_end: 执行 Agent 管线
    turn_end --> idle: 等待下一轮
    idle --> session_shutdown: pi.dev 关闭
    session_shutdown --> [*]

    note right of turn_end: Agent 管线中间件：\n- 脏卡片检测\n- 状态变更摘要\n- (可扩展自定义中间件)
```

## 全链路时序

```mermaid
sequenceDiagram
    autonumber
    actor User
    participant PiDev as pi.dev
    participant Engine as RP Engine
    participant LLM

    User->>PiDev: 发送消息
    PiDev->>Engine: input 事件

    activate Engine
    Engine->>Engine: ContextPipeline.assemble()
    Note right of Engine: collect → prioritize →<br/>schedule → render
    Engine->>Engine: Worldbook.searchByKeywords()
    Engine-->>PiDev: System Prompt + Context
    deactivate Engine

    PiDev->>Engine: before:agent:start
    Engine-->>PiDev: 注入 Skill 文件

    PiDev->>LLM: 装配后的 Prompt
    LLM-->>PiDev: 生成回复
    PiDev->>User: 显示回复

    PiDev->>Engine: turn_end 事件
    activate Engine
    Engine->>Engine: AgentPipeline.run()
    Engine->>Engine: StateStore.persist()
    Engine->>Engine: SkillGenerator (世界书→Skill)
    deactivate Engine
```

## 数据模型

```mermaid
classDiagram
    class PromptNode {
        +string id
        +ContextLayer layer
        +string source
        +number priority
        +number attentionWeight
        +string content
        +number byteSize
        +DegradationStrategy degradationStrategy
    }

    class SessionState {
        +string sessionId
        +number startedAt
        +Map~string,CardState~ activatedCards
        +string[] history
        +RuntimeStatus runtimeStatus
    }

    class CardMeta {
        +string id
        +string name
        +number version
        +string description
        +string[] tags
        +number activatedAt
    }

    class CardState {
        +string cardId
        +Record variables
        +number lastUpdated
    }

    class WorldbookEntry {
        +string id
        +string name
        +string[] keywords
        +number priority
        +boolean constant
        +boolean enabled
        +string content
        +string category
    }

    class RuntimeStatus {
        +string phase
        +Budget currentBudget
        +number totalBytesUsed
        +number nodeCount
        +TraceEntry[] trace
        +boolean degradationApplied
    }

    SessionState "1" --> "*" CardState
    SessionState "1" --> "1" RuntimeStatus
    CardState --> CardMeta: references
```

## 世界书→Skill 编译

```mermaid
flowchart TB
    WB[世界书条目] --> Filter{category ==<br/>常开设定?}

    Filter -->|是| Classify[内容特征分类]
    Filter -->|否| Trigger[触发词条<br/>按需搜索]

    Classify --> Rules[规则/禁止/必须<br/>→ 00-core-rules.md]
    Classify --> Style[格式/语气/画风<br/>→ style-protocol.md]
    Classify --> Judge[判定/骰子/概率<br/>→ judgment-system.md]
    Classify --> Var[变量/属性/数值<br/>→ variable-protocol.md]
    Classify --> Uncat[无法分类<br/>→ 跳过]

    Rules --> Sort[按 priority 排序]
    Style --> Sort
    Judge --> Sort
    Var --> Sort

    Sort --> Generate[生成 Skill 文件<br/>写入 .pi/skills/rp-engine/]
    Generate --> Inject[before:agent:start<br/>自动注入]
```

## 工具系统

| 工具 | 触发 | 功能 |
|------|------|------|
| `read_state` | LLM 自动 | 读取激活卡片的状态变量，keys 为空返回全部 |
| `update_state` | LLM 自动 | 更新卡片状态变量，类型校验 + 脏标记 |
| `advance_time` | LLM 自动 | 推进游戏内时间 |
| `search_worldbook` | LLM 自动 | 按关键词搜索触发词条 |

每个工具调用包裹在生命周期事件中：`tool_call` → 执行 → `tool_result`。

## 命令系统

| 命令 | 功能 |
|------|------|
| `/card list` | 列出所有已注册卡片及激活状态 |
| `/card activate <id>` | 激活指定卡片 |
| `/card deactivate <id>` | 停用指定卡片 |
| `/status` | 查看引擎状态 (phase/budget/nodes/degradation) |
| `/reset` | 清空当前 session 历史 |
| `/diag prompt` | 查看上下文装配 trace |
| `/history` | 查看对话历史 |

## 降级策略对比

| 策略 | 算法 | 适用场景 | 是否丢信息 |
|------|------|----------|------------|
| `drop` | 直接丢弃 | 不重要内容 | 全部丢失 |
| `compress` | 合并多余空行 | 格式化文本 | 仅去空白 |
| `truncate` | 按字节比截断 | 长文本 | 尾部丢失 |
| `summarize` | 提取式：前 N 句 + 末尾句 | 多句段文本 | 中间丢失 |

## 目录结构

```
src/
├── types.ts                  # 核心类型定义
├── index.ts                  # 统一导出
├── card-manager.ts           # 卡片管理（内存 + 文件持久化）
├── state-store.ts            # Session 状态存储
├── skill-generator.ts        # 世界书 → Skill 编译
├── tools.ts                  # AI 工具集（Pi + HTTP 双 API）
├── registry.ts               # Tool/Command 注册表基类
├── config.ts                 # .rpconfig.json 配置加载
├── utils.ts                  # 工具函数 (clamp/deepClone/setNested)
├── server.ts                 # HTTP 服务 (:3001)
├── rp-web-server.ts          # RP Web 服务 (:3012)
├── context/
│   ├── prompt-node.ts        # PromptNode 标准封装
│   ├── scheduler.ts          # 双预算调度器
│   └── pipeline.ts           # 上下文装配管线
├── lifecycle/
│   ├── events.ts             # 事件总线
│   ├── agent-pipeline.ts     # Agent 中间件管线
│   └── index.ts              # 生命周期导出
├── worldbook/
│   └── index.ts              # 世界书系统
├── cards/
│   ├── types.ts              # 卡片类型
│   ├── registry.ts           # 卡片注册表 (JSON)
│   └── importer.ts           # SillyTavern 兼容导入
├── commands/
│   └── index.ts              # 用户命令
└── regex/
    └── hooks.ts              # 双阶段正则引擎
```
