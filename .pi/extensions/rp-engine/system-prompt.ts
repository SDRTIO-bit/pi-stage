/**
 * RP Engine - 系统提示构建（多卡片支持版）
 *
 * 负责构建注入到 AI 对话的系统提示，包含：
 * - 动态读取激活卡片的世界观和角色信息
 * - Token 预算管理（世界书内容硬上限 1500 token）
 * - Author Note 注入
 * - 多卡片融合提示
 */

import type { CardState } from "./types";
import type { WorldState } from "./game-types";
import { readWorldbookIndexMulti, estimateTokens, MAX_WORLDBOOK_TOKENS } from "./worldbook";
import { AuthorNote } from "./author-note";
import { getActiveCards, getCardName } from "./card-manager";

// ============================================================
// Token 预算常量
// ============================================================

const WORLD_BOOK_TOKEN_LIMIT = MAX_WORLDBOOK_TOKENS;

// ============================================================
// 世界书 Token 预算控制
// ============================================================

/**
 * 对世界书索引按 token 预算进行截断
 */
function truncateWorldbookToBudget(indexText: string): string {
  if (!indexText) return "";

  const tokens = estimateTokens(indexText);
  if (tokens <= WORLD_BOOK_TOKEN_LIMIT) return indexText;

  const ratio = WORLD_BOOK_TOKEN_LIMIT / tokens;
  const targetChars = Math.floor(indexText.length * ratio);

  const truncated = indexText.slice(0, targetChars);
  const lastNewline = truncated.lastIndexOf("\n\n");
  const cutPoint = lastNewline > 0 ? lastNewline : targetChars;

  return truncated.slice(0, cutPoint) + "\n\n(世界书索引已截断，超出 token 预算)";
}

// ============================================================
// 工具：判断 cardStates 中是否有实际角色数据
// ============================================================

/**
 * 提取角色数据中可显示的标量字段
 * 显示规则：直接取 number / 短 string / boolean，跳过嵌套对象
 */
function formatCharFields(charData: any): string {
  const parts: string[] = [];
  if (!charData || typeof charData !== "object") return "";

  for (const [key, value] of Object.entries(charData)) {
    if (key === "基本信息" || key === "当前状态" || key.startsWith("_")) continue;
    if (typeof value === "number") {
      parts.push(`${key}=${value}`);
    } else if (typeof value === "string" && value.length < 20) {
      parts.push(`${key}:${value}`);
    } else if (typeof value === "boolean") {
      parts.push(value ? `✅${key}` : "");
    }
  }

  const loc = charData?.当前状态?.所在地点;
  if (loc) parts.push(`📍${loc}`);

  return parts.join(" ");
}

/**
 * 检查 cardStates 中是否包含至少一个有角色的卡片。
 * 用于在空对象和旧格式之间正确回退。
 */
function hasCardStateCharacters(state: Record<string, any>): boolean {
  const cardStates = state.cardStates;
  if (!cardStates || typeof cardStates !== "object") return false;
  return Object.values(cardStates as Record<string, CardState>).some(
    card => card?.characters && typeof card.characters === "object" && Object.keys(card.characters).length > 0
  );
}

// ============================================================
// 角色状态概要构建
// ============================================================

/**
 * 从卡片状态中构建角色状态概要（schema 驱动）
 */
function buildCharacterSummary(cardId: string, card: CardState): string {
  const lines: string[] = [];
  const charNames = Object.keys(card.characters);

  if (charNames.length === 0) return "";

  lines.push(`### ${card.meta.name || cardId} (${charNames.length} 个角色)`);

  // 限制最多显示 15 个角色
  const displayNames = charNames.slice(0, 15);
  for (const name of displayNames) {
    const char = card.characters[name] as Record<string, any>;
    if (!char) continue;

    const displayName = char?.基本信息?.姓名 || name;
    const fields = formatCharFields(char);
    if (fields) {
      lines.push(`  - ${displayName}: ${fields}`);
    } else {
      lines.push(`  - ${displayName}`);
    }
  }

  if (charNames.length > 15) {
    lines.push(`  ... 及其他 ${charNames.length - 15} 个角色`);
  }

  return lines.join("\n");
}

// ============================================================
// 多卡片融合描述
// ============================================================

/**
 * 生成多卡片融合时的场景描述
 */
function buildFusionDescription(cardIds: string[]): string {
  if (cardIds.length <= 1) return "";

  const names = cardIds.map((id) => getCardName(id));
  const fusionMsg = `\n## 🌐 跨世界观融合模式
当前同时激活 ${cardIds.length} 个世界：${names.join("、")}。
这是一个跨界相遇的故事，不同世界的角色因为某种事件交织在一起。
请合理安排各世界角色的出场，注意世界观之间的差异和融合点。
`;

  return fusionMsg;
}

// ============================================================
// 系统提示构建
// ============================================================

/**
 * 构建注入到 AI 对话的系统提示（多卡片版）
 *
 * @param state 当前世界/角色状态（新格式：含 global + cardStates）
 * @param worldbookDirs 世界书目录路径数组
 * @param authorNote AuthorNote 实例
 * @returns 完整的系统提示文本
 */
export function buildSystemPrompt(
  state: Record<string, any>,
  worldbookDirs: string | string[],
  authorNote?: AuthorNote
): string {
  // 兼容处理
  const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];

  // 读取世界状态（新格式：state.global.世界；旧格式：state.世界）
  const world: WorldState | undefined =
    (state.global?.["世界"]) || state["世界"];

  // 世界书索引：多目录合并 + Token 截断
  const indexText = readWorldbookIndexMulti(dirs);
  const worldbookSection = indexText
    ? `\n## 世界书快速索引 (≤${WORLD_BOOK_TOKEN_LIMIT} tokens)\n${truncateWorldbookToBudget(indexText)}\n`
    : "";

  // 获取激活的卡片 id 列表（用于融合描述）
  const activeCards = getActiveCards();
  const activeCardIds = activeCards.map(c => c.id);

  let prompt = `## 角色扮演设定
${worldbookSection}

## 游戏世界状态
- 📅 当前日期：${world?.当前日期 || "?"}
- 📆 当前星期：${world?.当前星期 || ""}
- 🕐 当前时间：${world?.当前时间 || ""}
- 📍 当前位置：${world?.当前位置 || ""}

${buildFusionDescription(activeCardIds)}\n`;

  // 核心角色状态概要
  prompt += `\n## 核心角色当前状态概要\n`;

  if (hasCardStateCharacters(state)) {
    // 新格式：遍历所有卡片状态
    let hasChars = false;
    for (const [cardId, card] of Object.entries(state.cardStates as Record<string, CardState>)) {
      const summary = buildCharacterSummary(cardId, card);
      if (summary) {
        prompt += summary + "\n";
        hasChars = true;
      }
    }
    if (!hasChars) {
      prompt += "（暂无角色状态）\n";
    }
  } else {
    // 旧格式兼容：直接遍历顶层角色
    const charNames = Object.keys(state).filter(k => k !== '世界' && k !== '{{user}}' && k !== '_meta' && k !== 'global' && k !== 'cardStates');
    for (const name of charNames) {
      const char = state[name] as Record<string, any>;
      if (!char) continue;
      const displayName = char?.基本信息?.姓名 || name;
      const fields = formatCharFields(char);
      prompt += `  - ${displayName}: ${fields || "（无数据）"}\n`;
    }
  }

  // 角色扮演规则
  prompt += `
## 角色扮演规则
1. 严格按世界书设定行事，不自编造
2. 使用 read_state 工具检查角色状态（可指定 cardId 参数）
3. 每次回复结束时使用 update_state 工具更新角色变量（关系值、状态等根据互动质量变动）
4. 使用 load_worldbook 工具按需加载设定（可加 cardId 过滤）
5. 使用 advance_time 工具推进时间
6. 格式要求参考当前激活卡片的设定

## 输出长度要求
每次回复的正文（<content> 标签内）必须达到规定字数。
`;

  // Author Note 注入
  if (authorNote) {
    const noteText = authorNote.getInjectionText();
    prompt += `\n## 作者注\n${noteText}\n`;
  }

  return prompt;
}

/**
 * 构建用于周期性注入的系统提示（精简版，不含世界书索引）
 *
 * 在长对话中周期性注入，抵消上下文压缩造成的规则丢失。
 * 包含：当前状态摘要 + 核心规则提醒 + 工具使用 + Author Note
 */
export function buildCompactSystemPrompt(
  state: Record<string, any>,
  authorNote?: AuthorNote
): string {
  const world: WorldState | undefined =
    (state.global?.["世界"]) || state["世界"];

  let prompt = `[系统 · 状态刷新] 📅 ${world?.当前日期 || "?"} ${world?.当前星期 || ""} 🕐 ${world?.当前时间 || ""} 📍 ${world?.当前位置 || ""}\n`;

  // 遍历所有卡片的所有角色
  if (hasCardStateCharacters(state)) {
    for (const [cardId, card] of Object.entries(state.cardStates as Record<string, CardState>)) {
      const cardName = card.meta?.name || cardId;
      prompt += `\n## ${cardName}\n`;
      for (const [name, charData] of Object.entries(card.characters)) {
        const char = charData as Record<string, any>;
        if (!char) continue;
        const displayName = char?.基本信息?.姓名 || name;
        const fields = formatCharFields(char);
        prompt += fields ? `  - ${displayName}: ${fields}\n` : `  - ${displayName}\n`;
      }
    }
  } else {
    // 旧格式兼容
    const charNames = Object.keys(state).filter(k => k !== '世界' && k !== '{{user}}' && k !== '_meta' && k !== 'global' && k !== 'cardStates');
    for (const name of charNames) {
      const char = state[name] as Record<string, any>;
      if (!char) continue;
      const displayName = char?.基本信息?.姓名 || name;
      const fields = formatCharFields(char);
      prompt += `  - ${displayName}: ${fields || "（无数据）"}\n`;
    }
  }

  // 核心规则提醒（每次刷新时注入，抵消压缩）
  prompt += `
## 格式要求
- 严格按世界书设定行事，不自编造
- 第三人称有限视角，禁止 OOC / 元评价

## 工具要求
- 使用 read_state 检查状态，update_state 更新角色变量，load_worldbook 搜索关键词条目，load_constant_worldbook 按顺序读取常开设定，advance_time 推进时间
`;

  if (authorNote) {
    prompt += `\n${authorNote.getInjectionText()}\n`;
  }

  return prompt;
}
