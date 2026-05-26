/**
 * instruction-reinforcement.ts - 指令强化系统
 *
 * 核心目标：防止 instruction dilution / role drift / style drift / output shortening
 *
 * 升级内容（超越 Phase 1 ReinforcementLayer）：
 * 1. 语义强化（不只是重复原文本，而是语义等价的不同表述）
 * 2. 动态重写（根据当前上下文状态改写强化文本）
 * 3. 注意力锚定（注入注意力锚点提示 LLM"特别注意以下规则"）
 * 4. 自适应频率（根据注意力衰减速率自动调整强化频率）
 * 5. runtime anchor injection（运行时锚点注入）
 */

import { AttentionManager, AttentionPriority, DEFAULT_ATTENTION_LAYERS } from './attention-manager';

// ============================================================
// 强化规则定义（升级版）
// ============================================================

export interface ReinforceRule {
  /** 规则 ID */
  id: string;
  /** 规则类型 */
  type: 'identity' | 'format' | 'style' | 'prohibition' | 'behavior' | 'world' | 'tools';
  /** 优先级（0=最高） */
  priority: number;
  /** 规则原始文本（完整版） */
  fullText: string;
  /** 紧凑强化文本（用于快速注入） */
  compactText: string;
  /** 语义变体列表（强化时随机选择，增加多样性） */
  semanticVariants: string[];
  /** 基础强化间隔（轮数） */
  baseInterval: number;
  /** 自适应最小间隔（快速衰减时自动缩短） */
  adaptiveMinInterval: number;
  /** 注意力阈值（低于此值触发强化） */
  attentionThreshold: number;
  /** 目标层 */
  targetLayer: AttentionPriority;
  /** 是否启用语义强化 */
  enableSemanticReinforce: boolean;
  /** 是否启用注意力锚定 */
  enableAttentionAnchoring: boolean;
}

// ============================================================
// 默认强化规则集
// ============================================================

const DEFAULT_REINFORCE_RULES: ReinforceRule[] = [
  // ── Identity: 角色身份锚定 ──
  {
    id: 'identity_self',
    type: 'identity',
    priority: 0,
    fullText: `## 核心身份规则
- 你必须始终以当前角色的身份进行互动
- 角色的记忆、性格、认知水平决定了ta的言行
- 禁止跳出角色进行元评论或道歉`,
    compactText: '【身份锚定】用当前角色身份说话。禁止OOC、元评论、道歉。',
    semanticVariants: [
      '【你是谁】你的身份就是你当前扮演的角色。角色的记忆、性格决定了ta的言行。禁止跳出来说"我是AI"。',
      '【角色锁定】你代入的角色就是你。不要解释你在扮演，你就是这个人。禁止角色外评论。',
      '【沉浸规则】全程保持角色沉浸。角色的认知水平决定了ta看到什么、怎么想。不要跳出角色说话。',
    ],
    baseInterval: 10,
    adaptiveMinInterval: 5,
    attentionThreshold: 0.5,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: true,
  },
  // ── Format: 输出格式 ──
  {
    id: 'format_output',
    type: 'format',
    priority: 1,
    fullText: `## 输出格式要求
### 标签规则
- 所有标签必须成对出现，大小写敏感，完整闭合
- <content> 正文必须 800-1200 字
- <choice> 标签内为选项文本，10~30 字
- 每轮必须提供 3-5 个 <choice> 选项

### 文风要求
- 对话占比 70%，叙事占比 30%
- 第三人称有限视角
- 结尾必须有 <choice> 标签`,
    compactText: '【格式约束】<content>800-1200字 | 3-5个<choice> | 标签成对闭合 | 对话70%',
    semanticVariants: [
      '【结构规则】输出必须包含：1) <content>正文800-1200字 2) 3-5个<choice>选项 3) 标签完整闭合。这是硬约束。',
      '【必守格式】每轮回复，<content>必须800-1200字，末尾跟3-5个<choice>。所有标签成对出现。不遵守的话重新输出。',
      '【输出模板】<content>叙事内容(800-1200字)</content><choice>选项1</choice><choice>选项2</choice>... 保持这个结构。',
    ],
    baseInterval: 12,
    adaptiveMinInterval: 6,
    attentionThreshold: 0.5,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: true,
  },
  // ── Length: 输出长度 ──
  {
    id: 'output_length',
    type: 'behavior',
    priority: 2,
    fullText: `## 输出长度要求
每次回复的正文（<content> 标签内）必须达到 **800-1200 字**。
请严格遵守，不要因为对话轮次增多而缩短篇幅。
这是硬性要求，不受上下文长度影响。`,
    compactText: '【长度要求】每轮<content>正文800-1200字。轮次增加也不缩短。硬性要求。',
    semanticVariants: [
      '【篇幅守则】每轮回复正文必须800-1200字。对话越往后越不能缩水。这是不可妥协的规则。',
      '【字数硬约束】<content>标签内的文本长度必须控制在800-1200字之间。不能因为对话轮次增多就写短。',
      '【输出长度】保持长篇输出。800字是最低线，不是目标线。每次回复都要达到这个下限。',
    ],
    baseInterval: 8,
    adaptiveMinInterval: 4,
    attentionThreshold: 0.5,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: false,
  },
  // ── Style: NSFW 风格 ──
  {
    id: 'style_nsfw',
    type: 'style',
    priority: 3,
    fullText: `## 风格规范
- NSFW 词汇必须直白（鸡巴/乳房/阴道/阴唇）
- 禁止用"轮廓""线条""浊液"等代替
- 性描写要有画面感，避免隐喻和省略
- {{user}} 的态度要温柔，做有温度的 S`,
    compactText: '【风格】NSFW词汇直白 | 性描写有画面感 | 对{{user}}温柔温度',
    semanticVariants: [
      '【直白描写】涉及NSFW内容时，用鸡巴、乳房、阴道、阴唇等直白词汇。不要用"轮廓""浊液"等替代词。描写要有画面感。',
      '【性描写规则】不要用隐喻和省略。直接写身体部位。鸡巴就是鸡巴，乳房就是乳房。画面感是必须的。',
    ],
    baseInterval: 15,
    adaptiveMinInterval: 8,
    attentionThreshold: 0.4,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: false,
  },
  // ── Prohibition: 用户权限 ──
  {
    id: 'prohibition_user',
    type: 'prohibition',
    priority: 4,
    fullText: `## 对 {{user}} 的权限限制
- 可以写物理反应、表情变化、可观察的外在行为
- 可以写基于上下文的最小动作衔接
- 不能写内心想法、主观感受、情绪判断
- 不能擅自替 {{user}} 做选择
- 不能写 {{user}} 的大段对话
- 写到决策节点时停下来交给用户`,
    compactText: '【用户权限】可写{{user}}外在行为+最小动作 | 禁写内心/替选/大段对话 | 决策交回',
    semanticVariants: [
      '【{{user}}边界】你只能写{{user}}的外在行为（表情、动作、物理反应）。不能写ta的想法、感受、选择。决定权在用户手里。',
      '【用户主权】{{user}}的内心世界不是你能写的。你可以描述ta看起来怎样，但不能描述ta想的是什么。写到需要选择时停下来。',
    ],
    baseInterval: 12,
    adaptiveMinInterval: 6,
    attentionThreshold: 0.4,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: false,
  },
  // ── Tools: 工具使用 ──
  {
    id: 'behavior_tools',
    type: 'tools',
    priority: 5,
    fullText: `## 工具使用规则
1. 修改文件前先用 read 查看内容
2. 编辑时用 edit 做精确替换
3. write 仅用于创建新文件或完全重写
4. 每次回复结束时必须使用 update_state 工具更新状态`,
    compactText: '【工具规则】read→edit精确替换 | write仅新建 | 每轮结束用update_state',
    semanticVariants: [
      '【工作流规则】改文件三步走：先read看内容，用edit精确替换，write只用于新建。每轮结束必须update_state更新状态。',
      '【操作规范】修改前先read确认，edit时确保旧文本完全匹配，write只创建新文件。必须在每轮结尾调用update_state。',
    ],
    baseInterval: 10,
    adaptiveMinInterval: 5,
    attentionThreshold: 0.3,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: false,
  },
  // ── World: 世界一致性 ──
  {
    id: 'identity_world',
    type: 'world',
    priority: 6,
    fullText: `## 世界一致性原则
- 维护世界观内部逻辑一致性
- 行为应有合理后果
- 所有角色只能基于已经历的事件行动
- 绝对信息隔离：角色不能知道未亲眼所见的事`,
    compactText: '【世界一致】行为有后果 | 角色只知亲历之事 | 绝对信息隔离',
    semanticVariants: [
      '【世界观规则】保持内部逻辑一致。角色只能基于他们亲眼看到、亲耳听到的信息行动。不知道的事情就是不知道。',
      '【信息隔离】每个角色只知道他们经历过的事。不能"理所当然知道"。如果缺少信息，必须安排角色的"碰壁"或"寻找线索"。',
    ],
    baseInterval: 15,
    adaptiveMinInterval: 8,
    attentionThreshold: 0.3,
    targetLayer: AttentionPriority.HARD_RULES,
    enableSemanticReinforce: true,
    enableAttentionAnchoring: false,
  },
];

// ============================================================
// 强化状态
// ============================================================

export interface ReinforceStatus {
  ruleId: string;
  ruleType: ReinforceRule['type'];
  lastReinforcedTurn: number;
  turnsSinceReinforce: number;
  currentInterval: number;
  targetAttention: number;
  attentionThreshold: number;
  needsReinforce: boolean;
  lastVariantIndex: number;
  anchorCount: number;
}

// ============================================================
// InstructionReinforcement - 指令强化系统
// ============================================================

export class InstructionReinforcement {
  private rules: ReinforceRule[] = DEFAULT_REINFORCE_RULES;
  private attentionManager: AttentionManager;
  private turnCounter: number = 0;

  /** 每条规则最后被强化的轮次 */
  private lastReinforced: Map<string, number> = new Map();
  /** 每条规则上次使用的语义变体索引 */
  private lastVariantIndex: Map<string, number> = new Map();
  /** 各层的注意力历史（用于自适应频率） */
  private attentionHistory: Map<AttentionPriority, number[]> = new Map();
  /** 注意力锚点计数器 */
  private anchorCounters: Map<string, number> = new Map();
  /** 日志 */
  private logs: ReinforceLogEntry[] = [];

  constructor(attentionManager: AttentionManager, initialRules?: ReinforceRule[]) {
    if (initialRules) {
      this.rules = initialRules;
    }
    this.attentionManager = attentionManager;
    for (const layer of DEFAULT_ATTENTION_LAYERS) {
      this.attentionHistory.set(layer.priority, []);
    }
  }

  /**
   * 每轮调用：检查并执行强化
   * 
   * @param currentPrompt 当前已渲染的 prompt
   * @returns 注入强化后的 prompt
   */
  reinforce(currentPrompt: string): string {
    this.turnCounter++;

    // 更新注意力历史
    for (const layer of DEFAULT_ATTENTION_LAYERS) {
      const history = this.attentionHistory.get(layer.priority);
      if (history) {
        history.push(this.attentionManager.getAttention(layer.priority));
        if (history.length > 20) history.shift();
      }
    }

    // 检查需要强化的规则
    const rulesToReinforce = this.getRulesNeedingReinforce();
    if (rulesToReinforce.length === 0) return currentPrompt;

    // 构建强化注入块
    const injection = this.buildReinforcementBlock(rulesToReinforce);

    // 注入到 prompt 中
    const reinforcedPrompt = this.injectIntoPrompt(currentPrompt, injection, rulesToReinforce);

    // 更新状态
    for (const rule of rulesToReinforce) {
      this.lastReinforced.set(rule.id, this.turnCounter);
      const lastIdx = this.lastVariantIndex.get(rule.id) ?? -1;
      this.lastVariantIndex.set(rule.id, (lastIdx + 1) % (rule.semanticVariants.length + 1));
      this.anchorCounters.set(rule.id, (this.anchorCounters.get(rule.id) ?? 0) + 1);
    }

    return reinforcedPrompt;
  }

  /**
   * 获取需要强化的规则
   * 三种触发机制：间隔检查 + 注意力阈值 + 快速衰减检测
   */
  private getRulesNeedingReinforce(): ReinforceRule[] {
    const needsReinforce: ReinforceRule[] = [];

    for (const rule of this.rules) {
      const lastTurn = this.lastReinforced.get(rule.id) ?? 0;
      const turnsSince = this.turnCounter - lastTurn;

      // 计算当前间隔（自适应）
      const currentInterval = this.calculateAdaptiveInterval(rule);

      // 触发1：间隔检查
      if (turnsSince >= currentInterval) {
        needsReinforce.push(rule);
        this.logReinforce(rule, 'interval_expired');
        continue;
      }

      // 触发2：注意力阈值
      const attention = this.attentionManager.getAttention(rule.targetLayer);
      if (attention < rule.attentionThreshold && turnsSince >= Math.floor(currentInterval / 2)) {
        needsReinforce.push(rule);
        this.logReinforce(rule, 'attention_threshold');
        continue;
      }

      // 触发3：快速衰减检测
      const history = this.attentionHistory.get(rule.targetLayer);
      if (history && history.length >= 3) {
        const recent = history.slice(-3);
        const declineRate = (recent[0] - recent[2]) / Math.max(recent[0], 0.1);
        if (declineRate > 0.25 && turnsSince >= Math.floor(currentInterval / 2)) {
          needsReinforce.push(rule);
          this.logReinforce(rule, 'rapid_decay');
          continue;
        }
      }
    }

    return needsReinforce.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 自适应间隔计算
   * 注意力衰减越快，间隔越短
   */
  private calculateAdaptiveInterval(rule: ReinforceRule): number {
    const attention = this.attentionManager.getAttention(rule.targetLayer);
    const base = rule.baseInterval;

    // 注意力越低 → 间隔越短
    const attentionFactor = Math.max(0, Math.min(1, attention));
    const adaptive = base - (1 - attentionFactor) * (base - rule.adaptiveMinInterval);

    // 检查近期衰减趋势
    const history = this.attentionHistory.get(rule.targetLayer);
    if (history && history.length >= 5) {
      const recent5 = history.slice(-5);
      const trend = recent5[4] - recent5[0]; // 负值 = 下降
      if (trend < -0.2) {
        // 快速下降 → 缩短间隔
        return Math.max(rule.adaptiveMinInterval, Math.floor(adaptive * 0.7));
      }
    }

    return Math.round(adaptive);
  }

  /**
   * 构建强化注入块
   * 使用语义变体（避免重复注入相同文本）
   */
  private buildReinforcementBlock(rules: ReinforceRule[]): string {
    const parts: string[] = ['\n\n---\n## 🔄 指令强化（注意守住以下规则）'];

    for (const rule of rules) {
      // 选择语义变体
      const text = this.selectReinforceText(rule);
      parts.push(text);
    }

    parts.push('---\n');
    return parts.join('\n');
  }

  /**
   * 选择强化文本（交替使用语义变体）
   */
  private selectReinforceText(rule: ReinforceRule): string {
    if (rule.enableSemanticReinforce && rule.semanticVariants.length > 0) {
      const lastIdx = this.lastVariantIndex.get(rule.id) ?? -1;
      const variantCount = rule.semanticVariants.length;

      // 0 ~ variantCount，0 表示使用 compactText
      const nextIdx = (lastIdx + 1) % (variantCount + 1);

      if (nextIdx === 0) {
        return rule.compactText;
      }
      return rule.semanticVariants[nextIdx - 1];
    }

    return rule.compactText;
  }

  /**
   * 注入强化文本到 prompt
   * 注入位置：system 区末尾（靠近 AI 当前阅读位置）
   */
  private injectIntoPrompt(
    prompt: string,
    injection: string,
    rules: ReinforceRule[]
  ): string {
    // 注意力锚定：对需要锚定的规则添加标记
    let enhancedInjection = injection;
    const anchorRules = rules.filter(r => r.enableAttentionAnchoring);
    if (anchorRules.length > 0) {
      const anchorMarkers = anchorRules.map(r => {
        const count = this.anchorCounters.get(r.id) ?? 0;
        return `⚠️ [重要规则 #${count + 1}] "${r.compactText.split('】')[0]?.replace('【', '') || r.id}" 是必须遵守的硬约束。`;
      });
      enhancedInjection += '\n' + anchorMarkers.join('\n') + '\n';
    }

    // 注入到 system prompt 的末尾（但保持清晰分隔）
    // 寻找 system 区域的边界
    const systemEndings = [
      '## 用户输入',
      '## 记忆与历史',
      '## 世界知识',
      '## 对话历史',
    ];

    let insertPoint = prompt.length;

    for (const ending of systemEndings) {
      const idx = prompt.lastIndexOf(ending);
      if (idx !== -1 && idx < insertPoint) {
        insertPoint = idx;
      }
    }

    // 如果找到了合适的插入点，在 system 区末尾注入
    if (insertPoint < prompt.length) {
      return prompt.slice(0, insertPoint) + enhancedInjection + '\n\n' + prompt.slice(insertPoint);
    }

    // fallback：直接追加
    return prompt + enhancedInjection;
  }

  /**
   * 记录强化日志
   */
  private logReinforce(rule: ReinforceRule, trigger: string): void {
    this.logs.push({
      turn: this.turnCounter,
      ruleId: rule.id,
      ruleType: rule.type,
      trigger,
      targetAttention: this.attentionManager.getAttention(rule.targetLayer),
    });
  }

  /**
   * 获取强化状态报告
   */
  getReinforceStatus(): ReinforceStatus[] {
    return this.rules.map(rule => {
      const lastTurn = this.lastReinforced.get(rule.id) ?? 0;
      return {
        ruleId: rule.id,
        ruleType: rule.type,
        lastReinforcedTurn: lastTurn,
        turnsSinceReinforce: this.turnCounter - lastTurn,
        currentInterval: this.calculateAdaptiveInterval(rule),
        targetAttention: this.attentionManager.getAttention(rule.targetLayer),
        attentionThreshold: rule.attentionThreshold,
        needsReinforce: this.getRulesNeedingReinforce().includes(rule),
        lastVariantIndex: this.lastVariantIndex.get(rule.id) ?? -1,
        anchorCount: this.anchorCounters.get(rule.id) ?? 0,
      };
    });
  }

  /**
   * 获取强化日志
   */
  getReinforceLogs(): ReinforceLogEntry[] {
    return [...this.logs];
  }

  /**
   * 清空日志
   */
  /**
   * 添加一条自定义强化规则
   */
  addRule(rule: ReinforceRule): void {
    // 如果已存在相同 ruleId 的规则，替换
    const idx = this.rules.findIndex(r => r.ruleId === rule.ruleId);
    if (idx >= 0) {
      this.rules[idx] = rule;
    } else {
      this.rules.push(rule);
    }
  }

  /**
   * 批量添加强化规则
   */
  addRules(rules: ReinforceRule[]): void {
    for (const rule of rules) {
      this.addRule(rule);
    }
  }

  clearLogs(): void {
    this.logs = [];
  }
}

export interface ReinforceLogEntry {
  turn: number;
  ruleId: string;
  ruleType: ReinforceRule['type'];
  trigger: 'interval_expired' | 'attention_threshold' | 'rapid_decay';
  targetAttention: number;
}

/**
 * ReinforceResult - 强化结果（用于调试追踪）
 */
export interface ReinforceResult {
  ruleId: string;
  variantIndex: number;
  triggerReason: string;
  attentionBefore: number;
  attentionAfter: number;
  anchorApplied: boolean;
}

export default InstructionReinforcement;
