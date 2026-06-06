# PI RP Engine — 使用文档

## 快速开始

### 启动

```bash
pi --extension .pi/extensions/rp-engine/index.ts --tools "read,bash" --thinking high
```

启动后 RP Web 前端自动打开 `http://localhost:3012`。

### 选一张卡，开始对话

直接在 PI 中输入对话内容。引擎会自动：
- 选择激活的角色卡（无指定时使用上次或默认卡）
- 装配上下文（世界书 + 格式规则 + 预设）
- 注入 Steering 检查点（格式提醒 + 可用工具）

## Web 前端

访问 `http://localhost:3012`，功能包括：

- **会话列表** — 查看所有历史会话，按项目分组，支持搜索、收藏、重命名
- **会话加载** — 点击任意历史会话恢复对话上下文
- **新建会话** — 开始新对话
- **导出 HTML** — 将对话导出为格式化的 HTML 文件
- **时间线视图** — 查看对话历史概览

## 角色卡管理

### 查看可用卡

```
/card list
```

### 切换角色卡

```
/rp-use <cardId>
```

切换后需重启 PI 或开始新对话生效。

### 导入新卡

将 SillyTavern PNG/JSON 卡片拖放到 `导入角色卡.bat`，或双击后选择文件。

### 查看当前状态

```
/status
```

显示：当前会话 ID、激活卡片、对话轮数、pipeline 状态。

## 会话管理

### 引擎自动管理

- **自动保存**：每轮对话自动持久化到 `.pi/sessions/`
- **重启恢复**：重启 PI 后自动恢复上次会话（通过 `.pi/current-session.json`）
- **多会话**：Web 前端可浏览和加载所有历史会话

### 手动控制

```
/reset    — 清除当前会话，下次对话重新初始化
/rp-use   — 切换角色卡（当前会话结束）
```

## 可用命令

| 命令 | 功能 |
|------|------|
| `/card list` | 列出所有可用角色卡 |
| `/rp-use <id>` | 选择角色卡（新对话生效） |
| `/status` | 查看引擎状态 |
| `/reset` | 重置当前会话 |
| `/history` | 查看对话历史 |
| `/presets` | 列出全局预设文件 |
| `/rp-mode` | 查看 RP 模式状态与推荐启动参数 |
| `/diag prompt` | 诊断：查看当前 pipeline prompt |

## AI 可用工具

模型在 RP 过程中可以主动调用以下工具：

| 工具 | 功能 | 使用时机 |
|------|------|---------|
| `rp_engine__search_worldbook` | 搜索世界书条目 | 需要查 NPC、场景、设定时 |
| `rp_engine__read_state` | 读取角色变量 | 需要回顾当前状态时 |
| `rp_engine__update_state` | 更新角色变量 | 剧情推进后更新属性/关系 |
| `rp_engine__roll_dice` | 投骰判定 | 战斗、技能、非凡等概率场景 |

模型每轮都会在 Steering 注入中收到工具提醒，无需手动提示。

## 格式检查

引擎每轮自动检查 AI 回复的格式纪律：

1. `<判定>` 与 `</判定>` 标签闭合配对
2. `*` 星号动作标注配对
3. 回复长度 < 10 字符

发现问题后不会中断对话，而是在下一轮的 Steering 检查点中注入 `[格式纠偏]` 提醒模型修正。

## 预设自定义

全局预设在 `.pi/presets/` 目录下，所有角色卡共享。可以添加/修改 `.md` 文件来定制：

- 写作风格约束（必须/禁止/不得句式）
- 输出结构标签（`<tag>` 模式）
- 角色扮演规则

修改后下一轮对话自动生效，无需重启。引擎自动从预设文件中提取格式标签和约束句注入 Steering。

## 配置调优

编辑 `.rpconfig.json`：

**加大上下文预算**（内容更长但 token 消耗更大）：
```json
"token_budget": {
  "pipeline_target": 49152,
  "pipeline_hard": 81920
}
```

**切换世界书检索方式**（TF-IDF 更准，keyword 更快）：
```json
"retriever": {
  "method": "keyword"
}
```

**关闭特定 Collector**（减少 prompt 长度）：
```json
"features": {
  "format_rules_collector": false,
  "state_collector": false
}
```

修改后重启 PI 生效。

## 提示与技巧

- **角色卡质量最重要**：世界书条目越详细，AI 的角色一致性越好
- **预设保持精简**：预设间不要有矛盾规则（如 NSFW 细则与反低俗条款同时生效）
- **长对话时注意压缩**：20+ 轮后引擎自动压缩早期对话，保留最近 5 轮完整
- **善用工具**：AI 可通过 `search_worldbook` 主动查设定，不需要在 prompt 中塞入全部背景
- **查看快照**：`.pi/snapshots/` 下有每轮 prompt 快照，可用 `node scripts/analyze-snapshots.mjs` 分析 token 分布
