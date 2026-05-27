/**
 * RP Engine - 消息生命周期事件处理
 *
 * message_end: 应用正则钩子（prompt 剥离 + display 替换）+ 剥离 [Thought] 通道
 *
 * [Thought] 剥离原则：
 *   [Thought] 是角色的内心独白，属于"只有角色自己知道"的信息。
 *   它不能进入上下文窗口，否则 AI 会在下一轮看到自己之前的内心戏，导致角色串线。
 *   剥离后的版本进入对话历史，(Action)、<<Environment>>、Speech 保留。
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
 * 从内容中剥离 [Thought] 块
 *
 * 保护 <choice> 标签不被误伤，只剥离顶层 [...] 块
 */
function stripThoughtBlocks(text: string): string {
  // 保护 <choice> 标签内容
  const choices: string[] = [];
  text = text.replace(/<choice>[\s\S]*?<\/choice>/g, (m) => {
    choices.push(m);
    return `\x00THOUGHT_HOLDER_\x00${choices.length - 1}\x00`;
  });

  // 剥离 [Thought] 块 — 4 通道格式中 [...] 专用于内心独白
  text = text.replace(/\[[^\]]*\]\s*/g, '');

  // 恢复 choice 标签
  text = text.replace(/\x00THOUGHT_HOLDER_\x00(\d+)\x00/g, (_, i) => choices[parseInt(i)]);

  return text;
}

/** 递归剥离消息内容中的 [Thought] 块 */
function stripThoughtFromMessage(msg: any): void {
  if (!msg || msg.role !== "assistant") return;

  if (typeof msg.content === "string") {
    msg.content = stripThoughtBlocks(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === "text" && typeof block.text === "string") {
        block.text = stripThoughtBlocks(block.text);
      }
    }
  }
}

/**
 * message_end: 在消息最终确定后应用正则钩子 + 剥离 [Thought]
 */
export function handleMessageEnd(event: any, deps: MessageDeps): void {
  if (event?.message) {
    applyHooksToMessage(event.message, deps.compiledHooks.current);
    // [Thought] 剥离已暂停（隐式融合写作不需要剥离），函数保留方便日后恢复
    // stripThoughtFromMessage(event.message);
  }
}
