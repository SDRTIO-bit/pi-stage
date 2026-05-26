/**
 * RP Engine - Turn 生命周期事件处理
 *
 * turn_start / turn_end
 *
 * ⭐ 注意：世界书注入、状态摘要已迁移到 input 事件（lifecycle/input.ts）
 *    注意力刷新已由 ctx.compact(hint) + before_agent_start 替代
 *    turn_start 只保留：session 持久化、runtime 启动、Context Assembly
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeBridge } from "../runtime-integration";
import { cleanupOldSessions } from "../utils/session-cleanup";
import { getActiveCardIds } from "../card-manager";
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
 * turn_end: 保存状态 + 记录 token 用量 + 清理旧 session
 */
export async function handleTurnEnd(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  event: any,
  deps: TurnDeps
): Promise<void> {
  deps.store.saveState(true);
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
 * turn_start: 用户消息持久化 + Runtime 启动 + Context Assembly
 *
 * ⭐ 世界书注入和状态摘要已迁移到 input 事件。
 *    注意力刷新已移除，由 ctx.compact(hint) 替代。
 */
export async function handleTurnStart(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  event: any,
  deps: TurnDeps
): Promise<void> {
  deps.rpWeb.broadcastToRP({ type: "event", event: { type: "turn_start", ...event } });

  // 持久化：保存原始用户消息到 session 文件（input 事件可能已 prepend 上下文到 event.content）
  // 使用 event.__originalUserContent（由 input 事件保存），回退到 event.message.content
  const userContent = event?.__originalUserContent || event?.message?.content || '';
  if (userContent) {
    appendSessionEntry(deps.stateDir.current, { role: "user", content: userContent });
  }

  // 启动 Autonomous Runtime（首次 turn_start 时 boot）
  deps.runtime.ensureRunning();

  // 判断是否启用 Runtime 模式
  deps.runtime.updateRuntimeMode(deps.userTurnCounter.value);

  // taverness scripts → 预执行并缓存结果给 before_agent_start 消费
  try {
    const sysMessages = await deps.tavernRunner.runMessageScripts();
    if (sysMessages.length > 0) {
      // 使用动态 import 避免循环依赖（before-agent.ts 和 turn.ts 互相引用）
      const { setPendingTavernMessages } = await import("./before-agent");
      setPendingTavernMessages(sysMessages);
    }
  } catch (e) {
    console.warn('[RP] tavern_helper 脚本执行失败:', (e as Error).message);
  }

  // 世界书注入 → 已迁移到 input 事件
  // 注意力刷新 → 已由 ctx.compact(hint) 替代

  const state = deps.store.getState();

  if (deps.runtime.runtimeEnabled) {
    // Context Assembly Engine 动态装配（异步执行，结果以 steer 形式注入）
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

    if (deps.runtime._pendingContextAssembly) {
      pi.sendUserMessage(
        `[系统 · Context Assembly]\n${deps.runtime._pendingContextAssembly}`,
        { deliverAs: "steer" }
      );
      deps.runtime._pendingContextAssembly = null;
    }
  }
}
