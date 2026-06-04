// ============================================================
// Format Rules Collector — 从卡目录 FORMAT_RULES.md 或 skills 提取
// 独立 collector，不再从已装配 prompt 中循环提取
// ============================================================

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { Collector } from "../context/pipeline.js"
import { createNode } from "../context/prompt-node.js"
import type { CardManager } from "../card-manager.js"
import type { StateStore } from "../state-store.js"

/** 正则提取格式规则（降级方案：无 FORMAT_RULES.md 时从 skills 提取） */
function extractFromContent(content: string): string {
  const patterns = [
    /[必须务必].{2,80}/g,
    /始终.{2,80}/g,
    /每[次个].{2,80}/g,
    /所有.{2,80}格式/g,
    /人称.{2,40}/g,
    /视角.{2,40}/g,
    /语气.{2,40}/g,
    /主人.{2,60}/g,
    /开头.{2,60}/g,
    /回复前?.{2,60}/g,
    /禁止.{2,60}/g,
    /不得.{2,60}/g,
  ]
  const rules: string[] = []
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const rule = match[0].trim()
      if (rule.length >= 4 && !rules.some((r) => r.includes(rule) || rule.includes(r))) {
        rules.push(rule)
      }
    }
    if (rules.length >= 10) break
  }
  if (rules.length === 0) return ""
  return (
    "[格式纪律 — 每次回复前必须逐条检查]\n" +
    "以下格式要求优先级最高，任何情况下不得违反：\n" +
    rules.map((r, i) => `${i + 1}. ${r}`).join("\n")
  )
}

export function createFormatRulesCollector(
  cardManager: CardManager,
  stateStore: StateStore,
): Collector {
  return {
    name: "format-rules",
    collect: async (sessionId: string) => {
      const session = stateStore.getSession(sessionId)
      if (!session?.cardId) return []

      const reg = cardManager.getRegistry()
      const cardDir = reg.cards[session.cardId]?.dir
      if (!cardDir) return []

      // 优先读 FORMAT_RULES.md
      const mdPath = join(cardDir, "FORMAT_RULES.md")
      let content = ""
      if (existsSync(mdPath)) {
        try { content = readFileSync(mdPath, "utf-8") } catch { /* ignore */ }
      }

      // 降级：从 skills 提取
      if (!content) {
        const skillsDir = join(cardDir, "skills", "rp-engine")
        const coreRules = join(skillsDir, "00-core-rules.md")
        const styleProtocol = join(skillsDir, "style-protocol.md")
        let raw = ""
        if (existsSync(coreRules))
          try { raw += readFileSync(coreRules, "utf-8") + "\n" } catch { /* ignore */ }
        if (existsSync(styleProtocol))
          try { raw += readFileSync(styleProtocol, "utf-8") } catch { /* ignore */ }
        if (raw) content = extractFromContent(raw)
      }

      if (!content.trim()) return []

      return [
        createNode({
          layer: "L0-survival",
          source: "格式规则",
          content,
          priority: 2,
          attentionWeight: 1.0,
          degradationStrategy: "summarize",
        }),
      ]
    },
  }
}
