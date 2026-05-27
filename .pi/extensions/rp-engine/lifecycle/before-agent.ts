/**
 * RP Engine - before_agent_start 事件处理
 *
 * 注入系统提示 + 开场指令 + 项目报告。
 * 两套方案共享此事件，但注入的内容不同：
 *   - legacy 模式：全量 system prompt（旧行为）
 *   - runtime 模式：精简版，核心规则由 Context Assembly Engine 动态装配
 *
 * 项目报告（Project Report）：
 *   在 session 首轮注入一份项目概况（引擎能力、激活卡片、文件结构），
 *   让 AI 无需逐文件摸索即可了解项目全貌，大幅降低前几轮的 token 浪费。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeBridge } from "../runtime-integration";
import { getActiveCards, getCardWorldbookDirs } from "../card-manager";
import { readWorldbookIndexMulti, estimateTokens, getAllConstantEntries } from "../worldbook";
import { consumeAgentBrief } from "./turn";

export interface BeforeAgentDeps {
  store: import("../state-store").StateStore;
  runtime: RuntimeBridge;
  authorNote: import("../author-note").AuthorNote;
  worldbookDir: { current: string };
  userTurnCounter: { value: number };
  stateDir: { current: string };
  tavernRunner: import("../tavern-runner").TavernRunner;
  memoryStore?: import("../prototypes/memory-store").MemoryStore;
  sceneScheduler?: import("../prototypes/scene-scheduler").SceneScheduler;
  characterRegistry?: import("../prototypes/character-registry").CharacterRegistry;
}

// ============================================================
// Session 级别缓存（只生成一次，确保 system prompt 完全固定）
// ============================================================

let _cachedProjectReport: string | null = null;
let _cachedWorldbookIndex: string | null = null;
let _cachedStablePrefix: string | null = null;
let _cachedConstantContent: string | null = null;

/** turn_start 预执行的 tavern 脚本输出缓存，供 before_agent_start 消费 */
let _pendingTavernMessages: string[] | null = null;

/**
 * 构建项目报告
 *
 * 在 session 首轮注入，让 AI 一次性了解：
 * - 项目是什么（引擎名称、版本）
 * - 激活了哪些卡片（名字、世界书条目数、关键文件）
 * - 引擎能力（可用工具、命令）
 * - 工作目录结构速查
 *
 * 报告控制在 1000 字以内，避免 token 浪费。
 */
function buildProjectReport(cwd: string, deps: BeforeAgentDeps): string {
  if (_cachedProjectReport) return _cachedProjectReport;

  const lines: string[] = [];

  // 1. 项目标识
  const pkgPath = join(cwd, "package.json");
  const readmePath = join(cwd, "README.md");
  lines.push(`## 📋 RP Engine · 项目报告`);

  // 2. 激活卡片概览
  const activeCards = getActiveCards();
  if (activeCards.length === 0) {
    lines.push(`\n### 激活卡片：无`);
    lines.push(`使用 /card list 查看可用卡片，/card activate <id> 激活。`);
  } else {
    lines.push(`\n### 激活卡片 (${activeCards.length})`);
    for (const card of activeCards) {
      const configPath = join(card.dir, "config.json");
      let name = card.id;
      let scenario = "";
      if (existsSync(configPath)) {
        try {
          const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
          if (cfg.character?.name) name = cfg.character.name;
          if (cfg.character?.scenario) scenario = cfg.character.scenario;
        } catch {}
      }

      // 统计世界书条目数（4 文件夹结构）
      let wbCount = 0;
      for (const sub of ["[触发]关键词", "[常开]设定"]) {
        const subDir = join(card.dir, "worldbook", sub);
        if (existsSync(subDir)) {
          try {
            wbCount += readdirSync(subDir).filter((f: string) => f.endsWith(".md")).length;
          } catch {}
        }
      }

      // 检查关键文件
      const hasRegex = existsSync(join(card.dir, "regex_hooks.json"));
      const hasVars = existsSync(join(card.dir, "variable_schema.json"));

      lines.push(`  - **${name}** (id: \`${card.id}\`)`);
      if (scenario) lines.push(`    场景：${scenario.slice(0, 100)}`);
      lines.push(`    世界书：${wbCount} 条 | 正则钩子：${hasRegex ? "有" : "无"} | 变量Schema：${hasVars ? "有" : "无"}`);
    }
  }

  // 3. 引擎核心能力
  lines.push(`
### 引擎能力`);
  lines.push(`- **AI 工具**: read_state / update_state / load_worldbook / load_constant_worldbook / advance_time`);
  lines.push(`- **用户命令**: /card list|activate|deactivate, /reset, /status, /history, /route, /rp`);

  // 4. 关键路径速查
  const stateDir = deps.stateDir?.current || join(cwd, ".pi");
  lines.push(`
### 关键路径`);
  lines.push(`- 卡片仓库: \`.pi/cards/\``);
  lines.push(`- 会话目录: \`.pi/sessions/<卡名>/\``);
  lines.push(`- 运行时引擎: \`.pi/runtime/\` (Phase 3)`);
  lines.push(`- 引擎扩展: \`.pi/extensions/rp-engine/\``);
  lines.push(`- 前端界面: \`.pi/extensions/rp-web/\``);
  lines.push(`- 配置文件: \`.rpconfig.json\``);

  // 5. 运行时模式
  const cm = deps.runtime.contextMode || "auto";
  lines.push(`
### 运行状态`);
  lines.push(`- 上下文模式: ${cm}`);
  lines.push(`- 当前轮数: ${deps.userTurnCounter.value}`);
  lines.push(`- 状态文件: \`${stateDir}/state.json\``);

  _cachedProjectReport = lines.join("\n");
  return _cachedProjectReport;
}

/**
 * 重置所有缓存（卡片切换时调用）
 */
export function resetProjectReportCache(): void {
  _cachedProjectReport = null;
  _cachedWorldbookIndex = null;
  _cachedStablePrefix = null;
  _cachedConstantContent = null;
  _pendingTavernMessages = null;
}

/** 设置 tavern 脚本消息缓存（由 turn_start 在 input 事件后调用） */
export function setPendingTavernMessages(messages: string[] | null): void {
  _pendingTavernMessages = messages;
}

/**
 * 获取世界书索引缓存（session 级别，只生成一次）
 * 带 token 预算控制（硬上限 12000 tokens，与 worldbook.ts 的 MAX_WORLDBOOK_TOKENS 一致）
 */
function getCachedWorldbookIndex(worldbookDirs: string[]): string {
  if (_cachedWorldbookIndex) return _cachedWorldbookIndex;

  const raw = readWorldbookIndexMulti(worldbookDirs);
  if (!raw) { _cachedWorldbookIndex = ""; return ""; }

  const tokens = estimateTokens(raw);
  if (tokens <= 12000) {
    _cachedWorldbookIndex = raw;
    return raw;
  }

  // 超出预算时截断
  const ratio = 12000 / tokens;
  const targetChars = Math.floor(raw.length * ratio);
  const truncated = raw.slice(0, targetChars);
  const lastNewline = truncated.lastIndexOf("\n\n");
  const cutPoint = lastNewline > 0 ? lastNewline : targetChars;
  _cachedWorldbookIndex = truncated.slice(0, cutPoint) + "\n\n(世界书索引已截断，超 token 预算)";
  return _cachedWorldbookIndex;
}

/**
 * 一次性读取全部常开世界书内容（session 级别缓存）
 */
function getCachedConstantContent(worldbookDirs: string[]): string {
  if (_cachedConstantContent) return _cachedConstantContent;

  const allEntries = getAllConstantEntries(worldbookDirs);
  if (allEntries.length === 0) {
    _cachedConstantContent = "";
    return "";
  }

  const lines: string[] = [];
  lines.push(`\n---\n## 🌐 常开世界书设定（${allEntries.length} 条，已全部加载）\n`);

  for (const entry of allEntries) {
    const fileName = entry.file.replace(/^\[常开\]设定\//, "");
    lines.push(`--- [${entry.sourceCard}] ${fileName} ---`);
    lines.push(entry.content.slice(0, 2000));
    lines.push("");
  }

  _cachedConstantContent = lines.join("\n");
  console.log(`[CachePrefix] 全量常开世界书已注入: ${allEntries.length} 条, ~${_cachedConstantContent.length} 字符`);
  return _cachedConstantContent;
}

/**
 * 获取稳定前缀缓存（session 级别，只生成一次）
 * 包含：规则 + 世界书索引 + 全量常开设定
 */
function getStablePrefix(worldbookDirs: string[]): string {
  if (_cachedStablePrefix) return _cachedStablePrefix;

  const indexText = getCachedWorldbookIndex(worldbookDirs);
  const constantContent = getCachedConstantContent(worldbookDirs);

  _cachedStablePrefix = `
## 🎭 角色扮演框架

### 核心规则
- 你必须以当前角色的身份互动，禁止 OOC / 元评价 / 道歉
- 所有角色只能基于已知事件行动（绝对信息隔离）
- 对 {{user}}：可写外在行为，禁止写内心/替代/大段对话

### 叙事质量要求
你的回复必须同时包含以下 4 个维度，并将它们自然融入叙事，不使用任何标记符号：

1. **心理活动** — 角色的内心想法、未说出口的感受，通过行文自然流露
2. **身体语言** — 具体的微表情和肢体动作，拒绝"她很伤心"这类抽象概括
3. **环境映射** — 环境描写必须与角色当前情绪形成映射，用环境"演"情绪
4. **对话** — 符合人物性格，使用引号包裹

以上 4 个维度应当像盐溶于水一样融入叙事，而非被标签分隔。

### 文风要求：对话驱动型（对话占比 70%）
- **对话占比**：正文中，对话段落（含人物台词及伴随的细微动作/表情）应明显多于叙述段落。避免大段的心理描写或环境铺陈，信息尽量通过对话传递。
- **对话真实感**：语言符合人物性格、身份、关系（如熟人之间随意，初识时客气）。多用口语、短句，保留自然停顿、重复、语气词（如"呃""那个……"），避免过于书面化或长篇独白。对话中可穿插打断、沉默、转移话题，增强生活气息。
- **动作穿插**：在对话过程中，适时加入人物的细微动作、表情变化、视线移动等，让场景"活"起来。例如："她低下头，手指绕着发梢，'其实……也没什么。'"
- **叙事简洁**：非对话部分（场景描写、过渡）采用白描，只保留必要信息。
- **节奏把控**：对话要有来有回，避免一方长时间独白。重要信息可分散在多个对话回合中透露，制造悬念或层次感。

### 可用工具
- read_state / update_state / load_worldbook / load_constant_worldbook / advance_time
- load_constant_worldbook — 按顺序读取常开设定（世界观、地理等），开篇必用
- 每轮结束必须用 update_state 更新角色状态变量

### ⭐ 世界书读取流程（严格顺序）
1. 先使用 load_constant_worldbook 按编号顺序读完所有常开条目（0001→0050→0083...）
2. 全部常开读完后，再根据需要使用 load_worldbook 搜索关键词条目
3. 常开条目编号有跳跃是正常的（例如 0012 直接到 0030），照常顺序往下读就行

### NSFW 规范
- 涉及 NSFW 的词汇禁止省略，必须直白、粗鲁地表述，例如"鸡巴""乳房""阴道""翘臀""阴唇"！禁止用"轮廓""线条""浊液""巨物"等代替。
- 涉及 NSFW 的部位要重点描写。例如：阴道吸着鸡巴。
- 涉及 NSFW 场景要刻画细节、动作，避免隐喻、戛然而止，要用有画面感的语句。
- {{user}} 态度温柔，做有温度的 S

### 📁 项目参考
- 卡片仓库: .pi/cards/<cardId>/
- 世界书常开设定: .pi/cards/<cardId>/worldbook/[常开]设定/
- 世界书触发词条: .pi/cards/<cardId>/worldbook/[触发]关键词/
- 角色状态: state.json（用 read_state 读取，update_state 更新）
- 输出格式参考: APPEND_SYSTEM.md（自动附加到用户消息末尾）

### 🔄 迷失恢复
当你对当前剧情/地点/角色状态感到不确定时：
1. read_state 查看全局状态（当前时间、地点、角色变量）
2. load_constant_worldbook start=1 重读常开设定找回上下文
3. 检查 update_state 记录判断上一轮发生了什么
4. 不要猜测或编造——用工具确认后再行动

## 世界书快速索引
${indexText || "（无世界书索引）"}
${constantContent}
`;

  return _cachedStablePrefix;
}

/**
 * before_agent_start: 注入纯静态系统提示
 *
 * ★ 缓存策略：system prompt 全部为静态内容（规则+世界书），session 内哈希不变，
 *    LLM 提供商缓存 100% 命中，每轮只传对话历史和新消息的 token。
 *    动态内容（状态、记忆检索、场景）改走 input 事件拼入用户消息。
 */
export function handleBeforeAgentStart(
  event: any,
  deps: BeforeAgentDeps
): { systemPrompt: string } | undefined {
  const worldbookDirs = getCardWorldbookDirs();
  const isFirstTurn = deps.userTurnCounter.value === 0;

  // ==================== 稳定前缀（可缓存，session 内不变） ====================

  // 规则 + 世界书索引，session 内只生成一次
  const cachePrefix = getStablePrefix(worldbookDirs);

  // ==================== 仅首轮附加内容 ====================

  const dynamicParts: string[] = [];

  // 首轮：项目报告 + 开场指令（仅首轮，后续靠对话历史）
  if (isFirstTurn) {
    const projectCwd = deps.stateDir?.current ? join(deps.stateDir.current, "..") : "";
    const projectReport = buildProjectReport(projectCwd, deps);
    const activeCards = getActiveCards();
    let startPrompt = "";
    if (activeCards.length > 0) {
      const cardNames = activeCards.map((c) => {
        const configPath = join(c.dir, "config.json");
        if (existsSync(configPath)) {
          try {
            const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
            return cfg.character?.name || c.id;
          } catch {}
        }
        return c.id;
      }).join("、");
      const cardIds = activeCards.map((c) => c.id).join("、");
      startPrompt = `
## 开始角色扮演
已加载角色卡：${cardNames} (${cardIds})
请先按顺序调用 load_constant_worldbook 读完所有常开世界书条目，
全部常开读完后，再根据需要使用 load_worldbook 搜索关键词条目。
使用 read_state 检查角色状态，update_state 更新进度。
`;
    }
    dynamicParts.push(projectReport + startPrompt);
  }

  // tavern 脚本系统消息（由 turn_start 预执行并缓存）
  if (_pendingTavernMessages && _pendingTavernMessages.length > 0) {
    dynamicParts.push(_pendingTavernMessages.join("\n\n"));
    _pendingTavernMessages = null; // 一次性消费
  }

  // ⭐ 角色 Agent 简报
  const agentBrief = consumeAgentBrief();
  if (agentBrief) {
    dynamicParts.push(agentBrief);
  }

  return {
    systemPrompt: event.systemPrompt + cachePrefix + dynamicParts.join("\n"),
  };
}
