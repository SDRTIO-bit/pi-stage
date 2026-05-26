/**
 * RP Engine - Session 生命周期事件处理
 *
 * session_start / session_tree / session_shutdown
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRPConfig, type RPConfig } from "../config";
import type { RuntimeBridge } from "../runtime-integration";
import { cleanupOldSessions } from "../utils/session-cleanup";
import { loadRegexHooks, type CompiledRegexHook } from "../regex-processor";
import { buildAllCardIndexes, setActiveCharacterNames } from "../worldbook";
import { initCardManager, getActiveCards, getActiveCardIds } from "../card-manager";
import type { TavernRunner } from "../tavern-runner";

function ensureDir(dir: string) { mkdirSync(dir, { recursive: true }); }

export interface SessionDeps {
  configRef: { current: RPConfig };
  store: import("../state-store").StateStore;
  rpWeb: ReturnType<typeof import("../rp-web-server").createRPWebServer>;
  agentApi: ReturnType<typeof import("../agent-api").createAgentApiServer>;
  runtime: RuntimeBridge;
  authorNote: import("../author-note").AuthorNote;
  compiledHooks: { current: CompiledRegexHook[] };
  /** 当前 state 目录路径（可变引用） */
  stateDir: { current: string };
  /** @deprecated 单个 worldbook 目录 */
  worldbookDir: { current: string };
  userTurnCounter: { value: number };
  tavernRunner: TavernRunner;
}

/**
 * session_start: 加载配置 + 状态 + 设置目录 + 清理旧 session
 */
export async function handleSessionStart(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: SessionDeps
): Promise<void> {
  deps.configRef.current = loadRPConfig(ctx.cwd);
  deps.stateDir.current = join(ctx.cwd, ".pi");
  deps.worldbookDir.current = join(ctx.cwd, ".pi", "worldbook");

  // 尝试初始化 Runtime
  await deps.runtime.tryInitialize(deps.configRef.current, deps.stateDir.current);

  // 初始化卡片管理器
  initCardManager(ctx.cwd);
  const activeCards = getActiveCards();
  const activeCardIds = getActiveCardIds();
  console.log(`[RP] 激活卡片 (${activeCardIds.length}): ${activeCardIds.join(", ") || "无"}`);
  if (activeCards.length === 0) {
    console.log("[RP] 提示: 没有激活的角色卡，使用默认世界书。输入 /card 管理卡片。");
  }

  // 注册角色到 Agent Loop
  await deps.runtime.registerCardAgents(
    (cardId) => deps.store.getCardState(cardId),
    () => getActiveCards()
  );

  // 加载正则脚本
  const cardDirs = activeCards.map((c) => c.dir);
  const hooks = loadRegexHooks(cardDirs);
  deps.compiledHooks.current = [...hooks.prompt, ...hooks.display];
  console.log(`[RP] 正则钩子: ${hooks.prompt.length} prompt + ${hooks.display.length} display (来自 ${activeCards.length} 张卡)`);

  // 构建动态关键词索引
  buildAllCardIndexes(activeCards.map((c) => ({ id: c.id, dir: c.dir })));

  // 设置活跃角色名（供 worldbook characterFilter 使用）
  {
    const charNames = getActiveCards().flatMap((c) => {
      try {
        const statePath = join(c.dir, "state.json");
        if (!existsSync(statePath)) return [];
        const st = JSON.parse(readFileSync(statePath, "utf-8"));
        return Object.keys(st).filter(
          (k: string) => k !== "世界" && k !== "{{user}}" && !k.startsWith("_")
        );
      } catch { return []; }
    });
    setActiveCharacterNames([...new Set(charNames)]);
  }

  // 加载 tavern_helper 脚本并执行 init 阶段
  deps.tavernRunner.loadScripts();
  await deps.tavernRunner.runInitScripts();

  deps.store.setDirectories(deps.stateDir.current);
  deps.store.setPI(pi);
  // ⭐ session-first：从 PI session 事件恢复状态，文件缓存仅做加速
  deps.store.loadFromSession(ctx, getActiveCardIds());

  // 按激活卡片设置独立的 session/history 目录
  const cardSessionsRoot = join(deps.stateDir.current, "sessions");
  const cardIds = getActiveCardIds();
  const sessionSubDir = cardIds.length === 1
    ? cardIds[0]
    : cardIds.join("+");
  const cardSessionsDir = join(cardSessionsRoot, sessionSubDir);

  const newSessionDir = ".pi/sessions/" + sessionSubDir;
  try {
    const settingsPath = join(deps.stateDir.current, "settings.json");
    let settings: Record<string, any> = {};
    if (existsSync(settingsPath)) {
      try {
        const raw = readFileSync(settingsPath, "utf-8");
        settings = raw.trim() ? JSON.parse(raw) : {};
      } catch {
        settings = {};
      }
    }
    if (settings.sessionDir !== newSessionDir) {
      settings.sessionDir = newSessionDir;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");
      console.log(`[RP] sessionDir → ${newSessionDir}`);
    }
  } catch { /* settings 写入失败不影响主流程 */ }

  ensureDir(cardSessionsDir);
  cleanupOldSessions(cardSessionsDir);

  ctx.ui.setStatus("rp", ctx.ui.theme.fg("accent", "RP模式"));

  deps.rpWeb.setLatestCtx(ctx);
  deps.agentApi.setLatestCtx(ctx);
  await deps.rpWeb.start(ctx);
  await deps.agentApi.start(ctx);
}

/**
 * session_tree: 分支导航时重建状态 + 压缩上下文
 */
export async function handleSessionTree(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps: Pick<SessionDeps, "store">
): Promise<void> {
  deps.store.reconstructFromSession(ctx);
  deps.store.saveState();
}

/**
 * session_shutdown: 关闭 Web 服务器 + 刷写持久化
 */
export async function handleSessionShutdown(
  _pi: ExtensionAPI,
  deps: Pick<SessionDeps, "store" | "rpWeb" | "agentApi" | "runtime">
): Promise<void> {
  deps.runtime.shutdown();
  deps.store.flushAll();
  await deps.rpWeb.shutdown();
  await deps.agentApi.shutdown();
}
