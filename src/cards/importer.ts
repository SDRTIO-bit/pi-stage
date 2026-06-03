// ============================================================
// SillyTavern 卡片导入 — 完整版
//
// 支持格式：PNG（tEXt/zTXt/iTXt） / WEBP / JPEG / JSON
// 支持规范：V1（自动归一化） / V2 / V3
//
// 基于 tavern2agent extract_card.py + pi-stage-test setup.mjs
// ============================================================

import type { CardMeta } from "../types.js"
import * as fs from "node:fs"
import * as zlib from "node:zlib"
import * as path from "node:path"
import extractChunks from "png-chunks-extract"
import { decode as decodeTextChunk } from "png-chunk-text"

// ============================================================
// 类型
// ============================================================

export interface STV2Card {
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  tags: string[]
  creator: string
  character_version: string
  extensions: Record<string, unknown>
}

export interface STV3Card {
  spec: "chara_card_v3"
  spec_version: string
  name: string
  description: string
  personality: string
  scenario: string
  first_mes: string
  mes_example: string
  creator_notes: string
  system_prompt: string
  tags: string[]
  creator: string
  character_version: string
  extensions: Record<string, unknown>
  alternate_greetings: string[]
  data?: {
    name?: string
    description?: string
    personality?: string
    scenario?: string
    first_mes?: string
    mes_example?: string
    creator_notes?: string
    system_prompt?: string
    tags?: string[]
    creator?: string
    character_version?: string
    extensions?: Record<string, unknown>
    alternate_greetings?: string[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

export type ImportedCard = STV2Card | STV3Card

export interface CardImportResult {
  meta: CardMeta
  initialContent: string
  // 文件路径（仅 importCardFromFile 填充）
  cardDir?: string
  statePath?: string
  configPath?: string
  systemPath?: string
  worldbookDir?: string
  // 生成统计
  worldbookEntryCount: number
  regexHooksCount: number
  variableSchemaCount: number
  regexScriptsCount: number
  tavernScriptsCount: number
  remoteUrlsCount: number
  // 原始数据
  rawData?: Record<string, unknown>
  extracted?: Record<string, unknown>
}

export interface ImportOptions {
  projectCwd?: string
  cardName?: string
  cardsDir?: string
  skipRegistry?: boolean
}

// ============================================================
// 常量
// ============================================================

const ENCODING_CANDIDATES = ["utf-8", "gbk", "gb18030", "shift-jis", "windows1252"] as const

const ACTIVE_DIRS = ["[常开]设定", "[触发]关键词"] as const

let _extractChunksAvailable = true

// ============================================================
// 工具函数
// ============================================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function decodeBuffer(buf: Buffer, encoding: string): string {
  return Buffer.from(buf).toString(encoding as BufferEncoding)
}

function tryParseCardText(rawText: string): Record<string, unknown> | null {
  const trimmed = rawText.trim()

  // 方式1: 纯 JSON
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) } catch { /* fall through */ }
  }

  // 方式2: Base64（含 URL-safe 变体）
  const b64Candidates = [trimmed]
  if (trimmed.includes("-") || trimmed.includes("_")) {
    b64Candidates.push(trimmed.replace(/-/g, "+").replace(/_/g, "/"))
  }

  for (const b64 of b64Candidates) {
    try {
      const decoded = Buffer.from(b64, "base64")
      const utf8 = decoded.toString("utf-8")
      if (utf8.startsWith("{") || utf8.startsWith("[")) {
        return JSON.parse(utf8)
      }
      try {
        const decompressed = zlib.inflateSync(decoded)
        const decompUtf8 = decompressed.toString("utf-8")
        if (decompUtf8.startsWith("{") || decompUtf8.startsWith("[")) {
          return JSON.parse(decompUtf8)
        }
      } catch { /* not zlib */ }
    } catch { /* skip */ }
  }

  return null
}

function getNested(obj: Record<string, unknown>, p: string): unknown {
  return p.split(".").reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k], obj)
}

// ============================================================
// V1 归一化
// ============================================================

const V1_LEGACY_MAP: Record<string, string> = {
  char_name: "name",
  char_persona: "personality",
  char_greeting: "first_mes",
  world_scenario: "scenario",
  example_dialogue: "mes_example",
}

const V1_FLAT_FIELDS = [
  "name", "description", "personality", "scenario",
  "first_mes", "mes_example", "creator_notes", "system_prompt",
  "post_history_instructions", "alternate_greetings", "tags", "creator",
  "character_version", "extensions", "character_book",
]

function normalizeV1(card: Record<string, unknown>): Record<string, unknown> {
  const spec = card.spec as string | undefined
  if (spec === "chara_card_v2" || spec === "chara_card_v3") return card

  const data: Record<string, unknown> = {}

  for (const [old, newKey] of Object.entries(V1_LEGACY_MAP)) {
    if (old in card && !(newKey in card)) {
      data[newKey] = card[old]
    }
  }

  for (const field of V1_FLAT_FIELDS) {
    if (field in card && !(field in data)) {
      data[field] = card[field]
    }
  }

  if (typeof card.data === "object" && card.data !== null) {
    for (const [k, v] of Object.entries(card.data as Record<string, unknown>)) {
      if (!(k in data)) data[k] = v
    }
  }

  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data,
    _normalized_from_v1: true,
  }
}

// ============================================================
// PNG 解析（主路径：png-chunks-extract）
// ============================================================

interface PngChunkCandidate {
  keyword: string
  rawData: Buffer
  type: string
}

function parsePNGChunksExtract(raw: Buffer): Record<string, unknown> {
  let chunks: { name: string; data: Uint8Array }[]
  try {
    chunks = extractChunks(raw)
  } catch (e) {
    throw new Error(`PNG chunk 提取失败：${e instanceof Error ? e.message : String(e)}`)
  }

  const textChunkTypes = new Set(["tEXt", "zTXt", "iTXt"])
  const cardChunks: PngChunkCandidate[] = []

  for (const chunk of chunks) {
    if (!textChunkTypes.has(chunk.name)) continue

    let keyword: string
    let rawData: Buffer

    if (chunk.name === "tEXt") {
      try {
        const decoded = decodeTextChunk(chunk)
        keyword = decoded.keyword
        rawData = Buffer.from(decoded.text, "latin1")
      } catch {
        continue
      }
    } else if (chunk.name === "zTXt") {
      const data = Buffer.from(chunk.data)
      const nullPos = data.indexOf(0)
      if (nullPos < 0) continue
      keyword = data.slice(0, nullPos).toString("ascii")
      const cm = data[nullPos + 1]
      if (cm !== 0) continue
      try {
        rawData = zlib.inflateSync(data.slice(nullPos + 2))
      } catch {
        continue
      }
    } else {
      // iTXt
      const data = Buffer.from(chunk.data)
      let p = 0
      const kwEnd = data.indexOf(0, p)
      if (kwEnd < 0) continue
      keyword = data.slice(p, kwEnd).toString("ascii")
      p = kwEnd + 1
      const compFlag = data[p]
      p++
      const cmEnd = data.indexOf(0, p)
      if (cmEnd < 0) continue
      p = cmEnd + 1 // skip compression method
      const langEnd = data.indexOf(0, p)
      if (langEnd < 0) continue
      p = langEnd + 1 // skip language tag
      const transKwEnd = data.indexOf(0, p)
      if (transKwEnd < 0) continue
      p = transKwEnd + 1 // skip translated keyword
      const textBytes = data.slice(p)
      if (compFlag === 1) {
        try {
          rawData = zlib.inflateSync(textBytes)
        } catch {
          continue
        }
      } else {
        rawData = textBytes
      }
    }

    if (keyword === "chara" || keyword === "ccv3") {
      cardChunks.push({ keyword, rawData, type: chunk.name })
    }
  }

  if (cardChunks.length === 0) {
    throw new Error(
      "PNG 文件中未找到角色卡数据。" +
      '请确认此 PNG 是由 SillyTavern 导出的角色卡（需包含 "chara" 或 "ccv3" 元数据）。',
    )
  }

  const candidates: { parsed: Record<string, unknown>; score: number; source: string }[] = []

  for (const { keyword, rawData, type } of cardChunks) {
    const encodings = type === "iTXt" ? ["utf-8"] : ENCODING_CANDIDATES

    for (const enc of encodings) {
      try {
        const text = decodeBuffer(rawData, enc)
        const parsed = tryParseCardText(text)
        if (parsed) {
          const garbledCount = (text.match(/�/g) || []).length
          candidates.push({ parsed, score: garbledCount, source: `${keyword}(${type})/${enc}` })
        }
      } catch { /* skip */ }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      "无法解析 PNG 中的角色卡数据。" +
      `已尝试 ${cardChunks.length} 个文本 chunk、多种编码组合，均无法提取有效 JSON。`,
    )
  }

  candidates.sort((a, b) => a.score - b.score)
  return candidates[0].parsed
}

// ============================================================
// PNG 解析（兜底：手动字节扫描）
// ============================================================

function parsePngTextChunks(raw: Buffer): Map<string, string> {
  const texts = new Map<string, string>()
  if (!raw.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error("不是合法的 PNG 文件")
  }

  let pos = 8
  while (pos < raw.length - 8) {
    if (pos + 8 > raw.length) break
    const length = raw.readUInt32BE(pos)
    const type = raw.toString("ascii", pos + 4, pos + 8)
    const data = raw.slice(pos + 8, pos + 8 + length)
    pos += 8 + length + 4

    try {
      if (type === "tEXt") {
        const nullIdx = data.indexOf(0)
        if (nullIdx < 0) continue
        const keyword = data.toString("latin1", 0, nullIdx)
        const value = data.toString("latin1", nullIdx + 1)
        texts.set(keyword, value)
      } else if (type === "zTXt") {
        const nullIdx = data.indexOf(0)
        if (nullIdx < 0) continue
        const keyword = data.toString("latin1", 0, nullIdx)
        const compMethod = data[nullIdx + 1]
        if (compMethod === 0) {
          texts.set(keyword, zlib.inflateSync(data.slice(nullIdx + 2)).toString("latin1"))
        }
      } else if (type === "iTXt") {
        const nullIdx = data.indexOf(0)
        if (nullIdx < 0) continue
        const keyword = data.toString("utf8", 0, nullIdx)
        const compFlag = data[nullIdx + 1]
        const compMethod = data[nullIdx + 2]
        let rest = data.slice(nullIdx + 3)
        const langEnd = rest.indexOf(0)
        rest = rest.slice(langEnd + 1)
        const transEnd = rest.indexOf(0)
        const payload = rest.slice(transEnd + 1)
        const value = compFlag && compMethod === 0
          ? zlib.inflateSync(payload).toString("utf8")
          : payload.toString("utf8")
        texts.set(keyword, value)
      } else if (type === "IEND") {
        break
      }
    } catch {
      continue
    }
  }

  return texts
}

function extractFromPng(raw: Buffer): Record<string, unknown> {
  let card: Record<string, unknown> | null = null

  try {
    card = parsePNGChunksExtract(raw)
  } catch {
    // 回退手动解析
    const texts = parsePngTextChunks(raw)
    for (const key of ["ccv3", "chara"]) {
      if (texts.has(key)) {
        const parsed = tryParseCardText(texts.get(key)!)
        if (parsed) { card = parsed; break }
      }
    }
  }

  if (!card) throw new Error("PNG 中未找到 chara/ccv3 文本块")
  return normalizeV1(card)
}

// ============================================================
// WEBP / JPEG 字节扫描
// ============================================================

function isBase64Char(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) ||
    (b >= 0x61 && b <= 0x7a) ||
    (b >= 0x30 && b <= 0x39) ||
    b === 0x2b || b === 0x2f || b === 0x3d ||
    b === 0x20 || b === 0x0a || b === 0x0d
  )
}

function scanForCard(raw: Buffer): Record<string, unknown> | null {
  for (const marker of [
    Buffer.from("ccv3\x00"),
    Buffer.from("chara\x00"),
    Buffer.from("ccv3:"),
    Buffer.from("chara:"),
  ]) {
    const idx = raw.indexOf(marker)
    if (idx < 0) continue

    let start = idx + marker.length
    while (start < raw.length && [0x00, 0x20, 0x09, 0x0a, 0x0d].includes(raw[start])) start++

    let end = start
    while (end < raw.length && isBase64Char(raw[end])) end++

    const b64 = raw.slice(start, end).filter((b) => b !== 0x20 && b !== 0x0a && b !== 0x0d)
    if (b64.length < 100) continue

    try {
      const json = JSON.parse(Buffer.from(b64).toString("base64"))
      if (json && typeof json === "object") return normalizeV1(json)
    } catch {
      continue
    }
  }

  // 回退：找原始 JSON
  for (const pattern of [
    Buffer.from('"spec":"chara_card'),
    Buffer.from('"chara_card_v'),
    Buffer.from('"data":{"name"'),
  ]) {
    const idx = raw.indexOf(pattern)
    if (idx < 0) continue

    const brace = raw.lastIndexOf(Buffer.from("{"), Math.max(0, idx - 500))
    if (brace < 0) continue

    const text = raw.toString("utf8", brace)
    let depth = 0
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "{") depth++
      else if (text[i] === "}") {
        depth--
        if (depth === 0) {
          try {
            const obj = JSON.parse(text.slice(0, i + 1))
            if (obj && typeof obj === "object" && ("data" in obj || "name" in obj || "char_name" in obj)) {
              return normalizeV1(obj)
            }
          } catch { /* skip */ }
          break
        }
      }
    }
  }

  return null
}

// ============================================================
// 分派：解析任意角色卡文件
// ============================================================

function parseCharacterCard(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`角色卡文件不存在: ${filePath}`)
  }

  const raw = fs.readFileSync(filePath)
  const ext = path.extname(filePath).toLowerCase()

  if (ext === ".png") return extractFromPng(raw as Buffer)
  if (ext === ".json") return normalizeV1(JSON.parse(raw.toString("utf8")))

  // Magic bytes 兜底
  if (raw.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return extractFromPng(raw as Buffer)
  }

  // WEBP / JPEG
  if (ext === ".webp" || ext === ".jpg" || ext === ".jpeg"
      || raw.slice(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    const card = scanForCard(raw as Buffer)
    if (!card) throw new Error("图片中未找到角色卡数据")
    return card
  }

  // 纯 JSON 文本
  const head = raw.toString("utf8", 0, Math.min(200, raw.length)).trimStart()
  if (head.startsWith("{")) {
    return normalizeV1(JSON.parse(raw.toString("utf8")))
  }

  throw new Error(`无法识别的文件格式: ${filePath}`)
}

// ============================================================
// 角色卡字段提取
// ============================================================

function extractCharacterData(card: Record<string, unknown>): {
  extracted: Record<string, unknown>
  missing: string[]
} {
  const source = (card.data as Record<string, unknown> | undefined) ?? card

  const fields = [
    "name", "description", "personality", "scenario",
    "first_mes", "mes_example", "system_prompt", "post_history_instructions",
    "creator_notes", "character_version",
  ]

  const extracted: Record<string, unknown> = {}
  const missing: string[] = []

  for (const f of fields) {
    const v = source[f]
    if (v !== undefined && v !== null && v !== "") {
      extracted[f] = v
    } else {
      if (f === "name" || f === "description") missing.push(f)
      extracted[f] = ""
    }
  }

  extracted.character_book = source.character_book || card.character_book || null

  const srcExt = source.extensions as Record<string, unknown> | undefined
  const cardExt = card.extensions as Record<string, unknown> | undefined
  extracted.regex_scripts = srcExt?.regex_scripts ?? cardExt?.regex_scripts ?? []
  extracted.tags = source.tags || card.tags || []

  let tavernHelper =
    srcExt?.tavern_helper ?? cardExt?.tavern_helper ??
    srcExt?.TavernHelper_scripts ?? cardExt?.TavernHelper_scripts ?? []
  if (Array.isArray(tavernHelper) && tavernHelper.length > 0 && Array.isArray(tavernHelper[0])) {
    const scriptsEntry = (tavernHelper as [string, unknown][]).find(
      (e) => Array.isArray(e) && e[0] === "scripts",
    )
    if (scriptsEntry) tavernHelper = scriptsEntry[1] ?? []
  }
  extracted.tavern_helper = tavernHelper

  extracted.spec = card.spec || ""
  extracted.spec_version = card.spec_version || ""
  extracted.create_date = card.create_date || new Date().toISOString()

  return { extracted, missing }
}

// ============================================================
// 世界书生成（character_book.entries → .md）
// ============================================================

function generateWorldbookEntries(
  characterData: Record<string, unknown>,
  charName: string,
  worldbookDir: string,
): number {
  const book = characterData.character_book as
    | { entries?: Array<Record<string, unknown>> }
    | undefined
  if (!book?.entries?.length) return 0

  const dirs = {
    constant: path.join(worldbookDir, "[常开]设定"),
    trigger: path.join(worldbookDir, "[触发]关键词"),
    disabledConst: path.join(worldbookDir, "[禁用]常开设定"),
    disabledTrigger: path.join(worldbookDir, "[禁用]触发词条"),
  }
  for (const d of Object.values(dirs)) ensureDir(d)

  let count = 0
  for (const entry of book.entries) {
    const enabled = entry.enabled !== false
    const constant = entry.constant === true

    const orderNum = ((entry.order ?? entry.insertion_order ?? count) as number) + 1
    const prefix = String(orderNum).padStart(4, "0")

    const targetDir = enabled
      ? (constant ? dirs.constant : dirs.trigger)
      : (constant ? dirs.disabledConst : dirs.disabledTrigger)

    const keys = entry.keys || entry.key || []
    const keywordList = Array.isArray(keys) ? keys as string[] : [keys as string]
    const entryContent = (entry.content as string) || ""
    const comment = (entry.comment || entry.name || `条目${count + 1}`) as string
    const priority = (entry.priority ?? entry.insertion_order ?? entry.order ?? count) as number
    const selective = (entry.selective !== undefined ? entry.selective : true) as boolean
    const secondaryKeys = ((entry.secondary_keys || entry.keysecondary || []) as string[])
    const position = ((entry.position ?? (constant ? 1 : undefined)) ?? 1) as number
    const depth = ((entry.depth ?? 4) as number)

    const safeName = comment.replace(/[<>:"/\\|?*]/g, "_").slice(0, 60)
    let fileName = `${prefix}-${safeName}.md`
    let filePath = path.join(targetDir, fileName)
    let suffix = 1
    while (fs.existsSync(filePath)) {
      filePath = path.join(targetDir, `${prefix}-${safeName}_${suffix}.md`)
      suffix++
    }

    const fmLines = [
      "---",
      `name: "${comment.replace(/"/g, '\\"')}"`,
      `keywords: [${keywordList.map((k) => `"${String(k).replace(/"/g, '\\"')}"`).join(", ")}]`,
      `priority: ${priority}`,
      `selective: ${selective}`,
      `constant: ${constant}`,
      `position: ${position}`,
      `depth: ${depth}`,
      `enabled: ${enabled}`,
      `source: "character_card:${charName}"`,
    ]
    if (secondaryKeys.length > 0) {
      fmLines.push(
        `secondary_keys: [${secondaryKeys.map((k) => `"${String(k).replace(/"/g, '\\"')}"`).join(", ")}]`,
      )
    }
    if (!enabled) fmLines.push("disabled: true")
    fmLines.push("---")

    fs.writeFileSync(filePath, `${fmLines.join("\n")}\n\n# ${comment}\n\n${entryContent}\n`, "utf-8")
    count++
  }

  return count
}

function generateCharacterDescriptionFile(
  characterData: Record<string, unknown>,
  charName: string,
  worldbookDir: string,
): void {
  const desc = (characterData.description as string) || ""
  const personality = (characterData.personality as string) || ""
  const scenario = (characterData.scenario as string) || ""
  const firstMes = (characterData.first_mes as string) || ""
  const mesExample = (characterData.mes_example as string) || ""
  const systemPrompt = (characterData.system_prompt as string) || ""

  const lines = [
    `# ${charName}`,
    "",
    "## 基本信息",
    `- 姓名: ${charName}`,
    characterData.creator_notes ? `- 创作者备注: ${characterData.creator_notes}` : "",
    characterData.character_version ? `- 角色版本: ${characterData.character_version}` : "",
    "",
    "## 描述",
    desc || "(无)",
    "",
    "## 性格",
    personality || "(无)",
    "",
    "## 场景",
    scenario || "(无)",
    "",
    "## 开场白",
    firstMes || "(无)",
    "",
    "## 示例对话",
    mesExample || "(无)",
    "",
    "## 系统提示",
    systemPrompt || "(无)",
  ]

  const content = lines.filter((l) => l !== undefined).join("\n")
  const safeName = charName.replace(/[<>:"/\\|?*]/g, "_")
  fs.writeFileSync(path.join(worldbookDir, `${safeName}_角色描述.md`), content, "utf-8")
}

function generateWorldbookJson(
  characterData: Record<string, unknown>,
  charName: string,
  worldbookDir: string,
): number {
  const book = characterData.character_book as
    | { entries?: Array<Record<string, unknown>> }
    | undefined
  if (!book?.entries?.length) return 0

  const entries: Record<string, unknown> = {}
  for (let i = 0; i < book.entries.length; i++) {
    const raw = book.entries[i]
    entries[i] = {
      ...raw,
      key: raw.key || raw.keys || [],
      keysecondary: raw.keysecondary || raw.secondary_keys || [],
      content: raw.content || "",
      comment: raw.comment || raw.name || `条目${i + 1}`,
      constant: raw.constant === true,
      disable: raw.disable !== undefined ? raw.disable : raw.enabled === false,
      selective: raw.selective !== undefined ? raw.selective : true,
      priority: raw.priority ?? raw.insertion_order ?? raw.order ?? i,
      position: raw.position ?? 1,
      depth: raw.depth ?? 4,
      probability: raw.probability ?? 100,
      order: raw.order ?? i,
      uid: raw.uid ?? i,
      displayIndex: raw.displayIndex ?? i,
      sticky: raw.sticky ?? 0,
      cooldown: raw.cooldown ?? 0,
      delay: raw.delay ?? 0,
    }
  }

  const jsonData = {
    source: `character_card:${charName}`,
    generatedAt: new Date().toISOString(),
    totalEntries: Object.keys(entries).length,
    entries,
  }

  fs.writeFileSync(
    path.join(worldbookDir, "worldbook_entries.json"),
    JSON.stringify(jsonData, null, 2),
    "utf-8",
  )
  return Object.keys(entries).length
}

// ============================================================
// State 生成（仅卡片原始数据，不含模板）
// ============================================================

function generateCardState(
  charName: string,
  characterData: Record<string, unknown>,
  statePath: string,
): void {
  const state: Record<string, unknown> = {
    name: charName,
    imported_at: new Date().toISOString(),
    source: "character_card",
  }
  for (const f of ["description", "personality", "scenario", "first_mes",
    "mes_example", "system_prompt", "post_history_instructions",
    "creator_notes", "character_version"]) {
    const v = characterData[f]
    if (v) state[f] = v
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8")
}

// ============================================================
// Config 生成（仅卡片元数据）
// ============================================================

function generateCardConfig(
  charName: string,
  characterData: Record<string, unknown>,
  configPath: string,
): void {
  const config: Record<string, unknown> = {
    character: {
      name: charName,
      imported_at: new Date().toISOString(),
    },
  }
  for (const f of ["system_prompt", "post_history_instructions", "scenario", "first_mes"]) {
    const v = characterData[f]
    if (v) config[f] = v
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8")
}

// ============================================================
// APPEND_SYSTEM.md 生成（仅卡片 system_prompt + first_mes）
// ============================================================

function generateCardSystemPrompt(
  charName: string,
  characterData: Record<string, unknown>,
  systemPath: string,
): void {
  const systemPrompt = (characterData.system_prompt as string) || ""
  const firstMes = (characterData.first_mes as string) || ""
  const scenario = (characterData.scenario as string) || ""

  const parts: string[] = [`# ${charName}`]
  if (scenario) parts.push("", `**场景：** ${scenario}`)
  if (systemPrompt) parts.push("", "## System Prompt", "", systemPrompt)
  if (firstMes) parts.push("", "## First Message", "", firstMes)

  fs.writeFileSync(systemPath, parts.join("\n"), "utf-8")
}

// ============================================================
// Regex 预处理
// ============================================================

function preprocessRegexScripts(
  regexScripts: Array<Record<string, unknown>>,
  cardDir: string,
): number {
  if (!regexScripts?.length) return 0

  const hooks: Array<Record<string, unknown>> = []

  for (const script of regexScripts) {
    if (script.disabled) continue

    const name = (script.scriptName as string) || ""
    if (name.includes("状态栏") || name.includes("[选项]") || name.includes("开场")) continue
    if (script.promptOnly) continue
    if (name.includes("对AI隐藏")) continue

    const findRegex = (script.findRegex as string) || ""
    const regexMatch = findRegex.match(/^\/(.+)\/([gimsuy]*)$/)
    if (!regexMatch) continue

    hooks.push({
      name,
      pattern: regexMatch[1],
      flags: regexMatch[2] || "g",
      replacement: script.replaceString || "",
      placement: script.placement || [1],
    })
  }

  if (hooks.length > 0) {
    fs.writeFileSync(
      path.join(cardDir, "regex_hooks.json"),
      JSON.stringify(hooks, null, 2),
      "utf-8",
    )
  }

  return hooks.length
}

function generateRegexScriptsFileToDir(
  regexScripts: Array<Record<string, unknown>>,
  charName: string,
  cardDir: string,
): number {
  if (!regexScripts?.length) return 0
  const regexDir = path.join(cardDir, "regex_scripts")
  ensureDir(regexDir)
  const safeName = charName.replace(/[<>:"/\\|?*]/g, "_")
  fs.writeFileSync(
    path.join(regexDir, `${safeName}.json`),
    JSON.stringify(regexScripts, null, 2),
    "utf-8",
  )
  return regexScripts.length
}

// ============================================================
// Tavern Helper 预处理
// ============================================================

function preprocessTavernScripts(
  tavernHelper: Array<Record<string, unknown>>,
  cardDir: string,
  statePath: string,
): number {
  if (!tavernHelper?.length) return 0

  const schemaScript = tavernHelper.find(
    (s) => s.name === "变量结构设计" || (s.name as string)?.includes("变量结构"),
  )
  if (!schemaScript) return 0

  const content = (schemaScript.content as string) || ""
  const charVariables: Record<string, Record<string, unknown>> = {}

  const charRegex = /(\S+):\s*z\.object\(\{([^}]*)\}/g
  let match
  while ((match = charRegex.exec(content)) !== null) {
    const cName = match[1].trim()
    if (cName === "世界") continue

    const fieldsBlock = match[2]
    const fields: Record<string, unknown> = {}
    const fieldRegex = /(\S+):\s*z\.(?:coerce\.)?(string|boolean|number)\(\)/g
    let fm
    while ((fm = fieldRegex.exec(fieldsBlock)) !== null) {
      const fieldName = fm[1].trim()
      const fieldType = fm[2]
      fields[fieldName] = fieldType === "number" ? 0 : fieldType === "boolean" ? false : ""
    }
    if (Object.keys(fields).length > 0) {
      charVariables[cName] = fields
    }
  }

  const eventMatch = content.match(/事件:\s*z\.object\(\{([^}]*)\}/)
  if (eventMatch) {
    const eventFields: Record<string, unknown> = {}
    const efRegex = /(\S+):\s*z\.boolean\(\)/g
    let efm
    while ((efm = efRegex.exec(eventMatch[1])) !== null) {
      eventFields[efm[1].trim()] = false
    }
    if (Object.keys(eventFields).length > 0) {
      charVariables["事件"] = eventFields
    }
  }

  if (Object.keys(charVariables).length === 0) return 0

  fs.writeFileSync(
    path.join(cardDir, "variable_schema.json"),
    JSON.stringify(charVariables, null, 2),
    "utf-8",
  )

  // 合并到 state.json
  if (fs.existsSync(statePath)) {
    try {
      const cardState = JSON.parse(fs.readFileSync(statePath, "utf-8"))
      for (const [cName, fields] of Object.entries(charVariables)) {
        if (cName === "事件") {
          cardState["事件"] = cardState["事件"] || fields
        } else if (cardState[cName]) {
          for (const [fname, fval] of Object.entries(fields)) {
            if (!(fname in cardState[cName])) cardState[cName][fname] = fval
          }
        } else {
          cardState[cName] = {
            归属值: 0,
            情分值: 100,
            基本信息: { 姓名: cName },
            ...fields,
          }
        }
      }
      if (cardState._meta) {
        const existing = cardState._meta.trackedCharacters || []
        for (const name of Object.keys(charVariables)) {
          if (name !== "事件" && !existing.includes(name)) existing.push(name)
        }
      }
      fs.writeFileSync(statePath, JSON.stringify(cardState, null, 2), "utf-8")
    } catch { /* state 写入失败不影响主流程 */ }
  }

  return Object.keys(charVariables).filter((k) => k !== "事件").length
}

function generateTavernHelperFileToDir(
  tavernHelper: Array<Record<string, unknown>>,
  charName: string,
  cardDir: string,
): number {
  if (!tavernHelper?.length) return 0
  const helperDir = path.join(cardDir, "tavern_scripts")
  ensureDir(helperDir)
  const safeName = charName.replace(/[<>:"/\\|?*]/g, "_")
  fs.writeFileSync(
    path.join(helperDir, `${safeName}.json`),
    JSON.stringify(tavernHelper, null, 2),
    "utf-8",
  )
  return tavernHelper.length
}

// ============================================================
// URL 扫描
// ============================================================

function scanRemoteUrls(
  regexScripts: Array<Record<string, unknown>>,
  tavernHelper: Array<Record<string, unknown>>,
  cardDir: string,
): number {
  const urls: Array<{ url: string; source: string; type: string }> = []
  const seen = new Set<string>()

  function collect(text: string, source: string) {
    if (!text) return
    const matches = text.matchAll(/https?:\/\/[^\s"'<>\]]+/g)
    for (const m of matches) {
      const url = m[0].replace(/[,;)}\\]+$/, "")
      if (!seen.has(url)) {
        seen.add(url)
        urls.push({ url, source, type: guessURLType(url) })
      }
    }
  }

  for (const s of regexScripts || []) {
    collect(s.replaceString as string, `regex: ${s.scriptName}`)
  }
  for (const s of tavernHelper || []) {
    collect(s.content as string, `tavern: ${s.name}`)
  }

  if (urls.length > 0) {
    fs.writeFileSync(
      path.join(cardDir, "remote_urls.json"),
      JSON.stringify(urls, null, 2),
      "utf-8",
    )
  }
  return urls.length
}

function guessURLType(url: string): string {
  if (url.includes("jsdelivr") || url.includes("cdn")) return "cdn_script"
  if (url.includes("gitgud.io") || url.includes("raw")) return "image_base_url"
  if (url.includes(".js")) return "javascript"
  if (url.includes(".html")) return "html_page"
  return "unknown"
}

// ============================================================
// Registry 集成
// ============================================================

function registerCardWithManager(charName: string, cardDir: string, cwd: string): void {
  // 直接修改 .pi/cards/registry.json（不依赖 CardManager 初始化状态）
  const registryPath = path.join(cwd, ".pi", "cards", "registry.json")
  let reg: { cards: Record<string, { dir: string; imported_at: string }>; active: string[] }
  if (fs.existsSync(registryPath)) {
    reg = JSON.parse(fs.readFileSync(registryPath, "utf-8"))
  } else {
    ensureDir(path.dirname(registryPath))
    reg = { cards: {}, active: [] }
  }
  reg.cards[charName] = {
    dir: cardDir,
    imported_at: new Date().toISOString(),
  }
  if (!reg.active || reg.active.length === 0) {
    reg.active = [charName]
  }
  fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2), "utf-8")
}

// ============================================================
// Content Assembly（从 assembleCard）
// ============================================================

function assembleContent(
  card: Record<string, unknown>,
  id?: string,
): { meta: CardMeta; initialContent: string } {
  const spec = (card.spec as string) ?? "chara_card_v2"
  const d = (card.data as Record<string, unknown> | undefined) ?? card

  const cardId = id ?? `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const version = spec.includes("v3") ? 3 : 2

  const dExt = d.extensions as Record<string, unknown> | undefined
  const tExt = (card.extensions as Record<string, unknown> | undefined)

  const meta: CardMeta = {
    id: cardId,
    name: (d.name as string) || (card.name as string) || "Unnamed",
    description: (d.description as string) || "",
    tags: (d.tags as string[]) ?? [],
    version,
  }

  const parts: string[] = []
  const sysPrompt = ((d.system_prompt as string)
    || (dExt?.depth_prompt as Record<string, unknown>)?.prompt as string
    || "") as string
  const personality = (d.personality as string) || ""
  const scenario = (d.scenario as string) || ""
  const firstMes = (d.first_mes as string) || ""
  const mesExample = (d.mes_example as string) || ""
  const creatorNotes = ((d.creator_notes as string) || (card.creatorcomment as string) || "") as string

  const world = ((dExt?.world as string) ?? (tExt?.world as string) ?? "") as string
  const worldLine = world ? `World: ${world}` : ""

  if (sysPrompt) parts.push(`[System]\n${sysPrompt}`)
  if (personality) parts.push(`[Personality]\n${personality}`)
  if (scenario || worldLine) parts.push(`[Scenario]\n${[scenario, worldLine].filter(Boolean).join("\n")}`)
  if (firstMes) parts.push(`[First Message]\n${firstMes}`)
  if (mesExample) parts.push(`[Example Messages]\n${mesExample}`)
  if (creatorNotes) parts.push(`[Creator Notes]\n${creatorNotes}`)

  if (worldLine && !meta.description) {
    meta.description = worldLine
  }

  return { meta, initialContent: parts.join("\n\n") }
}

// ============================================================
// 公开 API
// ============================================================

/**
 * 从文件导入角色卡（完整管线）
 * - 解析 PNG / WEBP / JPEG / JSON
 * - 生成 worldbook .md / state.json / config.json / APPEND_SYSTEM.md
 * - 预处理 regex_scripts → regex_hooks.json
 * - 预处理 tavern_helper → variable_schema.json
 * - 注册到 CardManager
 */
export function importCardFromFile(
  filePath: string,
  options?: ImportOptions,
): CardImportResult {
  const card = parseCharacterCard(filePath)
  const normalized = normalizeV1(card)

  const { extracted } = extractCharacterData(card)
  const charName = (options?.cardName || (extracted.name as string) || path.basename(filePath, path.extname(filePath)))

  // 确定目标目录
  const cwd = options?.projectCwd ?? process.cwd()
  const cardsDir = options?.cardsDir ?? path.join(cwd, ".pi", "cards")
  const cardDir = path.join(cardsDir, charName)
  const worldbookDir = path.join(cardDir, "worldbook")

  ensureDir(cardDir)
  ensureDir(worldbookDir)

  // 生成角色描述
  generateCharacterDescriptionFile(extracted, charName, worldbookDir)

  // 生成世界书条目
  const wbCount = generateWorldbookEntries(extracted, charName, worldbookDir)
  generateWorldbookJson(extracted, charName, worldbookDir)

  // 生成 state
  const statePath = path.join(cardDir, "state.json")
  generateCardState(charName, extracted, statePath)

  // 生成 config
  const configPath = path.join(cardDir, "config.json")
  generateCardConfig(charName, extracted, configPath)

  // 生成 APPEND_SYSTEM
  const systemPath = path.join(cardDir, "APPEND_SYSTEM.md")
  generateCardSystemPrompt(charName, extracted, systemPath)

  // 预处理脚本
  const regexScripts = (extracted.regex_scripts as Array<Record<string, unknown>>) || []
  const tavernHelper = (extracted.tavern_helper as Array<Record<string, unknown>>) || []

  const regexHooksCount = preprocessRegexScripts(regexScripts, cardDir)
  const variableSchemaCount = preprocessTavernScripts(tavernHelper, cardDir, statePath)
  const regexScriptsCount = generateRegexScriptsFileToDir(regexScripts, charName, cardDir)
  const tavernScriptsCount = generateTavernHelperFileToDir(tavernHelper, charName, cardDir)
  const remoteUrlsCount = scanRemoteUrls(regexScripts, tavernHelper, cardDir)

  // 注册到 CardManager
  if (!options?.skipRegistry) {
    try {
      registerCardWithManager(charName, cardDir, cwd)
    } catch { /* CardManager 可能未初始化 */ }
  }

  // 组装内容预览
  const { meta, initialContent } = assembleContent(normalized)

  return {
    meta,
    initialContent,
    cardDir,
    statePath,
    configPath,
    systemPath,
    worldbookDir,
    worldbookEntryCount: wbCount,
    regexHooksCount,
    variableSchemaCount,
    regexScriptsCount,
    tavernScriptsCount,
    remoteUrlsCount,
    rawData: card as Record<string, unknown>,
    extracted,
  }
}

/**
 * 从内存数据导入角色卡（不影响文件系统）
 * 仅做 V1→V2 归一化 + 内容组装
 */
export function importCard(
  data: ImportedCard | Record<string, unknown>,
  id?: string,
): CardImportResult {
  const normalized = normalizeV1(data as Record<string, unknown>)
  const { meta, initialContent } = assembleContent(normalized, id)

  return {
    meta,
    initialContent,
    worldbookEntryCount: 0,
    regexHooksCount: 0,
    variableSchemaCount: 0,
    regexScriptsCount: 0,
    tavernScriptsCount: 0,
    remoteUrlsCount: 0,
    rawData: data as Record<string, unknown>,
  }
}
