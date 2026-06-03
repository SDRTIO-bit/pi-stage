// ============================================================
// scheduler.test.ts — 双预算调度器单元测试
// ============================================================

import { describe, it, expect } from "vitest"
import { schedule } from "../src/context/scheduler.js"
import type { Budget, PromptNode } from "../src/types.js"

function node(
  id: string,
  byteSize: number,
  opts?: { priority?: number; strategy?: PromptNode["degradationStrategy"] },
): PromptNode {
  return {
    id,
    layer: "L1-stable",
    source: "test",
    priority: opts?.priority ?? 50,
    attentionWeight: 0.5,
    content: "x".repeat(byteSize),
    byteSize,
    degradationStrategy: opts?.strategy ?? "drop",
  }
}

const BUDGET: Budget = { target: 100, hard: 200 }

describe("schedule", () => {
  it("all nodes fit within target", () => {
    const nodes = [node("a", 30), node("b", 30), node("c", 30)]
    const r = schedule(nodes, BUDGET)
    expect(r.included).toHaveLength(3)
    expect(r.dropped).toHaveLength(0)
    expect(r.totalBytes).toBe(90)
  })

  it("drops nodes beyond hard limit", () => {
    // node "a": 90B, "b": 90B (exceeds target, default drop → dropped), "c" also dropped
    // Only "a" fits within target of 100; others exceed target and have "drop" strategy
    const nodes = [node("a", 90), node("b", 90), node("c", 90)]
    const r = schedule(nodes, BUDGET)
    expect(r.included).toHaveLength(1)
    expect(r.included[0].id).toBe("a")
    expect(r.dropped).toEqual(["b", "c"])
  })

  it("truncate strategy passes node through between target and hard", () => {
    // When node exceeds target but fits hard, truncate keeps node at full size
    // (hard check runs first; degradation is only tried when within hard limit)
    const nodes = [node("a", 30), node("b", 150, { strategy: "truncate" })]
    const r = schedule(nodes, BUDGET)
    expect(r.included).toHaveLength(2)
    expect(r.included[1].id).toBe("b")
    // truncation only reduces size when node exceeds hard budget, but hard check
    // drops it before degradation can run — so truncate acts as "pass-through"
  })

  it("compresses nodes between target and hard limit", () => {
    const content = "line1\n\n\n\nline2\n\n\n\nline3"
    const n: PromptNode = {
      id: "big",
      layer: "L1-stable",
      source: "test",
      priority: 50,
      attentionWeight: 0.5,
      content,
      byteSize: new TextEncoder().encode(content).byteLength,
      degradationStrategy: "compress",
    }
    const nodes = [node("a", 80), n]
    const r = schedule(nodes, BUDGET)
    expect(r.included).toHaveLength(2)
    expect(r.totalBytes).toBeLessThan(80 + n.byteSize)
  })

  it("extractive summarize keeps head + tail sentences", () => {
    // 15 sentences, ~225 bytes — won't all fit in 170 remaining budget
    const content = Array.from({ length: 15 }, (_, i) => `第${i + 1}句话。`).join("")
    const n: PromptNode = {
      id: "long-text",
      layer: "L1-stable",
      source: "test",
      priority: 50,
      attentionWeight: 0.5,
      content,
      byteSize: new TextEncoder().encode(content).byteLength,
      degradationStrategy: "summarize",
    }
    // first node uses 30, leaving 70 in target, 170 in hard
    const nodes = [node("a", 30), n]
    const r = schedule(nodes, BUDGET)
    expect(r.included).toHaveLength(2)
    const s = r.included.find((n) => n.id === "long-text")!
    expect(s.byteSize).toBeLessThan(n.byteSize)
    expect(s.content).toContain("…")
    expect(r.trace.some((t) => t.action === "summarized")).toBe(true)
  })

  it("preserves input order (sorting is done by caller)", () => {
    // schedule() walks nodes in given order; prioritize() in pipeline does sorting
    const nodes = [
      node("first", 30),
      node("second", 30),
    ]
    const r = schedule(nodes, BUDGET)
    expect(r.included[0].id).toBe("first")
    expect(r.included[1].id).toBe("second")
  })

  it("empty nodes returns empty result", () => {
    const r = schedule([], BUDGET)
    expect(r.included).toHaveLength(0)
    expect(r.totalBytes).toBe(0)
  })

  it("trace entries include scheduled and dropped actions", () => {
    const nodes = [node("a", 300)] // exceeds hard limit
    const r = schedule(nodes, BUDGET)
    expect(r.trace).toHaveLength(1)
    expect(r.trace[0].action).toBe("dropped")
  })
})
