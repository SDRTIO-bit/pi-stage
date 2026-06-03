// ============================================================
// state-store.test.ts — 状态存储单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { stateStore } from "../src/state-store.js"
import * as fs from "node:fs"

const SID = "test-session-001"

describe("StateStore", () => {
  beforeEach(() => {
    if (fs.existsSync("sessions")) fs.rmSync("sessions", { recursive: true })
  })

  afterAll(() => {
    if (fs.existsSync("sessions")) fs.rmSync("sessions", { recursive: true })
  })

  it("creates and retrieves a session", () => {
    const s = stateStore.createSession(SID)
    expect(s.sessionId).toBe(SID)
    expect(s.history).toHaveLength(0)
    expect(s.runtimeStatus.phase).toBe("idle")

    const got = stateStore.getSession(SID)
    expect(got).toBeDefined()
    expect(got?.sessionId).toBe(SID)
  })

  it("returns undefined for unknown session", () => {
    expect(stateStore.getSession("nonexistent")).toBeUndefined()
  })

  it("appends history entries", () => {
    stateStore.createSession(SID)
    stateStore.appendHistory(SID, "user: hello")
    stateStore.appendHistory(SID, "assistant: hi there")

    const s = stateStore.getSession(SID)!
    expect(s.history).toHaveLength(2)
    expect(s.history[0]).toBe("user: hello")
  })

  it("throws on appendHistory for missing session", () => {
    expect(() => stateStore.appendHistory("nope", "msg")).toThrow()
  })

  it("tracks dirty cards", () => {
    stateStore.createSession(SID)
    expect(stateStore.getDirtyCards()).toHaveLength(0)

    stateStore.markCardDirty("card-a")
    stateStore.markCardDirty("card-b")
    stateStore.markCardDirty("card-a") // duplicate

    const dirty = stateStore.getDirtyCards()
    expect(dirty).toContain("card-a")
    expect(dirty).toContain("card-b")

    stateStore.clearDirtyCards()
    expect(stateStore.getDirtyCards()).toHaveLength(0)
  })

  it("persists and loads session to/from disk", () => {
    stateStore.createSession(SID)
    stateStore.appendHistory(SID, "turn 1")
    stateStore.persist(SID)

    // Verify file exists
    expect(fs.existsSync(`sessions/${SID}/state.json`)).toBe(true)

    // Load into a fresh store
    const loaded = stateStore.load(SID)
    expect(loaded).toBeDefined()
    expect(loaded!.sessionId).toBe(SID)
    expect(loaded!.history).toEqual(["turn 1"])
  })

  it("load returns undefined for missing file", () => {
    expect(stateStore.load("no-such-session")).toBeUndefined()
  })

  it("rebuilds session from history", () => {
    const s = stateStore.rebuildFromHistory("rebuilt", ["a", "b", "c"])
    expect(s.sessionId).toBe("rebuilt")
    expect(s.history).toEqual(["a", "b", "c"])
    expect(s.runtimeStatus.phase).toBe("idle")
  })

  it("lists persisted sessions", () => {
    stateStore.createSession("s1")
    stateStore.createSession("s2")
    stateStore.persist("s1")
    stateStore.persist("s2")

    const list = stateStore.listSessions()
    expect(list).toContain("s1")
    expect(list).toContain("s2")
  })

  it("snapshot returns readonly copy", () => {
    stateStore.createSession(SID)
    const snap = stateStore.snapshot(SID)
    expect(snap!.sessionId).toBe(SID)
  })

  it("snapshot returns undefined for unknown session", () => {
    expect(stateStore.snapshot("nope")).toBeUndefined()
  })

  it("load handles corrupted state.json gracefully", () => {
    stateStore.createSession(SID)
    stateStore.persist(SID)
    fs.writeFileSync(`sessions/${SID}/state.json`, "not json", "utf-8")
    expect(stateStore.load(SID)).toBeUndefined()
  })
})
