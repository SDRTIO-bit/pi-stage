// ============================================================
// State Collector — 当前角色变量作为独立 PromptNode
// 放在 pipeline 末尾（priority 90），世界书触发词条（priority 85）之前
// 动态内容集中末尾，最大化前面的静态 prefix cache 命中
// ============================================================

import type { Collector } from "../context/pipeline.js"
import { createNode } from "../context/prompt-node.js"
import type { StateStore } from "../state-store.js"

export function createStateCollector(stateStore: StateStore): Collector {
  return {
    name: "state-variables",
    collect: async (sessionId: string) => {
      const session = stateStore.getSession(sessionId)
      if (!session?.cardId) return []

      const cardState = session.activatedCards.get(session.cardId)
      if (!cardState || Object.keys(cardState.variables).length === 0) return []

      const lines = ["[当前角色状态 — 这是角色的实时状态，每次回复前须参考]"]
      for (const [key, value] of Object.entries(cardState.variables)) {
        lines.push(`  ${key}: ${JSON.stringify(value)}`)
      }

      return [
        createNode({
          layer: "L1-stable",
          source: "角色状态",
          content: lines.join("\n"),
          priority: 90, // 末尾，变化频繁不破坏前置缓存
          attentionWeight: 0.8,
          degradationStrategy: "compress",
        }),
      ]
    },
  }
}
