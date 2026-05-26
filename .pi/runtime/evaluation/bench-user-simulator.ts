/**
 * bench-user-simulator.ts — 长跑测试用户模拟器
 *
 * 用模板拼接模拟用户发言，不调用真实 LLM。
 * 6 种策略随机选，随叙事阶段自动调整权重。
 *
 * 策略：
 *   advance    推进：同意并推进剧情
 *   question   质疑：提出疑问
 *   twist      转折：引入新事件
 *   silent     沉默：简短确认
 *   emotion    情绪：表达强烈情绪
 *   recall     回忆：提起之前的事
 */

// ============================================================
// 策略权重表（按叙事阶段）
// ============================================================

export type StageName = 'build' | 'conflict' | 'deepen' | 'climax' | 'reflection';

export interface StageConfig {
  label: string;
  roundRange: [number, number];
  weights: Record<Strategy, number>;
}

export type Strategy = 'advance' | 'question' | 'twist' | 'silent' | 'emotion' | 'recall';

const STAGES: StageConfig[] = [
  { label: '建立关系', roundRange: [1, 30],  weights: { advance: 0.40, question: 0.20, twist: 0.10, silent: 0.10, emotion: 0.20, recall: 0.00 } },
  { label: '冲突挑战', roundRange: [31, 60], weights: { advance: 0.10, question: 0.30, twist: 0.30, silent: 0.10, emotion: 0.20, recall: 0.00 } },
  { label: '深化转折', roundRange: [61, 90], weights: { advance: 0.10, question: 0.10, twist: 0.35, silent: 0.05, emotion: 0.15, recall: 0.25 } },
  { label: '高潮解决', roundRange: [91, 120], weights: { advance: 0.25, question: 0.10, twist: 0.20, silent: 0.05, emotion: 0.30, recall: 0.10 } },
  { label: '结局反思', roundRange: [121, 150], weights: { advance: 0.20, question: 0.05, twist: 0.05, silent: 0.05, emotion: 0.30, recall: 0.35 } },
];

// ============================================================
// 模板库
// ============================================================

const TEMPLATES: Record<Strategy, string[]> = {
  advance: [
    "你说的{topic}，我觉得很有道理。{action}",
    "我同意你的看法，关于{topic}，我们试试看吧。{action}",
    "好，就按你说的来。{action}",
    "嗯，我明白了。那接下来呢？{action}",
    "你说得对，我们继续吧。{action}",
  ],
  question: [
    "你说的{topic}，我不太确定。能再解释一下吗？",
    "等等，关于{topic}，我有一个疑问……",
    "你说的这个{topic}，真的是这样吗？",
    "我不太明白你的意思，{topic}到底是怎么回事？",
    "可是之前不是说{topic}不能这样做吗？",
  ],
  twist: [
    "等等，你听到了吗？好像有奇怪的声音从那边传来。{action}",
    "我突然想起来一件事，关于{topic}……其实还有另一个版本。",
    "你看那边！好像有什么东西在动。{action}",
    "不好了，我刚才听到{topic}相关的消息，出事了。",
    "等一下，有人过来了。{action}",
  ],
  silent: [
    "嗯。",
    "好的。",
    "我听着呢。",
    "继续。",
    "嗯嗯。",
  ],
  emotion: [
    "你这样说，我真的很开心！{action}",
    "为什么……为什么会这样……我觉得好难过……",
    "我受不了了！我真的很生气！{action}",
    "谢谢你……真的谢谢你……{action}",
    "我好害怕，{topic}真的太可怕了……{action}",
    "哇！真的吗？太棒了！{action}",
  ],
  recall: [
    "说到{topic}，让我想起之前我们……那时候还挺好的。",
    "还记得上次关于{topic}的事吗？那次真是……",
    "我突然想起来了，{topic}这件事以前发生过类似的情况。",
    "说到这个，我记起有个人曾经也说过{topic}……",
    "这不是和之前{topic}那次一样吗？",
  ],
};

// ============================================================
// 名词/动作词库
// ============================================================

const TOPICS = [
  "天气", "明天", "计划", "这个", "那件事", "这里", "约定",
  "秘密", "过去", "未来", "选择", "关系", "信任", "冒险",
];

const ACTIONS = [
  "我们走吧。", "你继续说。", "然后呢？", "等等，那边是什么声音？",
  "我们去看看吧。", "我跟你一起。", "你先走，我马上来。",
  "我们得做点什么。", "就这样吧。", "你决定就好。",
];

const EMOTIONAL_NOUNS = [
  "约定", "秘密", "回忆", "信任", "羁绊", "诺言", "错误",
];

// ============================================================
// 用户模拟器
// ============================================================

export class UserSimulator {
  private round: number = 0;
  private memory: string[] = [];

  /** 记录提到过的名词（用于 recall 策略） */
  private mentionedNouns: string[] = [];

  /**
   * 根据当前轮数和 Agent 上条回复，生成模拟用户消息
   */
  generate(agentLastReply: string, currentRound?: number): string {
    if (currentRound !== undefined) this.round = currentRound;
    else this.round++;

    // 从 Agent 回复中提取名词
    const extracted = this.extractNouns(agentLastReply);
    for (const n of extracted) {
      if (!this.mentionedNouns.includes(n)) {
        this.mentionedNouns.push(n);
      }
    }

    // 选择策略
    const strategy = this.pickStrategy();

    // 选择模板
    const templates = TEMPLATES[strategy];
    const tmpl = templates[Math.floor(Math.random() * templates.length)];

    // 填充占位符
    let topic = this.pickTopic(strategy, agentLastReply);
    let action = ACTIONS[Math.floor(Math.random() * ACTIONS.length)];

    let message = tmpl
      .replace('{topic}', topic)
      .replace('{action}', action);

    // 如果生成的消息和上一条一模一样，换个模板
    if (this.memory.length > 0 && message === this.memory[this.memory.length - 1]) {
      const alt = templates[Math.floor(Math.random() * templates.length)];
      message = alt
        .replace('{topic}', this.pickTopic(strategy, agentLastReply))
        .replace('{action}', ACTIONS[Math.floor(Math.random() * ACTIONS.length)]);
    }

    this.memory.push(message);

    return message;
  }

  /**
   * 根据当前轮数选择策略
   */
  private pickStrategy(): Strategy {
    const stage = STAGES.find(s =>
      this.round >= s.roundRange[0] && this.round <= s.roundRange[1]
    ) ?? STAGES[0];

    const weights = stage.weights;
    const entries = Object.entries(weights) as [Strategy, number][];
    const r = Math.random();
    let cumulative = 0;

    for (const [strategy, weight] of entries) {
      cumulative += weight;
      if (r <= cumulative) return strategy;
    }

    return 'advance';
  }

  /**
   * 挑选 topic 占位符
   */
  private pickTopic(strategy: Strategy, agentReply: string): string {
    // recall 策略优先用之前提到过的名词
    if (strategy === 'recall' && this.mentionedNouns.length > 0) {
      const idx = Math.floor(Math.random() * this.mentionedNouns.length);
      return this.mentionedNouns[idx];
    }

    // 从 Agent 回复中提取名词
    const extracted = this.extractNouns(agentReply);
    if (extracted.length > 0) {
      return extracted[Math.floor(Math.random() * extracted.length)];
    }

    // 阶段性情绪名词
    if (strategy === 'emotion' || strategy === 'recall') {
      return EMOTIONAL_NOUNS[Math.floor(Math.random() * EMOTIONAL_NOUNS.length)];
    }

    return TOPICS[Math.floor(Math.random() * TOPICS.length)];
  }

  /**
   * 从文本中提取名词（简单规则：2-4 个中文字符的词）
   */
  private extractNouns(text: string): string[] {
    if (!text) return [];
    const nouns: string[] = [];
    // 匹配中文字符序列
    const matches = text.match(/[\u4e00-\u9fff]{2,6}/g);
    if (matches) {
      const stopWords = ['我们', '他们', '自己', '什么', '怎么', '因为', '所以', '可以', '没有', '那个', '这个', '一下', '起来', '如果', '还是', '就是', '但是', '不是', '一个', '可能', '知道', '觉得', '时候', '已经', '应该', "不要", "一起", "之后"];
      for (const m of matches) {
        if (!stopWords.includes(m) && !nouns.includes(m)) {
          nouns.push(m);
        }
      }
    }
    return nouns.slice(0, 3);
  }

  /**
   * 获取当前叙事阶段
   */
  getCurrentStage(): StageConfig {
    return STAGES.find(s =>
      this.round >= s.roundRange[0] && this.round <= s.roundRange[1]
    ) ?? STAGES[0];
  }

  getRound(): number { return this.round; }
  reset(): void {
    this.round = 0;
    this.memory = [];
    this.mentionedNouns = [];
  }
}

export default UserSimulator;
