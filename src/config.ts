/**
 * RP Engine - 配置加载模块
 *
 * 负责加载 .rpconfig.json 并合并默认配置。
 * 从 pi-stage-test 直接复制，无修改。
 */

import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export interface RPConfig {
  token_budget?: {
    worldbook_max?: number
    history_max_tokens?: number
    /** ContextPipeline target（舒适区 bytes），默认 24576 */
    pipeline_target?: number
    /** ContextPipeline hard（硬上限 bytes），默认 40960 */
    pipeline_hard?: number
    /** LLM 输出预留 tokens，默认 4000 */
    output_reserve?: number
  }
  /** 世界书检索配置 */
  retriever?: {
    /** 检索方法: "keyword" | "tfidf"，默认 "tfidf" */
    method?: "keyword" | "tfidf"
    /** 最多返回条数，默认 3 */
    top_k?: number
    /** 返回条目总 token 上限，默认 4000 */
    max_tokens?: number
    /** 检索上下文窗口（最近 N 轮对话），默认 3 */
    context_window?: number
  }
  author_note?: string
  model_max_tokens?: number
  rp_web_port?: number
  rp_web_host?: string
  features?: {
    memoryStore?: boolean
    sceneScheduler?: boolean
    /** 启用 TF-IDF 检索（false 则回退关键词匹配） */
    tfidf_retriever?: boolean
    /** 启用格式规则独立 collector */
    format_rules_collector?: boolean
    /** 启用状态变量 collector */
    state_collector?: boolean
  }
}

export const DEFAULT_CONFIG: RPConfig = {
  token_budget: {
    worldbook_max: 1500,
    history_max_tokens: 8000,
    pipeline_target: 24576,
    pipeline_hard: 40960,
    output_reserve: 4000,
  },
  retriever: {
    method: "tfidf",
    top_k: 3,
    max_tokens: 4000,
    context_window: 3,
  },
  model_max_tokens: 128000,
  rp_web_port: 3012,
  rp_web_host: "0.0.0.0",
}

export function loadRPConfig(cwd: string): RPConfig {
  const configPath = join(cwd, ".rpconfig.json")
  let config: RPConfig = { ...DEFAULT_CONFIG }

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"))
      config = {
        ...DEFAULT_CONFIG,
        ...raw,
        token_budget: { ...DEFAULT_CONFIG.token_budget, ...(raw.token_budget || {}) },
      }
      console.log("[RP] 已加载 .rpconfig.json")
    } catch (e) {
      console.warn("[RP] .rpconfig.json 解析失败，使用默认配置:", (e as Error).message)
    }
  } else {
    try {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8")
      console.log("[RP] 已生成默认 .rpconfig.json（请按需修改后重启）")
    } catch {
      /* 静默失败 */
    }
  }

  if (config.rp_web_port && !process.env.RP_WEB_PORT)
    process.env.RP_WEB_PORT = String(config.rp_web_port)
  if (config.rp_web_host && !process.env.RP_WEB_HOST) process.env.RP_WEB_HOST = config.rp_web_host

  return config
}
