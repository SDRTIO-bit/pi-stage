// ============================================================
// worldbook.test.ts — Worldbook 关键词搜索 + 常开设定测试
// ============================================================

import { describe, it, expect } from "vitest"
import { Worldbook, estimateTokens } from "../src/worldbook/index.js"
import type { WorldbookEntry } from "../src/types.js"

function entry(overrides: Partial<WorldbookEntry> = {}): WorldbookEntry {
  return {
    id: overrides.id ?? "e-1",
    name: overrides.name ?? "entry-1",
    keywords: overrides.keywords ?? [],
    priority: overrides.priority ?? 0,
    constant: overrides.constant ?? false,
    enabled: overrides.enabled ?? true,
    content: overrides.content ?? "content",
    category: overrides.category ?? "触发词条",
  }
}

function makeWorldbook(entries: WorldbookEntry[]): Worldbook {
  const wb = new Worldbook()
  wb.load(entries)
  return wb
}

describe("Worldbook", () => {
  describe("searchByKeywords", () => {
    it("exact keyword match returns entries", () => {
      const wb = makeWorldbook([
        entry({ id: "e1", keywords: ["壁炉"], content: "温暖的壁炉" }),
      ])
      const results = wb.searchByKeywords("壁炉")
      expect(results).toHaveLength(1)
      expect(results[0].id).toBe("e1")
    })

    it("case-insensitive partial match", () => {
      const wb = makeWorldbook([
        entry({ id: "e1", keywords: ["Tavern"] }),
      ])
      const results = wb.searchByKeywords("tavern keeper")
      expect(results).toHaveLength(1)
    })

    it("returns entries sorted by priority descending", () => {
      const wb = makeWorldbook([
        entry({ id: "low", keywords: ["magic"], priority: 1 }),
        entry({ id: "high", keywords: ["magic"], priority: 10 }),
      ])
      const results = wb.searchByKeywords("magic")
      expect(results[0].id).toBe("high")
      expect(results[1].id).toBe("low")
    })

    it("disabled entries are not returned", () => {
      const wb = makeWorldbook([
        entry({ id: "e1", keywords: ["sword"], enabled: false }),
      ])
      expect(wb.searchByKeywords("sword")).toHaveLength(0)
    })

    it("no match returns empty array", () => {
      const wb = makeWorldbook([
        entry({ id: "e1", keywords: ["fire"] }),
      ])
      expect(wb.searchByKeywords("water")).toHaveLength(0)
    })

    it("multiple keywords in text match all relevant entries", () => {
      const wb = makeWorldbook([
        entry({ id: "e1", keywords: ["sword"] }),
        entry({ id: "e2", keywords: ["shield"] }),
        entry({ id: "e3", keywords: ["potion"] }),
      ])
      const results = wb.searchByKeywords("I draw my sword and raise my shield")
      expect(results).toHaveLength(2)
    })

    it("deduplicates when multiple keywords match same entry", () => {
      const wb = makeWorldbook([
        entry({ id: "e1", keywords: ["sword", "blade", "weapon"] }),
      ])
      expect(wb.searchByKeywords("sword blade weapon")).toHaveLength(1)
    })
  })

  describe("getConstantEntries", () => {
    it("returns only constant entries", () => {
      const wb = makeWorldbook([
        entry({ id: "c1", constant: true, content: "always" }),
        entry({ id: "t1", constant: false, keywords: ["trigger"] }),
      ])
      const constants = wb.getConstantEntries()
      expect(constants).toHaveLength(1)
      expect(constants[0].id).toBe("c1")
    })

    it("entries with category 常开设定 are treated as constant", () => {
      const wb = makeWorldbook([
        entry({ id: "c1", category: "常开设定", constant: false }),
      ])
      expect(wb.getConstantEntries()).toHaveLength(1)
    })

    it("sorted by priority ascending", () => {
      const wb = makeWorldbook([
        entry({ id: "low", constant: true, priority: 1 }),
        entry({ id: "high", constant: true, priority: 10 }),
      ])
      const constants = wb.getConstantEntries()
      expect(constants[0].id).toBe("low")
      expect(constants[1].id).toBe("high")
    })
  })

  describe("getIndex", () => {
    it("returns counts after load", () => {
      const wb = makeWorldbook([
        entry({ id: "c1", constant: true }),
        entry({ id: "t1", keywords: ["a", "b"] }),
      ])
      const idx = wb.getIndex()
      expect(idx.constantCount).toBe(1)
      expect(idx.triggerKeywordsCount).toBe(2)
    })
  })

  describe("estimateTokens", () => {
    it("empty string returns 0", () => {
      expect(estimateTokens("")).toBe(0)
    })

    it("estimates English at ~4 chars/token", () => {
      const tokens = estimateTokens("hello world") // 11 chars
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThanOrEqual(3)
    })

    it("estimates Chinese at ~1.5 chars/token", () => {
      const tokens = estimateTokens("你好世界") // 4 chars
      expect(tokens).toBeGreaterThan(0)
    })
  })
})
