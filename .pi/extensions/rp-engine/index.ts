/**
 * RP Engine - 角色扮演状态引擎（入口）
 *
 * 组合所有子模块，注册事件，委托给生命周期处理器。
 */

import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, type RPConfig } from "./config";
import { StateStore } from "./state-store";
import { createToolRegistry } from "./tools";
import { createCommandRegistry } from "./commands";
import { createRPWebServer } from "./rp-web-server";
import { createAgentApiServer } from "./agent-api";
import { AuthorNote } from "./author-note";
import { RuntimeBridge } from "./runtime-integration";
import type { CompiledRegexHook } from "./regex-processor";
import type { EngineServices } from "./services";
import { getActiveCards, getCardWorldbookDirs, getCardTavernScriptDirs } from "./card-manager";
import { initWorldbookService } from "./worldbook";
import { TavernRunner } from "./tavern-runner";

// 生命周期处理器
import { handleSessionStart, handleSessionTree, handleSessionShutdown } from "./lifecycle/session";
import { handleTurnStart, handleTurnEnd } from "./lifecycle/turn";
import { handleMessageEnd } from "./lifecycle/message";
import { handleBeforeAgentStart } from "./lifecycle/before-agent";

export default function (pi: ExtensionAPI) {
  // ========== 共享可变状态（包装为 mutable ref 对象，确保引用传递） ==========
  const configRef: { current: RPConfig } = { current: { ...DEFAULT_CONFIG } };
  const stateDir = { current: "" };
  const worldbookDir = { current: "" };
  const compiledHooks: { current: CompiledRegexHook[] } = { current: [] };
  const lastTotalTokens = { value: 0 };
  const userTurnCounter = { value: 0 };

  // ========== 初始化子服务 ==========
  const store = new StateStore();
  const runtime = new RuntimeBridge();
  const authorNote = new AuthorNote();

  const agentApi = createAgentApiServer(
    pi,
    () => stateDir.current,
    () => store.getState(),
    () => configRef.current
  );

  const rpWeb = createRPWebServer(
    pi,
    () => stateDir.current,
    () => store.getState(),
    () => {
      const displayHooks: { name: string; pattern: string; flags: string; replacement: string }[] = [];
      for (const h of compiledHooks.current) {
        if (h.phase === "display") {
          displayHooks.push({
            name: h.name,
            pattern: h.regex.source,
            flags: h.regex.flags,
            replacement: h.replacement,
          });
        }
      }
      return { prompt: [], display: displayHooks };
    }
  );

  // 事件转发注册（必须在 session_start 之前）
  rpWeb.registerEventForwarding();

  // ========== 构建服务容器 ==========

  const tavernRunner = new TavernRunner({
    store,
    getScriptDirs: () => getCardTavernScriptDirs(),
  });

  const services: EngineServices = {
    configRef, store, rpWeb, agentApi, runtime, authorNote,
    compiledHooks, stateDir, worldbookDir, userTurnCounter, lastTotalTokens,
    worldbook: initWorldbookService(),
    tavernRunner,
  };

  // ========== 生命周期事件注册 ==========

  pi.on("session_start", (ev: any, ctx: any) =>
    handleSessionStart(pi, ctx, services)
  );

  pi.on("session_tree", (ev: any, ctx: any) =>
    handleSessionTree(pi, ctx, services)
  );

  pi.on("session_shutdown", () =>
    handleSessionShutdown(pi, services)
  );

  pi.on("turn_start", (ev: any, ctx: any) =>
    handleTurnStart(pi, ctx, ev, services)
  );

  pi.on("turn_end", (ev: any, ctx: any) =>
    handleTurnEnd(pi, ctx, ev, services)
  );

  pi.on("message_end", (ev: any) =>
    handleMessageEnd(ev, services)
  );

  pi.on("before_agent_start", (ev: any) =>
    handleBeforeAgentStart(ev, services)
  );

  // ========== 工具注册 ==========

  const toolRegistry = createToolRegistry(
    () => store.getState(),
    () => store.saveState(),
    (record) => store.appendHistory(record),
    () => {
      const cardDirs = getCardWorldbookDirs();
      return cardDirs.length > 0 ? cardDirs : [worldbookDir.current];
    },
    () => {
      const schemas: Record<string, Record<string, Record<string, string>>> = {};
      try {
        for (const card of getActiveCards()) {
          const schemaPath = join(card.dir, "variable_schema.json");
          if (!existsSync(schemaPath)) continue;
          const cardSchema = JSON.parse(readFileSync(schemaPath, "utf-8"));
          const charSchemas: Record<string, Record<string, string>> = {};
          for (const [charName, fields] of Object.entries(cardSchema)) {
            if (charName === "事件") continue;
            const typedFields: Record<string, string> = {};
            for (const [fname, fval] of Object.entries(fields as Record<string, any>)) {
              typedFields[fname] = typeof fval;
            }
            charSchemas[charName] = typedFields;
          }
          if (Object.keys(charSchemas).length > 0) {
            schemas[card.id] = charSchemas;
          }
        }
      } catch {}
      return schemas;
    }
  );
  toolRegistry.registerAll(pi);

  // ========== 命令注册 ==========

  const cmdRegistry = createCommandRegistry(
    () => store.getState(),
    () => store.saveState(),
    () => store.getHistoryPath(),
    stateDir.current,
    (cardId: string) => store.resetCardFromTemplate(cardId)
  );
  cmdRegistry.registerAll(pi);
}
