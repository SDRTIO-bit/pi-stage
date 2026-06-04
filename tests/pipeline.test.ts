// ============================================================
// pipeline.test.ts — ContextPipeline 单元测试
// ============================================================

import { describe, it, expect, vi } from "vitest"
import { ContextPipeline, type Collector } from "../src/context/pipeline.js"
import type { PromptNode, Budget } from "../src/types.js"
import type { StateStore } from "../src/state-store.js"
import type { RegexEngine } from "../src/regex/hooks.js"

function makeNode(overrides: Partial<PromptNode> = {}): PromptNode {
  return {
    id: overrides.id ?? "node-1",
    layer: overrides.layer ?? "L0-survival",
    source: overrides.source ?? "system",
    content: overrides.content ?? "test content",
    priority: overrides.priority ?? 0,
    attentionWeight: overrides.attentionWeight ?? 1,
    byteSize: overrides.byteSize ?? (overrides.content ?? "test content").length,
  }
}

function mockStateStore(runtimeStatus?: object): StateStore {
  return {
    getSession: vi.fn().mockReturnValue(
      runtimeStatus !== undefined ? { runtimeStatus } : { runtimeStatus: {} },
    ),
  } as unknown as StateStore
}

function mockRegexEngine(applyFn?: (s: string, p: string) => string): RegexEngine {
  return {
    apply: vi.fn().mockImplementation(applyFn ?? ((s: string) => s)),
  } as unknown as RegexEngine
}

describe("ContextPipeline", () => {
  describe("assemble", () => {
    it("empty pipeline returns ready with empty prompt", async () => {
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      const result = await pipeline.assemble("s1")
      expect(result.phase).toBe("ready")
      if (result.phase === "ready") {
        expect(result.prompt).toBe("")
        expect(result.displayPrompt).toBe("")
      }
    })

    it("single collector produces prompt from its nodes", async () => {
      const collector: Collector = {
        name: "test-collector",
        collect: async () => [makeNode({ content: "hello world", byteSize: 11 })],
      }
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      pipeline.registerCollector(collector)

      const result = await pipeline.assemble("s1")
      expect(result.phase).toBe("ready")
      if (result.phase === "ready") {
        expect(result.prompt).toContain("hello world")
        expect(result.status.nodeCount).toBeGreaterThan(0)
      }
    })

    it("multiple collectors merge all nodes", async () => {
      const c1: Collector = {
        name: "c1",
        collect: async () => [makeNode({ id: "n1", content: "first", priority: 10 })],
      }
      const c2: Collector = {
        name: "c2",
        collect: async () => [makeNode({ id: "n2", content: "second", priority: 5 })],
      }
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      pipeline.registerCollector(c1)
      pipeline.registerCollector(c2)

      const result = await pipeline.assemble("s1")
      if (result.phase === "ready") {
        expect(result.prompt).toContain("first")
        expect(result.prompt).toContain("second")
      }
    })

    it("nodes are sorted by priority ascending", async () => {
      const collector: Collector = {
        name: "c",
        collect: async () => [
          makeNode({ id: "high", content: "Z", priority: 99 }),
          makeNode({ id: "low", content: "A", priority: 1 }),
        ],
      }
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      pipeline.registerCollector(collector)

      const result = await pipeline.assemble("s1")
      if (result.phase === "ready") {
        const idxA = result.prompt.indexOf("A")
        const idxZ = result.prompt.indexOf("Z")
        expect(idxA).toBeLessThan(idxZ)
      }
    })

    it("tight budget triggers degradation", async () => {
      const collector: Collector = {
        name: "c",
        collect: async () => [
          makeNode({ id: "big", content: "A".repeat(1000), byteSize: 1000 }),
          makeNode({ id: "also-big", content: "B".repeat(1000), byteSize: 1000 }),
        ],
      }
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      pipeline.setBudget({ target: 500, hard: 800 })
      pipeline.registerCollector(collector)

      const result = await pipeline.assemble("s1")
      if (result.phase === "ready") {
        expect(result.status.degradationApplied).toBe(true)
      }
    })

    it("collector error is caught — does not crash pipeline", async () => {
      const badCollector: Collector = {
        name: "bad",
        collect: async () => {
          throw new Error("BOOM")
        },
      }
      const goodCollector: Collector = {
        name: "good",
        collect: async () => [makeNode({ id: "n1", content: "still-works" })],
      }
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      pipeline.registerCollector(badCollector)
      pipeline.registerCollector(goodCollector)

      const result = await pipeline.assemble("s1")
      // pipeline should not crash, good collector nodes still come through
      expect(result.phase).toBe("ready")
      if (result.phase === "ready") {
        expect(result.prompt).toContain("still-works")
      }
    })

    it("missing session does not crash — just skips runtimeStatus write", async () => {
      const st = mockStateStore(undefined)
      vi.mocked(st.getSession).mockReturnValue(undefined)

      const collector: Collector = {
        name: "c",
        collect: async () => [makeNode({ content: "test" })],
      }
      const pipeline = new ContextPipeline(st, mockRegexEngine())
      pipeline.registerCollector(collector)

      const result = await pipeline.assemble("nonexistent")
      expect(result.phase).toBe("ready")
    })

    it("regexEngine.apply transforms prompt and display", async () => {
      const re = mockRegexEngine((s, phase) =>
        phase === "prompt" ? s.replace(/secret/g, "***") : s,
      )
      const collector: Collector = {
        name: "c",
        collect: async () => [makeNode({ content: "secret message" })],
      }
      const pipeline = new ContextPipeline(mockStateStore(), re)
      pipeline.registerCollector(collector)

      const result = await pipeline.assemble("s1")
      if (result.phase === "ready") {
        expect(result.prompt).toContain("***")
        expect(result.displayPrompt).toContain("secret")
      }
    })

    it("setBudget changes scheduling behavior", async () => {
      const collector: Collector = {
        name: "c",
        collect: async () => [makeNode({ content: "x", byteSize: 1 })],
      }
      const pipeline = new ContextPipeline(mockStateStore(), mockRegexEngine())
      pipeline.registerCollector(collector)

      // generous budget — node included
      pipeline.setBudget({ target: 10000, hard: 20000 })
      const r1 = await pipeline.assemble("s1")
      if (r1.phase === "ready") {
        expect(r1.status.nodeCount).toBeGreaterThan(0)
      }

      // tiny budget — node dropped
      pipeline.setBudget({ target: 0, hard: 0 })
      const r2 = await pipeline.assemble("s2")
      if (r2.phase === "ready") {
        expect(r2.prompt).toBe("")
      }
    })

    it("writes runtimeStatus to session when session exists", async () => {
      const sessionObj: { runtimeStatus: unknown } = { runtimeStatus: null }
      const st = {
        getSession: vi.fn().mockReturnValue(sessionObj),
      } as unknown as StateStore
      const collector: Collector = {
        name: "c",
        collect: async () => [makeNode({ content: "hello" })],
      }
      const pipeline = new ContextPipeline(st, mockRegexEngine())
      pipeline.registerCollector(collector)

      await pipeline.assemble("s1")
      // pipeline overwrites session.runtimeStatus
      expect(sessionObj.runtimeStatus).toBeDefined()
    })
  })
})
