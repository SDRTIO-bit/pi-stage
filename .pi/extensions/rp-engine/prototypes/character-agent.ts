/**
 * RP Engine - Character Agent
 *
 * 角色 Agent 核心引擎。为每个 NPC 赋予独立的情绪、需求、日程和关系系统，
 * 使其拥有内在驱动力而非被动等待玩家互动。
 *
 * 架构：
 * - 情绪演算：事件影响 + 用户影响 - 自然衰减（每轮 -10%）
 * - 需求系统：4 种需求，未被满足时每轮 +0.5，阈值 ≥7 标记迫切需要
 * - 日程表：从角色配置读取每日活动时间表
 * - 关系矩阵：好感度 / 信任度 / 恐惧度 / 愧疚度多维关系
 * - 自主决策：需求 > 情绪 > 日程 三级优先级竞争
 *
 * 数据来源（零硬编码）：
 * - 角色卡 config.json → personality / scenario / first_message
 * - state-store → 运行时数值（归属值/情分值等）
 * - MemoryStore → 历史事件检索
 */

import type { UserActionImpact } from "./player-agent";

// ============================================================
// 类型定义
// ============================================================

/** 5 维情绪向量 */
export interface EmotionalState {
  温暖: number;
  愧疚: number;
  悲伤: number;
  恐惧: number;
  愤怒: number;
}

export const DEFAULT_EMOTIONAL_STATE: EmotionalState = {
  温暖: 0,
  愧疚: 0,
  悲伤: 0,
  恐惧: 0,
  愤怒: 0,
};

/** 情绪标签列表（用于循环和外部匹配） */
export const EMOTION_LABELS: (keyof EmotionalState)[] = ['温暖', '愧疚', '悲伤', '恐惧', '愤怒'];

/** 需求条目 */
export interface NeedEntry {
  type: string;
  intensity: number;
  lastFulfilledRound: number;
  urgent: boolean;
}

/** 默认需求配置 */
export const DEFAULT_NEED_TYPES = ['被尊重', '安全感', '被爱', '生理需求'];

/** 日程条目 */
export interface ScheduleItem {
  time: string;
  location: string;
  activity: string;
}

/** 关系条目 */
export interface RelationshipEntry {
  target: string;
  好感度: number;
  信任度: number;
  恐惧度: number;
  愧疚度: number;
}

export const DEFAULT_RELATIONSHIP_ENTRY: Omit<RelationshipEntry, 'target'> = {
  好感度: 0,
  信任度: 0,
  恐惧度: 0,
  愧疚度: 0,
};

/** 角色 Agent 输出 — 行为意图 */
export interface CharacterIntent {
  characterName: string;
  emotionalState: EmotionalState;
  dominantNeed: NeedEntry | null;
  intendedAction: string;
  intensity: number;
  /** 意图来源：需求驱动 / 情绪驱动 / 日程驱动 / 默认 */
  motivationSource: 'need' | 'emotion' | 'schedule' | 'idle';
}

/** 角色 Agent 快照（持久化用） */
export interface AgentSnapshot {
  characterName: string;
  round: number;
  emotionalState: EmotionalState;
  needs: NeedEntry[];
  scheduleState: {
    currentActivity: string;
    deviated: boolean;
  };
  relationships: RelationshipEntry[];
  /** 事件 ID 引用（不存正文） */
  recentEventIds: number[];
}

/** 角色画像（从角色卡提取） */
export interface CharacterProfile {
  name: string;
  personality: string;
  scenario: string;
  firstMessage: string;
  /** 角色卡自定义变量映射（如归属值/情分值/背德值等） */
  variables: Record<string, number>;
  /** 日程表（可选） */
  schedule?: ScheduleItem[];
}

// ============================================================
// CharacterAgent
// ============================================================

export class CharacterAgent {
  readonly characterName: string;
  readonly profile: CharacterProfile;

  private emotionalState: EmotionalState;
  private needs: NeedEntry[];
  private schedule: ScheduleItem[];
  private relationships: Map<string, RelationshipEntry>;

  private currentRound = 0;
  private _scheduleDeviated = false;
  private _currentActivity = '';

  constructor(profile: CharacterProfile) {
    this.characterName = profile.name;
    this.profile = profile;

    // 从角色变量反推初始情绪 + 性格基线叠加
    this.emotionalState = this.inferEmotionFromVariables(profile.variables);
    const baseline = this.computePersonalityBaseline();
    for (const k of EMOTION_LABELS) {
      const delta = baseline[k] ?? 0;
      if (delta !== 0) {
        this.emotionalState[k] = Math.max(0, Math.min(1, this.emotionalState[k] + delta));
      }
    }

    // 初始化需求系统
    this.needs = DEFAULT_NEED_TYPES.map((type) => ({
      type,
      intensity: 0,
      lastFulfilledRound: 0,
      urgent: false,
    }));

    // 加载日程表
    this.schedule = profile.schedule || [];
    this._currentActivity = profile.schedule?.[0]?.activity || '闲逛';

    // 初始化关系矩阵
    this.relationships = new Map();
  }

  // ============================================================
  // 情绪系统
  // ============================================================

  /**
   * 从角色变量反推初始情绪
   * 将卡片自定义数值映射到情绪维度：
   *   归-属值 → 温暖 + 愧疚（低归属=愧疚，高归属=温暖）
   *   情分值 → 温暖
   *   背德值 → 愧疚 + 恐惧
   *   欲望值 → 温暖（物理层面）
   */
  private inferEmotionFromVariables(vars: Record<string, number>): EmotionalState {
    const state = { ...DEFAULT_EMOTIONAL_STATE };

    // 归-属值（0-100）：低→愧疚，高→温暖
    const gs = vars['归属值'] ?? 50;
    if (gs < 30) state.愧疚 += (30 - gs) / 100;
    else state.温暖 += (gs - 30) / 100;

    // 情分值（0-100）→ 温暖
    const qf = vars['情分值'] ?? 50;
    state.温暖 += qf / 200;

    // 背德值（0-200）→ 愧疚 + 恐惧
    const bd = vars['背德值'] ?? 0;
    if (bd > 0) {
      state.愧疚 += bd / 400;
      state.恐惧 += bd / 600;
    }

    // 欲望值（0-200）→ 温暖 + 愧疚
    const yw = vars['欲望值'] ?? 0;
    if (yw > 0) {
      state.温暖 += yw / 400;
      state.愧疚 += yw / 600;
    }

    // 钳制到 [0, 1]
    for (const k of EMOTION_LABELS) {
      state[k] = Math.max(0, Math.min(1, state[k]));
    }

    return state;
  }

  /**
   * 更新情绪：事件影响 + 用户影响 - 自然衰减
   *
   * @param eventImpacts 事件对情绪的影响 delta（可选键）
   * @param playerImpacts 用户行为对情绪的影响 delta
   */
  updateEmotion(
    eventImpacts: Partial<EmotionalState>,
    playerImpacts: Partial<EmotionalState>
  ): EmotionalState {
    // 自然衰减：每轮 -10%
    for (const k of EMOTION_LABELS) {
      this.emotionalState[k] *= 0.9;
    }

    // 事件影响
    for (const k of EMOTION_LABELS) {
      const delta = (eventImpacts[k] ?? 0) + (playerImpacts[k] ?? 0);
      if (delta !== 0) {
        this.emotionalState[k] = Math.max(0, Math.min(1, this.emotionalState[k] + delta));
      }
    }

    const es = this.emotionalState;
    console.log(`[CharacterAgent] ${this.characterName} 情绪演算: 温暖=${es.温暖.toFixed(3)} 愧疚=${es.愧疚.toFixed(3)} 悲伤=${es.悲伤.toFixed(3)} 恐惧=${es.恐惧.toFixed(3)} 愤怒=${es.愤怒.toFixed(3)}`);

    return { ...this.emotionalState };
  }

  /** 获取当前情绪副本 */
  getEmotion(): EmotionalState {
    return { ...this.emotionalState };
  }

  /**
   * 计算情绪波动幅度（最高维 - 最低维）
   * ≥ 0.3 表示情绪剧烈，需要表达
   */
  getEmotionVolatility(): number {
    const values = EMOTION_LABELS.map((k) => this.emotionalState[k]);
    return Math.max(...values) - Math.min(...values);
  }

  /** 获取主导情绪 */
  getDominantEmotion(): { label: keyof EmotionalState; value: number } {
    let maxK: keyof EmotionalState = '温暖';
    let maxV = -1;
    for (const k of EMOTION_LABELS) {
      if (this.emotionalState[k] > maxV) {
        maxV = this.emotionalState[k];
        maxK = k;
      }
    }
    return { label: maxK, value: maxV };
  }

  // ============================================================
  // 需求系统
  // ============================================================

  /** 更新所有需求：未被满足时每轮 +0.5 */
  updateNeeds(): NeedEntry[] {
    for (const need of this.needs) {
      need.intensity = Math.min(10, need.intensity + 0.5);
      need.urgent = need.intensity >= 7;
    }
    return this.needs.map((n) => ({ ...n }));
  }

  /** 满足特定需求 */
  fulfillNeed(type: string, round: number): void {
    const need = this.needs.find((n) => n.type === type);
    if (need) {
      need.intensity = 0;
      need.urgent = false;
      need.lastFulfilledRound = round;
    }
  }

  /** 获取所有需求副本 */
  getNeeds(): NeedEntry[] {
    return this.needs.map((n) => ({ ...n }));
  }

  /** 获取最迫切需求 */
  getDominantNeed(): NeedEntry | null {
    const urgent = this.needs.filter((n) => n.urgent);
    if (urgent.length > 0) {
      urgent.sort((a, b) => b.intensity - a.intensity);
      return { ...urgent[0] };
    }
    return null;
  }

  // ============================================================
  // 日程表
  // ============================================================

  /**
   * 获取当前时段活动
   * @param gameTime 当前游戏时间（"上午""下午""晚上""深夜"）
   * @param _location 当前位置
   */
  getCurrentActivity(gameTime: string, _location: string): string {
    if (this.schedule.length === 0) return '闲逛';

    // 匹配当前时段
    for (const item of this.schedule) {
      if (item.time === gameTime) {
        this._currentActivity = item.activity;
        this._scheduleDeviated = false;
        return item.activity;
      }
    }

    // 无匹配 → 偏离日程
    this._scheduleDeviated = true;
    this._currentActivity = '闲逛';
    return '闲逛';
  }

  /** 是否偏离了日程 */
  get scheduleDeviated(): boolean {
    return this._scheduleDeviated;
  }

  /** 设置当前活动（外部通知，如玩家互动打断） */
  setCurrentActivity(activity: string, deviated: boolean): void {
    this._currentActivity = activity;
    this._scheduleDeviated = deviated;
  }

  // ============================================================
  // 关系矩阵
  // ============================================================

  /** 获取对某个目标的关系 */
  getRelationship(target: string): RelationshipEntry {
    return this.relationships.get(target) ?? {
      target,
      ...DEFAULT_RELATIONSHIP_ENTRY,
    };
  }

  /** 更新对某个目标的关系 */
  updateRelationship(target: string, delta: Partial<RelationshipEntry>): RelationshipEntry {
    let entry = this.relationships.get(target);
    if (!entry) {
      entry = { target, ...DEFAULT_RELATIONSHIP_ENTRY };
    }
    if (delta.好感度 !== undefined) entry.好感度 = Math.max(-10, Math.min(10, entry.好感度 + delta.好感度));
    if (delta.信任度 !== undefined) entry.信任度 = Math.max(-10, Math.min(10, entry.信任度 + delta.信任度));
    if (delta.恐惧度 !== undefined) entry.恐惧度 = Math.max(0, Math.min(10, entry.恐惧度 + delta.恐惧度));
    if (delta.愧疚度 !== undefined) entry.愧疚度 = Math.max(0, Math.min(10, entry.愧疚度 + delta.愧疚度));
    this.relationships.set(target, entry);
    return { ...entry, target };
  }

  /** 获取所有关系副本 */
  getAllRelationships(): RelationshipEntry[] {
    return Array.from(this.relationships.values()).map((r) => ({ ...r }));
  }

  // ============================================================
  // 自主决策
  // ============================================================

  /**
   * 核心决策入口
   * 优先级：需求驱动 > 情绪驱动 > 日程驱动 > 继续当前活动
   *
   * @param gameTime 当前游戏时间
   * @param location 当前位置
   * @param visibleEvents 本轮可见事件摘要
   */
  decide(
    gameTime: string,
    location: string,
    visibleEvents: string[]
  ): CharacterIntent {
    this.currentRound++;

    // Step 1: 更新需求
    this.updateNeeds();

    // Step 2: 获取当前活动
    this.getCurrentActivity(gameTime, location);

    // Step 3: 决策
    const dominantNeed = this.getDominantNeed();
    const volatility = this.getEmotionVolatility();

    // 3a. 需求驱动（最优先）
    if (dominantNeed) {
      const intent = this.buildIntent('need', dominantNeed.type, 0.7 + dominantNeed.intensity / 20);
      console.log(`[CharacterAgent] ${this.characterName} 自主决策: 需求驱动(${dominantNeed.type}) action=${intent.intendedAction}`);
      return intent;
    }

    // 3b. 情绪驱动
    if (volatility >= 0.3) {
      const dominant = this.getDominantEmotion();
      const action = this.emotionToAction(dominant.label);
      const intent = this.buildIntent('emotion', action, 0.4 + volatility * 0.5);
      console.log(`[CharacterAgent] ${this.characterName} 自主决策: 情绪驱动(${dominant.label}) action=${intent.intendedAction}`);
      return intent;
    }

    // 3c. 日程偏离 → 决定是否回归
    if (this._scheduleDeviated) {
      // 性格偏向 "认真/守时" 的角色更可能回到日程
      const personality = (this.profile.personality || '').toLowerCase();
      const isDutiful = /认真|守时|负责|规矩|严谨|顺从/.test(personality);
      if (isDutiful) {
        const intent = this.buildIntent('schedule', `回到${this._currentActivity}`, 0.5);
        console.log(`[CharacterAgent] ${this.characterName} 自主决策: 日程回归 action=${intent.intendedAction}`);
        return intent;
      }
    }

    // 3d. 继续当前活动
    const intent = this.buildIntent('idle', this._currentActivity, 0.2);
    console.log(`[CharacterAgent] ${this.characterName} 自主决策: 默认空闲 action=${intent.intendedAction}`);
    return intent;
  }

  /** 情绪 → 默认行为映射 */
  private emotionToAction(emotion: keyof EmotionalState): string {
    const map: Record<keyof EmotionalState, string> = {
      '温暖': '靠近并表达好感',
      '愧疚': '回避或试图弥补',
      '悲伤': '独处或寻求安慰',
      '恐惧': '保持警惕或逃离',
      '愤怒': '对峙或发泄不满',
    };
    return map[emotion];
  }

  private buildIntent(
    source: CharacterIntent['motivationSource'],
    action: string,
    intensity: number
  ): CharacterIntent {
    return {
      characterName: this.characterName,
      emotionalState: { ...this.emotionalState },
      dominantNeed: this.getDominantNeed(),
      intendedAction: action,
      intensity: Math.min(1, intensity),
      motivationSource: source,
    };
  }

  // ============================================================
  // 外部输入
  // ============================================================

  /** 接收玩家行为影响（供 turn_end 管线调用） */
  receivePlayerImpact(
    playerFullImpact: UserActionImpact,
    characterName: string
  ): void {
    const rawDelta = playerFullImpact.emotionalImpacts[characterName] ?? {};
    // 用 intensity 二次缩放（PlayerAgent 的 scaleImpactsByIntensity 是预缩放，此处再按角色敏感度微调）
    const scale = 0.5 + playerFullImpact.intensity * 0.5;
    const scaledDelta: Partial<EmotionalState> = {};
    for (const k of EMOTION_LABELS) {
      const base = (rawDelta as any)[k] ?? 0;
      scaledDelta[k] = base * scale;
    }

    this.updateEmotion({}, scaledDelta);

    // 关系更新
    const relDelta = {
      好感度: (playerFullImpact.targetImpacts[characterName] ?? 0) * 0.1,
    };
    this.updateRelationship(playerFullImpact.actionType, relDelta);

    console.log(`[CharacterAgent] ${this.characterName} 接收用户影响: actionType=${playerFullImpact.actionType} tendency=${playerFullImpact.emotionalTendency} intensity=${playerFullImpact.intensity.toFixed(2)} rawDelta=${JSON.stringify(rawDelta)} scaledDelta=${JSON.stringify(scaledDelta)}`);
  }

  /** 接收世界事件影响 */
  receiveWorldEvents(events: { emotionalDelta: Partial<EmotionalState> }[]): void {
    for (const evt of events) {
      this.updateEmotion(evt.emotionalDelta, {});
    }
  }

  // ============================================================
  // 快照
  // ============================================================

  toSnapshot(): AgentSnapshot {
    return {
      characterName: this.characterName,
      round: this.currentRound,
      emotionalState: { ...this.emotionalState },
      needs: this.needs.map((n) => ({ ...n })),
      scheduleState: {
        currentActivity: this._currentActivity,
        deviated: this._scheduleDeviated,
      },
      relationships: Array.from(this.relationships.values()).map((r) => ({ ...r })),
      recentEventIds: [],
    };
  }

  fromSnapshot(snapshot: AgentSnapshot): void {
    this.currentRound = snapshot.round;
    this.emotionalState = { ...snapshot.emotionalState };
    this.needs = snapshot.needs.map((n) => ({ ...n }));
    this._currentActivity = snapshot.scheduleState.currentActivity;
    this._scheduleDeviated = snapshot.scheduleState.deviated;
    this.relationships.clear();
    for (const r of snapshot.relationships) {
      this.relationships.set(r.target, { ...r });
    }
  }

  /**
   * 从角色运行时数值降级重建 Agent 状态
   * 用于旧会话无快照时的恢复
   */
  fromStateValues(variables: Record<string, number>, round: number): void {
    this.currentRound = round;
    this.emotionalState = this.inferEmotionFromVariables(variables);

    // 性格基线叠加：根据 personality 关键词调整
    const baseline = this.computePersonalityBaseline();
    for (const k of EMOTION_LABELS) {
      const delta = baseline[k] ?? 0;
      if (delta !== 0) {
        this.emotionalState[k] = Math.max(0, Math.min(1, this.emotionalState[k] + delta));
      }
    }

    // 根据特殊事件标记调整关系
    if (variables['告白'] === 1) {
      this.ensureRelationship('{{user}}', { 好感度: 3, 信任度: 2 });
    }
    if (variables['结婚'] === 1) {
      this.ensureRelationship('{{user}}', { 好感度: 5, 信任度: 4, 愧疚度: 1 });
    }
  }

  /**
   * 从 personality 文本提取情绪基线偏移
   * 关键词 → 情绪维度映射，用于角色间初始差异化
   */
  private computePersonalityBaseline(): Partial<EmotionalState> {
    const text = (this.profile.personality || '').toLowerCase();
    const delta: Partial<EmotionalState> = {};
    let matched = false;

    if (/温顺|温柔|体贴|善良|温和|亲切/.test(text)) { delta.温暖 = (delta.温暖 ?? 0) + 0.15; matched = true; }
    if (/内疚|愧疚|自责|亏欠|忏悔/.test(text)) { delta.愧疚 = (delta.愧疚 ?? 0) + 0.2; matched = true; }
    if (/沉默|自卑|孤僻|内向|寡言|阴郁/.test(text)) {
      delta.愧疚 = (delta.愧疚 ?? 0) + 0.15;
      delta.悲伤 = (delta.悲伤 ?? 0) + 0.15;
      matched = true;
    }
    if (/开朗|活泼|热情|大方|爽朗/.test(text)) { delta.温暖 = (delta.温暖 ?? 0) + 0.2; matched = true; }
    if (/严肃|严厉|严格|刚正/.test(text)) { delta.愤怒 = (delta.愤怒 ?? 0) + 0.1; matched = true; }
    if (/胆小|恐惧|怯懦|柔弱|羞涩/.test(text)) { delta.恐惧 = (delta.恐惧 ?? 0) + 0.15; matched = true; }
    if (/冷漠|冷淡|冷酷|无情/.test(text)) { delta.温暖 = (delta.温暖 ?? 0) - 0.1; matched = true; }
    if (/沉稳|坚毅|冷静|理性/.test(text)) {
      delta.温暖 = (delta.温暖 ?? 0) + 0.1;
      delta.恐惧 = (delta.恐惧 ?? 0) - 0.05;
      matched = true;
    }

    // 后备：性格文本无匹配时，用角色名生成确定性签名确保角色间差异化
    if (!matched) {
      const hash = this.characterName.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
      delta.温暖 = ((hash * 7 + 3) % 20 - 10) / 100;
      delta.愧疚 = ((hash * 13 + 7) % 20 - 10) / 100;
      delta.悲伤 = ((hash * 17 + 11) % 20 - 10) / 100;
      delta.恐惧 = ((hash * 19 + 13) % 20 - 10) / 100;
      delta.愤怒 = ((hash * 23 + 17) % 20 - 10) / 100;
    }

    return delta;
  }

  private ensureRelationship(target: string, delta: Partial<RelationshipEntry>): void {
    if (!this.relationships.has(target)) {
      this.relationships.set(target, { target, ...DEFAULT_RELATIONSHIP_ENTRY });
    }
    const entry = this.relationships.get(target)!;
    if (delta.好感度 !== undefined) entry.好感度 = Math.max(-10, Math.min(10, entry.好感度 + delta.好感度));
    if (delta.信任度 !== undefined) entry.信任度 = Math.max(-10, Math.min(10, entry.信任度 + delta.信任度));
  }
}
