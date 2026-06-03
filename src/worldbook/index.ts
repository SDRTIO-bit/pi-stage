// ============================================================
// 世界书系统 — 统一版（合并旧内存API + 新文件系统API）
//
// 两套API共存：
//   - 内存API: load/searchByKeywords/getConstantEntries/getIndex (向后兼容)
//   - 文件API: findWorldbookFilesMulti/getAllConstantEntries/readWorldbookIndexMulti (新)
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
// 文件搜索类型（区别于 WorldbookEntry）
// ============================================================

export interface WorldbookFileEntry {
  file: string
  content: string
  hitCount: number
  tokenEstimate: number
  sourceCard: string
  sourceCardName: string
  constant?: boolean
  position?: number
  depth?: number
  selective?: boolean
  secondaryKeys?: string[]
  priority?: number
}

interface WorldbookYamlMeta {
  name: string
  keywords: string[]
  priority: number
  constant: boolean
  disabled: boolean
}

// ============================================================
// YAML Front Matter 解析
// ============================================================

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

// ============================================================
// 卡片名推断
// ============================================================

function getCardNameFromDir(cardDir: string): string {
  const configPath = join(cardDir, "config.json")
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"))
      if (config.character?.name) return config.character.name
    } catch {
      /* ignore */
    }
  }
  return basename(cardDir)
}

// ============================================================
// 文件系统 API (from worldbook-new)
// ============================================================

const ACTIVE_DIRS = ["[触发]关键词", "[常开]设定"]

/**
 * 按关键词搜索世界书（多目录版）
 */
export function findWorldbookFilesMulti(
  keyword: string,
  worldbookDirs: string[],
  cardId?: string,
): { file: string; content: string; sourceCard: string; score: number }[] {
  const dirs = cardId
    ? worldbookDirs.filter((d) => {
        try {
          return basename(join(d, "..")) === cardId
        } catch {
          return false
        }
      })
    : worldbookDirs

  const results: { file: string; content: string; sourceCard: string; score: number }[] = []
  const seen = new Set<string>()

  for (const wbDir of dirs) {
    if (!existsSync(wbDir)) continue
    const sourceCard = basename(join(wbDir, ".."))
    for (const subDir of ACTIVE_DIRS) {
      const fullDir = join(wbDir, subDir)
      if (!existsSync(fullDir)) continue
      try {
        for (const f of readdirSync(fullDir)) {
          if (!f.endsWith(".md")) continue
          const name = f.replace(".md", "")
          if (!name.includes(keyword) && keyword) continue
          const key = `${sourceCard}::${subDir}/${f}`
          if (seen.has(key)) continue
          seen.add(key)
          const content = readFileSync(join(fullDir, f), "utf-8").replace(
            /^---[\s\S]*?\n---\n?/,
            "",
          )
          results.push({ file: `${subDir}/${f}`, content, sourceCard, score: 0 })
        }
      } catch {
        /* skip */
      }
    }
  }
  return results
}

/**
 * 获取所有常开条目（按文件名序号排序）
 */
export function getAllConstantEntries(
  worldbookDirs: string[],
): { file: string; content: string; sourceCard: string; score: number; priority: number }[] {
  const results: {
    file: string
    content: string
    sourceCard: string
    score: number
    priority: number
  }[] = []

  for (const wbDir of worldbookDirs) {
    if (!existsSync(wbDir)) continue
    const sourceCard = basename(join(wbDir, ".."))
    const constDir = join(wbDir, "[常开]设定")
    if (!existsSync(constDir)) continue
    try {
      for (const f of readdirSync(constDir)) {
        if (!f.endsWith(".md")) continue
        const content = readFileSync(join(constDir, f), "utf-8")
        const meta = parseYamlFrontMatter(content)
        if (meta.disabled) continue
        const body = content.replace(/^---[\s\S]*?\n---\n?/, "")
        const num = parseInt((f.match(/(\d+)/) || [])[1] || "9999", 10)
        results.push({
          file: `[常开]设定/${f}`,
          content: body,
          sourceCard,
          score: 0,
          priority: num,
        })
      }
    } catch {
      /* skip */
    }
  }

  return results.sort((a, b) => a.priority - b.priority)
}

/**
 * 读取多目录世界书索引
 */
export function readWorldbookIndexMulti(worldbookDirs: string[]): string {
  const parts: string[] = []
  for (const wbDir of worldbookDirs) {
    if (!existsSync(wbDir)) continue
    const cardName = getCardNameFromDir(join(wbDir, ".."))
    parts.push(`## ${cardName}`)
    for (const subDir of ACTIVE_DIRS) {
      const fullDir = join(wbDir, subDir)
      if (!existsSync(fullDir)) continue
      try {
        const files = readdirSync(fullDir).filter((f) => f.endsWith(".md"))
        if (files.length > 0) {
          parts.push(`### ${subDir} (${files.length} 个文件)`)
          for (const f of files) parts.push(`- ${f.replace(".md", "")}`)
        }
      } catch {
        /* skip */
      }
    }
    parts.push("")
  }
  return parts.join("\n")
}

/**
 * 获取所有激活卡片的合并常开设定内容
 */
export function getMergedConstantContent(worldbookDirs: string[]): string[] {
  const all = getAllConstantEntries(worldbookDirs)
  return all.map((e) => e.content)
}

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

  /** 按关键词搜索触发词条 */
  searchByKeywords(text: string): WorldbookEntry[] {
    const lowerText = text.toLowerCase()
    const matchedIds = new Set<string>()

    for (const [keyword, ids] of this.index.triggerKeywords) {
      if (lowerText.includes(keyword)) {
        for (const id of ids) matchedIds.add(id)
      }
    }

    return this.entries
      .filter((e) => matchedIds.has(e.id))
      .sort((a, b) => b.priority - a.priority)
  }

  /** 获取世界书索引摘要 */
  getIndex(): { constantCount: number; triggerKeywordsCount: number } {
    return {
      constantCount: this.index.constantEntries.length,
      triggerKeywordsCount: this.index.triggerKeywords.size,
    }
  }
}

// ============================================================
// 模块级辅助（向后兼容）
// ============================================================

/**
 * 初始化 Worldbook 服务（兼容旧调用）
 */
export function initWorldbookService(): {
  getConstantDirs: () => string[]
} {
  // 延迟引用，避免循环依赖
  return {
    getConstantDirs: () => {
      const { getCardWorldbookDirs } = require("../card-manager.js")
      return getCardWorldbookDirs()
    },
  }
}

export const worldbook = new Worldbook()
