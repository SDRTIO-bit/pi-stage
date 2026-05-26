/**
 * worldbook_entries.json → 4 文件夹 .md 迁移脚本
 *
 * 按以下规则分拣条目：
 *   constant=true  disable=false → [常开]设定/  （游标轮换注入）
 *   constant=false disable=false → [触发]关键词/（关键词匹配注入）
 *   disable=true                 → 跳过
 *
 * 文件名 = {priority-padded}-{条目名}.md
 * 元数据写入 YAML front matter
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

const CARDS_DIR = ".pi/cards";

function safeName(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "") // 去掉非法字符
    .replace(/\s+/g, " ")
    .trim() || "未命名";
}

function buildFrontMatter(entry) {
  const lines = ["---"];
  if (entry.key?.length > 0) {
    lines.push(`keywords: [${entry.key.map(k => JSON.stringify(k)).join(", ")}]`);
  }
  if (entry.keysecondary?.length > 0) {
    lines.push(`secondary_keys: [${entry.keysecondary.map(k => JSON.stringify(k)).join(", ")}]`);
  }
  if (entry.position != null) lines.push(`position: ${entry.position}`);
  if (entry.selective != null) lines.push(`selective: ${entry.selective}`);
  if (entry.depth != null) lines.push(`depth: ${entry.depth}`);
  if (entry.useProbability) lines.push(`probability: ${entry.probability ?? 100}`);
  if (entry.characterFilter) {
    lines.push(`character_filter:`);
    lines.push(`  names: [${entry.characterFilter.names.map(n => JSON.stringify(n)).join(", ")}]`);
    if (entry.characterFilter.isExclude) lines.push(`  is_exclude: true`);
  }
  if (entry.group) lines.push(`group: ${JSON.stringify(entry.group)}`);
  if (entry.groupWeight != null) lines.push(`group_weight: ${entry.groupWeight}`);
  if (entry.matchWholeWords) lines.push(`match_whole_words: true`);
  if (entry.caseSensitive) lines.push(`case_sensitive: true`);
  lines.push("---");
  return lines.join("\n");
}

function getNumericPart(str) {
  const m = str.match(/^(\d+)/);
  return m ? parseInt(m[1], 10) : NaN;
}

function sortEntriesByPriority(entries) {
  return [...entries].sort((a, b) => {
    const pa = a.priority != null ? a.priority : a._rawIdx;
    const pb = b.priority != null ? b.priority : b._rawIdx;
    return pa - pb;
  });
}

function migrateCard(cardId, cardDir) {
  const jsonPath = join(cardDir, "worldbook", "worldbook_entries.json");
  if (!existsSync(jsonPath)) {
    console.log(`[${cardId}] 无 worldbook_entries.json，跳过`);
    return null;
  }

  const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const entries = raw.entries || raw;
  const total = Object.keys(entries).length;

  // 转为数组并注入 _rawIdx
  const allEntries = Object.entries(entries).map(([idx, e]) => ({
    ...e,
    _rawIdx: Number(idx),
    _comment: e.comment || `条目${idx}`,
  }));

  // 分拣
  const disabledConstant = allEntries.filter(e => e.disable === true && e.constant === true);
  const disabledTriggered = allEntries.filter(e => e.disable === true && e.constant !== true);
  const enabledConstant = allEntries.filter(e => e.disable !== true && e.constant === true);
  const enabledTriggered = allEntries.filter(e => e.disable !== true && e.constant !== true);

  // 按 priority 排序
  const sortedDisabledConstant = sortEntriesByPriority(disabledConstant);
  const sortedDisabledTriggered = sortEntriesByPriority(disabledTriggered);
  const sortedEnabledConstant = sortEntriesByPriority(enabledConstant);
  const sortedEnabledTriggered = sortEntriesByPriority(enabledTriggered);

  // 计算最大 priority 用于补零宽度（含禁用的，统一宽度）
  const allPriorities = [...sortedEnabledConstant, ...sortedEnabledTriggered, ...sortedDisabledConstant, ...sortedDisabledTriggered].map(e =>
    e.priority != null ? e.priority : e._rawIdx
  );
  const maxPriority = allPriorities.length > 0 ? Math.max(...allPriorities) : 0;
  const padWidth = Math.max(String(maxPriority).length, 3);

  // 目标目录
  const wbDir = join(cardDir, "worldbook");
  const dirs = {
    enabledConst: join(wbDir, "[常开]设定"),
    enabledTrig: join(wbDir, "[触发]关键词"),
    disabledConst: join(wbDir, "[禁用]常开设定"),
    disabledTrig: join(wbDir, "[禁用]触发词条"),
  };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

  let constCount = 0;
  let trigCount = 0;
  let disConstCount = 0;
  let disTrigCount = 0;

  function writeEntry(entry, targetDir, counter) {
    const pri = entry.priority != null ? entry.priority : entry._rawIdx;
    const prefix = String(pri).padStart(padWidth, "0");
    const name = safeName(entry._comment);
    const filename = `${prefix}-${name}.md`;
    const front = buildFrontMatter(entry);
    const content = entry.content || "";
    writeFileSync(join(targetDir, filename), `${front}\n\n${content}\n`, "utf-8");
    return counter + 1;
  }

  for (const entry of sortedEnabledConstant) constCount = writeEntry(entry, dirs.enabledConst, constCount);
  for (const entry of sortedEnabledTriggered) trigCount = writeEntry(entry, dirs.enabledTrig, trigCount);
  for (const entry of sortedDisabledConstant) disConstCount = writeEntry(entry, dirs.disabledConst, disConstCount);
  for (const entry of sortedDisabledTriggered) disTrigCount = writeEntry(entry, dirs.disabledTrig, disTrigCount);

  const report = {
    cardId,
    total,
    constant: constCount,
    triggered: trigCount,
    disabledConst: disConstCount,
    disabledTrig: disTrigCount,
  };

  console.log(
    `[${cardId}] ${total} 条 → 常开 ${constCount} + 触发 ${trigCount} + [禁用]常开 ${disConstCount} + [禁用]触发 ${disTrigCount}`
  );

  return report;
}

// ---- 主流程 ----
function main() {
  const cardsDir = join(process.cwd(), CARDS_DIR);
  if (!existsSync(cardsDir)) {
    console.error(`错误: ${cardsDir} 不存在，请在项目根目录运行`);
    process.exit(1);
  }

  const cardDirs = readdirSync(cardsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => ({ id: d.name, dir: join(cardsDir, d.name) }));

  if (cardDirs.length === 0) {
    console.log("未找到任何卡片目录");
    return;
  }

  console.log(`找到 ${cardDirs.length} 张卡片，开始迁移...\n`);
  const results = [];
  for (const card of cardDirs) {
    const r = migrateCard(card.id, card.dir);
    if (r) results.push(r);
  }

  console.log("\n--- 迁移完成 ---");
  const total = results.reduce((s, r) => s + r.total, 0);
  const enabled = results.reduce((s, r) => s + r.constant + r.triggered, 0);
  const disabled = results.reduce((s, r) => s + r.disabledConst + r.disabledTrig, 0);
  console.log(`总计 ${total} 条 → 启用 ${enabled} 个 .md + [禁用] ${disabled} 个 .md`);

  // 输出 .gitignore 建议
  console.log(`
注意:
  1. 执行后请 git add 新的 .md 文件并提交
  2. 原 worldbook_entries.json 暂不删除，确认迁移正确后再手动处理
`);
}

main();
