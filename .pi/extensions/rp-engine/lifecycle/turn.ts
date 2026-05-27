/**
 * RP Engine - Turn 生命周期事件处理
 *
 * turn_start / turn_end
 *
 * ⭐ 注意：世界书注入、状态摘要已迁移到 input 事件（lifecycle/input.ts）
 *    注意力刷新已由 ctx.compact(hint) + before_agent_start 替代
 *    turn_start 只保留：session 持久化、runtime 启动、Context Assembly
 */

import { join } from "node:path";
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeBridge } from "../runtime-integration";
import { cleanupOldSessions } from "../utils/session-cleanup";
import { getActiveCardIds } from "../card-manager";
import type { CompiledRegexHook } from "../regex-processor";
import { traceLog } from "../utils/trace-logger";
import { getRawInput, clearRawInput, setRawInput } from "../runtime/input-state";

// ============================================================
// 会话持久化：保存对话消息到 session JSONL 文件
// ============================================================

let _sessionFilePath: string | null = null;

/** 角色 Agent 简报缓存（turn_end → before_agent_start） */
let _pendingAgentBrief = '';

/** 获取并消费角色 Agent 简报 */
export function consumeAgentBrief(): string {
  const brief = _pendingAgentBrief;
  _pendingAgentBrief = '';
  return brief;
}

/** 获取当前 session 文件路径（惰性初始化，每次 pi run 一个文件） */
function getSessionFilePath(stateDir: string): string | null {
  if (_sessionFilePath) return _sessionFilePath;
  try {
    const activeIds = getActiveCardIds();
    const subDir = activeIds.length === 1 ? activeIds[0] : activeIds.join("+");
    const sessionDirPath = join(stateDir, "sessions", subDir);
    mkdirSync(sessionDirPath, { recursive: true });
    const existing = readdirSync(sessionDirPath).filter(f => f.endsWith(".jsonl"));
    const fileName = existing.length > 0
      ? existing.sort().reverse()[0]
      : `rp-${Date.now()}.jsonl`;
    _sessionFilePath = join(sessionDirPath, fileName);
    return _sessionFilePath;
  } catch {
    return null;
  }
}

/** 写入一条会话记录到 session 文件 */
function appendSessionEntry(stateDir: string, event: any): void {
  const filePath = getSessionFilePath(stateDir);
  if (!filePath) return;
  try {
    const line = JSON.stringify({ type: "message", message: event }) + "\n";
    appendFileSync(filePath, line, "utf-8");
  } catch {}
}

export interface TurnDeps {
  configRef: { current: import("../config").RPConfig };
  store: import("../state-store").StateStore;
  rpWeb: ReturnType<typeof import("../rp-web-server").createRPWebServer>;
  runtime: RuntimeBridge;
  authorNote: import("../author-note").AuthorNote;
  userTurnCounter: { value: number };
  lastTotalTokens: { value: number };
  stateDir: { current: string };
  worldbookDir: { current: string };
  tavernRunner: import("../tavern-runner").TavernRunner;
  compiledHooks: { current: CompiledRegexHook[] };
  memoryStore?: import("../prototypes/memory-store").MemoryStore;
  sceneScheduler?: import("../prototypes/scene-scheduler").SceneScheduler;
  worldAgent?: import("../prototypes/world-agent").WorldAgent;
  characterRegistry?: import("../prototypes/character-registry").CharacterRegistry;
}

/**
 * turn_end: 保存状态 + 记录 token 用量 + 清理旧 session
 */
export async function handleTurnEnd(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  event: any,
  deps: TurnDeps
): Promise<void> {
  traceLog("[Turn] turn_end 钩子被触发");
  deps.store.saveState(true);
  deps.userTurnCounter.value++;
  traceLog("[Turn] state保存完成");

  const msg = event?.message;
  if (msg?.role === "assistant" && msg?.usage?.totalTokens) {
    deps.lastTotalTokens.value = msg.usage.totalTokens;
  }

  // 持久化：保存助手消息到 session 文件
  if (msg) {
    appendSessionEntry(deps.stateDir.current, {
      role: "assistant",
      content: msg.content,
      usage: msg.usage,
    });
  }

  // Runtime 记忆存储
  await deps.runtime.storeMemory(msg);

  // Runtime world tick + 持久化
  deps.runtime.processTurnEnd(deps.userTurnCounter.value, deps.store);
  traceLog("[Turn] Runtime处理完成");

  // ========== MemoryStore 事件记录（如启用） ==========

  // 从 event 中提取用户消息原文（确保是纯文本，函数级作用域）
  const extractText = (content: any): string => {
    if (typeof content === 'string') {
      return content
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .replace(/<content>[\s\S]*?<\/content>/g, '')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .trim();
    }
    if (Array.isArray(content)) {
      return content.map((b: any) => b.text || b.content || '').join('\n');
    }
    return String(content || '');
  };
  // 方法1：从 input-state 模块级缓存读取（input 事件写入）
  let userContent = getRawInput();
  clearRawInput();

  // 方法2：event.originalUserMessage 字段（pi 内部回退）
  if (!userContent && event?.originalUserMessage) {
    userContent = extractText(event.originalUserMessage);
  }

  // 方法3：降级为从 event.content 中提取
  if (!userContent) {
    userContent = extractText(event?.content || '');
  }

  console.log("[Turn] userContent 来源: input-state缓存, 长度:", userContent.length, "前50:", userContent.substring(0, 50));
  const agentContent = extractText(msg?.content);

  const ms = deps.memoryStore;
  const ss = deps.sceneScheduler;
  if (ms) {

    // 当前场景 ID（由 SceneScheduler 管理，或回退）
    const sceneId = ss?.getCurrentScene()?.id || `scene_${deps.userTurnCounter.value}`;

    if (userContent) {
      ms.addEvent(
        userContent.slice(0, 500),
        'event', 'conversation', sceneId,
        ms.cardId || 'default', 'user'
      );
    }

    if (agentContent) {
      ms.addEvent(
        agentContent.slice(0, 500),
        'event', 'conversation', sceneId,
        ms.cardId || 'default', 'assistant'
      );
    }

    // SceneScheduler 记录本轮
    if (ss) {
      const curScene = ss.getCurrentScene();
      if (curScene) ss.recordTurn(curScene);
    }

    // 每 5 轮持久化一次 memory-store.json
    if (ms.initialized && deps.userTurnCounter.value % 5 === 0) {
      ms.flush(deps.stateDir.current);
    }
  }

  // 每 10 轮清理旧 session
  if (deps.userTurnCounter.value % 10 === 0) {
    const sessionsDir = join(deps.stateDir.current, "sessions");
    cleanupOldSessions(sessionsDir);
  }
  traceLog("[Turn] MemoryStore处理完成");

  // ========== World Agent 推演连锁事件 + round_summary 持久化 ==========
  try {
    const wa = deps.worldAgent;
    if (wa) {
      let memories: import("../prototypes/memory-store").MemoryQueryResult[] = [];
      if (ms && ms.initialized) {
        const sceneId = ss?.getCurrentScene()?.id;
        memories = ms.query(userContent, {
          targetLayers: ['event', 'summary'],
          currentSceneId: sceneId,
          topK: 5,
        });
      }

      const result = await wa.generateEvents(memories, ss?.getCurrentScene(), userContent);

      // 存储 round_summary 到 event 层（先清洗再存储）
      if (ms && result.roundSummary) {
        const sceneId = ss?.getCurrentScene()?.id || `scene_${deps.userTurnCounter.value}`;
        const raw = result.roundSummary;
        const cleaned = raw
          .replace(/\[.*?\]/g, '')              // 移除 [xxx] 标签
          .replace(/<\/?[a-z]+\s*\/?>/gi, '')    // 移除 XML 标签
          .replace(/<\/?[a-z]*$/gi, '')          // 移除截断的标签碎片
          .trim();
        console.log(`[RP] round_summary 清洗前: ${raw.slice(0, 80)}`);
        console.log(`[RP] round_summary 清洗后: ${cleaned.slice(0, 80)}`);

        if (cleaned.startsWith('好的，我先') || cleaned.startsWith('让我') || cleaned.length === 0) {
          console.log('[RP] round_summary 为工具确认语句或为空，丢弃并跳过本轮推演');
          result.roundSummary = '';
        } else {
          result.roundSummary = cleaned;
          ms.addEvent(
            cleaned,
            'event', 'round_summary', sceneId,
            ms.cardId || 'default', 'world_agent'
          );
        }
      }

      traceLog("[Turn] round_summary清洗完成");

      // ========== 场景转折检测（并行规则优先，场景调度器兜底） ==========
      if (ss && result.roundSummary) {
        const curScene = ss.getCurrentScene();
        const curSceneId = curScene?.id || `scene_${deps.userTurnCounter.value}`;

        // ① 并行规则 detectSceneTransition 建议（优先采用，最少 3 轮冷却）
        const ruleTransition = result.sceneTransition;
        if (ruleTransition?.shouldSwitch && ss.turnsSinceLastChange >= 3) {
          const sceneName = ss.generateSceneName(result.roundSummary);
          const description = [
            `【场景】${sceneName}`,
            `【在场角色】${curScene?.activeCharacters?.join('、') || '无'}`,
            `【推进理由】${ruleTransition.reason || '场景自然推进'}`,
          ].join('\n');
          console.log(`[SceneScheduler] 规则建议场景切换: ${curSceneId} → ${sceneName} (${ruleTransition.reason})`);
          const chars = curScene?.activeCharacters || [];
          ss.createScene(description, chars, sceneName);
          ss.turnsSinceLastChange = 0;
        } else {
          // ② 场景调度器兜底（turnCount / maxTurns / 关键词）
          const scheduled = ss.evaluateTransition(
            result.roundSummary,
            curSceneId,
            ss.turnsSinceLastChange
          );
          if (scheduled) {
            console.log(`[SceneScheduler] 调度器检测场景切换: ${curSceneId} → ${scheduled.name}`);
            const chars = curScene?.activeCharacters || [];
            ss.createScene(scheduled.description, chars, scheduled.name);
            ss.turnsSinceLastChange = 0;
          } else {
            ss.turnsSinceLastChange++;
          }
        }
      }

      // 每 10 轮合并 round_summary → summary 层
      if (ms && deps.userTurnCounter.value > 0 && deps.userTurnCounter.value % 10 === 0) {
        const sceneId = ss?.getCurrentScene()?.id || `scene_${deps.userTurnCounter.value}`;
        const roundChunks = ms.event.getAllChunks().filter(c => c.tag === 'round_summary');
        if (roundChunks.length > 0) {
          const combined = roundChunks.map(c => c.text).join('\n\n');
          ms.addEvent(
            combined, 'summary', 'summary_conversation', sceneId,
            ms.cardId || 'default', '__summarizer__'
          );
          console.log(`[RP] round_summary → summary 层 (${roundChunks.length} 条)`);
        }
      }
    }
  } catch (e) { traceLog("[Turn] WorldAgent异常:", (e as Error).message); }
  traceLog("[Turn] WorldAgent完成");

  // ========== 角色 Agent 管线（如启用） ==========
  try {
    console.log("[Turn] Agent管线 try 块正式开始执行");
    traceLog("[Turn] 准备进入Agent管线, deps.characterRegistry=", !!deps.characterRegistry, "reg?.playerAgent=", !!(deps.characterRegistry as any)?.playerAgent);
    traceLog("[Turn] deps keys:", Object.keys(deps));
    traceLog("[Turn] 开始角色Agent决策管线...");
    console.log("[Turn] step 0: 准备读取 characterRegistry");
    const reg = deps.characterRegistry;
    console.log("[Turn] step 1: characterRegistry 读取完成");

    if (reg && reg.playerAgent) {
      console.log("[Turn] step 2: 条件通过，准备读取场景信息");
      const curScene = ss?.getCurrentScene();
      console.log("[Turn] step 3: getCurrentScene 完成");
      const sceneChars = curScene?.activeCharacters || [];
      console.log("[Turn] step 4: activeCharacters 完成, count=" + sceneChars.length);
      const gameTime = deps.store.getState()?.世界?.当前时间 || '白天';
      const location = deps.store.getState()?.世界?.当前位置 || '屋内';
      console.log("[Turn] step 5: 状态读取完成, gameTime=" + gameTime + " location=" + location);

      // 1. PlayerAgent 行为分析
      const cleanForAnalyze = userContent.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
      console.log("[Turn] step 6: 准备调用 playerAgent.analyze, 输入长度=" + cleanForAnalyze.length + " 前50=" + cleanForAnalyze.slice(0, 50));
      const impact = reg.playerAgent.analyze(cleanForAnalyze.slice(0, 300), sceneChars);
      console.log("[Turn] step 7: playerAgent.analyze 完成, actionType=" + impact.actionType + " tendency=" + impact.emotionalTendency);
      traceLog(`[Turn] PlayerAgent分析: actionType=${impact.actionType} tendency=${impact.emotionalTendency}`);
      reg.playerAgent.updateState(impact);
      console.log("[Turn] step 8: updateState 完成");

      // 2. 运行角色 Agent 决策
      console.log("[Turn] step 9: 准备调用 reg.runAgents, 场景角色=" + sceneChars.join(","));
      const { intents, conflicts } = await reg.runAgents(
        sceneChars,
        gameTime,
        location,
        [userContent.slice(0, 200), agentContent.slice(0, 200)],
        impact
      );
      console.log("[Turn] step 10: runAgents 完成, intents=" + intents.length + " conflicts=" + conflicts.length);
      traceLog(`[Turn] 角色Agent决策完成, Agent数量: ${intents.length}`);

      // 3. 缓存意图供 before_agent_start 消费
      console.log("[Turn] step 11: 准备 generateBrief");
      _pendingAgentBrief = reg.generateBrief(intents);
      console.log("[Turn] step 12: generateBrief 完成, 长度=" + _pendingAgentBrief.length);

      // 4. 冲突日志
      if (conflicts.length > 0) {
        for (const c of conflicts) {
          traceLog(`[CharacterRegistry] 冲突已裁决: ${c.agents.join(' vs ')} → ${c.resolution}`);
        }
      }
      console.log("[Turn] step 13: 冲突日志处理完成");

      // 5. 保存 Agent 快照
      console.log("[Turn] step 14: 准备 toSnapshot");
      const snapshot = reg.toSnapshot();
      console.log("[Turn] step 15: toSnapshot 完成，准备持久化");
      try {
        pi.appendEntry('agent-snapshot', snapshot as any);
        console.log("[Turn] step 16: 快照持久化完成");
      } catch (e2) {
        traceLog("[Turn] Agent快照持久化失败:", (e2 as Error).message);
        console.log("[Turn] step 16-fail: 快照持久化失败");
      }
    } else {
      console.log("[Turn] step 2-fail: 条件不通过, reg=" + !!reg + " playerAgent=" + !!(reg as any)?.playerAgent);
      traceLog("[Turn] characterRegistry或playerAgent未就绪, 跳过Agent管线");
    }
  } catch (e) {
    traceLog("[Turn] 角色Agent管线异常:", (e as Error).message);
    console.error("[Turn] 角色Agent管线异常:", (e as Error).message, (e as Error).stack);
  }
}

/**
 * turn_start: 用户消息持久化 + Runtime 启动 + Context Assembly
 *
 * ⭐ 世界书注入和状态摘要已迁移到 input 事件。
 *    注意力刷新已移除，由 ctx.compact(hint) 替代。
 */
export async function handleTurnStart(
  pi: ExtensionAPI,
  _ctx: ExtensionContext,
  event: any,
  deps: TurnDeps
): Promise<void> {
  deps.rpWeb.broadcastToRP({ type: "event", event: { type: "turn_start", ...event } });

  // 持久化：保存原始用户消息到 session 文件（input 事件可能已 prepend 上下文到 event.content）
  // 使用 event.__originalUserContent（由 input 事件保存），回退到 event.message.content
  const userContent = event?.__originalUserContent || event?.message?.content || '';
  if (userContent) {
    appendSessionEntry(deps.stateDir.current, { role: "user", content: userContent });
  }

  // 缓存用户原始输入供 turn_end 的 Agent 管线使用
  // ⚠️ turn_start 事件没有 content/message 字段，只在有内容时写入
  // input 事件是主要的缓存来源
  if (userContent) setRawInput(userContent);

  // 启动 Autonomous Runtime（首次 turn_start 时 boot）
  deps.runtime.ensureRunning();

  // 判断是否启用 Runtime 模式
  deps.runtime.updateRuntimeMode(deps.userTurnCounter.value);

  // taverness scripts → 预执行并缓存结果给 before_agent_start 消费
  try {
    const sysMessages = await deps.tavernRunner.runMessageScripts();
    if (sysMessages.length > 0) {
      // 使用动态 import 避免循环依赖（before-agent.ts 和 turn.ts 互相引用）
      const { setPendingTavernMessages } = await import("./before-agent");
      setPendingTavernMessages(sysMessages);
    }
  } catch (e) {
    console.warn('[RP] tavern_helper 脚本执行失败:', (e as Error).message);
  }

  // 世界书注入 → 已迁移到 input 事件
  // 注意力刷新 → 已由 ctx.compact(hint) 替代

  const state = deps.store.getState();

  if (deps.runtime.runtimeEnabled) {
    // Context Assembly Engine 动态装配（异步执行，结果以 steer 形式注入）
    const userMsg = event?.message?.content || '';
    const activeCardIds = getActiveCardIds();

    deps.runtime._lastUserMsg = userMsg;
    deps.runtime._lastActiveCardIds = activeCardIds;

    deps.runtime.assembleContext(userMsg, state, activeCardIds, deps.configRef.current)
      .then(prompt => {
        if (prompt) {
          pi.sendUserMessage(`[系统 · Context Assembly]\n${prompt}`, { deliverAs: "steer" });
        }
      });

    if (deps.runtime._pendingContextAssembly) {
      pi.sendUserMessage(
        `[系统 · Context Assembly]\n${deps.runtime._pendingContextAssembly}`,
        { deliverAs: "steer" }
      );
      deps.runtime._pendingContextAssembly = null;
    }
  }
}
