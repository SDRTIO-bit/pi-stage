// ============================================================
// Skill 生命周期钩子 + SkillCollector
// - skillCollector 从卡目录读取专属 skills
// - registerSkillHooks 注册 before_agent_start 等钩子
// ============================================================

import type { LifecycleBus } from "./events.js"
import type { Collector } from "../context/pipeline.js"
import { createNode } from "../context/prompt-node.js"
import { readCardSkills } from "../cards/skill-writer.js"
import type { SkillCategory } from "../skill-generator.js"

/** 每个 skill 类别的管线 priority（越小越靠前，越不会被裁） */
const SKILL_PRIORITY: Record<SkillCategory, number> = {
  "core-rules": 3,
  "style-protocol": 5,
  "judgment-system": 6,
  "variable-protocol": 7,
  "uncategorized": 8,
}

let registered = false

/** 注册 skill 相关生命周期钩子（幂等） */
export function registerSkillHooks(lifecycleBus: LifecycleBus): void {
  if (registered) return
  registered = true

  // before_agent_start: 提供 skill 内容（供 pi.dev 宿主管线查询）
  lifecycleBus.on("before_agent_start", async (event) => {
    const sessionId = event.sessionId
    // 此钩子不再注入 skill 内容 — skills 通过 SkillCollector 在管线中注入
    void sessionId
  })
}

/** 创建卡专属 Skill Collector — 每个 skill 文件一个独立节点，便于调度器逐文件决策 */
export function createSkillCollector(
  getCardDir: (sessionId: string) => string | null,
): Collector {
  return {
    name: "rp-skills",
    collect: async (sessionId: string) => {
      const cardDir = getCardDir(sessionId)
      if (!cardDir) return []
      const skills = readCardSkills(cardDir)
      if (skills.length === 0) return []
      return skills.map((skill) =>
        createNode({
          layer: "L1-stable",
          source: `Skill: ${skill.filename}`,
          content: skill.content,
          priority: SKILL_PRIORITY[skill.category] ?? 8,
          attentionWeight: 0.9,
          degradationStrategy: "summarize",
        }),
      )
    },
  }
}

/** @deprecated 使用 createSkillCollector() 替代 */
export const skillCollector: Collector = {
  name: "rp-skills-legacy",
  collect: async () => [],
}

/** @deprecated 使用 createSkillCollector() 替代 */
export function regenerateSkills(): void {
  // no-op: skills 现在由 CardSkillWriter 管理
}
