/**
 * RP Engine - 消息生命周期事件处理
 *
 * message_end: 应用正则钩子（prompt 剥离 + display 替换）
 */

import { applyPromptHooks, type CompiledRegexHook } from "../regex-processor";

export interface MessageDeps {
  compiledHooks: { current: CompiledRegexHook[] };
}

/**
 * 对助理消息应用正则钩子
 * - prompt 钩子剥离的内容不会进入上下文
 * - display 钩子替换的内容由前端独立处理，引擎层不重复执行
 */
function applyHooksToMessage(msg: any, hooks: CompiledRegexHook[]): void {
  if (!msg || msg.role !== "assistant") return;
  if (hooks.length === 0) return;

  if (typeof msg.content === "string") {
    msg.content = applyPromptHooks(msg.content, hooks);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = applyPromptHooks(block.text, hooks);
      }
    }
  }
}

/**
 * message_end: 在消息最终确定后应用正则钩子
 */
export function handleMessageEnd(event: any, deps: MessageDeps): void {
  if (event?.message) {
    applyHooksToMessage(event.message, deps.compiledHooks.current);
  }
}
