/**
 * PI RP Engine — pi.dev 扩展入口
 *
 * 注册生命周期钩子 + 工具 + 命令。
 * 引擎层不调 LLM，专注上下文装配 + 状态管理。
 */

import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

import { stateStore } from "../../../src/state-store.js"
import { cardManager } from "../../../src/card-manager.js"
import { initCardManager } from "../../../src/card-manager-new.js"
import { contextPipeline, type Collector } from "../../../src/context/pipeline.js"
import { createNode } from "../../../src/context/prompt-node.js"
import { worldbook } from "../../../src/worldbook/index.js"
import { createPiTools } from "../../../src/tools.js"
import { createPiCommandRegistry } from "../../../src/commands/index.js"
import { generateSkills, type GeneratedSkill } from "../../../src/skill-generator.js"
import { regexEngine, type RegexHook } from "../../../src/regex/hooks.js"
import { agentPipeline } from "../../../src/lifecycle/agent-pipeline.js"
import { lifecycleBus } from "../../../src/lifecycle/events.js"
import { createRPWebServer } from "../../../src/rp-web-server.js"

import { ToolRegistry, CommandRegistry } from "../../../src/registry.js"

export default function (pi: ExtensionAPI) {
  // ==================== 可变状态引用 ====================
  const sessionIdRef = { current: "" }
  const skillsDir = join(process.cwd(), ".pi", "skills", "rp-engine")
  const stateDir = join(process.cwd(), ".pi")

  // ==================== RP Web 服务器 ====================
  const rpWeb = createRPWebServer(pi, () => stateDir)
  rpWeb.registerEventForwarding()

  // ==================== 初始化默认数据（幂等） ====================
  function initDefaultData() {
    const cards = [
      { id: "hero", name: "勇者亚瑟", version: 1, tags: ["pc"] },
      { id: "npc-guide", name: "引路精灵", version: 1, tags: ["npc"] },
      { id: "npc-merchant", name: "旅行商人", version: 1, tags: ["npc"] },
    ]
    for (const c of cards) {
      if (!cardManager.getAllRegistered().some((r) => r.id === c.id)) {
        cardManager.register(c)
      }
    }

    if (worldbook.getIndex().constantCount === 0) {
      worldbook.load([
        {
          id: "wb-setting", name: "世界观——奇幻大陆",
          keywords: ["剑", "魔法", "王国"], priority: 10, constant: true, enabled: true,
          content: "这是一个剑与魔法的世界，人类与精灵共存的艾尔多兰大陆。",
          category: "常开设定",
        },
        {
          id: "wb-tavern", name: "场景——十字路口的酒馆",
          keywords: ["酒馆", "旅店"], priority: 5, constant: true, enabled: true,
          content: "温暖的壁炉噼啪作响，橡木吧台擦得锃亮，空气中飘着麦酒和烤肉的味道。",
          category: "常开设定",
        },
        {
          id: "wb-secret", name: "隐藏——地下密道",
          keywords: ["地下室", "密道", "暗门"], priority: 1, constant: false, enabled: true,
          content: "吧台下方的地板有一道暗门，通往旧时代的走私通道。",
          category: "触发词条",
        },
      ])
    }

    if (regexEngine.getHooks().length === 0) {
      regexEngine.load([
        { id: "rx-thought", name: "剥离思考块", pattern: "\\{thought\\}[\\s\\S]*?\\{\\/thought\\}", replacement: "", phase: "prompt", enabled: true },
        { id: "rx-image", name: "图片标签", pattern: "\\[img:(.+?)\\]", replacement: "![\\](\\1)", phase: "display", enabled: true },
      ] as RegexHook[])
    }
  }

  // ==================== 世界书→Skill 编译 ====================
  function compileWorldbookToSkills() {
    const constantEntries = worldbook.getConstantEntries()
    if (constantEntries.length === 0) return
    const skills = generateSkills(constantEntries)
    if (skills.length === 0) return
    mkdirSync(skillsDir, { recursive: true })
    const categoryLabel: Record<string, string> = {
      "core-rules": "核心规则", "style-protocol": "文风协议",
      "judgment-system": "判定系统", "variable-protocol": "变量协议",
    }
    for (const skill of skills) {
      const content = [
        "---", `name: rp-${skill.category}`,
        `description: ${categoryLabel[skill.category] ?? skill.category} — 由世界书自动编译`,
        "version: 1.0.0", "---", "",
        `# ${categoryLabel[skill.category] ?? skill.category}`, "",
        skill.content,
      ].join("\n")
      writeFileSync(join(skillsDir, skill.filename), content, "utf-8")
    }
  }

  // ==================== 生命周期事件注册 ====================

  pi.on("session_start", async (_ev: unknown, ctx: ExtensionContext) => {
    const sid = `pi-session-${Date.now()}`
    sessionIdRef.current = sid
    stateStore.createSession(sid)
    initDefaultData()

    // 初始化新版卡片管理器（磁盘扫描）
    try {
      initCardManager(ctx.cwd)
      console.log("[RP] CardManager (new) 已初始化, cwd:", ctx.cwd)
    } catch (err) {
      console.warn("[RP] CardManager (new) 初始化失败:", err instanceof Error ? err.message : String(err))
    }

    contextPipeline.registerCollector({
      name: "pi-engine-base",
      collect: async () => [
        createNode({ layer: "L0-survival", source: "系统提示", content: "你是角色扮演AI，严格按设定互动。", priority: 0 }),
        createNode({ layer: "L1-stable", source: "世界书常开", content: worldbook.getConstantEntries().map((e) => e.content).join("\n"), priority: 10 }),
      ],
    })

    for (const c of ["hero", "npc-guide"]) {
      try { cardManager.activate(c, sid) } catch { /* 可能已经激活 */ }
    }

    ctx.ui?.setStatus?.("rp-engine", "引擎就绪")

    // 启动 RP Web 服务器
    try {
      rpWeb.setLatestCtx(ctx)
      await rpWeb.start(ctx)
    } catch (err) {
      console.warn("[RP] Web 服务器启动失败:", err instanceof Error ? err.message : String(err))
    }

    console.log("[RP] 引擎就绪, session:", sid)
  })

  pi.on("before_agent_start", (_ev: unknown) => {
    if (!existsSync(skillsDir)) return
    try {
      const files = readdirSync(skillsDir).filter((f) => f.endsWith(".md"))
      for (const file of files) {
        const content = readFileSync(join(skillsDir, file), "utf-8")
        pi.appendEntry("skill", { name: file.replace(".md", ""), content })
      }
    } catch { /* 静默跳过 */ }
  })

  pi.on("input", async (ev: any) => {
    const sid = sessionIdRef.current
    if (!sid) return
    const originalContent = ev?.text || ev?.content || ev?.value || ""
    const session = stateStore.getSession(sid)
    if (!session || session.history.length === 0) return
    try {
      const result = await contextPipeline.assemble(sid)
      if (result.phase === "ready" && result.prompt) {
        ev.content = `${result.prompt}\n\n---\n${originalContent}`
      }
    } catch { /* 装配失败不影响输入 */ }
  })

  pi.on("turn_end", async (_ev: unknown) => {
    const sid = sessionIdRef.current
    if (!sid) return
    try {
      await lifecycleBus.emit("turn_end", sid, {})
      await agentPipeline.run(sid)
      stateStore.persist(sid)
      compileWorldbookToSkills()
    } catch (err) {
      console.warn("[RP] turn_end 处理异常:", err instanceof Error ? err.message : String(err))
    }
  })

  pi.on("session_shutdown", async () => {
    if (sessionIdRef.current) {
      stateStore.persist(sessionIdRef.current)
      sessionIdRef.current = ""
    }
    try { await rpWeb.shutdown() } catch { /* ignore */ }
  })

  // ==================== 工具注册 ====================
  const tools = createPiTools(sessionIdRef)
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name, label: tool.label, description: tool.description,
      parameters: tool.parameters, execute: tool.execute,
    })
  }

  // ==================== 命令注册 ====================
  const cmdRegistry = createPiCommandRegistry(sessionIdRef)
  cmdRegistry.registerAll(pi)

  // ==================== 启动编译 ====================
  initDefaultData()
  compileWorldbookToSkills()
}
