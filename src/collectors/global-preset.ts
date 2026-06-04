// ============================================================
// Global Preset Collector — 引擎级全局预设
// 读取 .pi/presets/*.md，注入为 PromptNode
// 优先级高于卡专属 Skill，对所有卡片生效
// ============================================================

import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { Collector } from "../context/pipeline.js"
import { createNode } from "../context/prompt-node.js"

export function createGlobalPresetCollector(cwd: string): Collector {
  const presetsDir = join(cwd, ".pi", "presets")

  return {
    name: "global-preset",
    collect: async () => {
      if (!existsSync(presetsDir)) return []

      const files = readdirSync(presetsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()

      if (files.length === 0) return []

      return files.map((f) => {
        const content = readFileSync(join(presetsDir, f), "utf-8")
        return createNode({
          layer: "L1-stable",
          source: `全局预设: ${f}`,
          content: `[Preset: ${f}]\n${content}`,
          priority: 3,
          attentionWeight: 1.0,
          degradationStrategy: "summarize",
        })
      })
    },
  }
}
