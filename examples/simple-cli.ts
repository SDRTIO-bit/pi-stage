// ============================================================
// simple-cli.ts — 全链路集成 Demo
// 贯穿 Session → Card → Worldbook → Pipeline → Tool → Agent
//
// 运行：npx tsx examples/simple-cli.ts
// ============================================================

import { stateStore } from "../src/state-store.js"
import { cardManager } from "../src/card-manager.js"
import { contextPipeline, type Collector } from "../src/context/pipeline.js"
import { createNode } from "../src/context/prompt-node.js"
import { worldbook } from "../src/worldbook/index.js"
import { callTool } from "../src/tools.js"
import { lifecycleBus } from "../src/lifecycle/events.js"
import { agentPipeline, type AgentMiddleware } from "../src/lifecycle/agent-pipeline.js"
import { regexEngine, type RegexHook } from "../src/regex/hooks.js"

async function main() {
  console.log("=== PI RP Engine — 全链路 Demo ===\n")

  // ---- 1. Session ----
  const sessionId = "demo-session-001"
  stateStore.createSession(sessionId)
  console.log("[1] Session 创建:", sessionId)

  // ---- 2. 卡片注册 & 激活 ----
  cardManager.register({
    id: "card-npc01",
    name: "旅店老板娘",
    version: 1,
    tags: ["npc", " tavern"],
  })
  cardManager.register({ id: "card-npc02", name: "神秘旅人", version: 1, tags: ["npc", "quest"] })
  cardManager.activate("card-npc01", sessionId)
  cardManager.activate("card-npc02", sessionId)
  console.log(
    "[2] 激活卡片:",
    cardManager
      .getActiveCards()
      .map((c) => c.name)
      .join(", "),
  )

  // ---- 3. 世界书 ----
  worldbook.load([
    {
      id: "wb-001",
      name: "世界观——酒馆",
      keywords: ["酒馆", "旅店", "吧台"],
      priority: 10,
      constant: true,
      enabled: true,
      content: "这是一间位于十字路口的旅店，温暖的壁炉和橡木吧台是它的标志。",
      category: "常开设定",
    },
    {
      id: "wb-002",
      name: "角色——老板娘",
      keywords: ["老板娘", "老板"],
      priority: 5,
      constant: true,
      enabled: true,
      content: "老板娘是个四十出头的半精灵，总是边擦酒杯边听客人聊天。",
      category: "常开设定",
    },
    {
      id: "wb-003",
      name: "触发——秘密通道",
      keywords: ["地下室", "密道", "暗门"],
      priority: 1,
      constant: false,
      enabled: true,
      content: "吧台下方的地板有一道暗门，通往旧时代的走私通道。",
      category: "触发词条",
    },
  ])
  const wbIndex = worldbook.getIndex()
  console.log(
    `[3] 世界书加载完成：常开 ${wbIndex.constantCount} 条，触发词 ${wbIndex.triggerKeywordsCount} 组`,
  )

  const triggered = worldbook.searchByKeywords("他低声说地下室有秘密")
  console.log(
    `    触发搜索命中 ${triggered.length} 条:`,
    triggered.map((e) => `「${e.name}」`).join("、"),
  )

  // ---- 4. 注册 Collector（模拟各模块申报上下文） ----
  const demoCollector: Collector = {
    name: "card-base",
    collect: async () => [
      createNode({
        layer: "L0-survival",
        source: "系统提示",
        content: "你是一名角色扮演AI，请严格按照当前激活角色的设定进行互动。",
        priority: 0,
      }),
      createNode({
        layer: "L1-stable",
        source: "世界书常开",
        content: worldbook
          .getConstantEntries()
          .map((e) => e.content)
          .join("\n"),
        priority: 10,
      }),
    ],
  }
  contextPipeline.registerCollector(demoCollector)
  console.log("[4] Collector 注册:", demoCollector.name)

  // ---- 5. 正则钩子 ----
  regexEngine.load([
    {
      id: "rx-thought",
      name: "剥离思考块",
      pattern: "\\{thought\\}[\\s\\S]*?\\{\\/thought\\}",
      replacement: "",
      phase: "prompt",
      enabled: true,
    },
    {
      id: "rx-image",
      name: "图片标签",
      pattern: "\\[img:(.+?)\\]",
      replacement: "!\\[\\](\\1)",
      phase: "display",
      enabled: true,
    },
  ] as RegexHook[])
  console.log("[5] 正则钩子加载:", regexEngine.getHooks().length, "条")

  // ---- 6. Pipeline 装配 ----
  const result = await contextPipeline.assemble(sessionId)
  if (result.phase !== "ready") throw new Error(`Pipeline failed: ${result.phase}`)
  console.log(`[6] Pipeline 完成`)
  console.log(`    prompt: ${result.prompt.length} chars`)
  console.log(`    display: ${result.displayPrompt.length} chars`)
  console.log(`    nodes: ${result.status.nodeCount}`)
  console.log(`    degraded: ${result.status.degradationApplied}`)

  // ---- 7. 工具调用 ----
  const toolResult = await callTool("search_worldbook", { query: "暗门", maxResults: 3 }, sessionId)
  console.log(`[7] 工具调用 search_worldbook:`)
  console.log(`    ${toolResult.slice(0, 120)}...`)

  // ---- 8. 生命周期事件 + Agent ----
  await lifecycleBus.emit("turn_end", sessionId, { round: 1 })
  const actions = await agentPipeline.run(sessionId)
  console.log(`[8] Agent 管线完成: ${actions.length} 个动作`)
  for (const a of actions) {
    console.log(`    [${a.type}] ${a.description}`)
  }

  // ---- 9. 持久化验证 ----
  stateStore.persist(sessionId)
  const loaded = stateStore.load(sessionId)
  console.log(`[9] 持久化: ${loaded ? "OK (load 成功)" : "FAIL"}`)

  console.log("\n=== Demo 结束 ===")
}

main().catch(console.error)
