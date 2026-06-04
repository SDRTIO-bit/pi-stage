// ============================================================
// skill-generator.test.ts — 世界书→Skill 生成器单元测试
// ============================================================

import { describe, it, expect } from "vitest"
import { generateSkills } from "../src/skill-generator.js"
import type { WorldbookEntry } from "../src/types.js"

function entry(id: string, name: string, content: string): WorldbookEntry {
  return {
    id,
    name,
    keywords: [],
    priority: 1,
    constant: true,
    enabled: true,
    content,
    category: "常开设定",
  }
}

describe("generateSkills", () => {
  it("categorizes core-rules by content pattern", () => {
    const entries = [
      entry("r1", "核心规则", "本角色扮演中所有玩家必须遵守以下基本规则，禁止随意改变设定。"),
    ]
    const skills = generateSkills(entries)
    expect(skills).toHaveLength(1)
    expect(skills[0].category).toBe("core-rules")
    expect(skills[0].filename).toBe("00-core-rules.md")
  })

  it("categorizes style-protocol by content pattern", () => {
    const entries = [
      entry("s1", "文风指南", "请使用第三人称视角进行描写，语气保持轻松幽默的风格。"),
    ]
    const skills = generateSkills(entries)
    expect(skills[0].category).toBe("style-protocol")
    expect(skills[0].filename).toBe("style-protocol.md")
  })

  it("categorizes judgment-system by content pattern", () => {
    const entries = [
      entry("j1", "判定体系", "战斗判定采用d20骰子检定，难度为DC15，成功则造成伤害。"),
    ]
    const skills = generateSkills(entries)
    expect(skills[0].category).toBe("judgment-system")
    expect(skills[0].filename).toBe("judgment-system.md")
  })

  it("categorizes variable-protocol by content pattern", () => {
    const entries = [
      entry("v1", "属性系统", "角色属性包括体力、魔力、敏捷，值域为1-100，数值不可跨角色转移。"),
    ]
    const skills = generateSkills(entries)
    expect(skills[0].category).toBe("variable-protocol")
    expect(skills[0].filename).toBe("variable-protocol.md")
  })

  it("includes uncategorized entries as world-context", () => {
    const entries = [entry("u1", "杂项", "今天天气不错。")]
    const skills = generateSkills(entries)
    expect(skills).toHaveLength(1)
    expect(skills[0].category).toBe("uncategorized")
    expect(skills[0].filename).toBe("world-context.md")
  })

  it("groups multiple entries of same category into one skill", () => {
    const entries = [
      entry("r1", "规则一", "禁止随意穿越。"),
      entry("r2", "规则二", "必须遵守时间线。"),
    ]
    const skills = generateSkills(entries)
    expect(skills).toHaveLength(1)
    expect(skills[0].sourceEntries).toEqual(["r1", "r2"])
    expect(skills[0].content).toContain("规则一")
    expect(skills[0].content).toContain("规则二")
  })

  it("mixes categories correctly", () => {
    const entries = [
      entry("r1", "规则", "必须遵守规则。"),
      entry("s1", "风格", "第三人称视角。"),
      entry("j1", "判定", "d20判定。"),
    ]
    const skills = generateSkills(entries)
    expect(skills).toHaveLength(3)
    const cats = skills.map((s) => s.category).sort()
    expect(cats).toEqual(["core-rules", "judgment-system", "style-protocol"])
  })

  it("returns empty for no entries", () => {
    expect(generateSkills([])).toHaveLength(0)
  })

  it("sorts by priority within each category", () => {
    const entries = [
      entry("r2", "低优先规则", "第二条规则。"),
      entry("r1", "高优先规则", "第一条规则。"),
    ]
    entries[0].priority = 20
    entries[1].priority = 5
    const skills = generateSkills(entries)
    expect(skills[0].content).toContain("高优先规则")
    expect(skills[0].content.indexOf("高优先")).toBeLessThan(skills[0].content.indexOf("低优先"))
  })
})
