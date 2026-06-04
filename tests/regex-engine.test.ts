// ============================================================
// regex-engine.test.ts — 正则引擎单元测试
// ============================================================

import { describe, it, expect, beforeEach } from "vitest"
import { RegexEngine, type RegexHook } from "../src/regex/hooks.js"

describe("RegexEngine", () => {
  let engine: RegexEngine

  beforeEach(() => {
    engine = new RegexEngine()
  })

  it("applies prompt-phase hooks", () => {
    engine.load([
      {
        id: "rx-1",
        name: "strip thought",
        pattern: "\\{thought\\}[\\s\\S]*?\\{\\/thought\\}",
        replacement: "",
        phase: "prompt",
        enabled: true,
      },
    ])

    const input = "Hello {thought}secret stuff{/thought} world"
    const result = engine.apply(input, "prompt")
    expect(result).toBe("Hello  world")
  })

  it("applies display-phase hooks", () => {
    engine.load([
      {
        id: "rx-img",
        name: "img tag",
        pattern: "\\[img:(.+?)\\]",
        replacement: "![](\\1)",
        phase: "display",
        enabled: true,
      },
    ])

    const input = "Look [img:photo.png] here"
    const result = engine.apply(input, "display")
    // "\1" is literal in String.replace with a string pattern; $1 would be a backref
    expect(result).toBe("Look ![](\\1) here")
  })

  it("only applies hooks matching the requested phase", () => {
    engine.load([
      {
        id: "rx-p",
        name: "prompt only",
        pattern: "X",
        replacement: "Y",
        phase: "prompt",
        enabled: true,
      },
      {
        id: "rx-d",
        name: "display only",
        pattern: "A",
        replacement: "B",
        phase: "display",
        enabled: true,
      },
    ])

    expect(engine.apply("X A", "prompt")).toBe("Y A")
    expect(engine.apply("X A", "display")).toBe("X B")
  })

  it("skips disabled hooks", () => {
    engine.load([
      {
        id: "rx-off",
        name: "disabled",
        pattern: "bad",
        replacement: "good",
        phase: "prompt",
        enabled: false,
      },
    ])

    expect(engine.apply("bad", "prompt")).toBe("bad")
  })

  it("filters by cardId when provided", () => {
    engine.load([
      {
        id: "rx-card",
        name: "card specific",
        pattern: "\\{name\\}",
        replacement: "Alice",
        phase: "display",
        enabled: true,
        cardId: "hero",
      },
    ])

    // Without cardId filter — hook has cardId, so should only match when cardId matches
    expect(engine.apply("Hello {name}", "display")).toBe("Hello {name}")
    // With matching cardId
    expect(engine.apply("Hello {name}", "display", "hero")).toBe("Hello Alice")
    // With different cardId
    expect(engine.apply("Hello {name}", "display", "npc")).toBe("Hello {name}")
  })

  it("load hooks replace previous ones", () => {
    engine.load([
      { id: "rx-1", name: "a", pattern: "X", replacement: "Y", phase: "prompt", enabled: true },
    ])
    engine.load([
      { id: "rx-2", name: "b", pattern: "A", replacement: "B", phase: "prompt", enabled: true },
    ])
    expect(engine.getHooks()).toHaveLength(1)
    expect(engine.getHooks()[0].id).toBe("rx-2")
  })

  it("loadForCard appends card-scoped hooks", () => {
    engine.load([
      {
        id: "rx-1",
        name: "global",
        pattern: "X",
        replacement: "Y",
        phase: "prompt",
        enabled: true,
      },
    ])
    engine.loadForCard("hero", [
      {
        id: "rx-2",
        name: "hero-only",
        pattern: "A",
        replacement: "B",
        phase: "prompt",
        enabled: true,
      },
    ])
    expect(engine.getHooks()).toHaveLength(2)
    expect(engine.getHooks()[1].cardId).toBe("hero")
  })

  it("clear removes all hooks", () => {
    engine.load([
      { id: "rx-1", name: "a", pattern: "X", replacement: "Y", phase: "prompt", enabled: true },
    ])
    engine.clear()
    expect(engine.getHooks()).toHaveLength(0)
  })

  it("handles invalid regex gracefully", () => {
    engine.load([
      {
        id: "rx-bad",
        name: "bad",
        pattern: "[invalid(",
        replacement: "",
        phase: "prompt",
        enabled: true,
      },
    ])
    expect(() => engine.apply("test", "prompt")).not.toThrow()
    expect(engine.apply("test", "prompt")).toBe("test")
  })

  it("empty input returns empty", () => {
    engine.load([
      { id: "rx-1", name: "a", pattern: "X", replacement: "Y", phase: "prompt", enabled: true },
    ])
    expect(engine.apply("", "prompt")).toBe("")
  })
})
