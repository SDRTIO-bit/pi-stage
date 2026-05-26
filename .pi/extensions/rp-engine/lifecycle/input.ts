/**
 * RP Engine - input 事件处理器
 *
 * 替代之前的 turn_start steer 注入体系。
 * 在用户消息到达 agent 之前拦截并直接修改消息内容，零额外消息开销。
 *
 * 职责：
 * - 状态摘要（时间/地点）
 * - 关键词触发世界书（每 3 轮）
 * - tavern_helper 脚本输出 → 转到 before_agent_start 处理
 * - 注意力刷新 → 由 ctx.compact(hint) + before_agent_start 替代
 *
 * 注意：input 是阻塞事件，必须保持同步快速执行。
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getCardWorldbookDirs } from "../card-manager";
import { injectTriggeredWorldbook } from "../worldbook";

export interface InputDeps {
  store: import("../state-store").StateStore;
  userTurnCounter: { value: number };
  worldbookDir: { current: string };
}

/**
 * input: 在用户消息到达 agent 前拦截，直接拼上上下文内容
 *
 * ⭐ 替代了 turn_start 中的以下逻辑：
 *   - injectWorldbookIfNeeded() → 世界书直接拼入消息
 *   - buildAttentionRefresh() → 改为 ctx.compact(hint)
 *   - 所有 steer 消息 → 直接修改 event.content
 */
export function handleInput(
  event: any,
  _ctx: ExtensionContext,
  deps: InputDeps
): void {
  const originalContent = event?.content || event?.message?.content || "";
  if (!originalContent) return;

  const parts: string[] = [];

  // 1. 当前状态摘要（每轮都拼）
  try {
    const state = deps.store.getState();
    const world = state["世界"] || state.global?.世界 || {};
    if (world.当前日期 || world.当前时间 || world.当前位置) {
      parts.push(
        `📅 ${world.当前日期 || "?"} ${world.当前星期 || ""}` +
        ` 🕐 ${world.当前时间 || ""} 📍 ${world.当前位置 || "?"}`
      );
    }
  } catch { /* 静默 */ }

  // 2. 关键词触发世界书（每 3 轮，与原行为一致）
  try {
    if ((deps.userTurnCounter.value + 1) % 3 === 1) {
      const worldbookDirs = getCardWorldbookDirs();
      const searchDirs = worldbookDirs.length > 0
        ? worldbookDirs
        : (deps.worldbookDir.current ? [deps.worldbookDir.current] : []);

      if (searchDirs.length > 0) {
        const recentContext: string[] = [];
        const injected = injectTriggeredWorldbook(originalContent, recentContext, searchDirs);
        if (injected) {
          parts.push(injected);
        }
      }
    }
  } catch { /* 世界书注入失败不影响输入 */ }

  // 有上下文就拼到用户消息前面
  if (parts.length > 0) {
    // 保存原文供后续持久化使用（turn_start 写 session 文件时用原文）
    event.__originalUserContent = originalContent;

    const prefix = parts.join("\n\n");
    event.content = `${prefix}\n\n---\n${originalContent}`;
    if (event.message) {
      event.message.content = event.content;
    }
  }
}
