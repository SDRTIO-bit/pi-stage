// ============================================================
// performance.test.ts — 10 轮压测
// 模拟长 session 下双预算调度、状态持久化的稳定性
// ============================================================

import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { stateStore } from "../src/state-store.js"
import { cardManager } from "../src/card-manager.js"
import { contextPipeline, type Collector } from "../src/context/pipeline.js"
import { createNode } from "../src/context/prompt-node.js"
import { worldbook } from "../src/worldbook/index.js"
import { callTool } from "../src/tools.js"
import { lifecycleBus } from "../src/lifecycle/events.js"
import { agentPipeline } from "../src/lifecycle/agent-pipeline.js"
import * as fs from "node:fs"

const SESSION_ID = "perf-test-10r"
const TURNS = 10

interface TurnMetrics {
  turn: number
  promptBytes: number
  displayBytes: number
  nodeCount: number
  degraded: boolean
  collectMs: number
  persistMs: number
  toolMs: number
}

describe("10 轮压测", () => {
  beforeAll(async () => {
    // 清理上次残留
    if (fs.existsSync("sessions")) {
      fs.rmSync("sessions", { recursive: true })
    }

    // ---- 初始化 ----
    stateStore.createSession(SESSION_ID)

    // 注册 3 张卡片
    cardManager.register({ id: "hero", name: "勇者亚瑟", version: 1, tags: ["pc"] })
    cardManager.register({ id: "npc-guide", name: "引路精灵", version: 1, tags: ["npc"] })
    cardManager.register({ id: "npc-merchant", name: "旅行商人", version: 1, tags: ["npc"] })
    cardManager.activate("hero", SESSION_ID)
    cardManager.activate("npc-guide", SESSION_ID)

    // 世界书：10 条常开 + 10 条触发
    const entries = Array.from({ length: 20 }, (_, i) => {
      const isConstant = i < 10
      return {
        id: `wb-${String(i).padStart(3, "0")}`,
        name: isConstant ? `常开设定#${i}` : `触发词条#${i}`,
        keywords: isConstant ? [] : [`keyword${i}`, `tag${i}`],
        priority: i,
        constant: isConstant,
        enabled: true,
        content: `这是第 ${i} 条世界书内容。`.repeat(isConstant ? 50 : 10),
        category: (isConstant ? "常开设定" : "触发词条") as "常开设定" | "触发词条" | "禁用设定",
      }
    })
    worldbook.load(entries)

    // Collector（模拟 10 个模块申报上下文，总字节远超预算）
    const collectors: Collector[] = [
      {
        name: "system-base",
        collect: async () => [
          createNode({
            layer: "L0-survival",
            source: "system",
            priority: 0,
            content: "你是角色扮演AI，严格遵循设定。",
          }),
        ],
      },
      {
        name: "card-profile",
        collect: async () =>
          cardManager.getActiveCards().map((c) =>
            createNode({
              layer: "L0-survival",
              source: `card:${c.name}`,
              priority: 5,
              content: `设定：${c.name}，标签：${(c.tags ?? []).join(", ")}`,
              attentionWeight: 0.9,
            }),
          ),
      },
      {
        name: "worldbook-constant",
        collect: async () =>
          worldbook.getConstantEntries().map((e) =>
            createNode({
              layer: "L1-stable",
              source: "常开设定",
              priority: 10,
              content: e.content,
              degradationStrategy: "compress",
            }),
          ),
      },
      {
        name: "history-recent",
        collect: async () => {
          const session = stateStore.getSession(SESSION_ID)
          const recent = (session?.history ?? []).slice(-6)
          return [
            createNode({
              layer: "L1-stable",
              source: "最近对话",
              priority: 15,
              content: recent.join("\n") || "（无历史）",
            }),
          ]
        },
      },
      {
        name: "state-vars",
        collect: async () => {
          const vars = cardManager.getCardState("hero", SESSION_ID)?.variables ?? {}
          return [
            createNode({
              layer: "L2-enhanced",
              source: "角色状态",
              priority: 30,
              content: JSON.stringify(vars),
              degradationStrategy: "truncate",
            }),
          ]
        },
      },
    ]
    for (const c of collectors) contextPipeline.registerCollector(c)

    // 预算压到 2048/4096 强制触发降级
    contextPipeline.setBudget({ target: 2048, hard: 4096 })
  })

  const metrics: TurnMetrics[] = []

  it("10 轮对话压测", async () => {
    for (let turn = 1; turn <= TURNS; turn++) {
      // ---- 模拟用户输入 ----
      const userMsg = `第${turn}轮：keyword${turn % 10} 我想看看有什么商品`
      stateStore.appendHistory(SESSION_ID, `user: ${userMsg}`)

      // ---- 模拟工具调用（搜索世界书 + 更新状态） ----
      const t0 = performance.now()
      await callTool("search_worldbook", { query: `keyword${turn % 10}` }, SESSION_ID)
      await callTool(
        "update_state",
        { cardId: "hero", updates: { turn, hp: 100 - turn * 5 } },
        SESSION_ID,
      )
      const toolMs = performance.now() - t0

      // ---- Pipeline ----
      const t1 = performance.now()
      const result = await contextPipeline.assemble(SESSION_ID)
      const collectMs = performance.now() - t1

      expect(result.phase).toBe("ready")

      // ---- 持久化 ----
      const t2 = performance.now()
      stateStore.persist(SESSION_ID)
      const persistMs = performance.now() - t2

      // ---- Agent（turn_end 事件触发） ----
      await lifecycleBus.emit("turn_end", SESSION_ID, { turn })
      const agentActions = await agentPipeline.run(SESSION_ID)

      // ---- 记录指标 ----
      const m: TurnMetrics = {
        turn,
        promptBytes:
          result.phase === "ready" ? new TextEncoder().encode(result.prompt).byteLength : 0,
        displayBytes:
          result.phase === "ready" ? new TextEncoder().encode(result.displayPrompt).byteLength : 0,
        nodeCount: result.status.nodeCount ?? 0,
        degraded: result.status.degradationApplied ?? false,
        collectMs: Math.round(collectMs),
        persistMs: Math.round(persistMs),
        toolMs: Math.round(toolMs),
      }
      metrics.push(m)

      // ---- 状态校验 ----
      const session = stateStore.getSession(SESSION_ID)
      expect(session?.history.length).toBe(turn) // 每轮 1 条

      // 每 5 轮验证一次持久化恢复
      if (turn % 5 === 0) {
        const loaded = stateStore.load(SESSION_ID)
        expect(loaded?.sessionId).toBe(SESSION_ID)
        expect(loaded?.history.length).toBe(turn)
      }
    }
  })

  afterAll(() => {
    // ---- 打印报表 ----
    console.log("\n=== 10 轮压测报表 ===\n")
    console.log("Turn  promptB  displayB  nodes  degraded  collectMs  persistMs  toolMs")
    console.log("─".repeat(72))
    for (const m of metrics) {
      console.log(
        `  ${String(m.turn).padStart(2)}  ${String(m.promptBytes).padStart(7)}  ${String(
          m.displayBytes,
        ).padStart(8)}  ${String(m.nodeCount).padStart(5)}  ${
          m.degraded ? "YES    " : "no     "
        }  ${String(m.collectMs).padStart(4)}ms  ${String(m.persistMs).padStart(4)}ms  ${String(m.toolMs).padStart(4)}ms`,
      )
    }

    const degradedCount = metrics.filter((m) => m.degraded).length
    console.log(`\n降级触发: ${degradedCount}/${TURNS} 轮`)
    console.log(
      `平均 collect: ${Math.round(metrics.reduce((s, m) => s + m.collectMs, 0) / TURNS)}ms`,
    )
    console.log(
      `平均 persist: ${Math.round(metrics.reduce((s, m) => s + m.persistMs, 0) / TURNS)}ms`,
    )
    console.log(`平均 tool:    ${Math.round(metrics.reduce((s, m) => s + m.toolMs, 0) / TURNS)}ms`)
    console.log(`历史总量: ${stateStore.getSession(SESSION_ID)?.history.length} 条`)

    // 清理
    fs.rmSync("sessions", { recursive: true })
  })
})
