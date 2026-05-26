/**
 * RP Engine - Runtime 集成桥接层
 *
 * 封装 AgentRuntime / AutonomousRuntime / PersistenceManager 的创建和生命周期管理。
 * Runtime 是可选依赖（可能未编译），所有导入通过 await import() + try-catch 安全加载。
 */
import { join } from "node:path";
import type { RPConfig } from "./config";
import type {
  AgentRuntimeInstance,
  AutonomousRuntime,
  PersistenceManagerInstance,
  RuntimeModule,
  AutonomousModule,
  AgentModule,
  CompatModule,
} from "./runtime-types";

export interface RuntimeBridgeState {
  mode: 'unavailable' | 'legacy' | 'runtime' | 'auto';
  contextMode: 'legacy' | 'runtime' | 'auto';
  runtimeEnabled: boolean;
  instance: AgentRuntimeInstance | null;
  persistence: PersistenceManagerInstance | null;
  autonomous: AutonomousRuntime | null;
}

/**
 * 安全加载 runtime 模块（模块可能不存在，走 catch）
 */
async function tryImportRuntime(): Promise<RuntimeModule | null> {
  try {
    return await import('../../runtime/index');
  } catch {
    return null;
  }
}

async function tryImportAutonomous(): Promise<AutonomousModule | null> {
  try {
    return await import('../../runtime/autonomous/index');
  } catch {
    return null;
  }
}

async function tryImportAgent(): Promise<AgentModule | null> {
  try {
    return await import('../../runtime/agent/agent-runtime');
  } catch {
    return null;
  }
}

async function tryImportCompat(): Promise<CompatModule | null> {
  try {
    return await import('../../runtime/compat/runtime-adapter');
  } catch {
    return null;
  }
}

export class RuntimeBridge {
  contextMode: 'legacy' | 'runtime' | 'auto' = 'legacy';
  runtimeEnabled = false;
  instance: AgentRuntimeInstance | null = null;
  persistence: PersistenceManagerInstance | null = null;
  autonomous: AutonomousRuntime | null = null;

  /** 当前可用模式（初始化后确定） */
  mode: RuntimeBridgeState['mode'] = 'unavailable';

  // ---- 跨生命周期通信（turn_start → before_agent_start） ----
  // 注意：_pendingSteerContent 已废弃（动态内容改为 pi.sendUserMessage 注入）
  _pendingSteerContent: string | null = null;
  _pendingContextAssembly: string | null = null;
  _lastUserMsg = '';
  _lastActiveCardIds: string[] = [];

  /**
   * 在 session_start 时尝试初始化 Runtime 引擎
   */
  async tryInitialize(config: RPConfig, stateDir: string): Promise<boolean> {
    if (config.context_mode === 'runtime' || config.context_mode === 'auto') {
      this.contextMode = config.context_mode;
      console.log(`[RP] Context Assembly 模式: ${this.contextMode}`);
    }

    try {
      const runtimeMod = await tryImportRuntime();
      if (!runtimeMod) throw new Error('Runtime 模块不可用');

      const { AgentRuntime, PersistenceManager } = runtimeMod;
      const autonomousMod = await tryImportAutonomous();

      this.instance = new AgentRuntime({
        modelMaxTokens: config.model_max_tokens || 128000,
        safetyMargin: 4000,
        contextMode: this.contextMode === 'legacy' ? 'legacy' : 'auto',
        enableMemory: true,
        enableAutonomous: true,
        autonomousConfig: {
          autoStart: false,
          backgroundEnabled: true,
          worldSpeed: 'normal',
          maxAgents: 10,
          baseTickInterval: 2000,
        },
      });

      await this.instance.initialize();

      this.persistence = new PersistenceManager({
        autoSaveIntervalMs: 5 * 60 * 1000,
        maxSaveFiles: 10,
        includeDebugData: true,
        saveDir: join(stateDir, 'runtime', 'saves'),
      });

      if (this.instance.autonomous) {
        this.autonomous = this.instance.autonomous;
        this.persistence.attachRuntime(this.autonomous, this.instance.debug);
      }

      this.mode = this.contextMode === 'legacy' ? 'legacy' : 'auto';
      console.log('[RP] ✅ Autonomous Runtime 初始化成功');
      return true;
    } catch (e) {
      console.warn('[RP] Runtime 初始化失败:', (e as Error).message);
      console.warn('[RP] 请确保 Runtime 模块已编译。暂回退到 legacy 模式');
      this.mode = 'unavailable';
      return false;
    }
  }

  /**
   * 注册激活卡片的角色到 Agent Loop
   */
  async registerCardAgents(
    getCardState: (cardId: string) => any,
    getActiveCards: () => { id: string }[]
  ): Promise<void> {
    if (!this.autonomous) return;
    try {
      const agentMod = await tryImportAgent();
      if (!agentMod) return;

      const { AgentRuntimeState } = agentMod;
      const activeCards = getActiveCards();
      for (const card of activeCards) {
        const cardState = getCardState(card.id);
        if (cardState) {
          for (const [charName, charData] of Object.entries(cardState.characters as Record<string, any>)) {
            try {
              const agent = new AgentRuntimeState(
                `${card.id}/${charName}`,
                charName,
                charData?.当前状态?.所在地点 || '未知'
              );
              this.autonomous.registerAgent(agent);
            } catch { /* 单个 Agent 注册失败不影响其他 */ }
          }
        }
      }
    } catch { /* 静默失败 */ }
  }

  /**
   * 确保 Autonomous Runtime 已启动（在首次 turn_start 时调用）
   */
  ensureRunning(): void {
    if (this.autonomous && !this.autonomous.isRunning() && this.autonomous.getPhase() === 'uninitialized') {
      try {
        this.autonomous.boot();
        this.persistence?.startAutoSave();
        console.log('[RP] ✅ Autonomous Runtime 已启动');
      } catch (e) {
        console.warn('[RP] Autonomous Runtime 启动失败:', (e as Error).message);
      }
    }
  }

  /**
   * 判断当前是否应启用 Runtime 模式
   */
  updateRuntimeMode(userTurnCounter: number): void {
    if (this.contextMode === 'runtime') {
      this.runtimeEnabled = true;
    } else if (this.contextMode === 'auto' && userTurnCounter >= 5) {
      if (!this.runtimeEnabled) {
        this.runtimeEnabled = true;
        console.log('[RP] auto 模式：第 6 轮起切换为 Context Assembly Engine');
      }
    }
  }

  /**
   * 使用 Context Assembly Engine 装配上下文
   */
  async assembleContext(
    userMsg: string,
    state: Record<string, any>,
    activeCardIds: string[],
    config: RPConfig
  ): Promise<string | null> {
    try {
      if (!this.instance) {
        const runtimeMod = await tryImportRuntime();
        if (!runtimeMod) return null;

        const { AgentRuntime } = runtimeMod;
        this.instance = new AgentRuntime({
          modelMaxTokens: config.model_max_tokens || 128000,
          safetyMargin: 4000,
          contextMode: 'runtime',
          enableMemory: true,
          enableKnowledge: false,
        });
      }

      const compatMod = await tryImportCompat();
      if (!compatMod) return null;

      const { stateToRuntimeSnapshot } = compatMod;
      const snapshot = stateToRuntimeSnapshot(state, activeCardIds, []);

      const prompt = await this.instance.assemble(
        userMsg,
        snapshot,
        activeCardIds.join('+') || 'default'
      );

      return prompt && prompt.length > 100 ? prompt : null;
    } catch (e) {
      console.warn('[RP] Context Assembly 失败，回退到 legacy 模式:', (e as Error).message);
      return null;
    }
  }

  /**
   * 在 turn_end 时：触发 world tick + 写入历史 + 持久化
   */
  processTurnEnd(userTurnCounter: number, store: { appendHistory: (r: any) => void }): void {
    if (!this.autonomous || !this.autonomous.isRunning()) return;

    try {
      const tickResult = this.autonomous.forceWorldTick();

      store.appendHistory({
        timestamp: new Date().toISOString(),
        char: '__runtime__',
        field: 'turn_summary',
        oldValue: '',
        newValue: JSON.stringify({
          turn: userTurnCounter,
          phase: this.autonomous.getPhase(),
          worldTick: tickResult ? {
            timeAdvanced: tickResult.timeAdvanced,
            eventsTriggered: tickResult.eventsTriggered,
            changes: tickResult.changes,
          } : null,
          agentCount: this.autonomous.getAllAgents().length,
          debugStats: this.instance?.debug?.runtime?.getStats() || null,
        }),
      });

      if (userTurnCounter % 3 === 0) {
        const data = this.persistence?.save();
        if (data) {
          store.appendHistory({
            timestamp: new Date().toISOString(),
            char: '__runtime__',
            field: 'persistence_snapshot',
            oldValue: '',
            newValue: JSON.stringify({
              gameDay: data.worldState.environment?.day,
              gameTime: data.worldState.environment?.timeOfDay,
              season: data.worldState.environment?.season,
              weather: data.worldState.environment?.weather,
              agentCount: data.agents?.length,
            }),
          });
        }
      }
    } catch { /* Runtime 日志记录失败不影响主流程 */ }
  }

  /**
   * 在 turn_end 时存储记忆（仅 MemoryLayer 消费）
   */
  async storeMemory(msg: any): Promise<void> {
    if (!this.runtimeEnabled || !this.instance?.memory) return;
    if (msg?.role !== "assistant" || !msg?.content) return;

    try {
      const content = typeof msg.content === "string" ? msg.content : "";
      if (content.length > 200) {
        await this.instance.memory.store({
          type: "episodic",
          content: content.slice(0, 2000),
          timestamp: Date.now(),
          importance: 0.5,
          emotionalValence: 0,
          tags: ["conversation"],
          associations: [],
          accessCount: 0,
          lastAccess: Date.now(),
          decayRate: 0.05,
        });
      }
    } catch { /* 记忆存储失败不影响主流程 */ }
  }

  /**
   * 关闭 Runtime 所有资源
   */
  shutdown(): void {
    if (this.autonomous?.isRunning()) {
      try {
        this.persistence?.save();
        this.persistence?.stopAutoSave();
        this.autonomous.shutdown();
        console.log('[RP] Autonomous Runtime 已关闭');
      } catch (e) {
        console.warn('[RP] Runtime 关闭失败:', (e as Error).message);
      }
    }
  }

  /** 获取状态摘要 */
  getSnapshot(): RuntimeBridgeState {
    return {
      mode: this.mode,
      contextMode: this.contextMode,
      runtimeEnabled: this.runtimeEnabled,
      instance: this.instance,
      persistence: this.persistence,
      autonomous: this.autonomous,
    };
  }
}
