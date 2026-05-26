/**
 * RP Engine - 世界书加载与主动注入(多卡片支持版)
 *
 * 提供世界书搜索、索引读取,以及基于上下文的主动注入机制:
 * - 支持多目录(来自不同卡片的世界书合并搜索)
 * - 关键词匹配搜索 + 来源卡片标记
 * - Token 预算控制(硬上限 1500 token)
 * - 条目去重(基于「来源卡片 + 文件路径」的 Set 追踪)
 * - 优先级排序(命中关键词越多越靠前)
 * - 冲突检测(不同卡片包含同名关键词时记录)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { searchVectorIndex, hasVectorIndex, type VectorSearchResult } from "./utils/vector-search";

// ============================================================
// Token 估算(独立实现,与 system-prompt.ts 保持一致)
// ============================================================

/** 中文文本 token 估算比率:1 token ≈ 1.5 个字符 */
const CN_CHARS_PER_TOKEN = 1.5;

/** 世界书主动注入的 token 硬上限（可由 .rpconfig.json 中 token_budget.worldbook_max 覆盖） */
export const MAX_WORLDBOOK_TOKENS = 12000;

/**
 * 估算文本的 token 数量
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cnChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(ch)) {
      cnChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cnChars / CN_CHARS_PER_TOKEN + otherChars / 4);
}

// ============================================================
// 搜索目录常量
// ============================================================

/** 世界书的搜索子目录 — 引擎只读这两个活跃文件夹 */
const ACTIVE_DIRS = ["[触发]关键词", "[常开]设定"];

// ============================================================
// 条目去重(按来源卡片 + 文件路径 联合去重)
// ============================================================

/** 去重 key = "cardId::filePath" */
function dedupKey(cardId: string, filePath: string): string {
  return `${cardId}::${filePath}`;
}

/**
 * 已注入条目追踪器
 */
class InjectedEntriesTracker {
  private injected: Set<string> = new Set();

  isInjected(cardId: string, filePath: string): boolean {
    return this.injected.has(dedupKey(cardId, filePath));
  }

  mark(cardId: string, filePath: string): void {
    this.injected.add(dedupKey(cardId, filePath));
  }

  markAll(entries: { cardId: string; file: string }[]): void {
    for (const e of entries) this.injected.add(dedupKey(e.cardId, e.file));
  }

  reset(): void {
    this.injected.clear();
  }

  get size(): number {
    return this.injected.size;
  }

  get all(): string[] {
    return Array.from(this.injected);
  }
}

// ============================================================
// WorldbookService — 封装世界书状态（追踪器 + 关键词索引）
// ============================================================

export class WorldbookService {
  readonly injectedTracker = new InjectedEntriesTracker();
  readonly cardKeywordIndexes: Map<string, KeywordIndex> = new Map();
  /** 按 priority 排序的 [常开]设定 条目缓存（每张卡片独立） */
  readonly cardConstantEntries: Map<string, WorldbookEntry[]> = new Map();
  /** 当前激活角色名列表（供 characterFilter 使用） */
  private activeCharacterNames: string[] = [];
  /** [常开]设定 游标（跨轮推进，到头回卷） */
  private _constantCursor: number = 0;

  resetInjectedEntries(): void {
    this.injectedTracker.reset();
  }

  getInjectedTracker(): InjectedEntriesTracker {
    return this.injectedTracker;
  }

  setActiveCharacterNames(names: string[]): void {
    this.activeCharacterNames = names;
  }

  buildAllCardIndexes(cardDirs: { id: string; dir: string }[]): void {
    this.cardKeywordIndexes.clear();
    this.cardConstantEntries.clear();
    this._constantCursor = 0;
    let kwCount = 0;
    let constCount = 0;

    for (const { id, dir } of cardDirs) {
      const wbDir = join(dir, "worldbook");
      if (!existsSync(wbDir)) continue;

      // 1. [触发]关键词 → 构建关键词索引
      const trigDir = join(wbDir, "[触发]关键词");
      if (existsSync(trigDir)) {
        const idx = buildKeywordIndexForCardDir(trigDir, id);
        if (idx.map.size > 0) {
          this.cardKeywordIndexes.set(id, idx);
          kwCount += idx.map.size;
        }
      }

      // 2. [常开]设定 → 按文件名排序缓存（文件名前缀 = priority）
      const constDir = join(wbDir, "[常开]设定");
      if (existsSync(constDir)) {
        const entries = loadConstantEntries(constDir, id, dir);
        if (entries.length > 0) {
          this.cardConstantEntries.set(id, entries);
          constCount += entries.length;
        }
      }
    }

    console.log(`[Worldbook] 索引已构建: ${this.cardKeywordIndexes.size} 张卡片, ${kwCount} 个关键词 + ${constCount} 条常开设定`);
  }

  extractKeywords(text: string): string[] {
    if (!text) return [];
    const allKeys = new Set<string>();
    for (const idx of this.cardKeywordIndexes.values()) {
      for (const kw of idx.map.keys()) allKeys.add(kw);
    }
    if (allKeys.size === 0) return [];
    // 用单次正则匹配替代 N 次 includes
    const escaped = [...allKeys].map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(escaped.join('|'), 'g');
    const matches = text.match(pattern);
    return matches ? [...new Set(matches)] : [];
  }

  /**
   * 注入世界书条目
   *
   * 策略：
   *   1. 从 [触发]关键词/ 匹配关键词，取命中条目（去重）
   *   2. 从 [常开]设定/ 按游标轮换取条目（常开条目不被标记"已注入"，每轮游标推进）
   *   3. 匹配条目优先分配 budget，剩余 budget 给常开条目
   */
  injectRelevantWorldbook(
    userMessage: string,
    existingContext: string[],
    worldbookDirs: string | string[]
  ): string {
    const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];
    if (dirs.length === 0) return "";

    const contextText = existingContext.join(" ");
    const combinedText = userMessage + " " + contextText;
    const keywords = this.extractKeywords(combinedText);

    // 1. 关键词匹配 — 扫描 [触发]关键词/ 目录
    const matchedResults = keywords.length > 0
      ? searchTriggeredDir(keywords, dirs, combinedText)
      : [];

    const newMatched = matchedResults.filter(
      (e) => !this.injectedTracker.isInjected(e.sourceCard, e.file)
    );
    newMatched.sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return (a.priority ?? 999) - (b.priority ?? 999);
    });

    // 2. 常开条目 — 从游标位置取（跨卡片展平为全局游标）
    const allConstants: WorldbookEntry[] = [];
    for (const entries of this.cardConstantEntries.values()) {
      allConstants.push(...entries);
    }

    // 3. 选条目：匹配优先 → 常开游标填充
    const selected: WorldbookEntry[] = [];
    let totalTokens = 0;
    const FORMAT_OVERHEAD = 120;

    // 3a. 匹配条目先选
    for (const entry of newMatched) {
      const effectiveTokens = totalTokens + entry.tokenEstimate + FORMAT_OVERHEAD;
      if (effectiveTokens > MAX_WORLDBOOK_TOKENS) break;
      selected.push(entry);
      totalTokens += entry.tokenEstimate;
    }

    // 3b. 常开条目从游标填充剩余 budget
    const totalAllConstants = allConstants.length;
    if (totalAllConstants > 0) {
      const cursorStart = this._constantCursor;
      let constantsTaken = 0;

      for (let i = 0; i < totalAllConstants; i++) {
        const idx = (cursorStart + i) % totalAllConstants;
        const entry = allConstants[idx];
        const effectiveTokens = totalTokens + entry.tokenEstimate + FORMAT_OVERHEAD;
        if (effectiveTokens > MAX_WORLDBOOK_TOKENS) continue;

        selected.push(entry);
        totalTokens += entry.tokenEstimate;
        constantsTaken++;
      }

      this._constantCursor = (cursorStart + constantsTaken) % totalAllConstants;
    }

    if (selected.length === 0) return "";

    // 日志：常开条目选中信息
    const constInjected = selected.filter(e => e.constant);
    const matchedInjected = selected.filter(e => !e.constant);
    if (constInjected.length > 0) {
      console.log(`[Worldbook] 游标 ${this._constantCursor - constInjected.length} → ${this._constantCursor} | 常开 ${constInjected.length} 条: [${constInjected.map(e => e.file.replace(/^\[常开\]设定\//, '')).join(', ')}]`);
    }
    if (matchedInjected.length > 0) {
      console.log(`[Worldbook] 关键词匹配 ${matchedInjected.length} 条`);
    }

    // 4. 标记已注入（仅关键词条目，常开条目不标记）
    this.injectedTracker.markAll(
      selected.filter(e => !e.constant).map((e) => ({ cardId: e.sourceCard, file: e.file }))
    );

    // 5. 格式化输出
    const parts: string[] = [];
    const cardCount = new Set(selected.map((e) => e.sourceCard)).size;
    parts.push(`\n---\n## 世界书注入(${selected.length} 条,来自 ${cardCount} 张卡片)\n`);

    const grouped = new Map<string, WorldbookEntry[]>();
    for (const entry of selected) {
      if (!grouped.has(entry.sourceCard)) grouped.set(entry.sourceCard, []);
      grouped.get(entry.sourceCard)!.push(entry);
    }

    for (const [cardId, entries] of grouped) {
      const cardName = entries[0].sourceCardName;
      parts.push(`### ${cardName} (${cardId})`);
      for (const entry of entries) {
        const tag = entry.constant ? "📌" : entry.hitCount >= 3 ? "🔴" : entry.hitCount >= 2 ? "🟡" : "🟢";
        parts.push(`#### ${tag} ${entry.file}`);
        parts.push(entry.content);
        parts.push("");
      }
    }

    return parts.join("\n");
  }
  /**
   * 仅触发关键词匹配注入（不含常开游标轮换）
   * ★ 常开条目已全量写入 system prompt，这里只返回匹配的触发词条目
   */
  injectTriggeredOnly(
    userMessage: string,
    existingContext: string[],
    worldbookDirs: string | string[]
  ): string {
    const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];
    if (dirs.length === 0) return "";

    const contextText = existingContext.join(" ");
    const combinedText = userMessage + " " + contextText;
    const keywords = this.extractKeywords(combinedText);
    if (keywords.length === 0) return "";

    // 关键词匹配 — 扫描 [触发]关键词/ 目录
    const matchedResults = searchTriggeredDir(keywords, dirs, combinedText);
    const newMatched = matchedResults.filter(
      (e) => !this.injectedTracker.isInjected(e.sourceCard, e.file)
    );
    newMatched.sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return (a.priority ?? 999) - (b.priority ?? 999);
    });

    if (newMatched.length === 0) return "";

    // 选条目：匹配条目在 budget 内选入
    const selected: WorldbookEntry[] = [];
    let totalTokens = 0;
    const FORMAT_OVERHEAD = 120;

    for (const entry of newMatched) {
      const effectiveTokens = totalTokens + entry.tokenEstimate + FORMAT_OVERHEAD;
      if (effectiveTokens > MAX_WORLDBOOK_TOKENS) break;
      selected.push(entry);
      totalTokens += entry.tokenEstimate;
    }

    if (selected.length === 0) return "";

    console.log(`[Worldbook] 关键词匹配(triggered only) ${selected.length} 条`);

    // 标记已注入
    this.injectedTracker.markAll(
      selected.map((e) => ({ cardId: e.sourceCard, file: e.file }))
    );

    // 格式化输出
    const parts: string[] = [];
    const cardCount = new Set(selected.map((e) => e.sourceCard)).size;
    parts.push(`\n---\n## 世界书注入(${selected.length} 条,来自 ${cardCount} 张卡片)\n`);

    const grouped = new Map<string, WorldbookEntry[]>();
    for (const entry of selected) {
      if (!grouped.has(entry.sourceCard)) grouped.set(entry.sourceCard, []);
      grouped.get(entry.sourceCard)!.push(entry);
    }

    for (const [cardId, entries] of grouped) {
      const cardName = entries[0].sourceCardName;
      parts.push(`### ${cardName} (${cardId})`);
      for (const entry of entries) {
        const tag = entry.hitCount >= 3 ? "🔴" : entry.hitCount >= 2 ? "🟡" : "🟢";
        parts.push(`#### ${tag} ${entry.file}`);
        parts.push(entry.content);
        parts.push("");
      }
    }

    return parts.join("\n");
  }

  injectTopWorldbook(userMessage: string, worldbookDirs: string | string[]): string {
    const dirs = Array.isArray(worldbookDirs) ? worldbookDirs : [worldbookDirs];
    if (dirs.length === 0) return "";

    const contextText = "";
    const combinedText = userMessage;
    const keywords = this.extractKeywords(userMessage);
    if (keywords.length === 0) return "";

    const results = searchTriggeredDir(keywords, dirs, combinedText);

    const filtered = results.filter(
      (e) => !this.injectedTracker.isInjected(e.sourceCard, e.file)
    ).sort((a, b) => {
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      return (a.priority ?? 999) - (b.priority ?? 999);
    });
    if (filtered.length === 0) return "";
    const top = filtered[0];
    this.injectedTracker.mark(top.sourceCard, top.file);
    return `\n---\n## 世界书参考 | ${top.sourceCardName} / ${top.file}\n${top.content}\n`;
  }

  // ============================================================
  // 向量搜索（语义搜索，回退到关键词搜索）
  // ============================================================

  /**
   * 搜索世界书，优先尝试向量搜索，回退到关键词搜索
   *
   * @param keyword 搜索关键字
   * @param vectorsDirs 卡片 vectors/ 目录路径数组
   * @param worldbookDirs 世界书目录路径数组
   * @param topK 返回条数上限
   */
  searchWorldbook(
    keyword: string,
    vectorsDirs: string[],
    worldbookDirs: string[],
    topK: number = 5
  ): { file: string; content: string; score: number; sourceCard: string }[] {
    const results: { file: string; content: string; score: number; sourceCard: string }[] = [];

    // 1. 尝试向量搜索（语义）
    for (const vDir of vectorsDirs) {
      if (!existsSync(vDir)) continue;
      const vecResults = searchVectorIndex(keyword, vDir, topK);
      results.push(...vecResults);
    }

    if (results.length > 0) {
      // 去重 + 按分数排序
      const seen = new Set<string>();
      const unique = results.filter((r) => {
        const key = `${r.sourceCard}::${r.file}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      unique.sort((a, b) => b.score - a.score);
      return unique.slice(0, topK);
    }

    // 2. 回退到关键词搜索
    const kwResults = findWorldbookFilesMulti(keyword, worldbookDirs);
    return kwResults.map((r) => ({
      file: r.file,
      content: r.content,
      score: 1,
      sourceCard: r.sourceCard,
    })).slice(0, topK);
  }
}

/** 模块级默认实例 */
let _defaultWorldbookService: WorldbookService | null = null;

export function initWorldbookService(): WorldbookService {
  if (!_defaultWorldbookService) {
    _defaultWorldbookService = new WorldbookService();
  }
  return _defaultWorldbookService;
}

export function resetInjectedEntries(): void {
  initWorldbookService().resetInjectedEntries();
}

export function getInjectedTracker(): InjectedEntriesTracker {
  return initWorldbookService().getInjectedTracker();
}

export function setActiveCharacterNames(names: string[]): void {
  initWorldbookService().setActiveCharacterNames(names);
}

// ============================================================
// 世界书条目类型(带来源卡片标记)
// ============================================================

/** 世界书搜索结果(带卡片来源 + SillyTavern 原始 metadata) */
export interface WorldbookEntry {
  /** 文件相对路径(如 "世界观/天作之合.md") */
  file: string;
  /** 文件内容 */
  content: string;
  /** 命中关键词数(用于优先级排序) */
  hitCount: number;
  /** 内容 token 估算 */
  tokenEstimate: number;
  /** 来源卡片 id */
  sourceCard: string;
  /** 来源卡片名称 */
  sourceCardName: string;
  /** 常开标记：不依赖关键词，始终注入 */
  constant?: boolean;
  /** 上下文插入位置（0=before_char, 1=after_char 等） */
  position?: number;
  /** 搜索深度（在多少条历史消息内搜关键词） */
  depth?: number;
  /** 选择性模式：开启后需同时命中 primary + secondary 关键词 */
  selective?: boolean;
  /** 二次关键词列表（selective=true 时使用） */
  secondaryKeys?: string[];
  /** 排序优先级（同位置组内，越小越优先） */
  priority?: number;
}

// ============================================================
// 冲突检测类型
// ============================================================

/** 冲突记录 */
export interface WorldbookConflict {
  /** 关键词 */
  keyword: string;
  /** 冲突涉及的卡片 */
  cards: string[];
  /** 各卡片中匹配到的文件 */
  files: { cardId: string; file: string }[];
}

// ============================================================
// 动态关键词索引(按卡片隔离)
// ============================================================

/**
 * 倒排索引:关键词 -> 匹配的文件列表
 * 每张卡片独立维护一份,避免串卡
 */
interface KeywordIndex {
  map: Map<string, { cardId: string; file: string; priority: number }[]>;
  cardId: string;
}

/** 按卡片 id 隔离的索引集合（通过 WorldbookService 管理） */
// 由 WorldbookService 实例管理，模块级声明保留仅用于向后兼容引用
// （实际通过 initWorldbookService() 获取默认实例的 map）

/**
 * 从 yaml front matter 中解析 keywords 数组
 * 格式:keywords: ["词1", "词2"]
 */
function parseYamlKeywords(content: string): string[] {
  return parseYamlFrontMatter(content).keywords;
}

/**
 * 从 yaml front matter 中解析 name 字段
 */
function parseYamlName(content: string): string {
  return parseYamlFrontMatter(content).name;
}

// ============================================================
// YAML Front Matter 完整解析
// ============================================================

interface WorldbookYamlMeta {
  name: string;
  keywords: string[];
  priority: number;
  selective: boolean;
  constant: boolean;
  position: number;
  depth: number;
  secondaryKeys: string[];
  disabled: boolean;
}

function parseYamlFrontMatter(content: string): WorldbookYamlMeta {
  const empty: WorldbookYamlMeta = {
    name: "", keywords: [], priority: 0, selective: true,
    constant: false, position: 1, depth: 4, secondaryKeys: [], disabled: false,
  };

  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return empty;
  const yaml = match[1];

  function getStr(key: string): string {
    const r = yaml.match(new RegExp(`^${key}:\\s*["']?([^"']+)["']?`, "m"));
    return r ? r[1].trim() : "";
  }
  function getNum(key: string, def: number): number {
    const r = yaml.match(new RegExp(`^${key}:\\s*(\\d+)`, "m"));
    return r ? parseInt(r[1]) : def;
  }
  function getBool(key: string, def: boolean): boolean {
    const r = yaml.match(new RegExp(`^${key}:\\s*(true|false)`, "m"));
    return r ? r[1] === "true" : def;
  }
  function getStrArr(key: string): string[] {
    const r = yaml.match(new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m"));
    if (!r) return [];
    return r[1].split(",").map(s => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  }

  return {
    name: getStr("name") || getStr("title"),
    keywords: getStrArr("keywords"),
    priority: getNum("priority", 0),
    selective: getBool("selective", true),
    constant: getBool("constant", false),
    position: getNum("position", 1),
    depth: getNum("depth", 4),
    secondaryKeys: getStrArr("secondary_keys"),
    disabled: getBool("disabled", false) || !getBool("enabled", true),
  };
}

/**
 * 从文件名中提取关键词
 * - 去掉 .md 后缀
 * - 按常见分隔符拆分
 * - 去掉前缀分类词
 */
function extractKeywordsFromFileName(fileName: string): string[] {
  const withoutExt = fileName.replace(/\.md$/, "");
  const cleaned = withoutExt.replace(
    /^\[.*?\]\s*|\d+\s*[-–—]\s*/g,
    ""
  );
  const parts = cleaned.split(/[\s\-·、,,]+/).filter(Boolean);
  return [...new Set([cleaned, ...parts])];
}

/**
 * 为单张卡片的 [触发]关键词 目录构建关键词倒排索引
 * 读取 .md 文件的 YAML front matter 提取 keywords + name
 */
function buildKeywordIndexForCardDir(dir: string, cardId: string): KeywordIndex {
  const index: KeywordIndex = { map: new Map(), cardId };
  if (!existsSync(dir)) return index;

  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const content = readFileSync(join(dir, f), "utf-8");
      const meta = parseYamlFrontMatter(content);
      const allKeywords = [...new Set([
        ...meta.keywords,
        ...(meta.name ? [meta.name] : []),
        ...extractKeywordsFromFileName(f),
      ].filter(Boolean))];

      for (const kw of allKeywords) {
        if (!index.map.has(kw)) index.map.set(kw, []);
        index.map.get(kw)!.push({ cardId, file: `[触发]关键词/${f}`, priority: meta.priority });
      }
    }
  } catch { /* skip unreadable dirs */ }
  return index;
}

/**
 * 加载 [常开]设定 目录的条目，按文件名排序
 */
function loadConstantEntries(dir: string, cardId: string, cardDir: string): WorldbookEntry[] {
  const entries: WorldbookEntry[] = [];
  if (!existsSync(dir)) return entries;

  const cardName = getCardNameFromDir(cardDir);

  try {
    const files = readdirSync(dir)
      .filter(f => f.endsWith(".md"))
      .sort(); // 文件名前缀 = priority 按字典序排序

    for (const f of files) {
      const content = readFileSync(join(dir, f), "utf-8");
      const meta = parseYamlFrontMatter(content);
      const body = content.replace(/^---[\s\S]*?\n---\n?/, "");
      entries.push({
        file: `[常开]设定/${f}`,
        content: body,
        hitCount: 0,
        tokenEstimate: estimateTokens(body),
        sourceCard: cardId,
        sourceCardName: cardName,
        constant: true,
        position: meta.position,
        depth: meta.depth,
        selective: meta.selective,
        secondaryKeys: meta.secondaryKeys,
        priority: meta.priority,
      });
    }
  } catch { /* skip */ }

  return entries;
}

/**
 * 为所有激活卡片构建关键词索引
 * 在 session_start 时调用
 */
export function buildAllCardIndexes(cardDirs: { id: string; dir: string }[]): void {
  initWorldbookService().buildAllCardIndexes(cardDirs);
}

/**
 * 从文本中提取可用于匹配世界书的核心关键词
 * （通过 WorldbookService 委托）
 */
function extractKeywords(text: string): string[] {
  return initWorldbookService().extractKeywords(text);
}

// ============================================================
// 从目录名推断卡片 id
// ============================================================

/**
 * 从 worldbook 目录路径推断卡片 id
 * 目录结构: .pi/cards/<cardId>/worldbook
 */
function inferCardIdFromWorldbookDir(worldbookDir: string): string {
  const parent = basename(join(worldbookDir, ".."));
  return parent;
}

/**
 * 从卡片目录路径获取卡片名
 */
function getCardNameFromDir(cardDir: string): string {
  const configPath = join(cardDir, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.character?.name) return config.character.name;
    } catch { /* 忽略 */ }
  }
  return basename(cardDir);
}

// ============================================================
// 多目录世界书搜索
// ============================================================

/**
 * 按关键词搜索世界书文件(多目录版)
 * 返回每个命中的关键词数量、来源卡片及完整 metadata
 *
 * @param keywords 搜索关键词数组
 * @param worldbookDirs 世界书根目录数组(来自不同卡片)
 * @param combinedText 用户消息+上下文文本（用于 selective 二次关键词匹配）
 * @returns 搜索结果(含元数据)
 */
/**
 * 扫描 [触发]关键词/ 目录，匹配关键词条目
 * 只扫描每个 worldbook 目录下的 [触发]关键词/ 子目录
 */
function searchTriggeredDir(
  keywords: string[],
  worldbookDirs: string[],
  combinedText: string
): WorldbookEntry[] {
  if (keywords.length === 0) return [];
  const validKeywords = keywords.filter(kw => kw && kw.trim());
  if (validKeywords.length === 0) return [];
  const results: WorldbookEntry[] = [];

  for (const worldbookDir of worldbookDirs) {
    if (!existsSync(worldbookDir)) continue;

    const cardId = inferCardIdFromWorldbookDir(worldbookDir);
    const cardDir = join(worldbookDir, "..");
    const cardName = getCardNameFromDir(cardDir);
    const trigDir = join(worldbookDir, "[触发]关键词");
    if (!existsSync(trigDir)) continue;

    try {
      for (const f of readdirSync(trigDir)) {
        if (!f.endsWith(".md")) continue;
        const content = readFileSync(join(trigDir, f), "utf-8");
        const meta = parseYamlFrontMatter(content);
        if (meta.disabled) continue;

        const fileName = f.replace(".md", "");
        const filePath = `[触发]关键词/${f}`;
        const body = content.replace(/^---[\s\S]*?\n---\n?/, "");
        let hitCount = 0;
        let matchedByBody = false;

        // 从 YAML keywords 中匹配
        if (meta.keywords.length > 0) {
          for (const kw of validKeywords) {
            for (const mk of meta.keywords) {
              if (mk.includes(kw) || kw.includes(mk)) { hitCount++; break; }
            }
          }
        } else {
          // 无 YAML keywords 时按文件名匹配
          for (const kw of validKeywords) {
            if (!kw) continue;
            if (fileName.includes(kw)) { hitCount++; continue; }
            const shortName = fileName.replace(
              /^\[.*?\]\s*/g, ""
            ).trim();
            if (shortName.includes(kw)) { hitCount++; }
          }
        }

        // ★ 关键词/文件名没命中时，回退到正文匹配
        if (hitCount === 0) {
          const kw = validKeywords[0];
          if (kw && body.toLowerCase().includes(kw.toLowerCase())) {
            hitCount = 1;
            matchedByBody = true;
          }
        }

        if (hitCount === 0) continue;

        // selective: 二次关键词匹配（仅对非正文匹配的条目进行）
        if (!matchedByBody && meta.selective && meta.secondaryKeys.length > 0) {
          let secondaryHit = false;
          for (const sk of meta.secondaryKeys) {
            if (!sk) continue;
            if (combinedText.includes(sk)) { secondaryHit = true; break; }
          }
          if (!secondaryHit) continue;
        }

        results.push({
          file: filePath,
          content: body,
          hitCount,
          tokenEstimate: estimateTokens(body),
          sourceCard: cardId,
          sourceCardName: cardName,
          constant: false,
          position: meta.position,
          depth: meta.depth,
          selective: meta.selective,
          secondaryKeys: meta.secondaryKeys,
          priority: meta.priority,
        });
      }
    } catch { /* 跳过无法读取的目录 */ }
  }

  return results;
}

/** 旧名别名，保留兼容 */
function searchWorldbookMultiDir(
  keywords: string[],
  worldbookDirs: string[],
  combinedText?: string
): WorldbookEntry[] {
  return searchTriggeredDir(keywords, worldbookDirs, combinedText || "");
}

// ============================================================
// 冲突检测
// ============================================================

/**
 * 检测不同卡片世界书之间的关键词冲突
 * 同名关键词在不同卡片中出现即视为潜在冲突
 */
export function detectConflicts(
  entries: WorldbookEntry[]
): WorldbookConflict[] {
  const conflictMap = new Map<string, Set<string>>();
  const fileMap = new Map<string, { cardId: string; file: string }[]>();

  for (const entry of entries) {
    if (!conflictMap.has(entry.file)) {
      conflictMap.set(entry.file, new Set());
      fileMap.set(entry.file, []);
    }
    conflictMap.get(entry.file)!.add(entry.sourceCard);
    fileMap.get(entry.file)!.push({ cardId: entry.sourceCard, file: entry.file });
  }

  const conflicts: WorldbookConflict[] = [];
  for (const [keyword, cards] of conflictMap) {
    if (cards.size > 1) {
      conflicts.push({
        keyword,
        cards: Array.from(cards),
        files: fileMap.get(keyword) || [],
      });
    }
  }

  return conflicts;
}

// ============================================================
// 按关键词搜索世界书(兼容旧接口)
// ============================================================

/**
 * 按关键字搜索世界书文件(兼容旧接口,单目录版)
 * @deprecated 推荐使用 injectRelevantWorldbookMulti 获取多目录结果
 */
export function findWorldbookFiles(
  keyword: string,
  worldbookDir: string
): { file: string; content: string }[] {
  const normalizedKeyword = keyword
    .replace(/^\[.*?\]\s*/g, "")
    .trim();

  const results: { file: string; content: string }[] = [];

  for (const dir of ACTIVE_DIRS) {
    const fullDir = join(worldbookDir, dir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const f of readdirSync(fullDir)) {
        if (!f.endsWith(".md")) continue;
        const name = f.replace(".md", "");
        const shortName = name
          .replace(/^\[.*?\]\s*/g, "")
          .trim();
        if (
          name.includes(keyword) ||
          name.includes(normalizedKeyword) ||
          shortName.includes(normalizedKeyword)
        ) {
          const content = readFileSync(join(fullDir, f), "utf-8");
          results.push({ file: `${dir}/${f}`, content });
        }
      }
    } catch { /* 跳过 */ }
  }
  return results;
}

/**
 * 扫描 [常开]设定/ 目录，按文件名/正文模糊匹配
 * 常开条目没有 YAML keywords，靠文件名和正文匹配
 */
function searchConstantDirMulti(
  keyword: string,
  worldbookDirs: string[]
): WorldbookEntry[] {
  if (!keyword) return [];
  const kw = keyword.toLowerCase();
  const results: WorldbookEntry[] = [];

  for (const worldbookDir of worldbookDirs) {
    if (!existsSync(worldbookDir)) continue;

    const cardId = inferCardIdFromWorldbookDir(worldbookDir);
    const cardDir = join(worldbookDir, "..");
    const cardName = getCardNameFromDir(cardDir);
    const constDir = join(worldbookDir, "[常开]设定");
    if (!existsSync(constDir)) continue;

    try {
      for (const f of readdirSync(constDir)) {
        if (!f.endsWith(".md")) continue;
        const content = readFileSync(join(constDir, f), "utf-8");
        const meta = parseYamlFrontMatter(content);
        if (meta.disabled) continue;

        const fileName = f.replace(".md", "");
        const filePath = `[常开]设定/${f}`;
        const body = content.replace(/^---[\s\S]*?\n---\n?/, "");

        // 文件名匹配（去掉序号前缀）
        const shortName = fileName.replace(/^\d+-/, "").trim();
        if (!fileName.toLowerCase().includes(kw) && !shortName.toLowerCase().includes(kw) && !body.toLowerCase().includes(kw)) {
          continue;
        }

        results.push({
          file: filePath,
          content: body,
          hitCount: 0,
          tokenEstimate: estimateTokens(body),
          sourceCard: cardId,
          sourceCardName: cardName,
          constant: true,
          position: meta.position,
          depth: meta.depth,
          selective: meta.selective,
          secondaryKeys: meta.secondaryKeys,
          priority: meta.priority,
        });
      }
    } catch { /* 跳过 */ }
  }

  return results;
}

/**
 * 获取所有常开条目（按优先级排序）
 * 供 load_worldbook 无关键词时返回
 */
export function getAllConstantEntries(
  worldbookDirs: string[]
): { file: string; content: string; sourceCard: string; score: number; priority: number }[] {
  const results: { file: string; content: string; sourceCard: string; score: number; priority: number }[] = [];

  for (const worldbookDir of worldbookDirs) {
    if (!existsSync(worldbookDir)) continue;
    const cardId = inferCardIdFromWorldbookDir(worldbookDir);
    const constDir = join(worldbookDir, "[常开]设定");
    if (!existsSync(constDir)) continue;

    try {
      for (const f of readdirSync(constDir)) {
        if (!f.endsWith(".md")) continue;
        const content = readFileSync(join(constDir, f), "utf-8");
        const meta = parseYamlFrontMatter(content);
        if (meta.disabled) continue;
        const body = content.replace(/^---[\s\S]*?\n---\n?/, "");
        const num = parseInt(f.match(/(\d+)/)?.[1] || "9999", 10);
        results.push({
          file: `[常开]设定/${f}`,
          content: body,
          sourceCard: cardId,
          score: 0,
          priority: num,
        });
      }
    } catch { /* 跳过 */ }
  }

  results.sort((a, b) => a.priority - b.priority);
  return results;
}

/**
 * 按关键字 + 可选卡片 id 搜索世界书(多目录版)
 * 同时搜索 [触发]关键词/ 和 [常开]设定/ 两个目录
 *
 * 行为：
 *   - 无关键词 → 返回常开条目（按顺序），供 agent 浏览
 *   - 有关键词 → 常开匹配在前 + 触发词匹配在后，均按序号排序
 */
export function findWorldbookFilesMulti(
  keyword: string,
  worldbookDirs: string[],
  cardId?: string
): { file: string; content: string; sourceCard: string; score: number }[] {
  // 如果指定了卡片 id,过滤目录
  let dirs = worldbookDirs;
  if (cardId) {
    dirs = worldbookDirs.filter((d) => inferCardIdFromWorldbookDir(d) === cardId);
  }

  // ★ 无关键词 → 返回常开条目一览（按 priority 顺序，最多 10 条）
  if (!keyword || !keyword.trim()) {
    return getAllConstantEntries(dirs).slice(0, 10);
  }

  // 有关键词 → 同时搜索
  const triggered = searchWorldbookMultiDir([keyword], dirs);
  const constant = searchConstantDirMulti(keyword, dirs);

  // 合并，去重（按文件路径），常开在前、触发在后
  const seen = new Set<string>();
  const constantResults: { file: string; content: string; sourceCard: string; score: number }[] = [];
  const triggeredResults: { file: string; content: string; sourceCard: string; score: number }[] = [];

  for (const e of constant) {
    const key = `${e.sourceCard}:${e.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    constantResults.push({ file: e.file, content: e.content, sourceCard: e.sourceCard, score: 0 });
  }
  for (const e of triggered) {
    const key = `${e.sourceCard}:${e.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    triggeredResults.push({ file: e.file, content: e.content, sourceCard: e.sourceCard, score: 0 });
  }

  // 各自按文件名前缀序号排序
  const sortByNum = (a: { file: string }, b: { file: string }) => {
    const numA = parseInt(a.file.match(/(\d+)/)?.[1] || "9999", 10);
    const numB = parseInt(b.file.match(/(\d+)/)?.[1] || "9999", 10);
    return numA - numB;
  };
  constantResults.sort(sortByNum);
  triggeredResults.sort(sortByNum);

  return [...constantResults, ...triggeredResults];
}

// ============================================================
// 读取世界书索引(多目录版)
// ============================================================

/**
 * 读取世界书索引(单目录版,保留兼容)
 */
export function readWorldbookIndex(worldbookDir: string): string {
  const indexPath = join(worldbookDir, "索引.md");
  if (existsSync(indexPath)) {
    return readFileSync(indexPath, "utf-8");
  }
  return "";
}

/**
 * 读取多个世界书目录的合并索引
 */
export function readWorldbookIndexMulti(worldbookDirs: string[]): string {
  const parts: string[] = [];

  for (const worldbookDir of worldbookDirs) {
    if (!existsSync(worldbookDir)) continue;
    const cardName = getCardNameFromDir(join(worldbookDir, ".."));
    const indexPath = join(worldbookDir, "索引.md");
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, "utf-8");
      parts.push(`## 📇 ${cardName}\n${content}`);
    } else {
      // 无索引文件时生成简单目录
      parts.push(`## 📇 ${cardName}\n(无索引文件,以下为自动扫描)\n`);
      for (const dir of ACTIVE_DIRS) {
        const fullDir = join(worldbookDir, dir);
        if (!existsSync(fullDir)) continue;
        try {
          const files = readdirSync(fullDir).filter((f: string) => f.endsWith(".md"));
          if (files.length > 0) {
            parts.push(`### ${dir} (${files.length} 个文件)`);
            for (const f of files) {
              parts.push(`- ${f.replace(".md", "")}`);
            }
          }
        } catch { /* 跳过 */ }
      }
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ============================================================
// 主动注入逻辑(多目录版)
// ============================================================

/**
 * 基于用户消息和已有上下文,决定注入哪些世界书条目(多目录版)。
 * 通过 WorldbookService 委托。
 */
export function injectRelevantWorldbook(
  userMessage: string,
  existingContext: string[],
  worldbookDirs: string | string[]
): string {
  return initWorldbookService().injectRelevantWorldbook(userMessage, existingContext, worldbookDirs);
}

/**
 * 精简版主动注入:仅返回最高优先级的一条世界书条目
 */
export function injectTopWorldbook(
  userMessage: string,
  worldbookDirs: string | string[]
): string {
  return initWorldbookService().injectTopWorldbook(userMessage, worldbookDirs);
}

/**
 * 仅触发关键词匹配的世界书注入（不含常开游标轮换）
 * ★ 用于 turn.ts 中通过 pi.sendUserMessage 注入，常开条目已全量写入 system prompt
 */
export function injectTriggeredWorldbook(
  userMessage: string,
  existingContext: string[],
  worldbookDirs: string | string[]
): string {
  return initWorldbookService().injectTriggeredOnly(userMessage, existingContext, worldbookDirs);
}


/**
 * 注入常开世界书(从索引.md 的"常开设定"章节读取文件列表并加载内容)
 * 在 7 轮压缩后调用,确保 AI 始终有核心设定可用
 *
 * @param worldbookDirs 世界书根目录路径数组
 * @returns 格式化的注入文本;若无常开条目则返回空字符串
 */
export function injectAlwaysOnWorldbook(worldbookDirs: string[]): string {
  if (worldbookDirs.length === 0) return "";

  const parts: string[] = [];
  parts.push(`
---
## 世界书常开设定(压缩后重载)
`);

  for (const wbDir of worldbookDirs) {
    if (!existsSync(wbDir)) continue;
    const indexPath = join(wbDir, "索引.md");
    if (!existsSync(indexPath)) continue;

    const cardDir = join(wbDir, "..");
    const cardName = getCardNameFromDir(cardDir);
    const indexContent = readFileSync(indexPath, "utf-8");

    // 解析"常开设定"章节:匹配 ## 常开设定 到下一个 ## 或 文件末尾 之间的内容
    const alwaysOnMatch = indexContent.match(
      /## 常开设定[\s\S]*?(?=## |$)/

    );
    if (!alwaysOnMatch) continue;

    const sectionContent = alwaysOnMatch[0];
    // 提取所有反引号内的文件名(`xxx.md`)
    const filePattern = /`([^`]+?\.md)`/g;
    let fileMatch: RegExpExecArray | null;
    const loadedFiles: string[] = [];

    parts.push(`
### ${cardName}
`);

    while ((fileMatch = filePattern.exec(sectionContent)) !== null) {
      const fileName = fileMatch[1];
      // 在所有 ACTIVE_DIRS 中查找该文件
      let found = false;
      for (const subDir of ACTIVE_DIRS) {
        const filePath = join(wbDir, subDir, fileName);
        if (existsSync(filePath)) {
          const fileContent = readFileSync(filePath, "utf-8");
          // 跳过 yaml front matter
          const cleanContent = fileContent.replace(/^---[\s\S]*?\n---\n?/, "");
          parts.push(`#### ${fileName}
${cleanContent}
`);
          loadedFiles.push(subDir + "/" + fileName);
          found = true;
          break;
        }
      }
      if (!found) {
        parts.push(`(文件 ${fileName} 未找到)
`);
      }
    }

    if (loadedFiles.length === 0) {
      parts.push(`(无常开设定文件)
`);
    }
  }

  if (parts.length <= 1) return "";

  // 追加提醒:其他世界书从未被读取过
  parts.push(
    `---
` +
    `**提醒:以上是常开设定。除此之外,还有其他世界书条目(性爱规则/事件触发器/角色详情等)` +
    `在当前上下文中从未被加载过。请根据剧情进展,使用 load_worldbook 工具按需加载。**
`
  );

  return parts.join(`
`);
}

/**
 * 搜索世界书（优先向量语义搜索，回退关键词搜索）
 * 模块级封装，供 tools.ts 使用
 */
export function searchWorldbook(
  keyword: string,
  vectorsDirs: string[],
  worldbookDirs: string[]
): { file: string; content: string; score: number; sourceCard: string }[] {
  return initWorldbookService().searchWorldbook(keyword, vectorsDirs, worldbookDirs);
}