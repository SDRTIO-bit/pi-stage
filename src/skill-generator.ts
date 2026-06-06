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
export function categorizeEntry(entry: WorldbookEntry): SkillCategory {
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

  // 判定/骰子/概率/成功/失败 → judgment-system
  if (
    /判定|骰子|概率|成功|失败|roll|dice|check|难度|dc/.test(titleLower + contentLower.slice(0, 200))
  ) {
    return "judgment-system"
  }

  // 变量/属性/状态/值/数值 → variable-protocol
  // 放在 style-protocol 之前，避免 "format" 等宽泛关键词误匹配
  if (
    /变量|属性|状态|数值|值域|variable|attribute|stat|value|range/.test(
      titleLower + contentLower.slice(0, 200),
    )
  ) {
    return "variable-protocol"
  }

  // 格式/语气/人称/画风/描写 → style-protocol
  if (
    /格式|语气|人称|画风|描写|风格|style|format|语气|视角|tone/.test(
      titleLower + contentLower.slice(0, 200),
    )
  ) {
    return "style-protocol"
  }

  return "uncategorized"
}

/** 判断条目是否为"世界知识"（应从 Skill 排除，走 worldbook 触发检索） */
export function isKnowledgeEntry(entry: WorldbookEntry): boolean {
  const name = entry.name
  const content = entry.content.slice(0, 500)

  // 【世界】前缀 → 知识（地理位置、物价、年表、神之途径、神秘学、海洋、维多利亚风、物品、资本、突发事件）
  if (/^【世界】/.test(name)) return true

  // 原著时间线
  if (/原著时间线/.test(name)) return true

  // 分隔符标记（世界观/数值参考/合理性审查/系统结构/判定区域 的开始和结束）
  if (/——(世界观|数值参考|合理性审查|系统结构|判定区域)(开始|结束)/.test(name)) return true

  // 内容特征：纯描述性，无规则/指令/格式关键词
  // 如果内容前 500 字符不包含任何执行规则关键词 → 知识
  const ruleKeywords =
    /规则|必须|不得|禁止|格式|输出|更新|判定|骰子|DC|难度|roll|dice|check|替换|replace|JSON\s*Patch|UpdateVariable|Analysis|审查|OOC|叙事节奏|沉浸感|自动化|战斗|变量|数值|上限|基准|模板|\{\{/
  if (!ruleKeywords.test(content)) return true

  return false
}

/** 从常开设定生成 Skill 文件 */
export function generateSkills(
  constantEntries: WorldbookEntry[],
  opts?: { excludeKnowledge?: boolean },
): GeneratedSkill[] {
  const entries = opts?.excludeKnowledge
    ? constantEntries.filter((e) => !isKnowledgeEntry(e))
    : constantEntries

  // 按 name 去重（卡片 character_book 可能含重复条目）
  const seen = new Set<string>()
  const deduped = entries.filter((e) => {
    if (seen.has(e.name)) return false
    seen.add(e.name)
    return true
  })

  const grouped = new Map<SkillCategory, WorldbookEntry[]>()

  for (const entry of deduped) {
    const cat = categorizeEntry(entry)
    const list = grouped.get(cat) ?? []
    list.push(entry)
    grouped.set(cat, list)
  }

  const skills: GeneratedSkill[] = []

  for (const [category, entries] of grouped) {
    const filename = getFilename(category)
    const content = entries
      .sort((a, b) => a.priority - b.priority)
      .map((e) => `<!-- source: ${e.id} -->\n## ${e.name}\n${e.content}`)
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
    case "uncategorized":
      return "world-context.md"
  }
}
