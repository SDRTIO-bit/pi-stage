# PI RP Engine — 部署说明

## 环境要求

| 组件 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | ≥ 22 | 运行时 |
| npm | ≥ 10 | 包管理 |
| PI CLI | `@earendil-works/pi-coding-agent` | 全局安装，PI 扩展宿主 |
| pi-total-recall | ≥ 1.8.0 | 对话记忆管理 |

仅 HTTP 独立模式不需要 PI CLI 和 pi-total-recall。

## 安装

### 1. 安装 Node.js

从 [nodejs.org](https://nodejs.org/) 下载 LTS 版本（≥ 22），安装时勾选"添加到 PATH"。

### 2. 安装项目依赖

```bash
cd "F:\zhao\pi rp"
npm install
```

### 3. 安装 PI CLI（全局）

```bash
npm install -g @earendil-works/pi-coding-agent
```

### 4. 运行环境检查

```bash
setup.bat
```

缺失项会以 `[MISSING]` 标出，按提示补齐后重新运行。

### 5. 首次运行

首次运行会自动生成 `.rpconfig.json`（项目根目录）。配置缺失的字段使用默认值，无需手动填写。

## 运行模式

### 模式 A：PI 扩展（推荐）

PI 管理的完整 RP 体验，LLM 调用由 PI 处理：

```bash
pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high
```

启动后：
- PI 会话接管，RP 引擎自动初始化
- RP Web 前端自动启动：`http://localhost:3012`
- 会话自动持久化到 `.pi/sessions/`，支持重启恢复

### 模式 B：HTTP 独立服务

不依赖 PI，引擎直接暴露 HTTP API：

```bash
npx tsx src/server.ts
```

访问 `http://localhost:3001`。此模式不含 LLM 调用，仅提供上下文装配和状态管理 API。

## 配置 (.rpconfig.json)

首次运行自动生成，可手动编辑：

```json
{
  "token_budget": {
    "pipeline_target": 24576,
    "pipeline_hard": 40960,
    "output_reserve": 4000
  },
  "retriever": {
    "method": "tfidf",
    "top_k": 3,
    "max_tokens": 4000,
    "context_window": 3
  },
  "features": {
    "tfidf_retriever": true,
    "format_rules_collector": true,
    "state_collector": true
  },
  "rp_web_port": 3012,
  "rp_web_host": "0.0.0.0"
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `token_budget.pipeline_target` | 24576 | Pipeline 舒适区 (bytes)，超出触发降级 |
| `token_budget.pipeline_hard` | 40960 | Pipeline 硬上限 (bytes)，绝不超出 |
| `token_budget.output_reserve` | 4000 | LLM 输出预留 (tokens) |
| `retriever.method` | `"tfidf"` | 世界书检索方法：`"tfidf"` 或 `"keyword"` |
| `retriever.top_k` | 3 | 最多返回条目数 |
| `retriever.max_tokens` | 4000 | 返回条目总 token 上限 |
| `retriever.context_window` | 3 | 检索上下文窗口（最近 N 轮对话） |
| `features.tfidf_retriever` | true | 启用 TF-IDF 相似度检索 |
| `features.format_rules_collector` | true | 启用格式规则独立 collector |
| `features.state_collector` | true | 启用状态变量 collector |
| `rp_web_port` | 3012 | RP Web 服务端口 |
| `rp_web_host` | `"0.0.0.0"` | RP Web 绑定地址 |

## 角色卡管理

### 导入角色卡

支持 SillyTavern PNG/JSON 格式角色卡：

```bash
导入角色卡.bat
```

或拖放 PNG/JSON 文件到批处理图标。

导入后卡片存储在 `.pi/cards/{card-name}/`，包含：
- `config.json` — 卡片元数据
- `worldbook/` — 世界书条目（常开设定 + 触发关键词）
- `skills/rp-engine/` — 首次激活时自动生成的 5 个 Skill 文件

### 删除角色卡

```bash
删除角色卡.bat
```

## 验证部署

1. 启动 PI 扩展，确认控制台输出 `[RP] 引擎就绪`
2. 访问 `http://localhost:3012`，确认 Web 前端加载
3. 对话 2-3 轮，检查 `.pi/sessions/` 下是否有 `.jsonl` 文件生成
4. 重启 PI，确认会话自动恢复（控制台输出 `[RP] 恢复会话`）

## 目录结构（运行时）

```
.pi/
├── agents/rp.md               # RP 模式 agent 定义
├── settings.json              # PI 项目设置
├── presets/                   # 全局预设（所有卡共享的规则）
├── memory/                    # 持久记忆
├── sessions/                  # 项目级会话存储（JSONL 格式）
├── snapshots/                 # 每轮 prompt 快照（观测用）
├── cards/{name}/              # 角色卡数据
│   ├── config.json
│   ├── worldbook/
│   ├── skills/rp-engine/      # 自动生成的卡专属 Skill
│   └── sessions/
└── extensions/
    ├── rp-engine/index.ts     # PI 扩展入口
    └── rp-web/                # Web 前端
```

## 常见问题

### PI CLI 未找到

```bash
npm list -g @earendil-works/pi-coding-agent
```

如果未安装：`npm install -g @earendil-works/pi-coding-agent`

### 端口被占用

修改 `.rpconfig.json` 中的 `rp_web_port` 为其他端口（如 3013）。

### 会话未恢复

检查 `.pi/current-session.json` 是否存在且内容有效。删除该文件后重启将创建新会话。

### Skill Budget 截断

卡专属 5 个 Skill 文件合计 ~380KB，pipeline hard 默认 40KB。长内容会被调度器截断。调大 `pipeline_target`/`pipeline_hard` 可缓解，但会增加 token 消耗。
