/**
 * RP Engine - World Agent 原型
 *
 * 根据"过去发生了什么"（MemoryStore）和"当前是什么场景"（SceneScheduler）
 * 产生连锁事件，让世界不再凭空推演。
 *
 * 架构：
 * - World Agent 为独立模块，消费 MemoryStore 和 SceneScheduler 的输出
 * - 核心方法 generateEvents() 接受记忆检索结果 + 场景上下文 → 输出 ChainEvent[]
 * - 4 路并行规则驱动（plot / character / environment / scene_transition）
 * - 输出被 Narrative Agent 消费，形成"舞台指示"注入到用户消息
 *
 * 时序：
 *   turn_end → WorldAgent.generateEvents() → 存储事件
 *   input → NarrativeAgent 读取事件 → 注入"舞台指示"到用户消息
 *   延迟一轮：第 N 轮的事件在第 N+1 轮被 AI 感知
 */

import type { MemoryQueryResult } from "./memory-store";
import type { Scene } from "./scene-scheduler";

// ============================================================
// 类型定义
// ============================================================

export type ChainEventType = 'environment' | 'character' | 'plot' | 'ambient';

export type ChainEventSeverity = 'minor' | 'moderate' | 'major';

export interface ChainEvent {
  id: string;
  description: string;
  type: ChainEventType;
  severity: ChainEventSeverity;
  /** 事件强度 1-10（LLM 驱动保留字段） */
  intensity?: number;
  /** 触发此事件的相关记忆摘要 */
  sourceMemory?: string;
  /** 与此事件关联的角色 */
  relatedCharacters?: string[];
  /** 事件发生的时间戳 */
  createdAt: number;
}

/**
 * 场景切换建议
 * 由 World Agent 在推理中自主判断是否应切换场景
 */
export interface SceneTransitionSuggestion {
  shouldSwitch: boolean;
  /** 格式: "地点 — 情感阶段"，如 "灶房 — 温馨日常" */
  newSceneName?: string;
  /** 切换理由 */
  reason?: string;
}

/** World Agent 单轮输出：事件列表 + 本轮摘要 */
export interface WorldAgentResult {
  events: ChainEvent[];
  /** 1-2 句话概括本轮关键变化 */
  roundSummary: string;
  /** 场景张力分析（一句话） */
  sceneAnalysis?: string;
  /** 场景切换建议（由 detectSceneTransition 或 LLM 生成） */
  sceneTransition?: SceneTransitionSuggestion;
  /** 触发的世界书条目列表 */
  triggeredWorldbook?: string[];
}

/** World Agent 配置 */
export interface WorldAgentConfig {
  /** 每轮最大生成事件数 */
  maxEventsPerTurn: number;
  /** 存储的最大历史事件数 */
  maxHistoryEvents: number;
  /** 默认规则驱动模式下的记忆采样数 */
  sampleSize: number;
}

export const DEFAULT_WORLD_AGENT_CONFIG: WorldAgentConfig = {
  maxEventsPerTurn: 3,
  maxHistoryEvents: 20,
  sampleSize: 3,
};

// ============================================================
// 格式工具
// ============================================================

/** 将 ChainEvent 列表格式化为文本摘要 */
export function formatChainEvents(events: ChainEvent[]): string {
  if (events.length === 0) return '';
  return events
    .map((e) => `  [${e.type}/${e.severity}] ${e.description}`)
    .join('\n');
}

// ============================================================
// World Agent 主类
// ============================================================

export class WorldAgent {
  private config: WorldAgentConfig;
  private eventHistory: ChainEvent[] = [];
  private eventCounter = 0;

  constructor(config?: Partial<WorldAgentConfig>) {
    this.config = { ...DEFAULT_WORLD_AGENT_CONFIG, ...config };
  }

  /** 获取最新一批事件 */
  getLatestEvents(): ChainEvent[] {
    return this.eventHistory.length > 0
      ? this.eventHistory.slice(-this.config.maxEventsPerTurn)
      : [];
  }

  /** 获取完整事件历史 */
  getEventHistory(): ChainEvent[] {
    return [...this.eventHistory];
  }

  /** 获取最近 N 条事件 */
  getRecentEvents(n: number): ChainEvent[] {
    return this.eventHistory.slice(-n);
  }

  /**
   * 核心生成方法
   *
   * @param memories  MemoryStore 检索结果
   * @param scene     当前场景（SceneScheduler）
   * @param _userMessage 当前用户消息（用于上下文）
   * @returns 事件列表 + 本轮摘要 + 场景切换建议
   */
  async generateEvents(
    memories: MemoryQueryResult[],
    scene: Scene | undefined,
    _userMessage: string
  ): Promise<WorldAgentResult> {
    const sceneName = scene?.name || '未知场景';
    const sceneDescription = scene?.description || '';
    const activeCharacters = scene?.activeCharacters || [];

    // 并行规则驱动模式（4 个独立分支）
    console.log(`[WorldAgent] 规则驱动模式: ${memories.length} 条记忆输入`);
    const result = await this.parallelGenerate(memories, sceneName, sceneDescription, activeCharacters);
    this.storeEvents(result.events);
    return result;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 存储事件到历史，自动裁剪超出部分 */
  private storeEvents(events: ChainEvent[]): void {
    for (const event of events) {
      this.eventCounter++;
      event.id = `evt_${this.eventCounter}`;
      event.createdAt = Date.now();
      this.eventHistory.push(event);
    }
    if (this.eventHistory.length > this.config.maxHistoryEvents) {
      this.eventHistory = this.eventHistory.slice(-this.config.maxHistoryEvents);
    }
  }

  // ============================================================
  // 并行规则驱动 — 4 个独立分支
  // ============================================================

  /**
   * 并行执行 4 个规则分支：plot / character / environment 事件生成 + 场景转折检测
   * 失败时回退到原有的串行逻辑 (legacyGenerate)
   */
  private async parallelGenerate(
    memories: MemoryQueryResult[],
    sceneName: string,
    sceneDescription: string,
    activeCharacters: string[]
  ): Promise<WorldAgentResult> {
    const topMemories = memories.slice(0, this.config.sampleSize);

    try {
      console.log(`[WorldAgent] 并行规则驱动: ${topMemories.length} 条记忆 → 4 分支`);

      const [plotEvents, charEvents, envEvents, sceneTransition] = await Promise.all([
        this.generatePlotEvents(topMemories, sceneDescription, activeCharacters),
        this.generateCharacterEvents(topMemories, sceneDescription, activeCharacters),
        this.generateEnvironmentEvents(topMemories, sceneDescription, activeCharacters),
        this.detectSceneTransition(topMemories, sceneDescription),
      ]);

      const allEvents = [...plotEvents, ...charEvents, ...envEvents];

      // 保证至少一条事件
      if (allEvents.length === 0) {
        allEvents.push({
          id: '',
          description: '世界平静如常，没有任何特别事件发生。',
          type: 'ambient' as ChainEventType,
          severity: 'minor' as ChainEventSeverity,
          createdAt: 0,
        });
      }

      const roundSummary = this.buildRuleSummary(allEvents);
      const trimmed = allEvents.slice(0, this.config.maxEventsPerTurn);
      console.log(`[WorldAgent] 并行分支: plot=${plotEvents.length} char=${charEvents.length} env=${envEvents.length} 切换=${sceneTransition?.shouldSwitch ? '是' : '否'}`);
      console.log(`[WorldAgent] round_summary: "${roundSummary.slice(0, 120)}"`);

      return { events: trimmed, roundSummary, sceneTransition: sceneTransition || undefined };
    } catch (e) {
      console.warn(`[WorldAgent] 并行执行失败，回退到串行模式:`, (e as Error).message);
      return this.legacyGenerate(memories, sceneName, sceneDescription, activeCharacters);
    }
  }

  // ----------------------------------------------------------
  // 分支 1：剧情推进 (plot)
  // ----------------------------------------------------------

  private readonly PLOT_KEYWORDS = ['走', '去', '来', '进入', '离开', '前往', '到', '回', '出', '进', '追', '逃', '带', '跟'];

  private generatePlotEvents(
    memories: MemoryQueryResult[],
    sceneDescription: string,
    activeCharacters: string[]
  ): ChainEvent[] {
    return this.generateEventsForType(memories, this.PLOT_KEYWORDS, 'plot', 1, sceneDescription, activeCharacters);
  }

  // ----------------------------------------------------------
  // 分支 2：角色动态 (character)
  // ----------------------------------------------------------

  private readonly CHAR_KEYWORDS = ['说', '问', '答', '笑', '哭', '怒', '看', '望', '站', '坐', '蹲', '握', '抱', '拍', '拉', '推', '叹', '皱', '低'];

  private generateCharacterEvents(
    memories: MemoryQueryResult[],
    sceneDescription: string,
    activeCharacters: string[]
  ): ChainEvent[] {
    return this.generateEventsForType(memories, this.CHAR_KEYWORDS, 'character', 1, sceneDescription, activeCharacters);
  }

  // ----------------------------------------------------------
  // 分支 3：环境氛围 (environment)
  // ----------------------------------------------------------

  private readonly ENV_KEYWORDS = ['雨', '风', '晴', '雪', '夜', '晨', '黄昏', '季节', '温度', '天气', '月光', '阳光', '室内', '室外', '暗', '亮', '静'];

  private generateEnvironmentEvents(
    memories: MemoryQueryResult[],
    sceneDescription: string,
    activeCharacters: string[]
  ): ChainEvent[] {
    const events = this.generateEventsForType(memories, this.ENV_KEYWORDS, 'environment', 1, sceneDescription, activeCharacters);

    // 如无比对记忆触发，从场景描述中提取环境事件
    if (events.length === 0 && sceneDescription) {
      const matched = this.ENV_KEYWORDS.find(k => sceneDescription.includes(k));
      if (matched) {
        events.push({
          id: '',
          description: `${sceneDescription.slice(0, 40)}...环境氛围持续。`,
          type: 'environment',
          severity: 'minor' as ChainEventSeverity,
          createdAt: 0,
        });
      }
    }

    return events;
  }

  // ----------------------------------------------------------
  // 分支 4：场景转折检测
  // ----------------------------------------------------------

  private readonly TRANSITION_CATEGORIES: [string, string[]][] = [
    ['空间变化', ['走到', '离开', '进入', '回到', '去了', '出来', '进来', '出去', '前往']],
    ['时间推进', ['第二天', '次日', '天亮', '夜深', '清晨', '过了几天', '片刻后']],
    ['关系转折', ['第一次', '终于', '突然', '不再', '开始', '抱住', '握住', '蹲下来']],
    ['新角色', ['来了', '回来了', '进门', '出现']],
  ];

  private detectSceneTransition(
    memories: MemoryQueryResult[],
    _sceneDescription: string
  ): SceneTransitionSuggestion | null {
    for (const mem of memories) {
      const text = mem.chunk.text.slice(0, 200);
      for (const [category, keywords] of this.TRANSITION_CATEGORIES) {
        for (const kw of keywords) {
          if (text.includes(kw)) {
            return {
              shouldSwitch: true,
              reason: `检测到${category}关键词: "${kw}"`,
            };
          }
        }
      }
    }
    return null;
  }

  // ----------------------------------------------------------
  // 通用：记忆匹配 → 事件生成（每个分支共用）
  // ----------------------------------------------------------

  private generateEventsForType(
    memories: MemoryQueryResult[],
    keywords: string[],
    eventType: ChainEventType,
    maxEvents: number,
    _sceneDescription: string,
    _activeCharacters: string[]
  ): ChainEvent[] {
    const events: ChainEvent[] = [];

    for (const mem of memories) {
      if (events.length >= maxEvents) break;

      let text = mem.chunk.text.slice(0, 100);

      // ⭐ 三层防御 ①：跳过工具调用确认语句
      if (/^好的，我先|^让我|^我这就|^我马上|^我正在|\[tool_call|\[load_worldbook|\[update_state|\[read_state/.test(text)) {
        continue;
      }

      // ⭐ 三层防御 ②：清洗 [xxx] 前缀标记
      text = text.replace(/^\[.*?\]\s*/, '').trim();
      if (!text) continue;

      // ⭐ 三层防御 ③：检查是否匹配当前分支的关键词
      if (!keywords.some(k => text.includes(k))) continue;

      // ⭐ 三层防御 ④（二次保障）：如果清洗后仍以工具语句开头，丢弃
      if (/^好的，我先|^让我/.test(text)) continue;

      events.push({
        id: '',
        description: text.length > 60 ? text.slice(0, 60) + '...' : text,
        type: eventType,
        severity: 'minor' as ChainEventSeverity,
        sourceMemory: mem.chunk.text.slice(0, 80),
        relatedCharacters: [],
        createdAt: 0,
      });
    }

    return events;
  }

  // ----------------------------------------------------------
  // 串行回退（原有的规则驱动逻辑，完全保留）
  // ----------------------------------------------------------

  private legacyGenerate(
    memories: MemoryQueryResult[],
    _sceneName: string,
    sceneDescription: string,
    _activeCharacters: string[]
  ): WorldAgentResult {
    const events: ChainEvent[] = [];
    const usedTypes = new Set<ChainEventType>();

    const topMemories = memories.slice(0, this.config.sampleSize);

    console.log(`[WorldAgent] 串行回退: ${topMemories.length} 条记忆`);
    for (let i = 0; i < topMemories.length; i++) {
      const mem = topMemories[i];
      let text = mem.chunk.text.slice(0, 100);

      if (/^好的，我先|^让我|^我这就|^我马上|^我正在|\[tool_call|\[load_worldbook|\[update_state|\[read_state/.test(text)) {
        continue;
      }

      text = text.replace(/^\[.*?\]\s*/, '').trim();
      if (!text) continue;

      let type: ChainEventType = 'ambient';
      if (/走|去|来|进入|离开|前往/.test(text)) type = 'plot';
      else if (/说|问|答|笑|哭|怒/.test(text)) type = 'character';
      else if (/雨|风|晴|雪|夜|晨|黄昏|季节|温度/.test(text)) type = 'environment';

      if (usedTypes.has(type) && events.length >= 2) continue;
      usedTypes.add(type);

      events.push({
        id: '',
        description: text.length > 60 ? text.slice(0, 60) + '...' : text,
        type,
        severity: 'minor',
        sourceMemory: mem.chunk.text.slice(0, 80),
        relatedCharacters: [],
        createdAt: 0,
      });
    }

    if (sceneDescription && !usedTypes.has('environment') && events.length < 3) {
      const envKeywords = ['雨', '风', '夜', '晨', '黄昏', '阳光', '月光', '室内', '室外', '街道', '酒馆'];
      if (envKeywords.find(k => sceneDescription.includes(k))) {
        events.push({
          id: '',
          description: `${sceneDescription.slice(0, 40)}...环境持续`,
          type: 'environment',
          severity: 'ambient' as any,
          createdAt: 0,
        });
      }
    }

    if (events.length === 0) {
      events.push({
        id: '',
        description: '世界平静如常，没有任何特别事件发生。',
        type: 'ambient',
        severity: 'minor',
        createdAt: 0,
      });
    }

    return { events: events.slice(0, this.config.maxEventsPerTurn), roundSummary: this.buildRuleSummary(events) };
  }

  /** 从规则生成的事件构建文本摘要 */
  private buildRuleSummary(events: ChainEvent[]): string {
    if (events.length === 0) return '世界平静如常。';
    const summaries = events.map(e => {
      let desc = e.description;
      if (/^好的，我先|^让我/.test(desc)) {
        desc = '发生了某些变化。';
      }
      return `[${e.type}] ${desc}`;
    });
    return summaries.join('；');
  }

  /** 构建 Narrative Agent 用的"舞台指示"文本 */
  buildStageDirections(
    memories: MemoryQueryResult[],
    scene: Scene | undefined
  ): string {
    const parts: string[] = ['## 舞台指示'];

    if (scene) {
      parts.push(
        `### 当前场景\n` +
        `- **名称**: ${scene.name}\n` +
        `- **描述**: ${scene.description || "无"}\n` +
        `- **在场角色**: ${scene.activeCharacters.join('、')}`
      );
    }

    if (memories.length > 0) {
      const memoryLines = memories.slice(0, 3).map((m) =>
        `  - ${m.chunk.text.slice(0, 150)}`
      );
      parts.push('### 近期相关记忆');
      parts.push(memoryLines.join('\n'));
    }

    const latestEvents = this.getLatestEvents();
    if (latestEvents.length > 0) {
      parts.push('### 世界最新动态');
      parts.push(formatChainEvents(latestEvents));
      parts.push('> 你的回复必须对"世界最新动态"做出明确反应。如果是环境变化，你的角色必须表现出注意到了这个变化。');
    }

    return parts.join('\n');
  }
}
