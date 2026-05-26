/**
 * RP Engine - 配置加载模块
 *
 * 负责加载 .rpconfig.json 并合并默认配置。
 * 独立模块，无副作用函数。
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** .rpconfig.json 配置接口 */
export interface RPConfig {
  character_card?: string;
  worldbook_extra_dir?: string;
  token_budget?: {
    worldbook_max?: number;
    history_max_tokens?: number;
  };
  author_note?: string;
  model_max_tokens?: number;
  rp_web_port?: number;
  rp_web_host?: string;
  /** Context Assembly 模式：'legacy' | 'runtime' | 'auto' */
  context_mode?: string;
  agent_api?: {
    enabled?: boolean;
    port?: number;
    host?: string;
    api_key?: string;
    permission?: string;
  };
}

/** 内置默认配置 */
export const DEFAULT_CONFIG: RPConfig = {
  token_budget: {
    worldbook_max: 1500,
    history_max_tokens: 8000,
  },
  model_max_tokens: 128000,
  rp_web_port: 3012,
  rp_web_host: "0.0.0.0",
};

/**
 * 加载 .rpconfig.json 配置
 * - 如果文件存在：读取并合并到默认配置
 * - 如果文件不存在：使用默认配置并自动生成一份
 * - 设置相关环境变量（RP_WEB_PORT, RP_WEB_HOST, RP_AUTHOR_NOTE）
 */
export function loadRPConfig(cwd: string): RPConfig {
  const configPath = join(cwd, ".rpconfig.json");
  let config: RPConfig = { ...DEFAULT_CONFIG };

  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      config = {
        ...DEFAULT_CONFIG,
        ...raw,
        token_budget: {
          ...DEFAULT_CONFIG.token_budget,
          ...(raw.token_budget || {}),
        },
      };
      console.log("[RP] 已加载 .rpconfig.json");
    } catch (e) {
      console.warn("[RP] .rpconfig.json 解析失败，使用默认配置:", (e as Error).message);
    }
  } else {
    try {
      writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
      console.log("[RP] 已生成默认 .rpconfig.json（请按需修改后重启）");
    } catch {
      // 静默失败
    }
  }

  // 写入环境变量（覆盖 config 中的 author_note）
  if (config.author_note && !process.env.RP_AUTHOR_NOTE) {
    process.env.RP_AUTHOR_NOTE = config.author_note;
  }
  if (config.rp_web_port && !process.env.RP_WEB_PORT) {
    process.env.RP_WEB_PORT = String(config.rp_web_port);
  }
  if (config.rp_web_host && !process.env.RP_WEB_HOST) {
    process.env.RP_WEB_HOST = config.rp_web_host;
  }

  return config;
}
