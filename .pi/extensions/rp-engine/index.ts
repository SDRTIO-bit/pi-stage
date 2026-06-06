/**
 * PI RP Engine — pi.dev 扩展入口
 *
 * 从 createApp() DI 容器获取所有服务（不再使用模块级 @deprecated 单例）。
 * 一对一模型：一个 session = 一张卡片。
 *
 * 懒初始化策略：不依赖 session_start 事件（PI 可能不触发），
 * 在 before_agent_start 首次调用时初始化一切。
 */
import { join } from "node:path"
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import type { ExtensionAPI, ExtensionContext, BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent"
import { createApp, type App } from "../../../src/composition-root.js"
import { createPiTools } from "../../../src/tools.js"
import { createPiCommandRegistry } from "../../../src/commands/index.js"
import { createRPWebServer } from "../../../src/rp-web-server.js"
import {
  hasCardSkills,
  generateCardSkills,
} from "../../../src/cards/skill-writer.js"
import { logSnapshot } from "../../../src/observability/prompt-snapshot.js"
import { loadRPConfig } from "../../../src/config.js"
import { extractStructureTags, extractConstraints, buildSteeringContent } from "../../../src/helpers/checkpoint-extractor.js"
import { getRefreshSignal } from "../../../src/helpers/refresh-signals.js"
import { compressHistory } from "../../../src/helpers/compression.js"
import { createNode } from "../../../src/context/prompt-node.js"
import type { Collector } from "../../../src/context/pipeline.js"

// ---- 模块级单次初始化 ----
let _app: App | null = null
let _initDone = false

// ---- PHI Steering 检查点缓存 ----
let _structureTags: string[] = []
let _constraints: string[] = []
let _roundCounter = 0
let _lastFormatIssues: string[] = []
let _steeringCollectorRegistered = false

function getApp(): App {
  if (!_app) {
    const rpConfig = loadRPConfig(process.cwd())
    const budget = {
      target: rpConfig.token_budget?.pipeline_target ?? 24576,
      hard: rpConfig.token_budget?.pipeline_hard ?? 40960,
    }
    // TF-IDF 可通过 features.tfidf_retriever = false 关闭
    const retriever = {
      ...rpConfig.retriever,
    }
    if (rpConfig.features?.tfidf_retriever === false) {
      retriever.method = "keyword"
    }

    _app = createApp({
      sessionsRoot: join(process.cwd(), ".pi", "sessions"),
      budget,
      retriever,
      features: {
        formatRulesCollector: rpConfig.features?.format_rules_collector,
        stateCollector: rpConfig.features?.state_collector,
        worldbookTriggerCollector: false, // 世界书改由 Steering 注入，保持 system prompt 静态缓存
      },
    })
  }
  return _app
}

// ---- 扩展入口 ----
export default function (pi: ExtensionAPI) {
  const app = getApp()
  const sessionIdRef = { current: "" }
  const cardIdRef = { current: "" }
  // 从 registry.json 恢复上次选中的卡（持久化偏好）
  let _preferredCardId = app.cardManager.getActiveCardIds()[0] || ""

  /** 获取当前应激活的 cardId：用户指定 → 文件 registry active → 导入卡 → 种子卡 → hero */
  function resolveCardId(): string {
    if (_preferredCardId) return _preferredCardId
    const activeIds = app.cardManager.getActiveCardIds()
    if (activeIds.length > 0) return activeIds[0]
    const all = app.cardManager.getAllRegistered()
    // 优先使用导入的角色卡（排除种子卡）
    const imported = all.filter(
      (c) => !["hero", "npc-guide", "npc-merchant"].includes(c.id),
    )
    if (imported.length > 0) return imported[0].id
    if (all.length > 0) return all[0].id
    return "hero"
  }

  // RP Web 服务器（单次创建，避免重复注册事件）
  const rpWeb = createRPWebServer(
    pi,
    () => join(process.cwd(), ".pi"),
    app.cardManager,
    app.stateStore,
    () => sessionIdRef.current,
    () => { sessionIdRef.current = "" },
    process.cwd(),
    (cardId: string) => { _preferredCardId = cardId },
  )
  rpWeb.registerEventForwarding()

  /** 懒初始化：创建 session、加载世界书、生成 skills */
  function ensureSession(userPrompt?: string): string {
    if (sessionIdRef.current) return sessionIdRef.current

    // 尝试恢复上次会话
    const stateDir = join(process.cwd(), ".pi")
    const sessionStateFile = join(stateDir, "current-session.json")
    let restoredSid = ""
    if (existsSync(sessionStateFile)) {
      try {
        const saved = JSON.parse(readFileSync(sessionStateFile, "utf-8"))
        if (saved.sessionId && saved.cardId) {
          // 验证 session 数据文件存在
          const existingIds = app.stateStore.listSessions()
          if (existingIds.includes(saved.sessionId)) {
            const loaded = app.stateStore.load(saved.sessionId)
            if (loaded && loaded.history.length > 0) {
              restoredSid = saved.sessionId
              console.log(`[RP] 恢复会话: ${restoredSid}, ${loaded.history.length} 条历史`)
            }
          }
        }
      } catch { /* 文件损坏，忽略 */ }
    }

    const sid = restoredSid || `pi-session-${Date.now()}`
    sessionIdRef.current = sid

    // 持久化当前 session ID
    if (!restoredSid) {
      try {
        mkdirSync(stateDir, { recursive: true })
      } catch { /* exists */ }
    }

    // 一对一：选卡并独占激活
    const cardId = resolveCardId()
    cardIdRef.current = cardId
    app.cardManager.setActiveCard(cardId)

    // 注册卡专属世界书 + 首次激活 → 生成卡专属 Skills
    const reg = app.cardManager.getRegistry()
    const cardDir = reg.cards[cardId]?.dir
    if (cardDir) {
      const wbDir = app.cardManager.getCardWorldbookDir(cardId)
      if (wbDir) {
        app.worldbook.loadFromFiles([wbDir])
        const totalEntries = app.worldbook.getAllEntries().length
        console.log(`[RP] 世界书已加载: ${totalEntries} 条`)
        if (!hasCardSkills(cardDir)) {
          generateCardSkills(cardDir, wbDir)
        }

        // 缓存格式检查点（仅解析一次，后续每轮复用）
        const presetsDir = join(process.cwd(), ".pi", "presets")
        _structureTags = extractStructureTags(cardDir, presetsDir)
        _constraints = extractConstraints(cardDir, presetsDir)
        console.log(`[RP] 检查点已缓存: ${_structureTags.length} 个结构标签, ${_constraints.length} 条约束`)
      }
    }

    // 创建 session 并关联 cardId + 激活卡片状态
    const session = restoredSid
      ? app.stateStore.getSession(sid)!  // 从磁盘恢复，不覆盖已加载的历史
      : app.stateStore.createSession(sid)  // 新建 session
    if (!session) throw new Error(`Session ${sid} not found after load`)

    session.cardId = cardId
    if (!session.activatedCards.has(cardId)) {
      session.activatedCards.set(cardId, {
        cardId,
        variables: {},
        lastUpdated: Date.now(),
      })
    }
    if (userPrompt) {
      app.stateStore.appendHistory(sid, `user: ${userPrompt}`)
    }
    app.stateStore.persist(sid)

    // 持久化当前 session ID，支持重启后恢复
    if (!restoredSid) {
      try {
        writeFileSync(sessionStateFile, JSON.stringify({ sessionId: sid, cardId }, null, 2), "utf-8")
      } catch { /* ignore */ }
    }

    if (cardDir) {
      app.cardSessionStore.createSession(cardDir, sid)
      const cs = app.cardSessionStore.getSession(cardDir, sid)
      if (cs) {
        cs.cardId = cardId
        app.cardSessionStore.persist(cardDir, cs)
      }
    }

    // 注册 Steering 检查点 collector（priority 87，紧贴生成位置）
    // 替代 input handler 中的 pi.sendUserMessage()，避免递归死锁
    if (!_steeringCollectorRegistered) {
      _steeringCollectorRegistered = true
      const steeringCollector: Collector = {
        name: "steering-checkpoint",
        collect: async (collectSessionId: string) => {
          if (collectSessionId !== sessionIdRef.current) return []

          try {
            // 1. 注意力刷新信号（等长轮换，不破坏 system prompt 缓存）
            const refreshSignal = getRefreshSignal(_roundCounter)

            // 2. 上轮格式问题（由 message_end 存入，仅在有问题时非空）
            let formatWarning = ""
            if (_lastFormatIssues.length > 0) {
              formatWarning = `[格式纠偏] 上一条回复存在以下问题，本轮必须修正:\n${_lastFormatIssues.map((i) => "  - " + i).join("\n")}`
              _lastFormatIssues = []
            }

            // 3. 可用工具提醒（静态内容，不破坏缓存）
            const toolHints = `[可用工具 — 按需主动调用]
  • rp_engine__search_worldbook — 关键词/语义搜索世界书条目（场景、NPC、设定等）
  • rp_engine__read_state — 读取当前角色变量（属性、状态、关系等）
  • rp_engine__update_state — 更新角色变量（剧情推进后及时更新）
  • rp_engine__roll_dice — 投骰判定（战斗、技能、非凡等需要概率的场合）`

            // 4. 构建 Steering 内容（世界书由工具按需检索，不注入 system prompt）
            const steeringContent = buildSteeringContent(
              _structureTags,
              _constraints,
              "",
              refreshSignal,
              toolHints,
            )

            // 无格式问题时 fullContent 字节完全一致 → system prompt 缓存命中
            const fullContent = [steeringContent, formatWarning].filter(Boolean).join("\n\n")
            if (!fullContent.trim()) return []

            console.log(`[RP] 第${_roundCounter}轮 Steering 注入 (${fullContent.length} 字符, 缓存${formatWarning ? "miss" : "hit"})`)
            return [
              createNode({
                layer: "L2-enhanced",
                source: "Steering 检查点",
                content: fullContent,
                priority: 87,
                attentionWeight: 0.95,
              }),
            ]
          } catch (err) {
            console.warn("[RP] Steering collector 失败:", err instanceof Error ? err.message : String(err))
            return []
          }
        },
      }
      app.contextPipeline.registerCollector(steeringCollector)
    }

    _initDone = true
    console.log(`[RP] 引擎就绪, session: ${sid}, card: ${cardId} (lazy init)`)
    return sid
  }

  // ==================== session_start ====================
  // PI 可能触发也可能不触发 — 保留但仅做补充状态设置
  pi.on("session_start", async (_ev: unknown, ctx: ExtensionContext) => {
    ensureSession()
    const cardName = app.cardManager.getCardName(cardIdRef.current)
    ctx.ui?.setStatus?.("rp-engine", `卡: ${cardName}`)
    try {
      rpWeb.setLatestCtx(ctx)
      await rpWeb.start(ctx)
    } catch (err) {
      console.warn("[RP] Web 服务器启动失败:", err instanceof Error ? err.message : String(err))
    }
  })

  // ==================== session_before_compact ====================
  // 在 PI 压缩对话前: 先压缩对话历史，再保护状态变量
  pi.on("session_before_compact", (_ev) => {
    const sid = sessionIdRef.current
    if (!sid) return

    const session = app.stateStore.getSession(sid)
    if (!session?.cardId) return

    // 压缩对话历史: 保留最近 5 轮完整，早期轮次压缩为摘要
    const originalLen = session.history.length
    session.history = compressHistory(session.history)
    if (session.history.length !== originalLen) {
      console.log(`[RP] 历史已压缩: ${originalLen} -> ${session.history.length} 条`)
    }

    const cardState = session.activatedCards.get(session.cardId)
    if (cardState && Object.keys(cardState.variables).length > 0) {
      app.stateStore.persist(sid) // 确保变量写入磁盘
      console.log(`[RP] 状态已保护: ${Object.keys(cardState.variables).length} 个变量`)
    }
    // 返回 undefined，让 PI 正常执行压缩
  })

  // ==================== message_end ====================
  // 每轮 AI 回复后检查格式纪律
  pi.on("message_end", async (ev) => {
    const sid = sessionIdRef.current
    if (!sid) return

    const msg = ev as any
    const rawContent: unknown = msg?.message?.content || msg?.text || ""

    // 处理两种 content 格式: string 或 ContentBlock[] [{type:"text", text:"..."}]
    let content = ""
    if (typeof rawContent === "string") {
      content = rawContent
    } else if (Array.isArray(rawContent)) {
      content = rawContent
        .filter((block: any) => block?.type === "text")
        .map((block: any) => block.text ?? "")
        .join("\n")
    }

    if (!content.trim()) return

    const issues: string[] = []

    // 检查 1：是否有未闭合的判定块
    if ((content.match(/<判定/g) || []).length !== (content.match(/<\/判定>/g) || []).length) {
      issues.push("判定块未闭合，请确保 <判定> 与 </判定> 配对")
    }

    // 检查 2：是否有未闭合的星号动作标注
    if ((content.match(/\*/g) || []).length % 2 !== 0) {
      issues.push("星号动作标注未配对，检查是否遗漏了闭合 *")
    }

    // 检查 3：回复是否为空或过短
    if (content.trim().length < 10) {
      issues.push("回复过短，可能未正确生成内容")
    }

    // 记录 AI 回复到历史
    app.stateStore.appendHistory(sid, `assistant: ${content}`)

    // 格式问题存入模块变量，由下轮 steering-checkpoint collector 注入
    if (issues.length > 0) {
      _lastFormatIssues = issues
      console.log(`[RP] 格式检查: ${issues.length} 个问题，将在下轮 Steering 中注入`)
    }
  })

  // ==================== before_agent_start ====================
  // 懒初始化 + pipeline 装配 → 直接替换 system prompt
  pi.on("before_agent_start", async (ev: BeforeAgentStartEvent) => {
    const sid = ensureSession(ev.prompt)
    const cardId = cardIdRef.current
    const cardName = app.cardManager.getCardName(cardId)

    // 强制角色扮演系统提示词（即使 pipeline 装配失败也不会退回默认 coding agent）
    const rpGuard =
      "[角色扮演模式 — 最高优先级]\n" +
      "你是一个角色扮演引擎驱动的 AI，当前扮演角色卡《" + cardName + "》。\n" +
      "你的唯一任务是沉浸式进行角色扮演互动。\n" +
      "禁止读取项目文件。禁止浏览目录。禁止查看 src/ 或 .pi/ 内容。\n" +
      "禁止使用 read 工具读取 .ts / .json / .md 项目文件。\n" +
      "禁止使用 ls / dir / cat / type / find 等文件系统命令探索项目结构。\n" +
      "你已经拥有全部所需的世界观设定、角色信息和格式规则，无需额外获取。\n" +
      "直接开始角色扮演，从用户的第一条消息开始回应。\n"

    try {
      const result = await app.contextPipeline.assemble(sid)
      logSnapshot(join(process.cwd(), ".pi"), sid, result)
      if (result.phase === "ready" && result.prompt) {
        const separator = "\n\n---\n## PI 系统指令\n"
        console.log(`[RP] before_agent_start: pipeline ready, ${result.prompt.length} chars prompt`)
        return {
          systemPrompt: ev.systemPrompt + separator + rpGuard + "\n" + result.prompt,
        }
      }
      // 装配未就绪 — 用 fallback
      console.warn(`[RP] pipeline 未就绪 (phase=${result.phase})，使用 fallback prompt`)
    } catch (err) {
      console.error("[RP] pipeline 装配失败:", err instanceof Error ? err.message : String(err))
    }

    // fallback: 即使 pipeline 失败，也确保角色扮演模式
    const fallbackPrompt =
      rpGuard +
      "\n" +
      "[角色卡] " + cardName + " (" + cardId + ")\n" +
      "请根据角色卡设定，以第一人称/小说体进行沉浸式角色扮演。\n" +
      "使用 <判定></判定> 块包含系统判定，使用 *动作描述* 表达动作。\n"
    const separator = "\n\n---\n## PI 系统指令\n"
    console.log(`[RP] before_agent_start: fallback prompt (${fallbackPrompt.length} chars)`)
    return {
      systemPrompt: ev.systemPrompt + separator + fallbackPrompt,
    }
  })

  // ==================== input ====================
  pi.on("input", (ev: any) => {
    ensureSession()
    const sid = sessionIdRef.current
    const originalContent = ev?.text || ev?.content || ev?.value || ""
    if (!originalContent || originalContent.startsWith("/")) return

    // 记录用户消息
    app.stateStore.appendHistory(sid, `user: ${originalContent}`)
    _roundCounter++
  })

  // ==================== turn_end ====================
  pi.on("turn_end", async (_ev: unknown) => {
    const sid = sessionIdRef.current
    const cardId = cardIdRef.current
    if (!sid) return

    try {
      await app.lifecycleBus.emit("turn_end", sid, {})
      await app.agentPipeline.run(sid)
      app.stateStore.persist(sid)

      const reg = app.cardManager.getRegistry()
      const cardDir = reg.cards[cardId]?.dir
      if (cardDir) {
        const s = app.stateStore.getSession(sid)
        if (s) app.cardSessionStore.persist(cardDir, s)
      }
    } catch (err) {
      console.warn("[RP] turn_end 处理异常:", err instanceof Error ? err.message : String(err))
    }
  })

  // ==================== session_shutdown ====================
  pi.on("session_shutdown", async () => {
    if (sessionIdRef.current) {
      app.stateStore.persist(sessionIdRef.current)
      const cardId = cardIdRef.current
      const reg = app.cardManager.getRegistry()
      const cardDir = reg.cards[cardId]?.dir
      if (cardDir) {
        const s = app.stateStore.getSession(sessionIdRef.current)
        if (s) app.cardSessionStore.persist(cardDir, s)
      }
      sessionIdRef.current = ""
      cardIdRef.current = ""
      _initDone = false
      _roundCounter = 0
      _lastFormatIssues = []
      // 清除持久化的 session ID，重启后创建新会话
      try { const sf = join(process.cwd(), ".pi", "current-session.json"); if (existsSync(sf)) writeFileSync(sf, "{}", "utf-8") } catch { /* ignore */ }
    }
  })

  // ==================== 工具注册 ====================
  const tools = createPiTools(sessionIdRef, app.stateStore, app.lifecycleBus, app.worldbook)
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute,
    })
  }

  // ==================== RP 专属命令 ====================
  let _rpModeActive = true // 默认进入即 RP 模式

  pi.registerCommand("rp-mode", {
    description: "查看 RP 模式状态与推荐启动参数",
    handler: (_args, ctx) => {
      const agentFile = join(process.cwd(), ".pi", "agents", "rp.md")
      const agentExists = existsSync(agentFile)

      const memoryDir = join(process.cwd(), ".pi", "memory")
      const memoryReady = existsSync(memoryDir)

      const lines = [
        `RP 模式: ${_rpModeActive ? "🟢 已激活" : "⚪ 未激活"}`,
        `Agent 定义: ${agentExists ? "✅ .pi/agents/rp.md" : "⚠️ 未找到"}`,
        `三层记忆: ${memoryReady ? "✅ .pi/memory/" : "⚠️ 首次启动后自动创建"}`,
        "",
        "推荐启动命令:",
        "  pi --extension .pi/extensions/rp-engine/index.ts \\",
        "     --tools \"read,bash\" \\",
        "     --thinking high",
        "",
        "PI 会自动加载 pi-total-recall（.pi/settings.json 已配置）:",
        "  @samfp/pi-memory         — memory_search / memory_remember / memory_forget",
        "  pi-session-search        — episodic_memory_search（跨会话历史搜索）",
        "  pi-knowledge-search      — knowledge_search（世界书语义搜索）",
        "",
        "RP 引擎工具:",
        "  rp_engine__search_worldbook  — 关键词搜索世界书",
        "  rp_engine__read_state       — 读取角色变量",
        "  rp_engine__update_state     — 更新角色变量",
        "  rp_engine__roll_dice        — 投骰判定",
      ]

      ctx.ui?.notify?.(lines.join("\n"), "info")
    },
  })

  pi.registerCommand("rp-cards", {
    description: "列出所有可用角色卡",
    handler: (_args, ctx) => {
      const all = app.cardManager.getAllRegistered()
      const lines = all.map((c) => {
        const isImported = !["hero", "npc-guide", "npc-merchant"].includes(c.id)
        const preferred = _preferredCardId === c.id ? " ★ 当前选中" : ""
        return `  ${isImported ? "🃏" : "🌱"} ${c.id}: ${c.name}${preferred}`
      })
      ctx.ui?.notify?.(`可用角色卡 (${all.length} 张):\n${lines.join("\n")}`, "info")
    },
  })

  pi.registerCommand("rp-presets", {
    description: "列出全局预设文件，说明如何自定义",
    handler: (_args, ctx) => {
      const presetsDir = join(process.cwd(), ".pi", "presets")
      const hasDir = existsSync(presetsDir)

      const lines = [
        "全局预设 — 引擎级 RP 质量控制，对所有角色卡生效",
        "",
        `位置: .pi/presets/  ${hasDir ? "✅" : "⚠️ 目录不存在，引擎会自动创建"}`,
        "",
        "--- 当前预设文件 ---",
      ]

      if (hasDir) {
        const files = readdirSync(presetsDir).filter((f) => f.endsWith(".md")).sort()
        if (files.length > 0) {
          for (const f of files) {
            const content = readFileSync(join(presetsDir, f), "utf-8")
            lines.push(`  📄 ${f}  (${content.length} 字符)`)
          }
        } else {
          lines.push("  (无预设文件)")
        }
      } else {
        lines.push("  (目录不存在)")
      }

      lines.push("")
      lines.push("--- 如何自定义预设 ---")
      lines.push("")
      lines.push("1. 新增预设:")
      lines.push('   在 .pi/presets/ 下新建 .md 文件，引擎自动加载（按文件名排序）')
      lines.push("")
      lines.push("2. 预设内容格式:")
      lines.push("   纯 Markdown 文本，支持任意格式。引擎将其作为 PromptNode 注入到")
      lines.push("   卡专属 Skill 之前（L1-stable, priority 3）")
      lines.push("")
      lines.push("3. 预设类型建议:")
      lines.push("   cot-system.md     — COT 思维链（回复前强制自查，推荐保留）")
      lines.push("   anti-pattern.md   — 禁八股/防媚/叙事节奏黑名单")
      lines.push("   custom-rules.md   — 你的自定义规则（自由命名）")
      lines.push("")
      lines.push("4. 禁用预设:")
      lines.push("   将文件重命名为 .md.bak 或其他非 .md 后缀即可")
      lines.push("")
      lines.push("5. 适用规则:")
      lines.push("   全局预设对所有角色卡生效，不写入卡专属格式规则")
      lines.push("   （如插图标签名、选项格式等应放在卡的 Skill 中，不放在预设里）")

      ctx.ui?.notify?.(lines.join("\n"), "info")
    },
  })

  pi.registerCommand("rp-use", {
    description: "选择角色卡: /rp-use <cardId>（需重启 PI 或新对话生效）",
    handler: (args, ctx) => {
      const cardId = args.trim()
      if (!cardId) {
        ctx.ui?.notify?.("用法: /rp-use <cardId> — 先用 /rp-cards 查看可用卡片", "warning")
        return
      }
      const reg = app.cardManager.getRegistry()
      const exists = reg.cards[cardId] || app.cardManager.getAllRegistered().some((c) => c.id === cardId)
      if (!exists) {
        ctx.ui?.notify?.(`卡片不存在: ${cardId}`, "error")
        return
      }
      _preferredCardId = cardId
      // 立即持久化到 registry.json，防止 PI 重启后丢失偏好
      app.cardManager.setActiveCard(cardId)
      // 重置 session，下次 before_agent_start 会用新卡重新初始化
      sessionIdRef.current = ""
      cardIdRef.current = ""
      _initDone = false
      _roundCounter = 0
      _lastFormatIssues = []
      ctx.ui?.notify?.(`已选择: ${cardId}。开始新对话即可生效。`, "success")
    },
  })

  // ==================== /reset 命令（同时重置 rp-engine 和 PI 上下文） ====================
  pi.registerCommand("reset", {
    description: "重置当前会话和 PI 上下文",
    handler: (_args, ctx) => {
      const sid = sessionIdRef.current
      if (sid) {
        const session = app.stateStore.getSession(sid)
        if (session) {
          session.history = []
          session.runtimeStatus.phase = "idle"
        }
        app.stateStore.persist(sid)
      }
      sessionIdRef.current = ""
      cardIdRef.current = ""
      _initDone = false
      _roundCounter = 0
      _lastFormatIssues = []
      // 清除持久化的 session ID，重启后创建新会话
      try { const sf = join(process.cwd(), ".pi", "current-session.json"); if (existsSync(sf)) writeFileSync(sf, "{}", "utf-8") } catch { /* ignore */ }
      ctx?.ui?.notify?.("会话已重置，下次对话将重新初始化", "success")
    },
  })

  // ==================== 命令注册（通用命令） ====================
  const cmdRegistry = createPiCommandRegistry(sessionIdRef, {
    stateStore: app.stateStore,
    cardManager: app.cardManager,
    contextPipeline: app.contextPipeline,
  })
  cmdRegistry.registerAll(pi)
}
