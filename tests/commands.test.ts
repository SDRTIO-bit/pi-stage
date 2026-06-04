// ============================================================
// commands.test.ts — 命令系统单元测试
// ============================================================

import { describe, it, expect, vi, beforeEach } from "vitest"
import { handleCommand } from "../src/commands/index.js"

// mock module-level singletons used by core commands
vi.mock("../src/card-manager.js", () => ({
  cardManager: {
    getAllRegistered: vi.fn(),
    activate: vi.fn(),
    deactivate: vi.fn(),
  },
}))

const mockSession = (overrides: Record<string, unknown> = {}) => ({
  sessionId: "test-session",
  startedAt: Date.now(),
  activatedCards: new Map(),
  history: ["user: hello"],
  runtimeStatus: {
    phase: "idle" as const,
    currentBudget: { target: 8192, hard: 12288 },
    totalBytesUsed: 0,
    nodeCount: 5,
    trace: [{ nodeId: "n1", action: "collected" as const, reason: "test", timestamp: 1 }],
    degradationApplied: false,
  },
  ...overrides,
})

vi.mock("../src/state-store.js", () => ({
  stateStore: {
    getSession: vi.fn(),
  },
}))

vi.mock("../src/context/pipeline.js", () => ({
  contextPipeline: {
    assemble: vi.fn(),
  },
}))

import { cardManager } from "../src/card-manager.js"
import { stateStore } from "../src/state-store.js"
import { contextPipeline } from "../src/context/pipeline.js"

beforeEach(() => {
  vi.clearAllMocks()
})

describe("handleCommand", () => {
  describe("/card", () => {
    it("list returns registered cards", async () => {
      vi.mocked(cardManager.getAllRegistered).mockReturnValue([
        { id: "hero", name: "勇者", version: 1, tags: ["pc"] },
        { id: "npc", name: "精灵", version: 1, tags: ["npc"], activatedAt: Date.now() },
      ])

      const result = await handleCommand("/card list", "s1")
      expect(result).toContain("hero")
      expect(result).toContain("npc")
      expect(result).toContain("🟢") // activated
    })

    it("activate calls cardManager.activate", async () => {
      vi.mocked(cardManager.activate).mockReturnValue(undefined)

      const result = await handleCommand("/card activate hero", "s1")
      expect(cardManager.activate).toHaveBeenCalledWith("hero", "s1")
      expect(result).toContain("已激活")
    })

    it("activate with no id shows usage", async () => {
      const result = await handleCommand("/card activate", "s1")
      expect(result).toContain("用法:")
    })

    it("deactivate calls cardManager.deactivate", async () => {
      const result = await handleCommand("/card deactivate hero", "s1")
      expect(cardManager.deactivate).toHaveBeenCalledWith("hero")
      expect(result).toContain("已停用")
    })

    it("unknown subcommand shows usage", async () => {
      const result = await handleCommand("/card foobar", "s1")
      expect(result).toContain("用法:")
    })
  })

  describe("/status", () => {
    it("returns status for active session", async () => {
      vi.mocked(stateStore.getSession).mockReturnValue(mockSession() as any)

      const result = await handleCommand("/status", "s1")
      expect(result).toContain("引擎状态")
      expect(result).toContain("test-session")
      expect(result).toContain("idle")
    })

    it("returns message when no session", async () => {
      vi.mocked(stateStore.getSession).mockReturnValue(undefined)

      const result = await handleCommand("/status", "s1")
      expect(result).toBe("无活跃 Session")
    })
  })

  describe("/reset", () => {
    it("resets session history and phase", async () => {
      const sess = mockSession()
      vi.mocked(stateStore.getSession).mockReturnValue(sess as any)

      const result = await handleCommand("/reset", "s1")
      expect(result).toContain("已重置")
      expect(sess.history).toEqual([])
      expect(sess.runtimeStatus.phase).toBe("idle")
    })

    it("no session — does not crash", async () => {
      vi.mocked(stateStore.getSession).mockReturnValue(undefined)

      const result = await handleCommand("/reset", "s1")
      expect(result).toContain("已重置")
    })
  })

  describe("/diag", () => {
    it("ready pipeline returns trace info", async () => {
      vi.mocked(contextPipeline.assemble).mockResolvedValue({
        phase: "ready",
        prompt: "test prompt",
        displayPrompt: "test display",
        status: {
          nodeCount: 3,
          degradationApplied: false,
          trace: [{ nodeId: "n1", action: "collected" as const, reason: "test", timestamp: 1 }],
        },
      })

      const result = await handleCommand("/diag", "s1")
      expect(result).toContain("节点数: 3")
      expect(result).toContain("Prompt: 11 chars")
    })

    it("non-ready pipeline returns phase message", async () => {
      vi.mocked(contextPipeline.assemble).mockResolvedValue({
        phase: "error",
        message: "something broke",
      } as any)

      const result = await handleCommand("/diag", "s1")
      expect(result).toContain("管线失败")
    })
  })

  describe("/history", () => {
    it("returns history entries", async () => {
      vi.mocked(stateStore.getSession).mockReturnValue(
        mockSession({ history: ["user: hi", "assistant: hello"] }) as any,
      )

      const result = await handleCommand("/history", "s1")
      expect(result).toContain("user: hi")
      expect(result).toContain("assistant: hello")
    })

    it("no session shows message", async () => {
      vi.mocked(stateStore.getSession).mockReturnValue(undefined)

      const result = await handleCommand("/history", "s1")
      expect(result).toBe("无活跃 Session")
    })
  })

  describe("unknown command", () => {
    it("returns unknown command message", async () => {
      const result = await handleCommand("/bogus arg", "s1")
      expect(result).toContain("Unknown command")
    })
  })
})
