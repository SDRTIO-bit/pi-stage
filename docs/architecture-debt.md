# 架构技术债务（暂缓处理）

**记录时间**: 2026-06-05
**状态**: 观测期，不执行改造

---

## 核心问题

### 1. CardManager 双重状态管理

内存（memMeta、activeOrder）和文件（registry.json）两套状态源，同步逻辑分散在 6 个方法中，策略各不相同：
- register() 只写内存
- activate() 写内存+文件，文件失败静默吞错
- activateCards() 只写文件再同步内存
- deactivate/deactivateCards 镜像实现

**风险**: 崩溃恢复时内存/文件状态不一致。

### 2. DI 容器 + 模块单例并存

5 个模块同时导出弃用单例和 DI 版本：
- stateStore、cardManager、worldbook、contextPipeline、agentPipeline
- context/pipeline.ts 和 card-manager.ts 构造函数默认参数引用弃用单例
- tools.ts 的 search_worldbook fallback 用 dynamic import 加载 worldbook 单例

**风险**: 同一进程两套实例，各自维护独立状态。

### 3. tools.ts 三套 API + 隐式状态

- buildCoreTools() → 内部 handler 数组
- createPiTools() → PiToolDef（包装 lifecycle hook）
- getTool()/callTool()/listTools() → ToolHandler 适配器（依赖模块级 `_coreTools` 缓存）

**存量 bug**: HTTP 服务器路径（tool-routes → callTool()）从未调用 createPiTools()，`_coreTools` 始终为空。

### 4. rp-web-server.ts 上帝文件（615 行）

单函数 createRPWebServer() 塞进：HTTP 服务 + WebSocket + MIME + 静态文件 + JSONL 扫描/加载 + 命令路由 + 事件转发 + 端口重试 + 浏览器打开。无分层，不可测试。

### 5. 生命周期编排分散

LifecycleBus、AgentPipeline、ContextPipeline、RegexEngine 四组件各自独立，编排逻辑不在 DI 容器中。turn_end 的完整调用链无统一入口。

### 6. scheduler.ts 降级缺陷

- `cappedRemaining = (hard - totalBytes) * 0.6` — 魔法数字，无解释
- extractiveSummarize 用字符数推断字节数，中文 UTF-8 下比例不准

### 7. TF-IDF 每次全量重算

searchBySimilarity() 每轮对所有触发条目重新计算 TF/IDF/cosine，O(N × vocab)。应预计算并缓存文档向量。

### 8. 中文 bigram 分词过于原始

无词典、无词边界、无停用词。"数据库连接池" → ["数据","据库","库连","连接","接池"]。

### 9. 配置系统分裂

config.ts 的 RPConfig 和 composition-root.ts 的 AppConfig 不互通，各自独立默认值：
- pipeline_target: RPConfig 24576 vs AppConfig 102400
- pipeline_hard: RPConfig 40960 vs AppConfig 163840

### 10. 死代码

- tools.ts `registerTool()` — 空操作
- composition-root.ts `activateDefaultCards()` — 已弃用，无调用者
- lifecycle/skill-hooks.ts `skillCollector`、`regenerateSkills()` — no-op
- lifecycle/index.ts `lifecycleBus`/`agentPipeline` 重导出 — 无消费者

---

## 建议改造方案（4 阶段）

| 阶段 | 内容 | 风险 |
|------|------|------|
| 1 | 清理死代码（零风险） | 无 |
| 2 | 修复 tools.ts 模块级隐式状态，新增 createToolRegistry() | 中 |
| 3 | 修复 commands/index.ts 硬编码单例依赖 | 中 |
| 4 | 删除弃用单例导出（最后做） | 高 |

## 执行前置条件

- 测试环境恢复正常（`npm install` + vitest 可运行）
- 不在观测期
- 有明确的功能需求驱动

## 改造原则

每阶段可独立验证、独立回滚。改造后三条运行时路径必须全部正常：
- 路径 A: pi.dev 扩展（主路径，当前唯一活跃路径）
- 路径 B: HTTP 独立服务
- 路径 C: 12 个测试文件
