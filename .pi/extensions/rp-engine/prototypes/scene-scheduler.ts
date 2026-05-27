/**
 * RP Engine - SceneScheduler 原型
 *
 * 基于 AdaMARP Scene Manager 概念的 TypeScript 移植。
 * 作为 World Agent 和叙事 Agent 之间的"导演"，管理场景切换和发言人选择。
 *
 * 架构：
 * - SceneScheduler 可独立运行，也可作为 World Agent 的子模块
 * - 5种调度动作: init_scene / pick_speaker / switch_scene / add_role / end
 * - 原型阶段为规则驱动，后续可升级为 LLM 驱动
 * - 与 MemoryStore 配合：调度决策可查询历史记忆
 *
 * 注意：此文件为类骨架原型，尚未接入主流程。
 */

// ============================================================
// 类型定义
// ============================================================

export type SceneActionTag =
  | 'init_scene'
  | 'pick_speaker'
  | 'switch_scene'
  | 'add_role'
  | 'end';

export interface SceneAction {
  action: SceneActionTag;
  rationale: string;
  // init_scene
  initialScene?: string;
  // pick_speaker
  speaker?: string;
  // switch_scene
  targetScene?: string;
  // add_role
  role?: string;
  roleProfile?: string;
  roleMotivation?: string;
}

export interface Scene {
  id: string;
  name: string;
  description: string;
  activeCharacters: string[];
  turnCount: number;
  maxTurns: number;
  metadata: Record<string, unknown>;
  startedAt: number;
}

export interface CharacterState {
  name: string;
  turnCount: number;
  lastSpokeAt: number;    // unix ms
  emotion?: string;
  location?: string;
}

export interface SceneSchedulerContext {
  storyPremise: string;
  scenes: Scene[];
  activeCharacters: string[];
  characterStates: Record<string, CharacterState>;
  turnCount: number;
  maxTurns: number;
  recentEvents: string[];     // 最近的文本事件（来自 MemoryStore）
  /** 等待引入的角色队列 */
  pendingRoles: PendingRole[];
}

export interface PendingRole {
  name: string;
  profile: string;
  motivation: string;
  introduceAfterTurn: number; // 多少轮后引入
}

/** 场景切换评估结果 */
export interface SceneTransitionResult {
  name: string;
  description: string;
}

export interface SceneSchedulerConfig {
  maxSceneTurns: number;
  maxTotalTurns: number;
  roleIntroInterval: number;
  endSilenceTurns: number;
  speakerRandomness: number;
}

export const DEFAULT_SCHEDULER_CONFIG: SceneSchedulerConfig = {
  maxSceneTurns: 10,
  maxTotalTurns: 50,
  roleIntroInterval: 5,
  endSilenceTurns: 3,
  speakerRandomness: 0.2,
};

// ============================================================
// 4 通道消息解析器
// ============================================================

export interface ParsedMessage {
  thought: string[];
  action: string[];
  env: string[];
  speech: string;
}

export function parseFourChannel(text: string): ParsedMessage {
  const thought: string[] = [];
  const action: string[] = [];
  const env: string[] = [];

  let remaining = text;

  // 提取 <<Environment>>
  const envRegex = /<<(.*?)>>/g;
  let match: RegExpExecArray | null;
  while ((match = envRegex.exec(text)) !== null) {
    env.push(match[1].trim());
  }
  remaining = remaining.replace(/<<.*?>>/g, '');

  // 提取 [Thought]
  const thoughtRegex = /\[(.*?)\]/g;
  while ((match = thoughtRegex.exec(text)) !== null) {
    thought.push(match[1].trim());
  }
  remaining = remaining.replace(/\[.*?\]/g, '');

  // 提取 (Action)
  const actionRegex = /\((.*?)\)/g;
  while ((match = actionRegex.exec(text)) !== null) {
    action.push(match[1].trim());
  }
  remaining = remaining.replace(/\(.*?\)/g, '');

  return {
    thought,
    action,
    env,
    speech: remaining.trim(),
  };
}

/** 构建 prompt 要求 4 通道格式 */
export function buildFourChannelPrompt(): string {
  return [
    '请使用以下格式生成回复：',
    '- [内心想法] 用方括号包裹角色的内心独白',
    '- (动作描述) 用圆括号包裹角色的身体动作',
    '- <<环境描述>> 用双尖括号包裹环境变化',
    '- 对话内容 直接输出，无需标记',
    '',
    '示例：',
    '<<阳光透过彩色玻璃洒落>>(她抬起头，眯起眼睛)[他看起来有些紧张。]你还好吗？',
  ].join('\n');
}

// ============================================================
// 场景管理器
// ============================================================

export class SceneScheduler {
  private config: SceneSchedulerConfig;
  private sceneCounter = 0;
  private scenes: Scene[] = [];

  constructor(config?: Partial<SceneSchedulerConfig>) {
    this.config = { ...DEFAULT_SCHEDULER_CONFIG, ...config };
  }

  /** 距离上次场景切换的轮数（由外部调用 evaluateTransition 管理） */
  turnsSinceLastChange = 0;

  /** 获取当前场景 */
  getCurrentScene(): Scene | undefined {
    return this.scenes.length > 0 ? this.scenes[this.scenes.length - 1] : undefined;
  }

  /** 获取所有场景 */
  getAllScenes(): Scene[] {
    return [...this.scenes];
  }

  /**
   * 评估场景转折点
   * @param roundSummary 本轮摘要文本（检测关键词用）
   * @param _currentSceneId 当前场景标识
   * @param turnsSinceLastChange 距离上次场景切换的轮数
   * @returns SceneTransitionResult（含 name 和 description），或 null（不切换）
   */
  evaluateTransition(
    roundSummary: string,
    _currentSceneId: string,
    turnsSinceLastChange: number
  ): SceneTransitionResult | null {
    const current = this.getCurrentScene();
    if (!current) return null;

    // 条件 A：场景超出最大轮数 → 强制切换
    if (current.turnCount >= current.maxTurns) {
      return this.buildTransitionResult(roundSummary);
    }

    // 条件 B：长时间无切换 → 建议切换
    if (turnsSinceLastChange >= this.config.maxSceneTurns) {
      return this.buildTransitionResult(roundSummary);
    }

    // 条件 C：关键词触发 + 冷却 ≥ 3 轮
    if (turnsSinceLastChange >= 3 && this.detectTransitionKeyword(roundSummary)) {
      return this.buildTransitionResult(roundSummary);
    }

    return null;
  }

  /**
   * 从 roundSummary 构建场景切换结果
   * 提取地点 + 情感关键词，组合为 "地点 — 情感阶段" 格式
   */
  private buildTransitionResult(summary: string): SceneTransitionResult {
    const location = this.extractLocation(summary);
    const emotion = this.extractEmotion(summary);
    const chars = this.getCurrentScene()?.activeCharacters || [];

    const sceneName = `${location} — ${emotion}`;
    const description = [
      `【场景】${sceneName}`,
      `【在场角色】${chars.join('、')}`,
      `【环境简述】${location}。${emotion}。`,
    ].join('\n');

    return { name: sceneName, description };
  }

  /**
   * 公共方法：从 roundSummary 生成场景名
   * 供 turn.ts 在规则触发的场景切换中使用，确保命名一致性
   */
  generateSceneName(summary: string): string {
    const location = this.extractLocation(summary);
    const emotion = this.extractEmotion(summary);
    return `${location} — ${emotion}`;
  }

  /** 地点关键词集 */
  private readonly LOCATION_WORDS = [
    '院子', '灶房', '堂屋', '西厢房', '东厢房', '正房', '后院', '前院',
    '花园', '书房', '卧室', '客厅', '厨房', '餐厅', '门口', '树下',
    '床边', '窗前', '屋檐下', '走廊', '楼梯', '天台', '阳台', '浴室',
    '凉亭', '湖畔', '河边', '山上', '村口', '巷口', '街角', '屋顶',
    '马厩', '柴房', '地窖', '阁楼', '井边', '桥头',
  ];

  /** 地点别名映射：口语/现代名 → 场景地点词 */
  private readonly LOCATION_ALIASES: Record<string, string> = {
    '厨房': '灶房',
    '卫生间': '浴室',
    '洗手间': '浴室',
    '厕所': '浴室',
    '睡房': '卧室',
    '大厅': '堂屋',
    '正厅': '堂屋',
    '庭院': '院子',
    '天井': '院子',
    '露台': '天台',
    '门外': '门口',
    '大门': '门口',
    '后门': '门口',
    '窗边': '窗前',
    '窗口': '窗前',
    '大树下': '树下',
    '树荫': '树下',
    '酒店': '屋内',
    '房间': '屋内',
    '屋里': '屋内',
    '室内': '屋内',
  };

  /** 从 roundSummary 中提取地点 */
  private extractLocation(summary: string): string {
    // 1. 直接匹配地点词
    for (const w of this.LOCATION_WORDS) {
      if (summary.includes(w)) return w;
    }
    // 2. 查别名映射表
    for (const [alias, canonical] of Object.entries(this.LOCATION_ALIASES)) {
      if (summary.includes(alias)) return canonical;
    }
    // 3. 降级 — 检测是否在户外
    if (/出去|外面|出门|外头|户外/.test(summary)) return '院中';
    return '屋内';
  }

  /** 情感阶段关键词映射 */
  private readonly EMOTION_MAP: [string, string[]][] = [
    ['月光下的对峙',     ['对峙', '沉默', '僵持', '对视']],
    ['爆发与冲突',       ['爆发', '争吵', '怒吼', '冲突', '动手']],
    ['风暴后的平静',     ['平静', '平息', '冷静', '缓和']],
    ['暗流涌动',         ['汹涌', '暗流', '起伏', '不安', '压抑']],
    ['暧昧与试探',       ['暧昧', '试探', '靠近', '触碰', '凝视']],
    ['温柔时刻',         ['温柔', '拥抱', '依偎', '轻抚', '微笑']],
    ['温馨日常',         ['温馨', '日常', '谈笑', '闲聊', '做饭']],
    ['尴尬与微妙',       ['尴尬', '微妙', '难堪', '别扭', '局促']],
    ['欢快时光',         ['欢快', '大笑', '嬉戏', '玩笑', '活泼']],
    ['感伤与怀念',       ['感伤', '怀念', '伤感', '叹息', '回忆']],
    ['紧张与焦虑',       ['紧张', '焦虑', '忐忑', '不安', '担心']],
    ['期待与憧憬',       ['期待', '憧憬', '盼望', '希望']],
    ['失落与失望',       ['失落', '失望', '沮丧', '落寞']],
    ['愤怒与怨恨',       ['愤怒', '怨恨', '憎恨', '恼怒', '恼火']],
    ['缓冲与温柔',       ['缓冲', '不急了', '算了', '慢慢', '让步', '低头']],
  ];

  /** 从 roundSummary 中提取情感阶段 */
  private extractEmotion(summary: string): string {
    for (const [phase, words] of this.EMOTION_MAP) {
      for (const w of words) {
        if (summary.includes(w)) return phase;
      }
    }
    return '日常';
  }

  /**
   * 检测 roundSummary 中是否包含场景转折关键词
   * 返回 boolean（仅用于快速判定），实际命名由 buildTransitionResult 完成
   */
  private detectTransitionKeyword(summary: string): boolean {
    const keywords: Record<string, string[]> = {
      空间变化: ['走到', '离开', '进入', '回到', '去了', '出来', '进来', '出去'],
      时间推进: ['第二天', '次日', '天亮', '夜深', '清晨', '过了几天'],
      关系转折: ['第一次', '终于', '突然', '不再', '开始', '拍了拍', '握住', '抱住', '蹲下来', '平视', '掉下来'],
      新角色: ['来了', '回来了', '进门'],
    };

    for (const [category, words] of Object.entries(keywords)) {
      for (const word of words) {
        if (summary.includes(word)) {
          console.log(`[SceneScheduler] 检测到${category}关键词: "${word}"`);
          return true;
        }
      }
    }
    return false;
  }

  /** 主决策入口 */
  decide(context: SceneSchedulerContext): SceneAction {
    // 1. 终止条件检查
    if (context.turnCount >= context.maxTurns) {
      return {
        action: 'end',
        rationale: `达到最大对话轮次 ${context.maxTurns}`,
      };
    }

    // 2. 无场景 → init
    if (context.scenes.length === 0) {
      return this.decideInitScene(context);
    }

    const currentScene = context.scenes[context.scenes.length - 1];

    // 3. 场景切换
    if (currentScene.turnCount >= currentScene.maxTurns) {
      return this.decideSwitchScene(context, currentScene);
    }

    // 4. 角色引入
    const eligibleRoles = context.pendingRoles.filter(
      (r) => context.turnCount >= r.introduceAfterTurn
    );
    if (
      eligibleRoles.length > 0 &&
      context.turnCount > 0 &&
      context.turnCount % this.config.roleIntroInterval === 0
    ) {
      return this.decideAddRole(eligibleRoles[0]);
    }

    // 5. pick_speaker（默认）
    return this.decidePickSpeaker(context);
  }

  /** 记录场景已进行一轮 */
  recordTurn(scene: Scene): void {
    scene.turnCount++;
  }

  /** 创建新场景并加入场景列表 */
  createScene(
    description: string,
    characters: string[],
    name?: string
  ): Scene {
    this.sceneCounter++;
    const scene: Scene = {
      id: `scene_${this.sceneCounter}`,
      name: name ?? `场景 ${this.sceneCounter}`,
      description,
      activeCharacters: [...characters],
      turnCount: 0,
      maxTurns: this.config.maxSceneTurns,
      metadata: {},
      startedAt: Date.now(),
    };
    this.scenes.push(scene);
    return scene;
  }

  /** 生成叙事 Agent 用的场景上下文 prompt */
  buildScenePrompt(
    scene: Scene,
    memoryContext: string,
    additionalInstructions?: string
  ): string {
    const parts: string[] = [
      `【当前场景】${scene.description}`,
      `【在场角色】${scene.activeCharacters.join(', ')}`,
      '',
    ];

    if (memoryContext) {
      parts.push('【相关记忆】');
      parts.push(memoryContext);
      parts.push('');
    }

    if (additionalInstructions) {
      parts.push('【额外指令】');
      parts.push(additionalInstructions);
      parts.push('');
    }

    parts.push(buildFourChannelPrompt());

    return parts.join('\n');
  }

  // ---- 决策实现 ----

  private decideInitScene(context: SceneSchedulerContext): SceneAction {
    return {
      action: 'init_scene',
      initialScene: context.storyPremise,
      rationale: '初始化故事场景',
    };
  }

  private decideSwitchScene(
    context: SceneSchedulerContext,
    currentScene: Scene
  ): SceneAction {
    const nextChar = this.pickNextCharacterForScene(context, currentScene);
    const targetDesc = nextChar
      ? `${nextChar}前往新地点继续探索`
      : '场景自然转换到下一个地点';

    return {
      action: 'switch_scene',
      targetScene: targetDesc,
      rationale: `当前场景 "${currentScene.name}" 已完成 ${currentScene.maxTurns} 轮对话，需要切换场景推进剧情`,
    };
  }

  private decideAddRole(role: PendingRole): SceneAction {
    return {
      action: 'add_role',
      role: role.name,
      roleProfile: role.profile,
      roleMotivation: role.motivation,
      rationale: `引入新角色 "${role.name}" 以推进剧情`,
    };
  }

  private decidePickSpeaker(context: SceneSchedulerContext): SceneAction {
    const speaker = this.selectSpeaker(context);
    return {
      action: 'pick_speaker',
      speaker,
      rationale: `由 ${speaker} 继续当前对话`,
    };
  }

  /** 发言人选择：最少发言优先 + 随机因子 */
  private selectSpeaker(context: SceneSchedulerContext): string {
    const { activeCharacters, characterStates } = context;
    if (activeCharacters.length === 0) {
      throw new Error('无活跃角色，无法选择发言人');
    }
    if (activeCharacters.length === 1) return activeCharacters[0];

    const scored = activeCharacters.map((name) => {
      const state = characterStates[name];
      const baseScore = -(state?.turnCount ?? 0);
      const randomness = 1 - this.config.speakerRandomness + Math.random() * this.config.speakerRandomness * 2;
      return { name, score: baseScore * randomness };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0].name;
  }

  /** 为场景切换选择下一个主要角色 */
  private pickNextCharacterForScene(
    context: SceneSchedulerContext,
    currentScene: Scene
  ): string | null {
    const notInScene = context.activeCharacters.filter(
      (c) => !currentScene.activeCharacters.includes(c)
    );
    if (notInScene.length > 0) return notInScene[0];
    return null;
  }
}
