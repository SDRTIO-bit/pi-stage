// ============================================================
// Card Skill 自动生成
// 从世界书 `[常开]设定/` 中自动识别方法论类条目
// 按内容特征自动分类为：
//   00-core-rules.md / style-protocol.md / judgment-system.md / variable-protocol.md
// ============================================================

import type { WorldbookEntry } from "./types.js"

export type SkillCategory =
  | "core-rules"
  | "style-protocol"
  | "judgment-system"
  | "variable-protocol"
  | "uncategorized"

export interface GeneratedSkill {
  category: SkillCategory
  filename: string
  content: string
  sourceEntries: string[]
}

/** 根据内容特征推断分类 */
function categorizeEntry(entry: WorldbookEntry): SkillCategory {
  const titleLower = entry.name.toLowerCase()
  const contentLower = entry.content.toLowerCase()

  // 规则/禁止/必须/不得 → core-rules
  if (
    /规则|禁止|必须|不得|允许|can(?:not)?|must|shall|禁止|许可/.test(
      titleLower + contentLower.slice(0, 200),
    )
  ) {
    return "core-rules"
  }

  // 格式/语气/人称/画风/描写 → style-protocol
  if (
    /格式|语气|人称|画风|描写|风格|style|format|语气|视角|tone/.test(
      titleLower + contentLower.slice(0, 200),
    )
  ) {
    return "style-protocol"
  }

  // 判定/骰子/概率/成功/失败 → judgment-system
  if (
    /判定|骰子|概率|成功|失败|roll|dice|check|难度|dc/.test(titleLower + contentLower.slice(0, 200))
  ) {
    return "judgment-system"
  }

  // 变量/属性/状态/值/数值 → variable-protocol
  if (
    /变量|属性|状态|数值|值域|variable|attribute|stat|value|range/.test(
      titleLower + contentLower.slice(0, 200),
    )
  ) {
    return "variable-protocol"
  }

  return "uncategorized"
}

/** 从常开设定生成 Skill 文件 */
export function generateSkills(constantEntries: WorldbookEntry[]): GeneratedSkill[] {
  const grouped = new Map<SkillCategory, WorldbookEntry[]>()

  for (const entry of constantEntries) {
    const cat = categorizeEntry(entry)
    const list = grouped.get(cat) ?? []
    list.push(entry)
    grouped.set(cat, list)
  }

  const skills: GeneratedSkill[] = []

  for (const [category, entries] of grouped) {
    if (category === "uncategorized") continue

    const filename = getFilename(category)
    const content = entries
      .sort((a, b) => a.priority - b.priority)
      .map((e) => `## ${e.name}\n${e.content}`)
      .join("\n\n")

    skills.push({
      category,
      filename,
      content,
      sourceEntries: entries.map((e) => e.id),
    })
  }

  return skills
}

function getFilename(category: SkillCategory): string {
  switch (category) {
    case "core-rules":
      return "00-core-rules.md"
    case "style-protocol":
      return "style-protocol.md"
    case "judgment-system":
      return "judgment-system.md"
    case "variable-protocol":
      return "variable-protocol.md"
    default:
      return "uncategorized.md"
  }
}
