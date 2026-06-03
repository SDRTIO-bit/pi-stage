// ============================================================
// PromptNode 标准结构封装
// ============================================================

import type { ContextLayer, DegradationStrategy, PromptNode } from "../types.js"

let nodeCounter = 0

export function createNode(opts: {
  layer: ContextLayer
  source: string
  content: string
  priority?: number
  attentionWeight?: number
  degradationStrategy?: DegradationStrategy
  metadata?: Record<string, unknown>
}): PromptNode {
  return {
    id: `node-${++nodeCounter}-${Date.now()}`,
    layer: opts.layer,
    source: opts.source,
    content: opts.content,
    byteSize: new TextEncoder().encode(opts.content).byteLength,
    priority: opts.priority ?? 50,
    attentionWeight: opts.attentionWeight ?? 0.5,
    degradationStrategy: opts.degradationStrategy ?? "drop",
    metadata: opts.metadata,
  }
}
