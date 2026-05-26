/**
 * RP Engine - Turn 生命周期事件处理
 *
 * turn_start / turn_end
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeBridge } from "../runtime-integration";
import { buildCompactSystemPrompt } from "../system-prompt";
import { cleanupOldSessions } from "../utils/session-cleanup";
import { getActiveCardIds, getCardWorldbookDirs } from "../card-manager";
import { injectTriggeredWorldbook } from "../worldbook";
import type { CompiledRegexHook } from "../regex-processor";

// ============================================================
// 会话持久化：保存对话消息到 session JSONL 文件
// ============================================================

let _sessionFilePath: string | null = null;

/** 获取当前 session 文件路径（惰性初始化，每次 pi run 一个文件） */
function getSessionFilePath(stateDir: string): string | null {
  if (_sessionFilePath) return _sessionFilePath;
  try {
    const activeIds = getActiveCardIds();
    const subDir = activeIds.length === 1 ? activeIds[0] : activeIds.join("+");
    const sessionDirPath = join(stateDir, "sessions", subDir);
    mkdirSync(sessionDirPath, { recursive: true });
    const existing = readdirSync(sessionDirPath).filter(f => f.endsWith(".jsonl"));
    const fileName = existing.length > 0
      ? existing.sort().reverse()[0]
      : `rp-${Date.now()}.jsonl`;
    _sessionFilePath = join(sessionDirPath, fileName);
    return _sessionFilePath;
  } catch {
    return null;
  }
}

/** 写入一条会话记录到 session 文件 */
function appendSessionEntry(stateDir: string, event: any): void {
  const filePath = getSessionFilePath(stateDir);
  if (!filePath) return;
  try {
    const line = JSON.stringify({ type: "message", message: event }) + "\n";
    appendFileSync(filePath, line, "utf-8");
  } catch {}
}

/** 判断是否为系统 steer 消息（不应当被持久化或显示为对话内容） */
const STEER_PREFIXES = ['[系统', '[工具流程检查]', '[叙事校准]', '[当前状态同步]', '[扮演边界确认]', '[历史记录加载]'];
function isSteerMessage(content: any): boolean {
  const text = typeof content === 'string' ? content : '';
  return STEER_PREFIXES.some(p => text.startsWith(p));
}

export interface TurnDeps {
  configRef: { current: import("../config").RPConfig };
  store: import("../state-store").StateStore;
  rpWeb: ReturnType<typeof import("../rp-web-server").createRPWebServer>;
  runtime: RuntimeBridge;
  authorNote: import("../author-note").AuthorNote;
  userTurnCounter: { value: number };
  lastTotalTokens: { value: number };
  stateDir: { current: string };
  worldbookDir: { current: string };
  tavernRunner: import("../tavern-runner").TavernRunner;
  compiledHooks: { current: CompiledRegexHook[] };
}

/**
 * turn_end: 保存状态 + 记录 token 用量 + 清理旧 session + 用户轮数计数
 *
 * ⭐ 不再主动压缩上下文，由 pi 引擎原生压缩（global: 65）自行判断
 */
export async function handleTurnEnd(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  event: any,
  deps: TurnDeps
): Promise<void> {
  deps.store.saveState(true);
  deps.store.saveSessionSnapshot(pi);
  deps.userTurnCounter.value++;

  const msg = event?.message;
  if (msg?.role === "assistant" && msg?.usage?.totalTokens) {
    deps.lastTotalTokens.value = msg.usage.totalTokens;
  }

  // 持久化：保存助手消息到 session 文件
  if (msg) {
    appendSessionEntry(deps.stateDir.current, {
      role: "assistant",
      content: msg.content,
      usage: msg.usage,
    });
  }

  // Runtime 记忆存储
  await deps.runtime.storeMemory(msg);

  // Runtime world tick + 持久化
  deps.runtime.processTurnEnd(deps.userTurnCounter.value, deps.store);

  // 每 10 轮清理旧 session
  if (deps.userTurnCounter.value % 10 === 0) {
    const sessionsDir = join(deps.stateDir.current, "sessions");
    cleanupOldSessions(sessionsDir);
  }
}

/**
 * turn_start: 世界书注入 + Context Assembly Engine 上下文装配
 */
export async function handleTurnStart(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  event: any,
  deps: TurnDeps
): Promise<void> {
  deps.rpWeb.broadcastToRP({ type: "event", event: { type: "turn_start", ...event } });

  // 持久化：保存用户消息到 session 文件（过滤系统 steer 消息）
  const userContent = event?.message?.content || '';
  if (userContent && !isSteerMessage(userContent)) {
    appendSessionEntry(deps.stateDir.current, { role: "user", content: userContent });
  }

  // 启动 Autonomous Runtime（首次 turn_start 时 boot）
  deps.runtime.ensureRunning();

  const state = deps.store.getState();

  // 判断是否启用 Runtime 模式
  deps.runtime.updateRuntimeMode(deps.userTurnCounter.value);

  // ★ 收集动态注入内容，通过 pi.sendUserMessage({ deliverAs: "steer" }) 发送
  // 替代原来注入 system prompt 的方式，保证 system prompt 完全固定以命中 prompt cache
  let steerParts: string[] = [];

  // ★ tavern_helper 脚本：执行 message 阶段脚本，收集系统消息
  try {
    const sysMessages = await deps.tavernRunner.runMessageScripts();
    if (sysMessages.length > 0) {
      steerParts.push(...sysMessages);
    }
  } catch (e) {
    console.warn('[RP] tavern_helper 脚本执行失败:', (e as Error).message);
  }

  if (deps.runtime.runtimeEnabled) {
    // Context Assembly Engine 动态装配
    const userMsg = event?.message?.content || '';
    const activeCardIds = getActiveCardIds();

    deps.runtime._lastUserMsg = userMsg;
    deps.runtime._lastActiveCardIds = activeCardIds;

    deps.runtime.assembleContext(userMsg, state, activeCardIds, deps.configRef.current)
      .then(prompt => {
        if (prompt) {
          pi.sendUserMessage(`[系统 · Context Assembly]\n${prompt}`, { deliverAs: "steer" });
        }
      });

    // 如果上次有缓存的结果，注入到本轮
    if (deps.runtime._pendingContextAssembly) {
      pi.sendUserMessage(`[系统 · Context Assembly]\n${deps.runtime._pendingContextAssembly}`, { deliverAs: "steer" });
      deps.runtime._pendingContextAssembly = null;
    }
  } else {
    // 世界书主动注入（关键词触发匹配）— 结果以 user message 形式注入
    injectWorldbookIfNeeded(event, pi, deps, steerParts);
  }

  // ⭐ 注意力刷新：每 5 轮注入一次模式中断消息，以 user message 形式发送
  if (deps.userTurnCounter.value > 0 && deps.userTurnCounter.value % 5 === 0) {
    try {
      const refreshText = buildAttentionRefresh(deps);
      if (refreshText) {
        steerParts.push(refreshText);
      }
    } catch (e) {
      console.warn('[RP] 注意力刷新注入失败:', (e as Error).message);
    }
  }

  // ★ 所有动态内容通过 pi.sendUserMessage({ deliverAs: "steer" }) 注入
  // 前端不显示，但 AI 能读取。不破坏 system prompt 的缓存。
  if (steerParts.length > 0) {
    const steerText = steerParts.join('\n\n');
    pi.sendUserMessage(steerText, { deliverAs: "steer" });
  }

}

/**
 * ⭐ 注意力刷新：构建模式中断消息
 *
 * 通过轮换不同的前缀/焦点/结构，防止 AI 对固定文本产生习惯化。
 * 每次注入的都是"不同的无关指令"——强制 AI 重新分配注意力。
 *
 * 4 种变体轮换：
 *   0 - 格式校准（字数 + choice + 对话占比）
 *   1 - 工具提醒（tool 使用流程）
 *   2 - 状态快照（纯状态，不加规则）
 *   3 - 扮演底线（OOC/视角/NSFW 底线）
 */
function buildAttentionRefresh(deps: TurnDeps): string {
  const state = deps.store.getState();
  const turn = deps.userTurnCounter.value;
  const variant = Math.floor(turn / 5) % 4; // 每 5 轮变一次，4 种轮换

  // 当前状态摘要（所有变体都包含，但位置不同）
  const stateLines = buildCompactSystemPrompt(state, deps.authorNote)
    .split('\n')
    .filter(l => l.startsWith('[系统') || l.startsWith('- ') || l.startsWith('## '))
    .slice(0, 6)
    .join('\n');

  const authorNoteText = deps.authorNote?.getInjectionText() || '';

  const variants = [
    // 变体 0：格式校准（以格式问题开头，打断叙事模式）
    `[叙事校准] 检查上一轮输出：<content>正文是否 800-1200 字？结尾 3-5 个 <choice>？对话占比 70% 以上？
如果任意一项不达标，本轮立即修正。

当前概况：
${stateLines}

${authorNoteText}`,

    // 变体 1：工具提醒（从问题切入）
    `[工具流程检查] 上一轮有没有漏掉 update_state？角色状态更新了吗？

强制流程：read_state 检查 → load_worldbook（新场景）→ 动笔 → update_state（更新角色变量 + 内心想法 + 地点）
每轮结束必须 update_state，根据卡片 variable_schema 更新对应属性。

${stateLines}`,

    // 变体 2：纯状态快照（没有规则，只有状态——和前后都不同）
    `[当前状态同步] 以下是所有角色的最新状态：
${stateLines}`,

    // 变体 3：扮演底线（从底线规则切入，而非流程）
    `[扮演边界确认]
- 禁止 OOC / 元评价 / 道歉
- 第三人称有限视角，只写 {{user}} 能看到听到的
- NSFW 词汇直白：鸡巴/乳房/阴道/阴唇，禁止替代表达
- 必须 <content> + 3-5 个 <choice>

${stateLines}

${authorNoteText}`,
  ];

  return variants[variant];
}

/**
 * 世界书主动注入（每 3 次用户交互一次）
 * ★ 改为通过 pi.sendUserMessage({ deliverAs: "steer" }) 注入
 * 常开条目已全量注入 system prompt，不再需要每轮轮换
 */
function injectWorldbookIfNeeded(
  event: any,
  pi: ExtensionAPI,
  deps: Pick<TurnDeps, "worldbookDir" | "userTurnCounter">,
  _steerParts: string[]
): void {
  const worldbookDirs = getCardWorldbookDirs();
  const searchDirs = worldbookDirs.length > 0 ? worldbookDirs : (deps.worldbookDir.current ? [deps.worldbookDir.current] : []);

  if (searchDirs.length === 0) return;

  // 注意：常开条目已全量注入 system prompt，这里只做关键词触发匹配
  // 简化：每 3 轮触发一次关键词匹配
  if ((deps.userTurnCounter.value + 1) % 3 !== 1) return;

  try {
    const userMsg = event?.message?.content || "";
    const recentContext: string[] = [];
    const injected = injectTriggeredWorldbook(userMsg, recentContext, searchDirs);
    if (injected) {
      pi.sendUserMessage(`[系统 · 关键词触发世界书]\n${injected}`, { deliverAs: "steer" });
    }
  } catch { /* 注入失败不影响主流程 */ }
}
