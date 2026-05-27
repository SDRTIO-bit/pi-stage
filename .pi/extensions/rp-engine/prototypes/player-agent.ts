/**
 * RP Engine - Player Agent
 *
 * 玩家化身 Agent。将用户在对话中的自然语言选择翻译为
 * 其他 Agent 可理解的影响向量，追踪用户化身的状态和记忆。
 *
 * 职责：
 * - 行为分析：从用户消息提取动作类型、情感倾向、对各 NPC 的影响
 * - 影响向量：输出 UserActionImpact 供 CharacterAgent 消费
 * - 状态更新：更新用户化身需求（疲劳/饥饿/社交）、情感倾向
 * - 个人记忆：关联 MemoryStore 的用户桶
 *
 * 数据来源（零硬编码）：
 * - 角色卡的 {{user}} 描述提取化身定义
 * - 用户实际输入文本
 * - MemoryStore 用户桶的历史交互
 */

// ============================================================
// 类型定义
// ============================================================

/** 用户行为分析结果 */
export interface UserActionImpact {
  /** 动作类型 */
  actionType: ActionType;
  /** 情感倾向 */
  emotionalTendency: EmotionalTendency;
  /** 对每个 NPC 的影响值（-10 到 +10） */
  targetImpacts: Record<string, number>;
  /** 对每个 NPC 的情绪影响 delta */
  emotionalImpacts: Record<string, Partial<EmotionalDelta>>;
  /** 行为强度 0-1 */
  intensity: number;
}

/** 动作类型分类 */
export type ActionType =
  | '安慰'
  | '质问'
  | '沉默'
  | '肢体接触'
  | '离开'
  | '靠近'
  | '赠予'
  | '道歉'
  | '命令'
  | '请求'
  | '陈述'
  | '其他';

/** 情感倾向 */
export type EmotionalTendency = '温暖' | '冷淡' | '愧疚' | '愤怒' | '恐惧' | '中性';

/** 情绪影响 delta（与 CharacterAgent 的 EmotionalState 对应） */
export interface EmotionalDelta {
  温暖: number;
  愧疚: number;
  悲伤: number;
  恐惧: number;
  愤怒: number;
}

/** 玩家化身状态 */
export interface PlayerAvatarState {
  /** 疲劳度 0-10 */
  fatigue: number;
  /** 饥饿度 0-10 */
  hunger: number;
  /** 社交需求 0-10 */
  socialNeed: number;
  /** 对每个 NPC 的情感倾向（累积） */
  affections: Record<string, number>;
  /** 最后活动记录 */
  lastActivity: string;
}

export const DEFAULT_PLAYER_STATE: PlayerAvatarState = {
  fatigue: 3,
  hunger: 3,
  socialNeed: 5,
  affections: {},
  lastActivity: '',
};

// ============================================================
// 关键词规则映射（纯数据驱动，可扩展）
// ============================================================

interface ActionRule {
  patterns: RegExp[];
  type: ActionType;
}

const ACTION_RULES: ActionRule[] = [
  { patterns: [/安慰/, /别难过/, /没事的/, /拍了拍/, /轻抚/, /拥抱/, /抱紧/], type: '安慰' },
  { patterns: [/质问/, /为什么/, /怎么回事/, /解释/, /你说清楚/], type: '质问' },
  { patterns: [/沉默/, /不语/, /不说话/, /静静/, /一言不发/], type: '沉默' },
  { patterns: [/牵[起着手]/, /抱住/, /搂住/, /亲吻/, /抚摸/, /触碰/], type: '肢体接触' },
  { patterns: [/离开/, /转身/, /走出去/, /推开门/, /走远/, /走向门外/, /向.*走[去向]/, /出[去了门]/, /迈步/], type: '离开' },
  { patterns: [/走近/, /靠近/, /来到/, /进门/, /走上前/, /走到/, /走向.*[来近]/, /来到.*面前/, /朝.*走去/, /迎上去/], type: '靠近' },
  { patterns: [/递给/, /送给/, /给.*[了]?$/, /赠/, /递过/, /塞到/, /交到/], type: '赠予' },
  { patterns: [/抱歉/, /对不起/, /是我的错/, /我错了/, /是我不好/, /请原谅/, /赔罪/], type: '道歉' },
  { patterns: [/去.*做/, /命令/, /你给我/, /马上/, /去把/, /给我去/], type: '命令' },
  { patterns: [/请问/, /可以.*[吗么]/, /能.*[吗么]/, /拜托/, /麻烦你/, /帮我/, /好吗/, /行吗/], type: '请求' },
  { patterns: [/去找/, /去[^把给做].*$/, /叫.*来/, /喊.*来/], type: '靠近' },
];

interface EmotionRule {
  patterns: RegExp[];
  tendency: EmotionalTendency;
}

const EMOTION_RULES: EmotionRule[] = [
  { patterns: [/温柔/, /心疼/, /怜惜/, /轻轻/, /温柔地/, /柔声/], tendency: '温暖' },
  { patterns: [/冷冷/, /冷漠/, /懒得/, /不理/, /冷淡/, /不耐烦/], tendency: '冷淡' },
  { patterns: [/对不起/, /抱歉/, /愧疚/, /亏欠/, /是我不好/, /罪/], tendency: '愧疚' },
  { patterns: [/混蛋/, /滚/, /闭嘴/, /厌烦/, /憎恨/, /怒/], tendency: '愤怒' },
  { patterns: [/害怕/, /瑟瑟/, /发抖/, /恐惧/, /恐惧/, /畏缩/], tendency: '恐惧' },
];

/** 动作类型 → 影响 NPC 情绪映射 */
const ACTION_EMOTION_MAP: Record<string, Partial<EmotionalDelta>> = {
  '安慰': { 温暖: 0.15, 愧疚: -0.05, 悲伤: -0.1 },
  '质问': { 恐惧: 0.1, 愤怒: 0.1, 温暖: -0.1 },
  '沉默': { 恐惧: 0.05, 愧疚: 0.05 },
  '肢体接触': { 温暖: 0.2, 愧疚: 0.05 },
  '离开': { 悲伤: 0.1, 恐惧: 0.05, 温暖: -0.1 },
  '靠近': { 温暖: 0.1 },
  '赠予': { 温暖: 0.2, 愧疚: -0.05 },
  '道歉': { 愧疚: -0.1, 温暖: 0.05 },
  '命令': { 愤怒: 0.15, 恐惧: 0.15, 温暖: -0.15 },
  '请求': { 温暖: 0.05 },
};

// ============================================================
// PlayerAgent
// ============================================================

export class PlayerAgent {
  readonly avatarName: string;
  state: PlayerAvatarState;

  /** 化身描述（从角色卡 {{user}} 提取） */
  avatarDescription: string;

  constructor(avatarName: string, description?: string) {
    this.avatarName = avatarName;
    this.avatarDescription = description || '';
    this.state = { ...DEFAULT_PLAYER_STATE, affections: {} };
  }

  // ============================================================
  // 行为分析
  // ============================================================

  /**
   * 分析用户消息，生成影响向量
   *
   * @param userText 用户输入文本
   * @param sceneCharacters 当前场景中的角色列表
   */
  analyze(userText: string, sceneCharacters: string[]): UserActionImpact {
    const actionType = this.detectActionType(userText);
    const tendency = this.detectEmotionalTendency(userText);
    const targetImpacts = this.computeTargetImpacts(tendency, sceneCharacters);
    const intensity = this.computeIntensity(userText, tendency);
    const rawImpacts = this.computeEmotionalImpacts(actionType, sceneCharacters);
    const emotionalImpacts = this.scaleImpactsByIntensity(rawImpacts, intensity);

    console.log(`[PlayerAgent] analyze 输入(前200): ${userText.slice(0, 200).replace(/\n/g, ' ')}`);
    console.log(`[PlayerAgent] 检测结果: actionType=${actionType} tendency=${tendency} intensity=${intensity.toFixed(2)} targets=${sceneCharacters.join(',')}`);
    console.log(`[PlayerAgent] emotionalImpacts:`, JSON.stringify(emotionalImpacts));

    return {
      actionType,
      emotionalTendency: tendency,
      targetImpacts,
      emotionalImpacts,
      intensity,
    };
  }

  /** 检测动作类型 */
  private detectActionType(text: string): ActionType {
    for (const rule of ACTION_RULES) {
      for (const p of rule.patterns) {
        if (p.test(text)) return rule.type;
      }
    }
    return '陈述';
  }

  /** 检测情感倾向 */
  private detectEmotionalTendency(text: string): EmotionalTendency {
    for (const rule of EMOTION_RULES) {
      for (const p of rule.patterns) {
        if (p.test(text)) return rule.tendency;
      }
    }
    return '中性';
  }

  /** 计算对每个在场 NPC 的影响值 */
  private computeTargetImpacts(
    tendency: EmotionalTendency,
    characters: string[]
  ): Record<string, number> {
    const baseMap: Record<string, number> = {
      '温暖': 3,
      '冷淡': -2,
      '愧疚': -1,
      '愤怒': -4,
      '恐惧': -1,
      '中性': 0,
    };
    const base = baseMap[tendency] ?? 0;
    const impacts: Record<string, number> = {};
    for (const name of characters) {
      // 基于历史情感倾向调整
      const history = this.state.affections[name] ?? 0;
      impacts[name] = Math.max(-10, Math.min(10, base + history * 0.1));
    }
    return impacts;
  }

  /** 计算对每个在场 NPC 的情绪影响 */
  private computeEmotionalImpacts(
    actionType: ActionType,
    characters: string[]
  ): Record<string, Partial<EmotionalDelta>> {
    const baseDelta = ACTION_EMOTION_MAP[actionType] ?? {};
    // intensity 尚未计算完，在 analyze() 中统一缩放
    const impacts: Record<string, Partial<EmotionalDelta>> = {};
    for (const name of characters) {
      impacts[name] = { ...baseDelta };
    }
    return impacts;
  }

  /**
   * 用 intensity 缩放 emotionalImpacts
   * 在 analyze() 最后一步调用
   */
  private scaleImpactsByIntensity(
    impacts: Record<string, Partial<EmotionalDelta>>,
    intensity: number
  ): Record<string, Partial<EmotionalDelta>> {
    const factor = 0.3 + intensity * 0.7; // intensity=0 → 0.3x, intensity=1 → 1.0x
    const scaled: Record<string, Partial<EmotionalDelta>> = {};
    for (const [name, delta] of Object.entries(impacts)) {
      const s: Partial<EmotionalDelta> = {};
      for (const k of Object.keys(delta) as (keyof EmotionalDelta)[]) {
        s[k] = (delta[k] ?? 0) * factor;
      }
      scaled[name] = s;
    }
    return scaled;
  }

  /** 计算行为强度 */
  private computeIntensity(text: string, tendency: EmotionalTendency): number {
    const length = text.length;
    const base = Math.min(1, length / 100);

    // 情感倾向调整
    const intensityMap: Record<string, number> = {
      '愤怒': 0.2, '温暖': 0.1, '冷淡': 0.1, '愧疚': 0.1, '恐惧': 0.15, '中性': 0,
    };
    return Math.min(1, base + (intensityMap[tendency] ?? 0));
  }

  // ============================================================
  // 状态更新
  // ============================================================

  /**
   * 根据用户选择更新化身状态
   *
   * @param impact 行为分析结果
   * @param activityOverride 手动指定活动（如用户说了"去睡觉"）
   */
  updateState(impact: UserActionImpact, activityOverride?: string): void {
    // 更新疲劳
    const fatigueDelta: Record<string, number> = {
      '肢体接触': 0.3,
      '离开': 0.1,
      '沉默': 0.0,
      '陈述': 0.1,
    };
    this.state.fatigue = Math.max(0, Math.min(10,
      this.state.fatigue + (fatigueDelta[impact.actionType] ?? 0.2)));

    // 更新社交需求
    const socialDelta: Record<string, number> = {
      '沉默': 0.3,
      '离开': 0.5,
      '安慰': -0.3,
      '靠近': -0.5,
      '陈述': 0.1,
    };
    this.state.socialNeed = Math.max(0, Math.min(10,
      this.state.socialNeed + (socialDelta[impact.actionType] ?? 0.2)));

    // 更新对各 NPC 的情感倾向
    for (const [name, delta] of Object.entries(impact.targetImpacts)) {
      this.state.affections[name] = (this.state.affections[name] ?? 0) + delta * 0.1;
    }

    // 更新最后活动
    this.state.lastActivity = activityOverride || impact.actionType;
  }

  /** 获取对指定 NPC 的情感倾向 */
  getAffection(target: string): number {
    return this.state.affections[target] ?? 0;
  }

  /** 获取化身状态快照 */
  getState(): PlayerAvatarState {
    return { ...this.state, affections: { ...this.state.affections } };
  }

  // ============================================================
  // 快照
  // ============================================================

  toSnapshot(): Record<string, unknown> {
    return {
      avatarName: this.avatarName,
      state: this.state,
      avatarDescription: this.avatarDescription,
    };
  }

  fromSnapshot(snapshot: Record<string, unknown>): void {
    const data = snapshot as any;
    this.state = data.state ?? { ...DEFAULT_PLAYER_STATE, affections: {} };
    this.avatarDescription = data.avatarDescription ?? '';
  }

  /** 重置化身状态 */
  reset(): void {
    this.state = { ...DEFAULT_PLAYER_STATE, affections: {} };
  }
}
