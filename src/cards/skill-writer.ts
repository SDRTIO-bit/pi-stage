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

  // 原地重分类：知识条目 constant → false，回归触发检索
  wb.reclassifyKnowledge(isKnowledgeEntry)

  // 仅用执行规则条目生成 Skill 文件
  const skills = generateSkills(constantEntries, { excludeKnowledge: true })
  const skillsDir = getCardSkillsDir(cardDir)
  mkdirSync(skillsDir, { recursive: true })

  for (const skill of skills) {
    writeFileSync(join(skillsDir, skill.filename), skill.content, "utf-8")
  }

  // Phase 2 已移除：触发条目全部走 TF-IDF 按需检索，不再提升到 Skill 文件。
  // 否则 1359 条触发条目中有 267 条会被追加回 Skill，导致 Skill 膨胀到 700KB+。

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
