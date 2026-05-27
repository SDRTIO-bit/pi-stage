/**
 * RP Engine - Session 生命周期事件处理
 *
 * session_start / session_tree / session_shutdown
 */

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRPConfig, type RPConfig } from "../config";
import type { RuntimeBridge } from "../runtime-integration";
import { cleanupOldSessions } from "../utils/session-cleanup";
import { initTraceLogger } from "../utils/trace-logger";
import { loadRegexHooks, type CompiledRegexHook } from "../regex-processor";
import { buildAllCardIndexes, setActiveCharacterNames } from "../worldbook";
import { initCardManager, getActiveCards, getActiveCardIds } from "../card-manager";
import type { TavernRunner } from "../tavern-runner";
import { MemoryStore } from "../prototypes/memory-store";
import { SceneScheduler } from "../prototypes/scene-scheduler";
import { CharacterRegistry } from "../prototypes/character-registry";
import { CharacterAgent, type CharacterProfile } from "../prototypes/character-agent";
import { PlayerAgent } from "../prototypes/player-agent";

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
  memoryStore?: import("../prototypes/memory-store").MemoryStore;
  sceneScheduler?: import("../prototypes/scene-scheduler").SceneScheduler;
  worldAgent?: import("../prototypes/world-agent").WorldAgent;
  characterRegistry?: import("../prototypes/character-registry").CharacterRegistry;
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
  initTraceLogger(deps.stateDir.current);

  // ⭐ 延迟创建 MemoryStore / SceneScheduler（此时 config 已加载）
  const cfg = deps.configRef.current;
  if (cfg.features?.memoryStore && !deps.memoryStore) {
    (deps as any).memoryStore = new MemoryStore();
    console.log('[RP] ✅ MemoryStore 已启用');
  }
  if (cfg.features?.sceneScheduler && !deps.sceneScheduler) {
    (deps as any).sceneScheduler = new SceneScheduler();
    console.log('[RP] ✅ SceneScheduler 已启用');
  }

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
          (k: string) => k !== "世界" && k !== "{{user}}" && !k.startsWith("_") && isCharacterName(k)
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

  // 检测新会话（无 prior rp-state 事件 → 从卡片模板重置运行时状态）
  const hasPriorState = ctx.sessionManager.getBranch()
    .some((e: any) => e.type === "custom" && e.customType === "rp-state");
  if (!hasPriorState) {
    console.log('[RP] 新会话，从卡片模板重置运行时状态');
    for (const cardId of getActiveCardIds()) {
      deps.store.resetCardFromTemplate(cardId);
    }
  }

  // 初始化 MemoryStore（如启用）
  if (deps.memoryStore && deps.configRef.current.features?.memoryStore) {
    const cardIds = getActiveCardIds();
    const cardId = cardIds.length > 0 ? cardIds[0] : 'default';
    // 为新会话生成唯一 sessionId，主动归档内存中残留的旧会话数据
    const sessionId = `${cardId}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
    deps.memoryStore.archiveCurrentSession();
    await deps.memoryStore.initialize(deps.stateDir.current, cardId, sessionId);

    // ⭐ 写入世界书首条内容到 global 层（仅首轮新会话时）
    if (!hasPriorState) {
      for (const card of getActiveCards()) {
        const worldDir = join(card.dir, 'worldbook', '[常开]设定');
        let worldText = '';
        if (existsSync(worldDir)) {
          try {
            const files = readdirSync(worldDir).filter(f => f.endsWith('.md')).sort();
            for (const f of files) {
              const raw = readFileSync(join(worldDir, f), 'utf-8');
              // 跳过 YAML frontmatter
              const body = raw.replace(/^---[\s\S]*?---\n*/, '').trim();
              if (body) {
                worldText += `【${f.replace(/\.md$/, '').replace(/^\d+-/, '')}】\n${body.slice(0, 2000)}\n\n`;
              }
              if (worldText.length > 3000) break;
            }
          } catch {}
        }
        if (!worldText) {
          // 降级：使用卡片描述
          const configPath = join(card.dir, 'config.json');
          if (existsSync(configPath)) {
            try {
              const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
              worldText = cfg.character?.scenario || cfg.scenario || cfg.first_message || '';
            } catch {}
          }
        }
        if (worldText) {
          deps.memoryStore.addEvent(worldText, 'global', 'scene_init', 'init', card.id, '__system__');
          console.log(`[RP] 已写入 global 层: ${card.id} (${worldText.slice(0, 60)}...)`);
        }
      }
    }
  }

  // 初始化 SceneScheduler（如启用）
  if (deps.sceneScheduler && deps.configRef.current.features?.sceneScheduler) {
    const charNames = getActiveCards().flatMap((c) => {
      try {
        const statePath = join(c.dir, "state.json");
        if (!existsSync(statePath)) return [];
        const st = JSON.parse(readFileSync(statePath, "utf-8"));
        return Object.keys(st).filter(
          (k: string) => k !== "世界" && k !== "{{user}}" && !k.startsWith("_") && isCharacterName(k)
        );
      } catch { return []; }
    });
    // 创建初始场景
    deps.sceneScheduler.createScene(
      '故事开始',
      [...new Set(charNames)],
      '起始'
    );
    deps.sceneScheduler.turnsSinceLastChange = 0;
  }

  // ========== 角色 Agent 注册中心（如启用） ==========
  console.log("[Session] 开始初始化角色Agent系统...");
  try {
    const registry = new CharacterRegistry(deps.memoryStore);
    deps.characterRegistry = registry;

    // 为每个核心角色创建 Agent
    const charProfiles = buildCoreCharacterProfiles(ctx.cwd);
    console.log(`[Session] 角色画像加载完毕, 共 ${charProfiles.length} 个`);
    for (const profile of charProfiles) {
      const agent = new CharacterAgent(profile);
      registry.registerCore(agent);
      console.log(`[Session] Agent已创建: ${profile.name}`);
    }

    // 创建玩家化身 Agent
    const userDesc = extractUserDescription(ctx.cwd);
    const pa = new PlayerAgent('{{user}}', userDesc);
    registry.registerPlayerAgent(pa);
    console.log(`[Session] 玩家化身Agent已创建`);

    // 尝试从 session 事件恢复快照
    try {
      const hasAgentSnapshot = ctx.sessionManager.getBranch()
        .some((e: any) => e.type === 'custom' && e.customType === 'agent-snapshot');
      if (hasAgentSnapshot) {
        const snapshotEntries = ctx.sessionManager.getBranch()
          .filter((e: any) => e.type === 'custom' && e.customType === 'agent-snapshot');
        const latestSnapshot = snapshotEntries[snapshotEntries.length - 1];
        if (latestSnapshot?.data) {
          registry.fromSnapshot(latestSnapshot.data);
          console.log('[Session] Agent状态已从快照恢复');
        }
      } else {
        console.log('[Session] 无Agent快照，从角色数值降级重建');
        for (const card of getActiveCards()) {
          const cardState = deps.store.getCardState(card.id);
          if (cardState) {
            for (const [charName, charData] of Object.entries(cardState)) {
              if (charName === '世界' || charName === '{{user}}' || charName.startsWith('_')) continue;
              if (!isCharacterName(charName)) continue;
              const agent = registry.getAgent(charName);
              if (agent && typeof charData === 'object' && charData !== null) {
                const vars = charData as Record<string, number>;
                agent.fromStateValues(vars, deps.userTurnCounter.value);
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[Session] Agent快照恢复失败:', (e as Error).message, (e as Error).stack);
    }

    console.log("[Session] 角色Agent系统初始化完成");
  } catch (e) {
    console.error("[Session] 角色Agent初始化失败:", (e as Error).message, (e as Error).stack);
  }

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
  deps: Pick<SessionDeps, "store" | "rpWeb" | "agentApi" | "runtime" | "memoryStore" | "stateDir">
): Promise<void> {
  deps.runtime.shutdown();
  deps.memoryStore?.flush(deps.stateDir.current);
  deps.store.flushAll();
  await deps.rpWeb.shutdown();
  await deps.agentApi.shutdown();
}

// ============================================================
// 角色 Agent 辅助函数（零硬编码，从角色卡动态提取）
// ============================================================

/** 角色名白名单检查：过滤 World Agent 标签 */
function isCharacterName(name: string): boolean {
  const nonCharacterTags = ['事件', '环境', '剧情', '旁白', 'ambient', 'plot', 'character', 'environment', 'narrative'];
  return !nonCharacterTags.includes(name);
}

/** 从激活的卡片构建核心角色画像列表 */
function buildCoreCharacterProfiles(cwd: string): CharacterProfile[] {
  const profiles: CharacterProfile[] = [];
  const activeCards = getActiveCards();

  for (const card of activeCards) {
    const configPath = join(card.dir, "config.json");
    if (!existsSync(configPath)) continue;

    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));

      // 从 state.json 提取角色变量（每个角色独立收集）
      const statePath = join(card.dir, "state.json");
      const charVarsMap = new Map<string, Record<string, number>>();

      if (existsSync(statePath)) {
        const st = JSON.parse(readFileSync(statePath, "utf-8"));
        for (const [charName, charData] of Object.entries(st)) {
          if (charName === '世界' || charName === '{{user}}' || charName.startsWith('_')) continue;
          if (!isCharacterName(charName)) continue;
          const vars: Record<string, number> = {};
          if (typeof charData === 'object' && charData !== null) {
            for (const [vk, vv] of Object.entries(charData as Record<string, unknown>)) {
              if (typeof vv === 'number') vars[vk] = vv;
            }
          }
          charVarsMap.set(charName, vars);
        }
      }

      // 为每个角色名创建 Agent
      const cardName = cfg.character?.name || card.id;
      const cardLevelPersonality = cfg.character?.personality || '';
      const scenario = cfg.character?.scenario || '';
      const firstMessage = cfg.character?.first_message || '';

      const namesToCreate = charVarsMap.size > 0
        ? Array.from(charVarsMap.entries())
        : [[cardName, {} as Record<string, number>]];

      for (const [name, vars] of namesToCreate) {
        // 只有卡主角色才使用 config 中的 personality，次要角色留空避免误配
        const personality = name === cardName ? cardLevelPersonality : '';
        profiles.push({
          name,
          personality,
          scenario,
          firstMessage,
          variables: { ...vars },
          schedule: [],
        });
      }
    } catch {}
  }

  return profiles;
}

/** 从角色卡提取 {{user}} 描述 */
function extractUserDescription(cwd: string): string {
  try {
    for (const card of getActiveCards()) {
      const configPath = join(card.dir, "config.json");
      if (!existsSync(configPath)) continue;
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.character?.description) {
        const desc = cfg.character.description;
        const userMatch = desc.match(/\{\{user\}\}[\s\S]*?(?=\n\n|\{\{|\Z)/);
        if (userMatch) return userMatch[0].trim();
      }
    }
  } catch {}
  return '';
}

export { buildCoreCharacterProfiles, extractUserDescription };
