// ============================================================
// state-store.test.ts — 状态存储单元测试
// 使用 MemoryStorage 替代文件系统，消除 beforeEach 清理
// ============================================================

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import { StateStore } from "../src/state-store.js"
import { MemoryStorage, FileSystemStorage } from "../src/infrastructure/storage-provider.js"
import * as fs from "node:fs"

const SID = "test-session-001"

describe("StateStore (MemoryStorage)", () => {
  let store: StateStore

  beforeEach(() => {
    store = new StateStore(new MemoryStorage())
  })

  it("creates and retrieves a session", () => {
    const s = store.createSession(SID)
    expect(s.sessionId).toBe(SID)
    expect(s.history).toHaveLength(0)
    expect(s.runtimeStatus.phase).toBe("idle")

    const got = store.getSession(SID)
    expect(got).toBeDefined()
    expect(got?.sessionId).toBe(SID)
  })

  it("returns undefined for unknown session", () => {
    expect(store.getSession("nonexistent")).toBeUndefined()
  })

  it("appends history entries", () => {
    store.createSession(SID)
    store.appendHistory(SID, "user: hello")
    store.appendHistory(SID, "assistant: hi there")

    const s = store.getSession(SID)!
    expect(s.history).toHaveLength(2)
    expect(s.history[0]).toBe("user: hello")
  })

  it("throws on appendHistory for missing session", () => {
    expect(() => store.appendHistory("nope", "msg")).toThrow()
  })

  it("tracks dirty cards", () => {
    store.createSession(SID)
    expect(store.getDirtyCards()).toHaveLength(0)

    store.markCardDirty("card-a")
    store.markCardDirty("card-b")
    store.markCardDirty("card-a") // duplicate

    const dirty = store.getDirtyCards()
    expect(dirty).toContain("card-a")
    expect(dirty).toContain("card-b")

    store.clearDirtyCards()
    expect(store.getDirtyCards()).toHaveLength(0)
  })

  it("persists and loads session", () => {
    store.createSession(SID)
    store.appendHistory(SID, "turn 1")
    store.persist(SID)

    const loaded = store.load(SID)
    expect(loaded).toBeDefined()
    expect(loaded!.sessionId).toBe(SID)
    expect(loaded!.history).toEqual(["turn 1"])
  })

  it("load returns undefined for missing session", () => {
    expect(store.load("no-such-session")).toBeUndefined()
  })

  it("rebuilds session from history", () => {
    const s = store.rebuildFromHistory("rebuilt", ["a", "b", "c"])
    expect(s.sessionId).toBe("rebuilt")
    expect(s.history).toEqual(["a", "b", "c"])
    expect(s.runtimeStatus.phase).toBe("idle")
  })

  it("lists persisted sessions", () => {
    store.createSession("s1")
    store.createSession("s2")
    store.persist("s1")
    store.persist("s2")

    const list = store.listSessions()
    expect(list).toContain("s1")
    expect(list).toContain("s2")
  })

  it("snapshot returns readonly copy", () => {
    store.createSession(SID)
    const snap = store.snapshot(SID)
    expect(snap!.sessionId).toBe(SID)
  })

  it("snapshot returns undefined for unknown session", () => {
    expect(store.snapshot("nope")).toBeUndefined()
  })
})

describe("StateStore (FileSystemStorage)", () => {
  const FS_SID = "fs-test-session"

  afterAll(() => {
    if (fs.existsSync("sessions")) fs.rmSync("sessions", { recursive: true })
  })

  it("persists to disk and loads back", () => {
    if (fs.existsSync("sessions")) fs.rmSync("sessions", { recursive: true })
    const store = new StateStore(new FileSystemStorage("sessions"))
    store.createSession(FS_SID)
    store.appendHistory(FS_SID, "turn 1")
    store.persist(FS_SID)

    expect(fs.existsSync(`sessions/${FS_SID}.json`)).toBe(true)

    const loaded = store.load(FS_SID)
    expect(loaded).toBeDefined()
    expect(loaded!.history).toEqual(["turn 1"])
  })

  it("load handles corrupted data gracefully", () => {
    const store = new StateStore(new FileSystemStorage("sessions"))
    store.createSession(FS_SID)
    store.persist(FS_SID)
    fs.writeFileSync(`sessions/${FS_SID}.json`, "not json", "utf-8")
    expect(store.load(FS_SID)).toBeUndefined()
  })
})
