/**
 * RP Engine - input 事件处理器
 *
 * 替代之前的 turn_start steer 注入体系。
 * 在用户消息到达 agent 之前拦截并直接修改消息内容，零额外消息开销。
 *
 * ★ 缓存策略：所有动态上下文（状态、记忆检索、场景信息）在此处拼入用户消息，
 *   保持 system prompt（before_agent_start）纯静态，LLM 缓存完美命中。
 *
 * 职责：
 * - 状态摘要（时间/地点）
 * - World Agent 舞台指示（场景 + 记忆检索 + 世界动态）
 * - 关键词触发世界书（每 3 轮）
 * - 项目报告刷新（每 20 轮）
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { getCardWorldbookDirs, getActiveCards } from "../card-manager";
import { injectTriggeredWorldbook } from "../worldbook";
import { setRawInput } from "../runtime/input-state";
import { traceLog } from "../utils/trace-logger";

export interface InputDeps {
  store: import("../state-store").StateStore;
  userTurnCounter: { value: number };
  worldbookDir: { current: string };
  memoryStore?: import("../prototypes/memory-store").MemoryStore;
  sceneScheduler?: import("../prototypes/scene-scheduler").SceneScheduler;
  runtime?: import("../runtime-integration").RuntimeBridge;
  stateDir?: { current: string };
  configRef?: { current: import("../config").RPConfig };
  worldAgent?: import("../prototypes/world-agent").WorldAgent;
}

/**
 * input: 在用户消息到达 agent 前拦截，直接拼上上下文内容
 */
export function handleInput(
  event: any,
  _ctx: ExtensionContext,
  deps: InputDeps
): void {
  const originalContent = event?.content || event?.message?.content || event?.text || event?.input || event?.value || "";
  if (!originalContent) {
    // 综合诊断：输出 event 所有字段名和值类型
    const dump: string[] = [];
    if (typeof event === 'object' && event) {
      for (const k of Object.keys(event)) {
        const v = (event as any)[k];
        const typeStr = typeof v;
        const valStr = typeStr === 'string' ? `="${v.substring(0, 60)}"` : Array.isArray(v) ? `[${v.length}]` : typeStr === 'object' && v ? `{${Object.keys(v).length}}` : '';
        dump.push(`${k}:${typeStr}${valStr}`);
      }
    }
    traceLog("[Input] 空内容, 原始事件字段:", ...dump);
    return;
  }

  // 缓存原始消息供 turn_end 使用（跨事件传递）
  setRawInput(originalContent);
  console.log("[Input] setRawInput:", originalContent.slice(0, 80));

  const parts: string[] = [];

  // 1. 当前状态摘要（每轮都拼）
  try {
    const state = deps.store.getState();
    const world = state["世界"] || state.global?.世界 || {};
    if (world.当前日期 || world.当前时间 || world.当前位置) {
      parts.push(
        `📅 ${world.当前日期 || "?"} ${world.当前星期 || ""}` +
        ` 🕐 ${world.当前时间 || ""} 📍 ${world.当前位置 || "?"}`
      );
    }
  } catch { /* 静默 */ }

  // 2. 上下文舞台指示（场景 + 记忆 + 世界动态）
  try {
    const ms = deps.memoryStore;
    const ss = deps.sceneScheduler;
    const wa = deps.worldAgent;

    let memResults: import("../prototypes/memory-store").MemoryQueryResult[] = [];
    if (ms?.initialized) {
      const currentSceneId = ss?.getCurrentScene()?.id;
      memResults = ms.query(originalContent, {
        targetLayers: ['global', 'event', 'summary'],
        currentSceneId,
        topK: 3,
      });
    }

    if (wa) {
      const stageDirs = wa.buildStageDirections(memResults, ss?.getCurrentScene());
      if (stageDirs) parts.push(stageDirs);
    }
  } catch { /* 上下文舞台指示失败不影响输入 */ }

  // 3. 关键词触发世界书（每 3 轮）
  try {
    if ((deps.userTurnCounter.value + 1) % 3 === 1) {
      const worldbookDirs = getCardWorldbookDirs();
      const searchDirs = worldbookDirs.length > 0
        ? worldbookDirs
        : (deps.worldbookDir.current ? [deps.worldbookDir.current] : []);

      if (searchDirs.length > 0) {
        const recentContext: string[] = [];
        const injected = injectTriggeredWorldbook(originalContent, recentContext, searchDirs);
        if (injected) {
          parts.push(injected);
        }
      }
    }
  } catch { /* 世界书注入失败不影响输入 */ }

  // 4. 每 20 轮刷新项目报告
  try {
    if (deps.userTurnCounter.value > 0 && deps.userTurnCounter.value % 20 === 0) {
      const cwd = deps.stateDir?.current ? join(deps.stateDir.current, "..") : "";
      const activeCards = getActiveCards();
      const cardLines = activeCards.map((c) => {
        const configPath = join(c.dir, "config.json");
        let name = c.id;
        try {
          if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
            if (cfg.character?.name) name = cfg.character.name;
          }
        } catch {}
        return `  - ${name} (${c.id})`;
      });
      parts.push(`[状态刷新] 激活卡片 (${activeCards.length}):\n${cardLines.join('\n')}`);
    }
  } catch { /* 刷新失败不影响输入 */ }

  // 保存原文供后续持久化使用（turn_start 写 session 文件时用原文）
  event.__originalUserContent = originalContent;

  // 有上下文就拼到用户消息前面
  if (parts.length > 0) {
    const prefix = parts.join("\n\n");
    event.content = `${prefix}\n\n---\n${originalContent}`;
  } else {
    event.content = originalContent;
  }
  if (event.message) {
    event.message.content = event.content;
  }
}
