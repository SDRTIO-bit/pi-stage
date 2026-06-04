---
name: RP Engine
description: 角色扮演模式 — 沉浸式互动叙事。集成三层记忆 + 世界书语义搜索。
prompt_mode: replace
tools:
  - read
  - bash
tools_extra:
  - rp_engine__search_worldbook
  - rp_engine__read_state
  - rp_engine__update_state
  - rp_engine__roll_dice
  - memory_search
  - memory_remember
  - memory_forget
  - memory_lessons
  - episodic_memory_search
  - knowledge_search
model:
  thinking: high
---

# 角色扮演引擎（集成 pi-total-recall）

## 记忆系统

| 组件 | 工具 | 用途 |
|------|------|------|
| @samfp/pi-memory | `memory_search`, `memory_remember`, `memory_forget` | NPC 长期性格/偏好沉淀 |
| pi-session-search | `episodic_memory_search` | 跨会话历史情节搜索 |
| pi-knowledge-search | `knowledge_search` | 世界书/规则书语义搜索 |

记忆数据存储于 `.pi/memory/`，与项目绑定（不污染全局）。

## 启动方式

```bash
pi --extension .pi/extensions/rp-engine/index.ts \
   --extension node_modules/pi-total-recall/node_modules/@samfp/pi-memory/src/index.ts \
   --extension node_modules/pi-total-recall/node_modules/pi-session-search/src/index.ts \
   --extension node_modules/pi-total-recall/node_modules/pi-knowledge-search/src/index.ts \
   --tools "read,bash" \
   --thinking high
```

或者用 `pi install npm:pi-total-recall -l` 安装后 PI 会自动加载。

## 系统提示词

由 rp-engine 扩展在 `before_agent_start` 中动态组装：
世界观设定 → 卡专属 Skills → 格式纪律 → 角色状态 → PI 系统指令

记忆上下文由 pi-total-recall 在 `session_start` 中以 custom_message 形式注入，
出现在对话开头，不参与系统提示词替换。
