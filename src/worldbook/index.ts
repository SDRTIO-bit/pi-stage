// ============================================================
// 世界书系统
// ============================================================

import type { WorldbookEntry, WorldbookIndex } from "../types.js"
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, basename } from "node:path"

// ============================================================
// Token 估算
// ============================================================

const CN_CHARS_PER_TOKEN = 1.5
export const MAX_WORLDBOOK_TOKENS = 12000

export function estimateTokens(text: string): number {
  if (!text) return 0
  let cnChars = 0
  let otherChars = 0
  for (const ch of text) {
    if (/[一-鿿㐀-䶿豈-﫿　-〿＀-￯]/.test(ch)) cnChars++
    else otherChars++
  }
  return Math.ceil(cnChars / CN_CHARS_PER_TOKEN + otherChars / 4)
}

// ============================================================
// YAML Front Matter 解析
// ============================================================

interface WorldbookYamlMeta {
  name: string
  keywords: string[]
  priority: number
  constant: boolean
  disabled: boolean
}

function parseYamlFrontMatter(content: string): WorldbookYamlMeta {
  const empty: WorldbookYamlMeta = {
    name: "",
    keywords: [],
    priority: 0,
    constant: false,
    disabled: false,
  }
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return empty
  const yaml = match[1]
  return {
    name: (yaml.match(/(?:name|title):\s*["']?([^"'\n]+)["']?/m) || [])[1] || "",
    keywords: ((yaml.match(/keywords:\s*\[([^\]]*)\]/m) || [])[1] || "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean),
    priority: parseInt((yaml.match(/priority:\s*(\d+)/m) || [])[1] || "0"),
    constant: /constant:\s*true/m.test(yaml),
    disabled:
      /disabled:\s*true/m.test(yaml) ||
      (!/enabled:\s*true/m.test(yaml) && /enabled:\s*false/m.test(yaml)),
  }
}

const ACTIVE_DIRS = ["[触发]关键词", "[常开]设定"]

// ============================================================
// Worldbook class (内存API, 向后兼容)
// ============================================================

export class Worldbook {
  private entries: WorldbookEntry[] = []
  private index: WorldbookIndex = { constantEntries: [], triggerKeywords: new Map() }
  private worldbookDirs: string[] = []

  /** 设置文件系统目录（供文件API使用） */
  setDirs(dirs: string[]): void {
    this.worldbookDirs = dirs
  }

  /** 加载世界书条目（编程式，向后兼容） */
  load(entries: WorldbookEntry[]): void {
    this.entries = entries
    this.rebuildIndex()
  }

  /** 增量追加条目（不替换已有条目） */
  addEntries(entries: WorldbookEntry[]): void {
    this.entries.push(...entries)
    this.rebuildIndex()
  }

  /** 原地将知识类常开条目重分类为触发词条（修改 constant/category 后重建索引） */
  reclassifyKnowledge(isKnowledge: (entry: WorldbookEntry) => boolean): number {
    let count = 0
    for (const entry of this.entries) {
      if (entry.constant && entry.enabled && isKnowledge(entry)) {
        entry.constant = false
        entry.category = "触发词条"
        count++
      }
    }
    if (count > 0) this.rebuildIndex()
    return count
  }

  /** 合并文件系统中的世界书到内存 */
  loadFromFiles(worldbookDirs?: string[]): void {
    const dirs = worldbookDirs ?? this.worldbookDirs
    if (dirs.length === 0) return
    const converted: WorldbookEntry[] = []

    for (const wbDir of dirs) {
      if (!existsSync(wbDir)) continue
      for (const subDir of ACTIVE_DIRS) {
        const fullDir = join(wbDir, subDir)
        if (!existsSync(fullDir)) continue
        try {
          const files = readdirSync(fullDir).filter((f) => f.endsWith(".md"))
          for (const f of files) {
            const content = readFileSync(join(fullDir, f), "utf-8")
            const meta = parseYamlFrontMatter(content)
            if (meta.disabled) continue
            const body = content.replace(/^---[\s\S]*?\n---\n?/, "")
            converted.push({
              id: `${basename(join(wbDir, ".."))}/${f}`,
              name: meta.name || f.replace(".md", ""),
              keywords: meta.keywords,
              priority: meta.priority,
              constant: meta.constant || subDir === "[常开]设定",
              enabled: true,
              content: body,
              category: subDir === "[常开]设定" ? "常开设定" : "触发词条",
            })
          }
        } catch {
          /* skip */
        }
      }
    }

    this.entries = converted
    this.rebuildIndex()
  }

  private rebuildIndex(): void {
    const constant: WorldbookEntry[] = []
    const triggerMap = new Map<string, string[]>()

    for (const entry of this.entries) {
      if (!entry.enabled) continue

      if (entry.constant || entry.category === "常开设定") {
        constant.push(entry)
      }

      if (entry.keywords.length > 0) {
        for (const kw of entry.keywords) {
          const existing = triggerMap.get(kw.toLowerCase()) ?? []
          existing.push(entry.id)
          triggerMap.set(kw.toLowerCase(), existing)
        }
      }
    }

    constant.sort((a, b) => a.priority - b.priority)
    this.index = { constantEntries: constant, triggerKeywords: triggerMap }
  }

  /** 获取常开设定 */
  getConstantEntries(): WorldbookEntry[] {
    return this.index.constantEntries
  }

  /** 获取全部已加载条目（含常开 + 触发） */
  getAllEntries(): WorldbookEntry[] {
    return [...this.entries]
  }

  /** 获取触发条目（非 constant） */
  getTriggerEntries(): WorldbookEntry[] {
    return this.entries.filter((e) => !e.constant && e.category !== "常开设定")
  }

  /** 按关键词搜索触发词条 */
  searchByKeywords(text: string): WorldbookEntry[] {
    const lowerText = text.toLowerCase()
    const matchedIds = new Set<string>()

    for (const [keyword, ids] of this.index.triggerKeywords) {
      if (lowerText.includes(keyword)) {
        for (const id of ids) matchedIds.add(id)
      }
    }

    return this.entries.filter((e) => matchedIds.has(e.id)).sort((a, b) => b.priority - a.priority)
  }

  /** TF-IDF 相似度检索触发条目（双限制：top_k + max_tokens） */
  searchBySimilarity(query: string, opts?: { topK?: number; maxTokens?: number }): WorldbookEntry[] {
    const topK = opts?.topK ?? 3
    const maxTokens = opts?.maxTokens ?? 4000

    const triggerEntries = this.getTriggerEntries()
    if (triggerEntries.length === 0) return []

    const queryTokens = tokenizeCN(query)
    if (queryTokens.length === 0) return this.searchByKeywords(query).slice(0, topK)

    const docTokens = triggerEntries.map((e) => tokenizeCN(e.name + " " + e.content))

    // IDF
    const docCount = docTokens.length
    const df = new Map<string, number>()
    for (const tokens of docTokens) {
      for (const t of new Set(tokens)) {
        df.set(t, (df.get(t) ?? 0) + 1)
      }
    }

    // Score: cosine similarity on TF-IDF vectors
    const queryTf = termFrequency(queryTokens)
    const queryVector = tfidfVector(queryTf, df, docCount)

    const scored = triggerEntries.map((entry, i) => ({
      entry,
      score: cosineSimilarity(queryVector, tfidfVector(termFrequency(docTokens[i]), df, docCount)),
    }))

    scored.sort((a, b) => b.score - a.score)

    const results: WorldbookEntry[] = []
    let totalTokens = 0
    for (const { entry, score } of scored) {
      if (score <= 0) continue
      if (results.length >= topK) break
      const t = estimateTokens(entry.content)
      if (totalTokens + t > maxTokens) continue
      results.push(entry)
      totalTokens += t
    }

    return results
  }

  /** 获取世界书索引摘要 */
  getIndex(): { constantCount: number; triggerKeywordsCount: number } {
    return {
      constantCount: this.index.constantEntries.length,
      triggerKeywordsCount: this.index.triggerKeywords.size,
    }
  }
}

/** @deprecated 使用组合根 `createApp()` 或 `new Worldbook()` 替代 */
export const worldbook = new Worldbook()

// ============================================================
// TF-IDF 相似度检索 — 轻量级实现
// ============================================================

/** 中文 bigram 分词 + 英文/数字保留原词 */
function tokenizeCN(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    // 跳过标点和空白
    if (/[\s,，。！？、：；""''（）\(\)\[\]【】\-—…\.\,\!\?\s]/.test(ch)) {
      i++
      continue
    }
    // 英文/数字词：连续吞入
    if (/[a-zA-Z0-9_]/.test(ch)) {
      let word = ""
      while (i < text.length && /[a-zA-Z0-9_]/.test(text[i])) {
        word += text[i++]
      }
      if (word.length >= 2) tokens.push(word.toLowerCase())
      continue
    }
    // 中文字符：bigram
    if (i + 1 < text.length && /[一-鿿]/.test(text[i + 1]) && !/[\s,，。！？、：；""''（）\(\)\[\]【】\-—…]/.test(text[i + 1])) {
      tokens.push(text.slice(i, i + 2))
    } else {
      tokens.push(ch)
    }
    i++
  }
  return tokens
}

function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1)
  }
  // Normalize
  const len = tokens.length || 1
  for (const [k, v] of tf) {
    tf.set(k, v / len)
  }
  return tf
}

function tfidfVector(tf: Map<string, number>, df: Map<string, number>, docCount: number): Map<string, number> {
  const vec = new Map<string, number>()
  for (const [term, tfVal] of tf) {
    const docFreq = df.get(term) ?? 0
    const idf = Math.log((docCount + 1) / (docFreq + 1)) + 1
    vec.set(term, tfVal * idf)
  }
  return vec
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let magA = 0
  let magB = 0
  for (const [term, valA] of a) {
    dot += valA * (b.get(term) ?? 0)
    magA += valA * valA
  }
  for (const valB of b.values()) {
    magB += valB * valB
  }
  if (magA === 0 || magB === 0) return 0
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}
