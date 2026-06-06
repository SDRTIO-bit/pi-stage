// ============================================================
// Composition Root — 唯一对象组装入口
//
// 所有依赖在此显式创建并连接，替代跨文件的隐式 import 单例。
// 旧代码继续通过 deprecated 单例运行，新代码统一走 createApp()。
// ============================================================

import { StateStore } from "./state-store.js"
import { CardManager } from "./card-manager.js"
import { ContextPipeline, type Collector } from "./context/pipeline.js"
import { createNode } from "./context/prompt-node.js"
import { Worldbook } from "./worldbook/index.js"
import type { WorldbookEntry } from "./types.js"
import { LifecycleBus } from "./lifecycle/events.js"
import { AgentPipeline } from "./lifecycle/agent-pipeline.js"
import { RegexEngine, type RegexHook } from "./regex/hooks.js"
import { SkillWriter } from "./skill-writer.js"
import { CardSessionStore } from "./cards/session-store.js"
import { registerSkillHooks, createSkillCollector } from "./lifecycle/skill-hooks.js"
import { createFormatRulesCollector } from "./collectors/format-rules.js"
import { createStateCollector } from "./collectors/state-variables.js"
import { createGlobalPresetCollector } from "./collectors/global-preset.js"
import { PiJsonlStorage } from "./infrastructure/pi-jsonl-storage.js"

// ---- App 类型 ----

export interface App {
  stateStore: StateStore
  cardManager: CardManager
  contextPipeline: ContextPipeline
  worldbook: Worldbook
  lifecycleBus: LifecycleBus
  agentPipeline: AgentPipeline
  regexEngine: RegexEngine
  skillWriter: SkillWriter
  cardSessionStore: CardSessionStore
}

export interface AppConfig {
  /** sessions 存储根目录，默认 "sessions" */
  sessionsRoot?: string
  /** 项目根目录，默认 process.cwd() */
  cwd?: string
  /** 上下文预算 */
  budget?: { target: number; hard: number }
  /** 世界书检索配置 */
  retriever?: {
    method?: "keyword" | "tfidf"
    topK?: number
    maxTokens?: number
    contextWindow?: number
  }
  /** 功能开关（默认全部开启） */
  features?: {
    formatRulesCollector?: boolean
    stateCollector?: boolean
    /** @default true — 设为 false 则不在 pipeline 中注入世界书触发词（改用 Steering） */
    worldbookTriggerCollector?: boolean
  }
  /** 种子数据（可覆盖默认的卡片/世界书/正则钩子） */
  seed?: {
    cards?: Array<{ id: string; name: string; version: number; tags?: string[] }>
    worldbook?: WorldbookEntry[]
    regexHooks?: RegexHook[]
  }
}

// ---- 默认种子数据 ----

const DEFAULT_CARDS = [
  { id: "hero", name: "勇者亚瑟", version: 1, tags: ["pc"] },
  { id: "npc-guide", name: "引路精灵", version: 1, tags: ["npc"] },
  { id: "npc-merchant", name: "旅行商人", version: 1, tags: ["npc"] },
]

const DEFAULT_WORLDBOOK: WorldbookEntry[] = [
  {
    id: "wb-setting",
    name: "世界观——奇幻大陆",
    keywords: ["剑", "魔法", "王国"],
    priority: 10,
    constant: true,
    enabled: true,
    content: "剑与魔法的世界，人类与精灵共存的艾尔多兰大陆。",
    category: "常开设定",
  },
  {
    id: "wb-tavern",
    name: "场景——十字路口的酒馆",
    keywords: ["酒馆", "旅店"],
    priority: 5,
    constant: true,
    enabled: true,
    content: "温暖的壁炉，橡木吧台，空气中飘着麦酒和烤肉的味道。",
    category: "常开设定",
  },
  {
    id: "wb-secret",
    name: "隐藏——地下密道",
    keywords: ["地下室", "密道", "暗门"],
    priority: 1,
    constant: false,
    enabled: true,
    content: "吧台下方的地板有一道暗门，通往旧时代的走私通道。",
    category: "触发词条",
  },
]

const DEFAULT_REGEX_HOOKS: RegexHook[] = [
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
]

// ---- 默认 Seed Loader ----

function loadSeed(config: AppConfig): NonNullable<AppConfig["seed"]> {
  return (
    config.seed ?? {
      cards: DEFAULT_CARDS,
      worldbook: DEFAULT_WORLDBOOK,
      regexHooks: DEFAULT_REGEX_HOOKS,
    }
  )
}

// ---- 内部：为 session 配置默认数据 ----

function ensureDefaults(app: App, seed: NonNullable<AppConfig["seed"]>): void {
  // 卡片注册（幂等）
  for (const c of seed.cards ?? []) {
    try {
      app.cardManager.register(c)
    } catch {
      /* 幂等忽略 */
    }
  }

  // 世界书（幂等）
  if (app.worldbook.getIndex().constantCount === 0 && seed.worldbook) {
    app.worldbook.load(seed.worldbook)
  }

  // 正则引擎（幂等）
  if (app.regexEngine.getHooks().length === 0 && seed.regexHooks) {
    app.regexEngine.load(seed.regexHooks)
  }
}

// ---- 核心工厂函数 ----

export function createApp(config: AppConfig = {}): App {
  const cwd = config.cwd ?? process.cwd()
  const budget = config.budget ?? { target: 102400, hard: 163840 }
  const retriever = config.retriever ?? {}
  const seed = loadSeed(config)
  const features = config.features ?? {}

  // 1. 基础设施层 — 使用项目级 JSONL 存储
  const storage = new PiJsonlStorage(cwd)
  const stateStore = new StateStore(storage)

  // 2. 领域层
  const cardManager = new CardManager(cwd, stateStore)
  const worldbook = new Worldbook()
  const regexEngine = new RegexEngine()
  const lifecycleBus = new LifecycleBus()
  const agentPipeline = new AgentPipeline(stateStore)

  // 内置中间件：状态变更摘要
  agentPipeline.use(async (ctx, next) => {
    const dirtyCards = stateStore.getDirtyCards()
    if (dirtyCards.length > 0) {
      ctx.actions.push({
        type: "state_update",
        description: `${dirtyCards.length} dirty card(s) detected`,
        payload: dirtyCards,
      })
      stateStore.clearDirtyCards()
    }
    await next()
  })

  // 3. 应用层
  const contextPipeline = new ContextPipeline(stateStore, regexEngine)
  contextPipeline.setBudget(budget)
  const skillWriter = new SkillWriter(cwd)
  const cardSessionStore = new CardSessionStore()

  const app: App = {
    stateStore,
    cardManager,
    contextPipeline,
    worldbook,
    lifecycleBus,
    agentPipeline,
    regexEngine,
    skillWriter,
    cardSessionStore,
  }

  // 4. 加载种子数据
  ensureDefaults(app, seed)

  // 5. 注册 Collector（幂等）
  // card-base: 仅 L0 系统提示。常开设定由 rp-skills collector 以结构化 skill 格式注入
  const demoCollector: Collector = {
    name: "card-base",
    collect: async () => [
      createNode({
        layer: "L0-survival",
        source: "系统提示",
        content: "你是角色扮演AI，严格按照设定互动。",
        priority: 0,
      }),
    ],
  }
  contextPipeline.registerCollector(demoCollector)

  // 注册世界书触发词 collector（关键词 或 TF-IDF 相似度检索）
  // 可通过 features.worldbookTriggerCollector = false 禁用以改用 Steering 注入
  const useTFIDF = retriever.method !== "keyword"
  const topK = retriever.topK ?? 3
  const maxTokens = retriever.maxTokens ?? 4000
  const contextWindow = retriever.contextWindow ?? 3

  if (features.worldbookTriggerCollector !== false) {
    const triggerCollector: Collector = {
      name: "worldbook-trigger",
      collect: async (sessionId: string) => {
        const session = stateStore.getSession(sessionId)
        if (!session || session.history.length === 0) return []

        // 拼接最近 N 轮用户消息作为检索上下文
        const queryParts: string[] = []
        for (let i = session.history.length - 1; i >= 0 && queryParts.length < contextWindow; i--) {
          const entry = session.history[i]
          if (entry.startsWith("user: ")) queryParts.unshift(entry.slice(6))
        }
        if (queryParts.length === 0) return []
        const query = queryParts.join(" ")

        const results = useTFIDF
          ? worldbook.searchBySimilarity(query, { topK, maxTokens })
          : worldbook.searchByKeywords(query).slice(0, topK)

        if (results.length === 0) return []
        return results.map((entry) =>
          createNode({
            layer: "L2-enhanced",
            source: `世界书触发: ${entry.name}`,
            content: entry.content,
            priority: 85, // 靠近末尾，仅高于状态变量(90)，最大化静态前缀缓存命中
            attentionWeight: 0.7,
          }),
        )
      },
    }
    contextPipeline.registerCollector(triggerCollector)
  }

  // 注册全局预设 collector（引擎级，所有卡共享，优先级高于卡专属 Skill）
  contextPipeline.registerCollector(createGlobalPresetCollector(cwd))

  // 注册卡专属 SkillCollector（根据 session 关联的 cardId 查找卡目录）
  contextPipeline.registerCollector(
    createSkillCollector((sessionId: string) => {
      const session = stateStore.getSession(sessionId)
      if (!session?.cardId) return null
      const card = cardManager.getRegistry().cards[session.cardId]
      return card?.dir ?? null
    }),
  )

  // 注册格式规则 collector（从卡目录 FORMAT_RULES.md 或 skills 提取）
  if (features.formatRulesCollector !== false) {
    contextPipeline.registerCollector(createFormatRulesCollector(cardManager, stateStore))
  }

  // 注册状态变量 collector（当前角色变量，末尾注入）
  if (features.stateCollector !== false) {
    contextPipeline.registerCollector(createStateCollector(stateStore))
  }

  // 6. 注册生命周期钩子
  registerSkillHooks(lifecycleBus)

  return app
}

/** @deprecated 一对一模型下不再需要批量激活，使用 POST /session { cardId } 替代 */
export function activateDefaultCards(app: App, sessionId: string): void {
  const seed = loadSeed({})
  for (const c of seed.cards ?? []) {
    try {
      app.cardManager.activate(c.id, sessionId)
    } catch {
      /* skip */
    }
  }
}
