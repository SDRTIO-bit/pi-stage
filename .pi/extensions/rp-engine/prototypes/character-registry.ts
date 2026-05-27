/**
 * RP Engine - Character Registry
 *
 * 角色 Agent 注册中心。管理所有角色 Agent 的生命周期、分级创建、
 * 显著性预算和冲突检测。
 *
 * 架构：
 * - 分级策略：核心角色（卡片激活时创建）> 重要角色（惰性创建）> 背景角色（不创建）
 * - 惰性创建：从 MemoryStore 事件中自动学习角色特征
 * - 显著性预算：每轮最多运行 6-8 个 Agent，按优先级排序
 * - 冲突检测：并行 Agent 间的行为冲突裁决
 *
 * 数据来源（零硬编码）：
 * - card-manager → 激活卡片列表
 * - state-store → 角色运行时数值
 * - MemoryStore → 历史事件（惰性创建用）
 * - scene-scheduler → 当前场景角色
 */

import type { MemoryStore } from "./memory-store";
import { CharacterAgent, type CharacterIntent, type CharacterProfile, type EmotionalState, EMOTION_LABELS } from "./character-agent";
import type { PlayerAgent, UserActionImpact } from "./player-agent";

// ============================================================
// 类型定义
// ============================================================

/** 角色分级 */
export type AgentTier = 'core' | 'important' | 'background';

/** 注册条目 */
interface RegistryEntry {
  agent: CharacterAgent;
  tier: AgentTier;
  /** 是否由惰性创建生成（需要特殊处理） */
  lazyCreated: boolean;
  /** 创建时的轮数 */
  createdAtRound: number;
  /** 上次活跃轮数 */
  lastActiveRound: number;
}

/** 显著性预算配置 */
export interface SalienceBudget {
  maxAgentsPerTurn: number;
  /** 最低显著性分数才运行 */
  minThreshold: number;
}

export const DEFAULT_SALIENCE_BUDGET: SalienceBudget = {
  maxAgentsPerTurn: 8,
  minThreshold: 0.1,
};

/** 冲突事件 */
export interface ConflictEvent {
  agents: string[];
  description: string;
  resolution: string;
}

// ============================================================
// CharacterRegistry
// ============================================================

export class CharacterRegistry {
  private entries: Map<string, RegistryEntry> = new Map();
  private memoryStore?: MemoryStore;
  private salienceBudget: SalienceBudget;
  private currentRound = 0;

  constructor(memoryStore?: MemoryStore, budget?: Partial<SalienceBudget>) {
    this.memoryStore = memoryStore;
    this.salienceBudget = { ...DEFAULT_SALIENCE_BUDGET, ...budget };
  }

  // ============================================================
  // 注册管理
  // ============================================================

  /**
   * 注册核心角色 Agent（卡片激活时调用）
   * 核心角色：角色卡中明确定义的完整 Agent
   */
  registerCore(agent: CharacterAgent): void {
    const existing = this.entries.get(agent.characterName);
    if (existing) {
      console.log(`[CharacterRegistry] 更新核心角色: ${agent.characterName}`);
      this.entries.set(agent.characterName, {
        ...existing,
        agent,
        tier: 'core',
      });
    } else {
      console.log(`[CharacterRegistry] 注册核心角色: ${agent.characterName}`);
      this.entries.set(agent.characterName, {
        agent,
        tier: 'core',
        lazyCreated: false,
        createdAtRound: this.currentRound,
        lastActiveRound: this.currentRound,
      });
    }
  }

  /**
   * 注册 PlayerAgent
   */
  private _playerAgent?: PlayerAgent;

  get playerAgent(): PlayerAgent | undefined {
    return this._playerAgent;
  }

  registerPlayerAgent(agent: PlayerAgent): void {
    this._playerAgent = agent;
    console.log(`[CharacterRegistry] 注册玩家化身: ${agent.avatarName}`);
  }

  /** 获取已注册的角色名列表 */
  getCharacterNames(): string[] {
    return Array.from(this.entries.keys());
  }

  /** 获取指定角色 Agent */
  getAgent(name: string): CharacterAgent | undefined {
    return this.entries.get(name)?.agent;
  }

  /** 获取指定角色的注册级别 */
  getTier(name: string): AgentTier | undefined {
    return this.entries.get(name)?.tier;
  }

  /** 获取所有注册条目 */
  getAllEntries(): Map<string, RegistryEntry> {
    return new Map(this.entries);
  }

  // ============================================================
  // 惰性创建
  // ============================================================

  /**
   * 检查并惰性创建角色 Agent
   * - 超过 5 条事件 → 轻量 Agent（从事件提取性格/关系/日程）
   * - 超过 15 条 → 升级为完整 Agent
   *
   * @param characterName 角色名
   * @param memoryStore 用于检索相关事件
   */
  ensureAgent(characterName: string, memoryStore?: MemoryStore): CharacterAgent | undefined {
    const existing = this.entries.get(characterName);
    if (existing) return existing.agent;

    const ms = memoryStore ?? this.memoryStore;
    if (!ms || !ms.initialized) return undefined;

    // 检索该角色的相关事件
    const events = ms.query(characterName, {
      targetLayers: ['event'],
      topK: 20,
    });

    const eventCount = events.length;

    // 不足 5 条 → 不创建
    if (eventCount < 5) return undefined;

    // 从事件中提取角色画像
    const profile = this.inferProfileFromEvents(characterName, events);

    // 超过 15 条 → 完整 Agent；否则轻量 Agent
    const isComplete = eventCount >= 15;
    const agent = new CharacterAgent(profile);

    if (isComplete) {
      // 从事件重放情绪和关系
      this.replayEventsToAgent(agent, events);
    }

    this.entries.set(characterName, {
      agent,
      tier: 'important',
      lazyCreated: true,
      createdAtRound: this.currentRound,
      lastActiveRound: this.currentRound,
    });

    console.log(`[CharacterRegistry] 惰性创建角色 Agent: ${characterName} (${isComplete ? '完整' : '轻量'}, ${eventCount} 条事件)`);
    return agent;
  }

  /** 从事件推断角色画像 */
  private inferProfileFromEvents(
    name: string,
    events: import("./memory-store").MemoryQueryResult[]
  ): CharacterProfile {
    // 提取 personality 关键词
    const allText = events.map((e) => e.chunk.text).join('\n');
    const personalityHints: string[] = [];
    const personalityKeywords = ['温柔', '安静', '活泼', '严肃', '冷淡', '热情', '害羞', '大方', '细心', '粗心'];
    for (const kw of personalityKeywords) {
      if (allText.includes(kw)) personalityHints.push(kw);
    }

    return {
      name,
      personality: personalityHints.join('、') || '未知',
      scenario: '',
      firstMessage: '',
      variables: {},
      schedule: [],
    };
  }

  /** 将事件重放到 Agent 以恢复情绪状态 */
  private replayEventsToAgent(
    agent: CharacterAgent,
    events: import("./memory-store").MemoryQueryResult[]
  ): void {
    for (const evt of events) {
      const text = evt.chunk.text;
      const delta: Partial<EmotionalState> = {};

      // 从文本推断情绪影响
      if (/温柔|安慰|拥抱|轻抚/.test(text)) delta.温暖 = 0.05;
      if (/愤怒|争吵|怒吼/.test(text)) delta.愤怒 = 0.08;
      if (/恐惧|害怕|颤抖/.test(text)) delta.恐惧 = 0.08;
      if (/悲伤|哭泣|叹息/.test(text)) delta.悲伤 = 0.08;
      if (/愧疚|抱歉|对不起/.test(text)) delta.愧疚 = 0.05;

      if (Object.keys(delta).length > 0) {
        agent.updateEmotion(delta, {});
      }
    }
  }

  // ============================================================
  // 显著性预算
  // ============================================================

  /**
   * 获取本轮需要运行的角色 Agent 列表
   *
   * 优先级排序：
   * 1. 当前场景中的角色（最高）
   * 2. 用户最近 3 轮交互过的角色
   * 3. 需求强度 ≥ 7 的角色（迫切需要行动）
   * 4. 情绪波动 ≥ 0.5 的角色（情绪爆发边缘）
   *
   * @param sceneCharacters 当前场景中的角色
   * @param budget 可选覆盖预算
   */
  getActiveAgents(
    sceneCharacters: string[],
    budget?: number
  ): { agent: CharacterAgent; tier: AgentTier; score: number }[] {
    const maxAgents = budget ?? this.salienceBudget.maxAgentsPerTurn;
    const scored: { agent: CharacterAgent; tier: AgentTier; score: number }[] = [];

    for (const [name, entry] of this.entries) {
      let score = 0;

      // 1. 当前场景中 → +3
      if (sceneCharacters.includes(name)) score += 3;

      // 2. 最近活跃 → +2
      const roundsSinceActive = this.currentRound - entry.lastActiveRound;
      if (roundsSinceActive <= 3) score += 2;

      // 3. 需求紧迫 → +2
      const dominantNeed = entry.agent.getDominantNeed();
      if (dominantNeed) {
        score += dominantNeed.intensity / 5; // 0-2
      }

      // 4. 情绪波动大 → +1
      const volatility = entry.agent.getEmotionVolatility();
      if (volatility >= 0.5) score += 1;
      else if (volatility >= 0.3) score += 0.5;

      // 5. 核心角色优先
      if (entry.tier === 'core') score += 1;

      if (score >= this.salienceBudget.minThreshold) {
        scored.push({ agent: entry.agent, tier: entry.tier, score });
      }
    }

    // 按分数降序，取预算上限
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxAgents);
  }

  // ============================================================
  // 批处理运行
  // ============================================================

  /**
   * 批量运行角色 Agent 决策
   * 在 turn_end 管线中调用
   *
   * @param sceneCharacters 当前场景角色
   * @param gameTime 游戏时间
   * @param location 当前位置
   * @param visibleEvents 可见事件摘要
   * @param playerImpact 用户行为影响（可选）
   */
  async runAgents(
    sceneCharacters: string[],
    gameTime: string,
    location: string,
    visibleEvents: string[],
    playerImpact?: UserActionImpact
  ): Promise<{
    intents: CharacterIntent[];
    conflicts: ConflictEvent[];
  }> {
    this.currentRound++;

    // Step 1: 离线衰减（不在场角色）
    for (const [, entry] of this.entries) {
      if (!sceneCharacters.includes(entry.agent.characterName)) {
        // 情绪衰减已由 updateEmotion 在内部处理
        // 这里只做需求增长
        entry.agent.updateNeeds();
      }
    }

    // Step 2: 获取活跃 Agent
    const activeAgents = this.getActiveAgents(sceneCharacters);
    console.log(`[CharacterRegistry] runAgents: 获取到 ${activeAgents.length} 个活跃 Agent`);

    // Step 3: 并行决策
    const intents: CharacterIntent[] = [];
    for (const { agent } of activeAgents) {
      console.log(`[CharacterRegistry] runAgents: 开始处理 ${agent.characterName}`);
      // 应用玩家影响
      if (playerImpact) {
        agent.receivePlayerImpact(playerImpact, agent.characterName);
      }

      // 执行决策
      console.log(`[CharacterRegistry] runAgents: 准备调用 ${agent.characterName}.decide()`);
      const intent = agent.decide(gameTime, location, visibleEvents);
      console.log(`[CharacterRegistry] runAgents: ${agent.characterName}.decide() 完成, action=${intent.intendedAction}`);
      intents.push(intent);

      // 更新活跃轮数
      const entry = this.entries.get(agent.characterName);
      if (entry) entry.lastActiveRound = this.currentRound;
    }

    // Step 4: 冲突检测
    const conflicts = this.detectConflicts(intents);
    const resolved = this.resolveConflicts(conflicts, intents);

    return { intents: (resolved ?? intents), conflicts };
  }

  // ============================================================
  // 冲突检测与裁决
  // ============================================================

  /**
   * 检测并行 Agent 间的行为冲突
   * 规则：两个角色不能同时做占据同一空间位置的事
   */
  detectConflicts(intents: CharacterIntent[]): ConflictEvent[] {
    const conflicts: ConflictEvent[] = [];
    const locationActions = ['走进堂屋', '走进院子', '走进卧室', '走进灶房', '离开', '回到'];

    for (let i = 0; i < intents.length; i++) {
      for (let j = i + 1; j < intents.length; j++) {
        const a = intents[i];
        const b = intents[j];

        // 检测位置冲突
        for (const action of locationActions) {
          if (a.intendedAction.includes(action) && b.intendedAction.includes(action)) {
            conflicts.push({
              agents: [a.characterName, b.characterName],
              description: `两人同时试图 "${action}"`,
              resolution: '',
            });
            break;
          }
        }
      }
    }

    return conflicts;
  }

  /**
   * 裁决冲突：按角色层级决定
   * 优先级：core > important > background
   * 被挤掉的角色改为"观察反应"或"推迟行动"
   */
  resolveConflicts(conflicts: ConflictEvent[], intents: CharacterIntent[]): CharacterIntent[] | null {
    if (conflicts.length === 0) return null;

    for (const conflict of conflicts) {
      const [nameA, nameB] = conflict.agents;
      const tierA = this.entries.get(nameA)?.tier ?? 'background';
      const tierB = this.entries.get(nameB)?.tier ?? 'background';

      const tierOrder: Record<AgentTier, number> = { core: 3, important: 2, background: 1 };
      let loser: string | null = null;

      if (tierOrder[tierA] < tierOrder[tierB]) loser = nameA;
      else if (tierOrder[tierB] < tierOrder[tierA]) loser = nameB;
      else loser = nameB; // 同级别，后者让步

      // 修改落败者的意图
      const loserIntent = intents.find((i) => i.characterName === loser);
      if (loserIntent) {
        conflict.resolution = `${loser} 让步，改为观察反应`;
        loserIntent.intendedAction = '观察反应';
        loserIntent.motivationSource = 'idle';
        loserIntent.intensity = 0.1;
      } else {
        conflict.resolution = `${nameA} 优先级更高`;
      }
    }

    return intents;
  }

  // ============================================================
  // 简报生成
  // ============================================================

  /**
   * 生成角色状态简报（供叙事 Agent 消费）
   * 格式为纯文本描述，不含任何硬编码角色名
   */
  generateBrief(intents: CharacterIntent[]): string {
    if (intents.length === 0) return '';

    const lines: string[] = ['### 角色当前状态'];

    for (const intent of intents) {
      const emotion = intent.emotionalState;
      const emotionDesc = this.describeEmotion(emotion, intent.characterName);
      const needDesc = intent.dominantNeed
        ? `需求：${intent.dominantNeed.type}（强度 ${intent.dominantNeed.intensity.toFixed(1)}/10）${intent.dominantNeed.urgent ? '→ 迫切需要' : ''}`
        : '';

      lines.push(`- ${intent.characterName}：${emotionDesc}。${needDesc ? `${needDesc}` : '状态平稳'}`);
    }

    lines.push('');
    lines.push('指导：以上角色状态是他们的"内在驱动力"。请在叙事中自然地、不露痕迹地体现这些状态。');
    lines.push('不要直接复述上述描述，而是通过动作、微表情、环境映射来表现。');

    return lines.join('\n');
  }

  /** 情绪向量 → 自然语言描述 */
  private describeEmotion(emotion: EmotionalState, _name: string): string {
    const parts: string[] = [];
    for (const k of EMOTION_LABELS) {
      if (emotion[k] >= 0.3) {
        const desc = this.emotionToWord(k, emotion[k]);
        parts.push(desc);
      }
    }
    return parts.length > 0 ? parts.join('与') : '平静';
  }

  private emotionToWord(k: keyof EmotionalState, v: number): string {
    const intensity = v >= 0.7 ? '强烈' : v >= 0.5 ? '明显' : '些许';
    const map: Record<keyof EmotionalState, string> = {
      '温暖': '温暖',
      '愧疚': '愧疚',
      '悲伤': '悲伤',
      '恐惧': '恐惧',
      '愤怒': '愤怒',
    };
    return `${intensity}${map[k]}`;
  }

  // ============================================================
  // 快照
  // ============================================================

  toSnapshot(): Record<string, unknown> {
    const agents: Record<string, unknown> = {};
    for (const [name, entry] of this.entries) {
      agents[name] = {
        snapshot: entry.agent.toSnapshot(),
        tier: entry.tier,
        lazyCreated: entry.lazyCreated,
        createdAtRound: entry.createdAtRound,
        lastActiveRound: entry.lastActiveRound,
      };
    }

    return {
      currentRound: this.currentRound,
      agents,
      playerAgent: this._playerAgent?.toSnapshot(),
    };
  }

  fromSnapshot(snapshot: Record<string, unknown>): void {
    const data = snapshot as any;
    this.currentRound = data.currentRound ?? 0;

    if (data.agents) {
      for (const [name, entryData] of Object.entries(data.agents)) {
        const ed = entryData as any;
        // Agent 实例需要重建 — fromSnapshot 恢复其内部状态
        const existing = this.entries.get(name)?.agent;
        if (existing && ed.snapshot) {
          existing.fromSnapshot(ed.snapshot);
        }
      }
    }

    if (data.playerAgent && this._playerAgent) {
      this._playerAgent.fromSnapshot(data.playerAgent);
    }
  }

  /** 重置所有 Agent */
  reset(): void {
    this.entries.clear();
    this._playerAgent = undefined;
    this.currentRound = 0;
  }
}
