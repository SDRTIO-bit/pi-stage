// ============================================================
// Skill 生命周期钩子
// - turn_end: 从 Worldbook 常开设定重新编译 Skill 文件
// - 提供 SkillCollector 供 ContextPipeline 注入
// - 提供 before_agent_start 响应函数
// ============================================================

import { lifecycleBus } from "./events.js"
import { skillWriter } from "../skill-writer.js"
import { worldbook } from "../worldbook/index.js"
import type { Collector } from "../context/pipeline.js"
import { createNode } from "../context/prompt-node.js"

let registered = false

/** 注册 skill 相关生命周期钩子（幂等） */
export function registerSkillHooks(): void {
  if (registered) return
  registered = true

  // turn_end: 从 worldbook 常开设定重新编译 skill 文件
  lifecycleBus.on("turn_end", async () => {
    const entries = worldbook.getConstantEntries()
    if (entries.length > 0) {
      skillWriter.regenerate(entries)
    }
  })

  // before_agent_start: 提供 skill 内容（供 pi.dev 宿主管线查询）
  lifecycleBus.on("before_agent_start", async (event) => {
    const content = skillWriter.getMergedContent()
    if (content) {
      ;(event as unknown as Record<string, unknown>).payload = { skills: content }
    }
  })
}

/** ContextPipeline Collector: 将编译后的 skill 文件作为 L1-stable 节点注入 */
export const skillCollector: Collector = {
  name: "rp-skills",
  collect: async () => {
    const files = skillWriter.readAll()
    if (files.length === 0) return []
    const content = files.map((f) => `<!-- ${f.filename} -->\n${f.content}`).join("\n\n")
    return [
      createNode({
        layer: "L1-stable",
        source: "RP Engine Skills",
        content,
        priority: 5,
        attentionWeight: 0.9,
      }),
    ]
  },
}

/** 手动触发 skill 重新生成（供外部调用，如卡片激活后） */
export function regenerateSkills(): void {
  const entries = worldbook.getConstantEntries()
  if (entries.length > 0) {
    skillWriter.regenerate(entries)
  }
}
