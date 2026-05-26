/**
 * 从 SillyTavern 卡片 JSON/PNG 导入 → 4 文件夹世界书结构
 *
 * 用法:
 *   node scripts/import-tavern-card.mjs <tavern-json-path> [卡片ID]
 *
 * 卡片 JSON 可以从 SillyTavern 的 export -> export character 获得（.json）
 * 或从 PNG 中提取的 character.json。
 *
 * 生成的目录结构:
 *   .pi/cards/<cardId>/
 *     config.json         ← 卡片元数据
 *     worldbook/
 *       [常开]设定/        ← constant=true 的条目, 文件名 = priority-条目名.md
 *       [触发]关键词/      ← constant=false 的条目
 *       [禁用]常开设定/    ← disable=true + constant=true
 *       [禁用]触发词条/    ← disable=true + constant=false
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

const CARDS_DIR = ".pi/cards";

function safeName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim() || "未命名";
}

function buildFrontMatter(entry) {
  const lines = ["---"];
  if (entry.keys?.length > 0) {
    lines.push(`keywords: [${entry.keys.map(k => JSON.stringify(k)).join(", ")}]`);
  }
  if (entry.secondary_keys?.length > 0) {
    lines.push(`secondary_keys: [${entry.secondary_keys.map(k => JSON.stringify(k)).join(", ")}]`);
  }
  if (entry.position != null) lines.push(`position: ${entry.position}`);
  if (entry.selective != null) lines.push(`selective: ${entry.selective}`);
  if (entry.depth != null) lines.push(`depth: ${entry.depth}`);
  if (entry.constant === true) lines.push(`constant: true`);
  if (entry.disabled === true) lines.push(`disabled: true`);
  if (entry.match_whole_words) lines.push(`match_whole_words: true`);
  if (entry.case_sensitive) lines.push(`case_sensitive: true`);
  lines.push("---");
  return lines.join("\n");
}

function importCard(tavernJsonPath, customId) {
  if (!existsSync(tavernJsonPath)) {
    console.error(`错误: 文件不存在 ${tavernJsonPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(tavernJsonPath, "utf-8"));
  const charData = raw.character || raw;
  const cardId = customId || charData.name || safeName(basename(tavernJsonPath).replace(/\.[^.]+$/, ""));

  // 创建卡片目录
  const cardDir = join(process.cwd(), CARDS_DIR, cardId);
  const wbDir = join(cardDir, "worldbook");
  mkdirSync(wbDir, { recursive: true });

  // --- config.json ---
  const config = {
    id: cardId,
    name: charData.name || cardId,
    description: charData.description || "",
    personality: charData.personality || "",
    scenario: charData.scenario || "",
    first_mes: charData.first_mes || "",
    avatar: charData.avatar || "none",
    imported_at: new Date().toISOString(),
  };
  writeFileSync(join(cardDir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
  console.log(`[${cardId}] config.json 已生成`);

  // --- 世界书 ---
  const book = charData.character_book || raw.character_book;
  if (!book || !book.entries || book.entries.length === 0) {
    console.log(`[${cardId}] 无世界书条目`);
    return;
  }

  const entries = book.entries;
  const maxPriority = entries.length > 0 ? Math.max(...entries.map(e => e.priority ?? 0)) : 0;
  const padWidth = Math.max(String(maxPriority).length, 3);

  // 分拣
  const groups = {
    enabledConst: [],
    enabledTrig: [],
    disabledConst: [],
    disabledTrig: [],
  };

  for (const entry of entries) {
    if (entry.disabled) {
      if (entry.constant) groups.disabledConst.push(entry);
      else groups.disabledTrig.push(entry);
    } else {
      if (entry.constant) groups.enabledConst.push(entry);
      else groups.enabledTrig.push(entry);
    }
  }

  // 排序
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => (a.priority ?? 9999) - (b.priority ?? 9999));
  }

  const dirMap = {
    enabledConst: join(wbDir, "[常开]设定"),
    enabledTrig: join(wbDir, "[触发]关键词"),
    disabledConst: join(wbDir, "[禁用]常开设定"),
    disabledTrig: join(wbDir, "[禁用]触发词条"),
  };

  let totalWritten = 0;
  for (const [key, dirPath] of Object.entries(dirMap)) {
    const list = groups[key];
    if (list.length === 0) continue;
    mkdirSync(dirPath, { recursive: true });

    for (const entry of list) {
      const pri = entry.priority != null ? entry.priority : 9999;
      const prefix = String(pri).padStart(padWidth, "0");
      const name = safeName(entry.comment || entry.name || `条目${pri}`);
      const filename = `${prefix}-${name}.md`;
      const front = buildFrontMatter(entry);
      const content = entry.content || "";
      writeFileSync(join(dirPath, filename), `${front}\n\n${content}\n`, "utf-8");
      totalWritten++;
    }
  }

  console.log(`[${cardId}] 世界书: ${totalWritten} 条
  常开设定: ${groups.enabledConst.length}
  触发关键词: ${groups.enabledTrig.length}
  禁用常开: ${groups.disabledConst.length}
  禁用触发: ${groups.disabledTrig.length}`);

  // 注册卡片到 registry
  const registryPath = join(process.cwd(), ".pi", "cards", "registry.json");
  let registry = { cards: {}, active: [] };
  if (existsSync(registryPath)) {
    try { registry = JSON.parse(readFileSync(registryPath, "utf-8")); } catch {}
  }
  registry.cards[cardId] = { id: cardId, dir: cardDir, imported_at: config.imported_at };
  writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
  console.log(`[${cardId}] 已注册到卡片仓库`);
  console.log(`\n使用 /card activate ${cardId} 激活`);
}

// ---- 主入口 ----
const args = process.argv.slice(2);
if (args.length === 0) {
  console.log(`用法: node scripts/import-tavern-card.mjs <tavern-json-path> [卡片ID]

示例:
  node scripts/import-tavern-card.mjs ~/Downloads/诡秘之主.json
  node scripts/import-tavern-card.mjs ./my-card.json 自定义ID
`);
  process.exit(0);
}

importCard(args[0], args[1]);
