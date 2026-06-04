// ============================================================
// CardSkillWriter — 卡级 Skill 生成器
// 从单张卡的 worldbook 目录生成专属 skills
// 首次激活时生成 → skills/rp-engine/*.md，之后直接复用
// ============================================================

import { generateSkills, categorizeEntry, isKnowledgeEntry, type GeneratedSkill, type SkillCategory } from "../skill-generator.js"
import type { WorldbookEntry } from "../types.js"
import { Worldbook } from "../worldbook/index.js"
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, appendFileSync } from "node:fs"
import { join } from "node:path"

const FILENAME_CATEGORY: Record<string, SkillCategory> = {
  "00-core-rules.md": "core-rules",
  "style-protocol.md": "style-protocol",
  "judgment-system.md": "judgment-system",
  "variable-protocol.md": "variable-protocol",
}

export function getCardSkillsDir(cardDir: string): string {
  return join(cardDir, "skills", "rp-engine")
}

export function hasCardSkills(cardDir: string): boolean {
  return existsSync(join(getCardSkillsDir(cardDir), "00-core-rules.md"))
}

/** 从卡 worldbook 目录生成专属 skills 并写入 skills/rp-engine/
 *
 *  两阶段：
 *  1. 常开设定 → generateSkills() 生成基础 5 个 skill 文件
 *  2. 触发目录 → categorizeEntry() 扫描，命中的追加到对应 skill
 *     （只收割确定性高的，未命中留在触发目录）
 */
export function generateCardSkills(cardDir: string, worldbookDir: string): GeneratedSkill[] {
  const wb = new Worldbook()
  wb.loadFromFiles([worldbookDir])

  // ---- Phase 1: 常开设定 → 拆分执行规则 / 世界知识 ----
  const constantEntries = wb.getConstantEntries()

  // 检出知识条目（从 Skill 中排除，回归 worldbook 触发检索）
  const knowledgeEntries = constantEntries.filter((e) => isKnowledgeEntry(e))
  if (knowledgeEntries.length > 0) {
    const reclassified = knowledgeEntries.map((e) => ({
      ...e,
      constant: false,
      category: "触发词条" as const,
    }))
    wb.addEntries(reclassified)
  }

  // 仅用执行规则条目生成 Skill 文件
  const skills = generateSkills(constantEntries, { excludeKnowledge: true })
  const skillsDir = getCardSkillsDir(cardDir)
  mkdirSync(skillsDir, { recursive: true })

  for (const skill of skills) {
    writeFileSync(join(skillsDir, skill.filename), skill.content, "utf-8")
  }

  // ---- Phase 2: 扫描触发目录，提升匹配的元规则 ----
  const triggerEntries = wb.getTriggerEntries()
  if (triggerEntries.length > 0) {
    // 按 target category 分组触发条目
    const promoted = new Map<SkillCategory, WorldbookEntry[]>()

    for (const entry of triggerEntries) {
      const cat = categorizeEntry(entry)
      if (cat === "uncategorized") continue // 拿不准的留在触发目录
      const list = promoted.get(cat) ?? []
      list.push(entry)
      promoted.set(cat, list)
    }

    // 追加到对应 skill 文件
    const filenameMap: Record<string, string> = {
      "core-rules": "00-core-rules.md",
      "style-protocol": "style-protocol.md",
      "judgment-system": "judgment-system.md",
      "variable-protocol": "variable-protocol.md",
    }

    for (const [cat, entries] of promoted) {
      const filename = filenameMap[cat]
      if (!filename) continue
      const filePath = join(skillsDir, filename)

      // 确保文件存在（如果 Phase 1 没生成，创建一个空文件）
      if (!existsSync(filePath)) {
        writeFileSync(filePath, "", "utf-8")
      }

      const appendix = entries
        .sort((a, b) => a.priority - b.priority)
        .map((e) => `## 来源: 触发条目 | ${e.name}\n${e.content}`)
        .join("\n\n")

      appendFileSync(filePath, "\n\n---\n\n" + appendix, "utf-8")
    }

    // 更新内存中的 skills 列表
    if (promoted.size > 0) {
      const updated = readCardSkills(cardDir)
      return updated
    }
  }

  return skills
}

/** 读取已生成的卡专属 skills */
export function readCardSkills(cardDir: string): GeneratedSkill[] {
  const skillsDir = getCardSkillsDir(cardDir)
  if (!existsSync(skillsDir)) return []

  const result: GeneratedSkill[] = []
  for (const f of readdirSync(skillsDir)) {
    if (!f.endsWith(".md")) continue
    const content = readFileSync(join(skillsDir, f), "utf-8")
    result.push({
      category: FILENAME_CATEGORY[f] ?? "uncategorized",
      filename: f,
      content,
      sourceEntries: [],
    })
  }
  return result.sort((a, b) => a.filename.localeCompare(b.filename))
}

/** 获取卡专属 skills 的合并文本（供 pipeline 注入） */
export function getCardSkillsContent(cardDir: string): string {
  const files = readCardSkills(cardDir)
  if (files.length === 0) return ""
  return files.map((f) => `<!-- ${f.filename} -->\n${f.content}`).join("\n\n")
}
