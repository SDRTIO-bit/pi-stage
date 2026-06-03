// ============================================================
// tools.test.ts — AI 工具集单元测试
// ============================================================

import { describe, it, expect, beforeAll } from "vitest"
import { stateStore } from "../src/state-store.js"
import { cardManager } from "../src/card-manager.js"
import { worldbook } from "../src/worldbook/index.js"
import { createPiTools, callTool, listTools, getTool } from "../src/tools.js"
import type { PiToolDef } from "../src/tools.js"

const SID = "tools-test-session"

function ensureCardsRegistered() {
  for (const card of [
    { id: "hero", name: "勇者", version: 1, tags: ["pc"] },
    { id: "npc", name: "精灵", version: 1, tags: ["npc"] },
  ]) {
    try {
      cardManager.register(card)
    } catch {
      // already registered from previous test — ok
    }
  }
}

function setupSession(sessionId: string) {
  stateStore.createSession(sessionId)
  ensureCardsRegistered()
  cardManager.activate("hero", sessionId)
  cardManager.activate("npc", sessionId)
  if (worldbook.getIndex().constantCount === 0) {
    worldbook.load([
      {
        id: "wb-tavern", name: "酒馆场景", keywords: ["酒馆", "旅店"], priority: 10,
        constant: true, enabled: true, content: "温暖的壁炉，橡木吧台。", category: "常开设定",
      },
      {
        id: "wb-secret", name: "密道", keywords: ["地下室", "密道", "暗门"], priority: 5,
        constant: false, enabled: true, content: "吧台下有暗门通往密道。", category: "触发词条",
      },
    ])
  }
}

describe("createPiTools", () => {
  let tools: PiToolDef[]

  beforeAll(() => {
    setupSession(SID)
    tools = createPiTools({ current: SID })
  })

  it("returns 4 tools", () => {
    expect(tools).toHaveLength(4)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(["advance_time", "read_state", "search_worldbook", "update_state"])
  })

  it("read_state returns all variables when no keys specified", async () => {
    const t = tools.find((t) => t.name === "read_state")!
    const heroState = stateStore.getSession(SID)!.activatedCards.get("hero")!
    heroState.variables = { hp: 100, mp: 50 }

    const result = await t.execute("call-1", {}, null, null, {})
    const text = result.content[0].text
    expect(text).toContain("hp")
    expect(text).toContain("mp")
  })

  it("read_state filters by keys", async () => {
    const t = tools.find((t) => t.name === "read_state")!
    const heroState = stateStore.getSession(SID)!.activatedCards.get("hero")!
    heroState.variables = { hp: 100, mp: 50, xp: 200 }

    const result = await t.execute("call-2", { keys: ["hp", "mp"] }, null, null, {})
    const text = result.content[0].text
    expect(text).toContain("hp")
    expect(text).toContain("mp")
    expect(text).not.toContain("xp")
  })

  it("read_state returns placeholder when no active cards", async () => {
    const emptySid = "empty-tools-session"
    stateStore.createSession(emptySid)
    const emptyTools = createPiTools({ current: emptySid })
    const t = emptyTools.find((t) => t.name === "read_state")!
    const result = await t.execute("call-3", {}, null, null, {})
    expect(result.content[0].text).toContain("无激活卡片")
  })

  it("update_state sets variables on card", async () => {
    const t = tools.find((t) => t.name === "update_state")!
    const result = await t.execute("call-4", { cardId: "hero", updates: { hp: 80, mood: "angry" } }, null, null, {})
    expect(result.content[0].text).toContain("已更新")
    expect(result.content[0].text).toContain("hero")

    const heroState = stateStore.getSession(SID)!.activatedCards.get("hero")!
    expect(heroState.variables.hp).toBe(80)
    expect(heroState.variables.mood).toBe("angry")
  })

  it("update_state errors on non-active card", async () => {
    const t = tools.find((t) => t.name === "update_state")!
    const result = await t.execute("call-5", { cardId: "nonexistent", updates: { x: 1 } }, null, null, {})
    expect(result.content[0].text).toContain("❌")
  })

  it("advance_time returns formatted time message", async () => {
    const t = tools.find((t) => t.name === "advance_time")!
    const result = await t.execute("call-6", { amount: 3, unit: "hours" }, null, null, {})
    expect(result.content[0].text).toContain("3 hours")
  })

  it("search_worldbook finds matching entries", async () => {
    const t = tools.find((t) => t.name === "search_worldbook")!
    const result = await t.execute("call-7", { query: "地下室" }, null, null, {})
    expect(result.content[0].text).toContain("密道")
  })

  it("search_worldbook returns not found for no matches", async () => {
    const t = tools.find((t) => t.name === "search_worldbook")!
    const result = await t.execute("call-8", { query: "飞机" }, null, null, {})
    expect(result.content[0].text).toContain("未找到")
  })

  it("read_state errors on no active session", async () => {
    const deadTools = createPiTools({ current: "nope" })
    const t = deadTools.find((t) => t.name === "read_state")!
    const result = await t.execute("call-9", {}, null, null, {})
    expect(result.content[0].text).toContain("❌")
  })
})

describe("old API (registerTool / callTool)", () => {
  beforeAll(() => {
    setupSession(SID)
  })

  it("lists registered tools", () => {
    const tools = listTools()
    expect(tools.length).toBeGreaterThanOrEqual(4)
    const names = tools.map((t) => t.definition.name)
    expect(names).toContain("read_state")
    expect(names).toContain("update_state")
    expect(names).toContain("advance_time")
    expect(names).toContain("search_worldbook")
  })

  it("calls old API tool successfully", async () => {
    const result = await callTool("search_worldbook", { query: "旅店" }, SID)
    const parsed = JSON.parse(result)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].name).toBe("酒馆场景")
  })

  it("getTool returns handler by name", () => {
    const t = getTool("read_state")
    expect(t).toBeDefined()
    expect(t!.definition.name).toBe("read_state")
  })

  it("getTool returns undefined for unknown tool", () => {
    expect(getTool("nope")).toBeUndefined()
  })

  it("callTool returns error for unknown tool", async () => {
    const result = await callTool("nope", {}, SID)
    const parsed = JSON.parse(result)
    expect(parsed.error).toContain("not found")
  })

  it("callTool returns error for missing session", async () => {
    const result = await callTool("read_state", {}, "no-session")
    const parsed = JSON.parse(result)
    expect(parsed.error).toBe("Session not found")
  })
})
