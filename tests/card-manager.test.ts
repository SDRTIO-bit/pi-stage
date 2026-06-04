// ============================================================
// card-manager.test.ts — CardManager 单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { CardManager } from "../src/card-manager.js"
import { StateStore } from "../src/state-store.js"
import { MemoryStorage } from "../src/infrastructure/storage-provider.js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

let tmpDir: string
let cardManager: CardManager
let stateStore: StateStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-cm-test-"))
  stateStore = new StateStore(new MemoryStorage())
  cardManager = new CardManager(tmpDir, stateStore)
})

afterAll(() => {
  const parent = os.tmpdir()
  for (const entry of fs.readdirSync(parent)) {
    if (entry.startsWith("rp-cm-test-")) {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true })
    }
  }
})

describe("CardManager", () => {
  describe("register", () => {
    it("registers a card in memory", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1, tags: ["pc"] })
      const all = cardManager.getAllRegistered()
      expect(all.some((c) => c.id === "hero")).toBe(true)
    })

    it("throws on duplicate id", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      expect(() =>
        cardManager.register({ id: "hero", name: "勇者2", version: 1 }),
      ).toThrow()
    })
  })

  describe("activate / deactivate", () => {
    it("activate puts card in active order", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      cardManager.activate("hero")
      const active = cardManager.getActiveCards()
      expect(active.some((c) => c.id === "hero")).toBe(true)
    })

    it("activate nonexistent card throws", () => {
      expect(() => cardManager.activate("nonexistent")).toThrow()
    })

    it("deactivate removes from active order", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      cardManager.activate("hero")
      cardManager.deactivate("hero")
      const active = cardManager.getActiveCards()
      expect(active.some((c) => c.id === "hero")).toBe(false)
    })

    it("deactivate works without crash when card not active", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      // deactivate a card that was never activated — should not throw
      cardManager.deactivate("hero")
      const active = cardManager.getActiveCards()
      expect(active.some((c) => c.id === "hero")).toBe(false)
    })

    it("activate with sessionId writes CardState", () => {
      stateStore.createSession("s1")
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      cardManager.activate("hero", "s1")

      const state = cardManager.getCardState("hero", "s1")
      expect(state).toBeDefined()
      expect(state!.cardId).toBe("hero")
    })
  })

  describe("getCardState", () => {
    it("returns undefined for unknown card", () => {
      stateStore.createSession("s1")
      expect(cardManager.getCardState("hero", "s1")).toBeUndefined()
    })

    it("returns undefined for unknown session", () => {
      expect(cardManager.getCardState("hero", "nonexistent")).toBeUndefined()
    })
  })

  describe("getRegistry", () => {
    it("returns empty registry for empty dir", () => {
      const reg = cardManager.getRegistry()
      expect(reg.cards).toEqual({})
      expect(reg.active).toEqual([])
    })
  })

  describe("getActiveCardIds", () => {
    it("returns empty array initially", () => {
      expect(cardManager.getActiveCardIds()).toEqual([])
    })
  })

  describe("getCardName", () => {
    it("returns card id as fallback when not in registry", () => {
      expect(cardManager.getCardName("unknown")).toBe("unknown")
    })
  })

  describe("getAllRegistered", () => {
    it("includes memory-registered entries", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      const all = cardManager.getAllRegistered()
      expect(all.some((c) => c.id === "hero")).toBe(true)
    })
  })

  describe("unregister", () => {
    it("removes card from memory and active order", () => {
      cardManager.register({ id: "hero", name: "勇者", version: 1 })
      cardManager.activate("hero")
      cardManager.unregister("hero")
      const all = cardManager.getAllRegistered()
      expect(all.some((c) => c.id === "hero")).toBe(false)
      expect(cardManager.getActiveCards().some((c) => c.id === "hero")).toBe(false)
    })
  })
})
