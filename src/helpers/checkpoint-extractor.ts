// ============================================================
// 格式检查点提取器
// 从卡 Skill 和预设文件中扫描:
//   - 输出结构标签 (<tag> 模式)
//   - 写作约束 (禁止/必须/不得 句式)
// 零硬编码 RP 内容 — 所有内容从源文件动态提取
// ============================================================

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** 非格式标签 — 这些是引用标记，不是输出结构 */
const NON_STRUCTURE_TAGS = new Set([
  "User", "user", "CharacterCard", "JSONPatch", "img",
])

/** 约束句扫描模式 */
const CONSTRAINT_PATTERNS = [
  /(?:必须|务必|禁止|不得|红线|始终|只能|需要)[^。\n]{0,100}/g,
  /每[次个][^。\n]{0,80}格式/g,
]

interface FileSource { dir: string }

/**
 * 从卡技能和预设文件中扫描输出结构标签 (<tag> 模式)。
 * 自动排除引用标记 (<User>, <CharacterCard> 等)。
 */
export function extractStructureTags(
  cardDir: string,
  presetsDir: string,
): string[] {
  const tags = new Set<string>()
  const sources: FileSource[] = []

  const skillsDir = join(cardDir, "skills", "rp-engine")
  if (existsSync(skillsDir)) sources.push({ dir: skillsDir })
  if (existsSync(presetsDir)) sources.push({ dir: presetsDir })

  for (const src of sources) {
    const files = readdirSync(src.dir).filter((f) => f.endsWith(".md"))
    for (const f of files) {
      let content = ""
      try { content = readFileSync(join(src.dir, f), "utf-8") } catch { continue }

      const tagRegex = /<([a-zA-Z_][a-zA-Z0-9_-]*)>/g
      let match: RegExpExecArray | null
      while ((match = tagRegex.exec(content)) !== null) {
        if (!NON_STRUCTURE_TAGS.has(match[1])) {
          tags.add(`<${match[1]}>`)
        }
      }
    }
  }

  return [...tags].sort()
}

/**
 * 从技能和预设文件中提取约束语句（禁止/必须/不得/红线 句式）。
 * 返回去重后的约束列表（最多 10 条）。
 */
export function extractConstraints(
  cardDir: string,
  presetsDir: string,
): string[] {
  const constraints = new Map<string, number>() // text -> length (keep shorter version)
  const sources: FileSource[] = []

  const skillsDir = join(cardDir, "skills", "rp-engine")
  if (existsSync(skillsDir)) sources.push({ dir: skillsDir })
  if (existsSync(presetsDir)) sources.push({ dir: presetsDir })

  for (const src of sources) {
    const files = readdirSync(src.dir).filter((f) => f.endsWith(".md"))
    for (const f of files) {
      let content = ""
      try { content = readFileSync(join(src.dir, f), "utf-8") } catch { continue }

      for (const pattern of CONSTRAINT_PATTERNS) {
        let m: RegExpExecArray | null
        while ((m = pattern.exec(content)) !== null) {
          const rule = m[0].trim()
          if (rule.length < 6) continue

          // 去重: 如果已存在相似规则，保留更短的版本
          const existing = constraints.get(rule)
          if (existing === undefined || rule.length < existing) {
            // 检查是否有内容重叠的规则
            let hasOverlap = false
            for (const [key] of constraints) {
              if (key.includes(rule) || rule.includes(key)) {
                hasOverlap = true
                if (rule.length < key.length) {
                  constraints.delete(key)
                  constraints.set(rule, rule.length)
                }
                break
              }
            }
            if (!hasOverlap) {
              constraints.set(rule, rule.length)
            }
          }

          if (constraints.size >= 10) break
        }
        if (constraints.size >= 10) break
      }
      if (constraints.size >= 10) break
    }
    if (constraints.size >= 10) break
  }

  return [...constraints.keys()]
}

/**
 * 构建 Steering 注入的完整内容。
 * 包含格式检查点、关键约束、可用工具提醒、注意力刷新信号。
 * 所有内容从源文件提取，不含硬编码 RP 内容。
 */
export function buildSteeringContent(
  structureTags: string[],
  constraints: string[],
  worldbookContent: string,
  refreshSignal: string | null,
  toolHints?: string,
): string {
  const parts: string[] = []

  if (structureTags.length > 0) {
    const tagList = structureTags.join(" > ")
    parts.push(`[输出结构] 回复必须包含以下标签序列: ${tagList}`)
  }

  if (constraints.length > 0) {
    const rules = constraints.map((c, i) => `${i + 1}. ${c}`).join("\n")
    parts.push(`[关键约束]\n${rules}`)
  }

  if (toolHints) {
    parts.push(toolHints)
  }

  if (worldbookContent) {
    parts.push(`[世界书]\n${worldbookContent}`)
  }

  if (refreshSignal) {
    parts.push(refreshSignal)
  }

  return parts.join("\n\n")
}
