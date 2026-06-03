// ============================================================
// card-importer.test.ts — SillyTavern 卡片导入测试
// ============================================================

import { describe, it, expect } from "vitest"
import { importCard, type STV2Card, type STV3Card } from "../src/cards/importer.js"

const v2Minimal: STV2Card = {
  name: "TestChar",
  description: "",
  personality: "",
  scenario: "",
  first_mes: "",
  mes_example: "",
  creator_notes: "",
  system_prompt: "",
  tags: [],
  creator: "",
  character_version: "1.0",
  extensions: {},
}

const v2Full: STV2Card = {
  name: "ShadowMage",
  description: "A dark mage from the northern wastes",
  personality: "Cold and calculating, but fiercely loyal to allies",
  scenario: "The tavern at dusk, rain pouring outside",
  first_mes: "*She looks up from her spellbook* You're late.",
  mes_example: "{{char}}: Do not test my patience.\n{{user}}: I wouldn't dare.",
  creator_notes: "NPC for main quest",
  system_prompt: "You are ShadowMage. Speak in a cold tone. Use * actions.",
  tags: ["mage", "dark", "quest-npc"],
  creator: "Alice",
  character_version: "2.0",
  extensions: { depth: 4 },
}

const v3Card: STV3Card = {
  spec: "chara_card_v3",
  name: "LunaLight",
  description: "A celestial guardian of the moon temple",
  personality: "Gentle, wise, speaks in riddles",
  scenario: "The moon temple under eternal twilight",
  first_mes: "Welcome, traveler of the night. The moon has been expecting you.",
  mes_example: "",
  creator_notes: "",
  system_prompt: "You are LunaLight. Speak poetically. Use celestial imagery.",
  tags: ["celestial", "guardian", "quest-npc"],
  creator: "Bob",
  character_version: "3.0",
  extensions: {},
  alternate_greetings: ["Greetings, mortal.", "The stars guided you here."],
}

describe("importCard", () => {
  it("imports V2 card with full data", () => {
    const result = importCard(v2Full, "card-001")
    expect(result.meta.id).toBe("card-001")
    expect(result.meta.name).toBe("ShadowMage")
    expect(result.meta.description).toBe("A dark mage from the northern wastes")
    expect(result.meta.tags).toEqual(["mage", "dark", "quest-npc"])
    expect(result.meta.version).toBe(2)

    expect(result.initialContent).toContain("[System]")
    expect(result.initialContent).toContain("You are ShadowMage")
    expect(result.initialContent).toContain("[Personality]")
    expect(result.initialContent).toContain("Cold and calculating")
    expect(result.initialContent).toContain("[Scenario]")
    expect(result.initialContent).toContain("The tavern at dusk")
    expect(result.initialContent).toContain("[First Message]")
    expect(result.initialContent).toContain("*She looks up from her spellbook*")
    expect(result.initialContent).toContain("[Example Messages]")
  })

  it("imports V3 card with spec version", () => {
    const result = importCard(v3Card)
    expect(result.meta.version).toBe(3)
    expect(result.meta.name).toBe("LunaLight")

    const content = result.initialContent
    expect(content).toContain("[System]")
    expect(content).toContain("LunaLight")
    // V3 alternate_greetings should not appear in initialContent
  })

  it("assigns auto-generated id when not provided", () => {
    const result = importCard(v2Minimal)
    expect(result.meta.id).toMatch(/^card-\d+-[a-z0-9]+$/)
  })

  it("handles minimal V2 data without errors", () => {
    const result = importCard(v2Minimal)
    expect(result.meta.name).toBe("TestChar")
    expect(result.meta.version).toBe(2)
    expect(result.meta.tags).toEqual([])
    expect(result.initialContent).toBe("")
  })

  it("handles V2 with only system_prompt", () => {
    const card: STV2Card = {
      ...v2Minimal,
      system_prompt: "You are a helpful assistant.",
    }
    const result = importCard(card)
    expect(result.initialContent).toBe("[System]\nYou are a helpful assistant.")
  })

  it("handles V2 with only personality", () => {
    const card: STV2Card = { ...v2Minimal, personality: "Brave and honest." }
    const result = importCard(card)
    expect(result.initialContent).toBe("[Personality]\nBrave and honest.")
  })

  it("handles V2 with only first_mes", () => {
    const card: STV2Card = { ...v2Minimal, first_mes: "Hello there!" }
    const result = importCard(card)
    expect(result.initialContent).toBe("[First Message]\nHello there!")
  })

  it("handles V2 with only scenario", () => {
    const card: STV2Card = { ...v2Minimal, scenario: "A dark forest." }
    const result = importCard(card)
    expect(result.initialContent).toBe("[Scenario]\nA dark forest.")
  })

  it("handles V2 with only mes_example", () => {
    const card: STV2Card = {
      ...v2Minimal,
      mes_example: "{{char}}: Hi\n{{user}}: Hello",
    }
    const result = importCard(card)
    expect(result.initialContent).toBe("[Example Messages]\n{{char}}: Hi\n{{user}}: Hello")
  })

  it("sections separated by double newlines", () => {
    const card: STV2Card = {
      ...v2Minimal,
      system_prompt: "Sys",
      personality: "Pers",
    }
    const result = importCard(card)
    expect(result.initialContent).toBe("[System]\nSys\n\n[Personality]\nPers")
  })

  it("V3 alternate_greetings not included in content", () => {
    const result = importCard(v3Card)
    expect(result.initialContent).not.toContain("Greetings, mortal")
    expect(result.initialContent).not.toContain("The stars guided you")
  })

  it("V3 spec field sets version to 3", () => {
    const result = importCard(v3Card)
    expect(result.meta.version).toBe(3)
  })

  it("V2 without spec field sets version to 2 (implied)", () => {
    const result = importCard(v2Full)
    expect(result.meta.version).toBe(2)
  })
})
