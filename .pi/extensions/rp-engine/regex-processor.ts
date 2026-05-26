/**
 * RP Engine - 正则脚本处理器
 *
 * 加载激活卡片的原始正则脚本（regex_scripts/*.json），
 * 按阶段分类并应用：
 *   - promptOnly: 在消息发给 AI 前剥离匹配内容
 *   - display: 在消息发送给前端前替换匹配内容（如 SFW_IMG → img 标签）
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// 类型定义
// ============================================================

/** 原始 SillyTavern 正则脚本条目 */
interface RawRegexScript {
  scriptName: string;
  disabled: boolean;
  findRegex: string;    // "/pattern/flags" 格式
  replaceString: string;
  placement: number[];  // 1=display, 2=prompt
  promptOnly: boolean;
  markdownOnly: boolean;
  runOnEdit: boolean;
}

/** 编译后的正则钩子 */
export interface CompiledRegexHook {
  name: string;
  regex: RegExp;
  replacement: string;
  phase: "prompt" | "display";
}

// ============================================================
// SillyTavern 正则格式 → JavaScript RegExp
// ============================================================

/**
 * 将 SillyTavern 的 findRegex 编译为 RegExp。
 * 兼容两种格式：
 *   - ST 标准: "/pattern/flags" → new RegExp(pattern, flags)
 *   - 原始字符串: "pattern" → new RegExp(pattern, "g")
 */
function compileSTRegex(findRegex: string): RegExp | null {
  if (!findRegex) return null;
  // 优先匹配 /pattern/flags 格式
  const stMatch = findRegex.match(/^\/(.+)\/([gimsuy]*)$/);
  if (stMatch) {
    try {
      return new RegExp(stMatch[1], stMatch[2] || "g");
    } catch {
      return null;
    }
  }
  // fallback：原始正则字符串，直接编译（默认 flags: g）
  try {
    return new RegExp(findRegex, "g");
  } catch {
    return null;
  }
}

// ============================================================
// 加载卡片正则脚本
// ============================================================

/**
 * 从激活的卡片目录中加载所有正则脚本，编译为钩子列表
 *
 * @param activeCardDirs 激活卡片的目录路径数组（.pi/cards/<卡名>/）
 * @returns 编译后的正则钩子（按 phase 分类）
 */
export function loadRegexHooks(activeCardDirs: string[]): {
  prompt: CompiledRegexHook[];
  display: CompiledRegexHook[];
} {
  const promptHooks: CompiledRegexHook[] = [];
  const displayHooks: CompiledRegexHook[] = [];

  for (const cardDir of activeCardDirs) {
    const regexDir = join(cardDir, "regex_scripts");
    if (!existsSync(regexDir)) continue;

    try {
      for (const f of readdirSync(regexDir)) {
        if (!f.endsWith(".json")) continue;
        const rawScripts: RawRegexScript[] = JSON.parse(
          readFileSync(join(regexDir, f), "utf-8")
        );
        for (const script of rawScripts) {
          if (script.disabled) continue;

          const regex = compileSTRegex(script.findRegex);
          if (!regex) continue;

          const hook: CompiledRegexHook = {
            name: script.scriptName,
            regex,
            replacement: script.replaceString,
            phase: script.promptOnly ? "prompt" : "display",
          };

          if (script.promptOnly) {
            // prompt 阶段：通常用于剥离（replacement 为空字符串）
            promptHooks.push(hook);
          } else {
            displayHooks.push(hook);
          }
        }
      }
    } catch { /* 卡片正则目录无法读取 */ }
  }

  return { prompt: promptHooks, display: displayHooks };
}

// ============================================================
// 应用正则钩子
// ============================================================

/**
 * 对文本应用一系列正则钩子
 * prompt 阶段钩子通常用于剥离不必要的标签
 */
export function applyRegexHooks(
  text: string,
  hooks: CompiledRegexHook[]
): string {
  let result = text;
  for (const hook of hooks) {
    try {
      result = result.replace(hook.regex, hook.replacement);
    } catch { /* 正则执行错误，跳过 */ }
  }
  return result;
}

/**
 * 对文本应用所有 prompt 阶段钩子（剥离隐藏内容）
 */
export function applyPromptHooks(
  text: string,
  hooks: CompiledRegexHook[]
): string {
  const promptHooks = hooks.filter((h) => h.phase === "prompt");
  return applyRegexHooks(text, promptHooks);
}

/**
 * 对文本应用所有 display 阶段钩子（内容替换/渲染）
 */
export function applyDisplayHooks(
  text: string,
  hooks: CompiledRegexHook[]
): string {
  const displayHooks = hooks.filter((h) => h.phase === "display");
  return applyRegexHooks(text, displayHooks);
}
