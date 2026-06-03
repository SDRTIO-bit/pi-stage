/**
 * RP Engine - 配置加载模块
 *
 * 负责加载 .rpconfig.json 并合并默认配置。
 * 从 pi-stage-test 直接复制，无修改。
 */

import { join } from "node:path"
import { existsSync, readFileSync, writeFileSync } from "node:fs"

export interface RPConfig {
  token_budget?: { worldbook_max?: number; history_max_tokens?: number }
  author_note?: string
  model_max_tokens?: number
  rp_web_port?: number
  rp_web_host?: string
  features?: { memoryStore?: boolean; sceneScheduler?: boolean }
}

export const DEFAULT_CONFIG: RPConfig = {
  token_budget: { worldbook_max: 1500, history_max_tokens: 8000 },
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
