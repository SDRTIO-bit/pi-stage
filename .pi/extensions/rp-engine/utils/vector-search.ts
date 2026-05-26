/**
 * RP Engine - 向量搜索工具
 *
 * 提供世界书条目的语义检索能力。
 * 双模式：
 *   - local: 基于词频的轻量语义搜索（无需外部 API）
 *   - api:   基于 text-embedding API 的向量搜索（需配置）
 *
 * 存储：向量索引保存在卡片目录的 vectors/ 下。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";

// ============================================================
// 类型定义
// ============================================================

/** 向量索引条目 */
export interface VectorIndexEntry {
  /** 条目唯一 ID（文件路径 hash） */
  id: string;
  /** 文件路径（相对于 worldbook） */
  path: string;
  /** 条目标题 */
  title: string;
  /** 条目全文 */
  content: string;
  /** 词频向量（word → count） */
  tf: Record<string, number>;
  /** 文本长度（用于归一化） */
  length: number;
}

/** 向量索引元数据 */
export interface VectorIndexMeta {
  version: number;
  cardId: string;
  builtAt: string;
  totalEntries: number;
  totalTokens: number;
  mode: "local" | "api";
}

/** 向量搜索结果 */
export interface VectorSearchResult {
  file: string;
  content: string;
  score: number;
  sourceCard: string;
}

// ============================================================
// 中文分词辅助（按字 + 双字组合，轻量级）
// ============================================================

/** 中文标点符号（分词时忽略） */
const CN_PUNCTUATION = /[，。、；：？！""''（）【】《》\s\n\r\t,.;:?!()\[\]{}"'\-_/\\]/g;

/** 提取文本特征词（中文按字 + 双字组合，英文按词） */
function extractFeatures(text: string): string[] {
  const cleaned = text.replace(CN_PUNCTUATION, " ").trim();
  if (!cleaned) return [];

  const features: string[] = [];

  // 英文单词（≥2 字符）
  const engWords = cleaned.match(/[a-zA-Z]{2,}/g);
  if (engWords) features.push(...engWords.map(w => w.toLowerCase()));

  // 中文字符（单个字）
  const cnChars = cleaned.match(/[一-鿿㐀-䶿]/g);
  if (cnChars) {
    // 单个字
    features.push(...cnChars);

    // 双字组合
    for (let i = 0; i < cnChars.length - 1; i++) {
      features.push(cnChars[i] + cnChars[i + 1]);
    }

    // 三字组合（重要概念往往三字）
    for (let i = 0; i < cnChars.length - 2; i++) {
      features.push(cnChars[i] + cnChars[i + 1] + cnChars[i + 2]);
    }
  }

  return features;
}

/** 从文本构建词频向量 */
function buildTF(text: string): Record<string, number> {
  const features = extractFeatures(text);
  const tf: Record<string, number> = {};
  for (const f of features) {
    tf[f] = (tf[f] || 0) + 1;
  }
  return tf;
}

// ============================================================
// 向量相似度计算
// ============================================================

/**
 * 计算两个词频向量的余弦相似度
 */
function cosineSimilarity(a: Record<string, number>, b: Record<string, number>): number {
  let dotProduct = 0;
  let magA = 0;
  let magB = 0;

  for (const [key, val] of Object.entries(a)) {
    magA += val * val;
    if (b[key]) dotProduct += val * b[key];
  }
  for (const val of Object.values(b)) {
    magB += val * val;
  }

  if (magA === 0 || magB === 0) return 0;
  return dotProduct / (Math.sqrt(magA) * Math.sqrt(magB));
}

// ============================================================
// 索引构建
// ============================================================

/**
 * 为卡片世界书构建本地向量索引
 *
 * @param cardDir 卡片目录路径
 * @param wbDir 世界书目录路径
 * @returns 构建的条目数，0 表示失败
 */
export function buildVectorIndex(cardDir: string, wbDir: string): number {
  if (!existsSync(wbDir)) return 0;

  const { readdirSync } = require("node:fs");
  const entries: VectorIndexEntry[] = [];
  const SEARCH_DIRS = ["世界观", "角色设定", "身体演化", "格式指令"];

  for (const subDir of SEARCH_DIRS) {
    const fullDir = join(wbDir, subDir);
    if (!existsSync(fullDir)) continue;
    try {
      for (const f of readdirSync(fullDir)) {
        if (!f.endsWith(".md")) continue;

        const filePath = join(fullDir, f);
        const content = readFileSync(filePath, "utf-8");
        const cleanContent = content.replace(/^---[\s\S]*?\n---\n?/, "").trim();
        if (!cleanContent) continue;

        const id = `${subDir}/${f}`;
        entries.push({
          id,
          path: `${subDir}/${f}`,
          title: f.replace(/\.md$/, ""),
          content: cleanContent.slice(0, 5000), // 限制单条最大长度
          tf: buildTF(cleanContent),
          length: cleanContent.length,
        });
      }
    } catch { /* 跳过不可读目录 */ }
  }

  if (entries.length === 0) return 0;

  // 保存索引文件
  const vectorsDir = join(cardDir, "vectors");
  mkdirSync(vectorsDir, { recursive: true });

  const meta: VectorIndexMeta = {
    version: 1,
    cardId: basename(cardDir),
    builtAt: new Date().toISOString(),
    totalEntries: entries.length,
    totalTokens: entries.reduce((s, e) => s + e.content.length, 0),
    mode: "local",
  };

  writeFileSync(join(vectorsDir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
  writeFileSync(join(vectorsDir, "index.json"), JSON.stringify(entries, null, 2), "utf-8");

  console.log(`[Vector] 已构建本地向量索引: ${entries.length} 条目 (卡片 ${basename(cardDir)})`);
  return entries.length;
}

// ============================================================
// 搜索
// ============================================================

/**
 * 从向量索引中搜索与查询最相关的条目
 *
 * @param query 搜索查询
 * @param vectorsDir 向量索引目录
 * @param topK 返回前 K 条（默认 5）
 * @returns 搜索结果
 */
export function searchVectorIndex(
  query: string,
  vectorsDir: string,
  topK: number = 5
): VectorSearchResult[] {
  const indexFile = join(vectorsDir, "index.json");
  if (!existsSync(indexFile)) return [];

  let entries: VectorIndexEntry[];
  try {
    entries = JSON.parse(readFileSync(indexFile, "utf-8"));
  } catch {
    return [];
  }

  if (entries.length === 0) return [];

  const queryTF = buildTF(query);
  const scored: { entry: VectorIndexEntry; score: number }[] = [];

  for (const entry of entries) {
    const score = cosineSimilarity(queryTF, entry.tf);
    if (score > 0) {
      scored.push({ entry, score });
    }
  }

  // 按分数降序排列
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK).map(({ entry, score }) => ({
    file: entry.path,
    content: entry.content,
    score,
    sourceCard: basename(vectorsDir.replace("/vectors", "").replace("\\vectors", "")),
  }));
}

/**
 * 检查卡片是否有向量索引
 */
export function hasVectorIndex(cardDir: string): boolean {
  return existsSync(join(cardDir, "vectors", "index.json"));
}

/**
 * 读取向量索引元数据
 */
export function readVectorMeta(cardDir: string): VectorIndexMeta | null {
  const metaFile = join(cardDir, "vectors", "meta.json");
  if (!existsSync(metaFile)) return null;
  try {
    return JSON.parse(readFileSync(metaFile, "utf-8"));
  } catch {
    return null;
  }
}
