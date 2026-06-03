// ============================================================
// SkillWriter — 将 Worldbook 常开设定编译为 Skill 文件
// 写入 .pi/skills/rp-engine/*.md，供 before_agent_start 注入
// ============================================================

import { generateSkills, type GeneratedSkill } from "./skill-generator.js"
import type { WorldbookEntry } from "./types.js"
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"

export class SkillWriter {
  private skillsDir: string
  private lastHash = ""

  constructor(cwd?: string) {
    this.skillsDir = join(cwd ?? process.cwd(), ".pi", "skills", "rp-engine")
  }

  /** 从 Worldbook 常开设定重新生成 Skill 文件 */
  regenerate(entries: WorldbookEntry[]): GeneratedSkill[] {
    const skills = generateSkills(entries)

    const hash = createHash("sha1").update(JSON.stringify(skills)).digest("hex")
    if (hash === this.lastHash) return skills
    this.lastHash = hash

    mkdirSync(this.skillsDir, { recursive: true })

    // 清理旧文件
    const writtenFiles = new Set(skills.map((s) => s.filename))
    if (existsSync(this.skillsDir)) {
      for (const f of readdirSync(this.skillsDir)) {
        if (f.endsWith(".md") && !writtenFiles.has(f)) {
          try { unlinkSync(join(this.skillsDir, f)) } catch { /* skip */ }
        }
      }
    }

    for (const skill of skills) {
      writeFileSync(join(this.skillsDir, skill.filename), skill.content, "utf-8")
    }

    return skills
  }

  /** 读取所有已生成的 Skill 文件内容（用于注入到 LLM context） */
  readAll(): { filename: string; content: string }[] {
    if (!existsSync(this.skillsDir)) return []
    const result: { filename: string; content: string }[] = []
    for (const f of readdirSync(this.skillsDir)) {
      if (!f.endsWith(".md")) continue
      result.push({
        filename: f,
        content: readFileSync(join(this.skillsDir, f), "utf-8"),
      })
    }
    return result.sort((a, b) => a.filename.localeCompare(b.filename))
  }

  /** 获取合并后的 Skill 文本（作为 system prompt 注入） */
  getMergedContent(): string {
    const files = this.readAll()
    if (files.length === 0) return ""
    return files.map((f) => `<!-- ${f.filename} -->\n${f.content}`).join("\n\n")
  }
}

export const skillWriter = new SkillWriter()
