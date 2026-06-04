// ============================================================
// 双预算调度器 — target 舒适区 / hard 硬上限
// 4种降级策略：drop / compress / summarize / truncate
// ============================================================

import type { Budget, PromptNode, TraceEntry } from "../types.js"

export interface ScheduleResult {
  included: PromptNode[]
  dropped: string[]
  trace: TraceEntry[]
  totalBytes: number
}

export function schedule(nodes: PromptNode[], budget: Budget): ScheduleResult {
  const trace: TraceEntry[] = []
  let totalBytes = 0
  const included: PromptNode[] = []
  const droppedIds: string[] = []

  for (const node of nodes) {
    const remaining = budget.hard - totalBytes
    // 硬上限检查：summarize 策略可尝试降级后放入，其他策略直接丢弃
    const exceedsHard = totalBytes + node.byteSize > budget.hard
    if (exceedsHard && node.degradationStrategy !== "summarize") {
      droppedIds.push(node.id)
      trace.push({
        nodeId: node.id,
        action: "dropped",
        reason: `Exceeds hard budget (${budget.hard})`,
        byteSizeBefore: node.byteSize,
        timestamp: Date.now(),
      })
      continue
    }
    if (exceedsHard) {
      // summarize 策略：只用60%剩余预算，留空间给后续节点
      const cappedRemaining = Math.floor(remaining * 0.6)
      const degraded = applyDegradation(node, cappedRemaining)
      if (degraded && totalBytes + degraded.node.byteSize <= budget.hard) {
        included.push(degraded.node)
        totalBytes += degraded.node.byteSize
        trace.push(degraded.trace)
      } else {
        droppedIds.push(node.id)
        trace.push({
          nodeId: node.id,
          action: "dropped",
          reason: `Summarization failed to fit hard budget (${budget.hard})`,
          byteSizeBefore: node.byteSize,
          timestamp: Date.now(),
        })
      }
      continue
    }

    // 舒适区检查
    if (totalBytes + node.byteSize > budget.target) {
      // 尝试降级（用60%剩余预算，保留空间给后续节点）
      const cappedRemaining = Math.floor((budget.hard - totalBytes) * 0.6)
      const degraded = applyDegradation(node, cappedRemaining)
      if (degraded) {
        included.push(degraded.node)
        totalBytes += degraded.node.byteSize
        trace.push(degraded.trace)
        continue
      }
      // 降级失败则丢弃
      droppedIds.push(node.id)
      trace.push({
        nodeId: node.id,
        action: "dropped",
        reason: `Degradation failed, exceeds comfort zone (${budget.target})`,
        byteSizeBefore: node.byteSize,
        timestamp: Date.now(),
      })
      continue
    }

    included.push(node)
    totalBytes += node.byteSize
    trace.push({
      nodeId: node.id,
      action: "scheduled",
      reason: "Within budget",
      byteSizeAfter: node.byteSize,
      timestamp: Date.now(),
    })
  }

  return { included, dropped: droppedIds, trace, totalBytes }
}

interface DegradationResult {
  node: PromptNode
  trace: TraceEntry
}

/** 提取式摘要：保留前 N 句 + 末尾句，控制在预算内 */
function extractiveSummarize(node: PromptNode, remainingBudget: number): DegradationResult | null {
  const sentences = node.content.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) ?? []
  if (sentences.length <= 3) return null // 太短无法摘要

  const last = sentences[sentences.length - 1]
  const encoder = new TextEncoder()
  const lastBytes = encoder.encode(last).byteLength
  // 如果全文都放得下，不需要摘要
  if (node.byteSize <= remainingBudget) return null

  let head = ""
  let headBytes = 0
  let kept = 0

  for (let i = 0; i < sentences.length - 1; i++) {
    const s = sentences[i]
    const sBytes = encoder.encode(s).byteLength
    if (headBytes + sBytes + lastBytes + 3 > remainingBudget) break
    head += s
    headBytes += sBytes
    kept++
  }

  if (kept === 0) return null
  if (kept === sentences.length - 1) return null // 没有省略句，无需摘要

  const separator = head.endsWith("\n") ? "…\n" : "…\n"
  const result = head + separator + last
  const resultBytes = encoder.encode(result).byteLength

  return {
    node: { ...node, content: result, byteSize: resultBytes },
    trace: {
      nodeId: node.id,
      action: "summarized",
      reason: `Extractive: ${sentences.length}→${kept + 1} sentences`,
      byteSizeBefore: node.byteSize,
      byteSizeAfter: resultBytes,
      timestamp: Date.now(),
    },
  }
}

function applyDegradation(node: PromptNode, remainingBudget: number): DegradationResult | null {
  switch (node.degradationStrategy) {
    case "drop":
      return null

    case "truncate": {
      const maxBytes = Math.min(node.byteSize, remainingBudget)
      const ratio = maxBytes / node.byteSize
      const truncatedLen = Math.floor(node.content.length * ratio)
      const truncated = node.content.slice(0, truncatedLen)
      return {
        node: {
          ...node,
          content: truncated,
          byteSize: new TextEncoder().encode(truncated).byteLength,
        },
        trace: {
          nodeId: node.id,
          action: "truncated",
          reason: `Truncated to fit remaining budget`,
          byteSizeBefore: node.byteSize,
          byteSizeAfter: truncated.length,
          timestamp: Date.now(),
        },
      }
    }

    case "compress": {
      // 压缩：移除多余空白行
      const compressed = node.content.replace(/\n{3,}/g, "\n\n").trim()
      const newSize = new TextEncoder().encode(compressed).byteLength
      if (newSize >= node.byteSize) return null // 没压缩成功，交给上游drop
      return {
        node: { ...node, content: compressed, byteSize: newSize },
        trace: {
          nodeId: node.id,
          action: "compressed",
          reason: `Compressed whitespace`,
          byteSizeBefore: node.byteSize,
          byteSizeAfter: newSize,
          timestamp: Date.now(),
        },
      }
    }

    case "summarize":
      return extractiveSummarize(node, remainingBudget)

    default:
      return null
  }
}
