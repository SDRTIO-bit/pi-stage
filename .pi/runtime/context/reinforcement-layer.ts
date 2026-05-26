/**
 * Context Assembly Engine - 指令强化层
 *
 * 核心目标：防止以下问题：
 * - instruction dilution（指令稀释）
 * - role drift（角色漂移）
 * - style drift（风格漂移）
 * - output shortening（输出缩短）
 * - system prompt weakening（系统提示弱化）
 *
 * 机制：
 * 1. 关键规则周期性重复注入
 * 2. 注意力衰减检测 → 触发强化
 * 3. 格式约束校验
 * 4. 角色身份锚定
 */

import type { AssembledContext } from './context-controller';
import { ContextPriority } from './context-controller';
import type { PriorityLayer } from './priority-layer';
import { PRIORITY_LAYERS } from './priority-layer';
import type { AttentionManager } from './priority-layer';

// ============================================================
// 强化规则定义
// ============================================================

export interface ReinforceRule {
  /** 规则 ID */
  id: string;
  /** 规则类型 */
  type: 'identity' | 'format' | 'style' | 'prohibition' | 'behavior';
  /** 规则优先级（0=最高，数字越大优先级越低） */
  priority: number;
  /** 规则原始文本 */
  ruleText: string;
  /** 强化时使用的紧凑文本 */
  reinforceText: string;
  /** 强化间隔（轮数） */
  interval: number;
  /** 注意力阈值（低于此值触发强化） */
  attentionThreshold: number;
  /** 目标层 */
  targetLayer: ContextPriority;
}

// ============================================================
// 默认强化规则集
// ============================================================

const DEFAULT_REINFORCE_RULES: ReinforceRule[] = [
  // ── 身份规则 ──
  {
    id: 'identity_self',
    type: 'identity',
    priority: 0,
    ruleText: `## 核心身份规则
- 你必须始终以当前角色的身份进行互动
- 角色的记忆、性格、认知水平决定了ta的言行
- 禁止跳出角色进行元评论或道歉`,
    reinforceText: `【身份锚定】当前角色：你是谁就用谁的身份说话。禁止 OOC、元评论、道歉。`,
    interval: 10,
    attentionThreshold: 0.6,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
  // ── 输出格式 ──
  {
    id: 'format_output',
    type: 'format',
    priority: 1,
    ruleText: `## 输出格式要求
### 标签规则
- 所有标签必须成对出现，大小写敏感，完整闭合
- <content> 正文必须 800-1200 字
- <choice> 标签内为选项文本，10~30 字
- 每轮必须提供 3-5 个 <choice> 选项

### 文风要求
- 对话占比 70%，叙事占比 30%
- 第三人称有限视角
- 结尾必须有 <choice> 标签`,
    reinforceText: `【格式约束】<content>800-1200字 | 3-5个<choice> | 标签成对闭合 | 对话占比70% | 第三人称有限视角`,
    interval: 12,
    attentionThreshold: 0.5,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
  // ── 输出长度 ──
  {
    id: 'output_length',
    type: 'behavior',
    priority: 2,
    ruleText: `## 输出长度要求
每次回复的正文（<content> 标签内）必须达到 **800-1200 字**。
请严格遵守，不要因为对话轮次增多而缩短篇幅。
这是硬性要求，不受上下文长度影响。`,
    reinforceText: `【长度要求】每轮<content>正文必须800-1200字。随轮次增加也不缩短。硬性要求。`,
    interval: 8,
    attentionThreshold: 0.5,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
  // ── 风格规范 ──
  {
    id: 'style_nsfw',
    type: 'style',
    priority: 3,
    ruleText: `## 风格规范
- NSFW 词汇必须直白（鸡巴/乳房/阴道/阴唇）
- 禁止用"轮廓""线条""浊液"等代替
- 性描写要有画面感，避免隐喻和省略
- {{user}} 的态度要温柔，做有温度的 S`,
    reinforceText: `【风格规范】NSFW词汇直白不省略 | 性描写有画面感 | 对{{user}}保持温柔温度`,
    interval: 15,
    attentionThreshold: 0.4,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
  // ── 禁止事项 ──
  {
    id: 'prohibition_user',
    type: 'prohibition',
    priority: 4,
    ruleText: `## 对 {{user}} 的权限限制
- 可以写物理反应、表情变化、可观察的外在行为
- 可以写基于上下文的最小动作衔接
- 不能写内心想法、主观感受、情绪判断
- 不能擅自替 {{user}} 做选择
- 不能写 {{user}} 的大段对话
- 写到决策节点时停下来交给用户`,
    reinforceText: `【用户权限】可写{{user}}外在行为+最小动作衔接 | 禁写内心/替选/大段对话 | 决策节点交回`,
    interval: 12,
    attentionThreshold: 0.4,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
  // ── 工具使用 ──
  {
    id: 'behavior_tools',
    type: 'behavior',
    priority: 5,
    ruleText: `## 工具使用规则
1. 修改文件前先用 read 查看内容
2. 编辑时用 edit 做精确替换
3. write 仅用于创建新文件或完全重写
4. 每次回复结束时必须使用 update_state 工具更新状态`,
    reinforceText: `【工具规则】read→edit精确替换 | write仅新建 | 每轮结束用update_state更新归属值`,
    interval: 10,
    attentionThreshold: 0.3,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
  // ── 世界一致性 ──
  {
    id: 'identity_world',
    type: 'identity',
    priority: 6,
    ruleText: `## 世界一致性原则
- 维护世界观内部逻辑一致性
- 行为应有合理后果
- 所有角色只能基于已经历的事件行动
- 绝对信息隔离：角色不能知道未亲眼所见的事`,
    reinforceText: `【世界一致】行为有后果 | 角色只知亲历之事 | 绝对信息隔离 | 找不到线索就安排碰壁`,
    interval: 15,
    attentionThreshold: 0.3,
    targetLayer: ContextPriority.SYSTEM_RULES,
  },
];

// ============================================================
// 强化注入器
// ============================================================

export class ReinforcementLayer {
  private rules: ReinforceRule[] = DEFAULT_REINFORCE_RULES;
  private attentionManager: AttentionManager;
  private turnCounter: number = 0;

  /** 记录每条规则最后被强化的轮次 */
  private lastReinforced: Map<string, number> = new Map();
  /** 各层的注意力轨迹（用于检测注意力衰减） */
  private attentionHistory: Map<ContextPriority, number[]> = new Map();

  constructor(attentionManager: AttentionManager) {
    this.attentionManager = attentionManager;
    for (const layer of PRIORITY_LAYERS) {
      this.attentionHistory.set(layer.priority, []);
    }
  }

  /**
   * 每轮调用：检查并执行强化
   * 
   * @param context 当前装配的上下文
   * @returns 强化后的上下文（可能注入了强化文本）
   */
  reinforce(context: AssembledContext): AssembledContext {
    this.turnCounter++;

    // 记录各层注意力
    for (const layer of PRIORITY_LAYERS) {
      const history = this.attentionHistory.get(layer.priority);
      if (history) {
        history.push(this.attentionManager.getAttention(layer.priority));
        // 只保留最近 20 轮的记录
        if (history.length > 20) history.shift();
      }
    }

    // 检查哪些规则需要强化
    const rulesToReinforce = this.getRulesNeedingReinforce();

    if (rulesToReinforce.length === 0) {
      return context; // 不需要强化，直接返回
    }

    // 构建强化文本
    const reinforceText = this.buildReinforceText(rulesToReinforce);

    // 注入到 system 区尾部（在 system 区内，但靠近最近读到的位置）
    const reinforced = this.injectReinforceText(context, reinforceText);

    // 记录强化轮次
    for (const rule of rulesToReinforce) {
      this.lastReinforced.set(rule.id, this.turnCounter);
    }

    return reinforced;
  }

  /**
   * 获取需要强化的规则
   */
  private getRulesNeedingReinforce(): ReinforceRule[] {
    const needsReinforce: ReinforceRule[] = [];

    for (const rule of this.rules) {
      // 1. 检查是否到了强化间隔
      const lastTurn = this.lastReinforced.get(rule.id) ?? 0;
      const turnsSince = this.turnCounter - lastTurn;
      if (turnsSince < rule.interval) continue;

      // 2. 检查目标层的注意力是否低于阈值
      const attention = this.attentionManager.getAttention(rule.targetLayer);
      if (attention >= rule.attentionThreshold) continue;

      // 3. 检测注意力是否在快速下降
      const history = this.attentionHistory.get(rule.targetLayer);
      if (history && history.length >= 3) {
        const recent = history.slice(-3);
        const declineRate = (recent[0] - recent[2]) / recent[0];
        // 如果注意力快速下降（>20% 每 3 轮），即使未到间隔也触发
        if (declineRate > 0.2 && turnsSince >= Math.floor(rule.interval / 2)) {
          needsReinforce.push(rule);
          continue;
        }
      }

      // 3（续）：正常阈值检查
      if (attention < rule.attentionThreshold) {
        needsReinforce.push(rule);
      }
    }

    // 按优先级排序
    return needsReinforce.sort((a, b) => a.priority - b.priority);
  }

  /**
   * 构建强化文本
   * 将多条规则合并为紧凑的强化块
   */
  private buildReinforceText(rules: ReinforceRule[]): string {
    const parts: string[] = ['\n\n---\n## 🔄 指令强化'];

    for (const rule of rules) {
      parts.push(rule.reinforceText);
    }

    parts.push('---\n');
    return parts.join('\n');
  }

  /**
   * 将强化文本注入到上下文中
   * 
   * 注入策略：
   * - 注入到 system 区的尾部（靠近 AI 当前阅读位置）
   * - 使用标记分隔，避免与原始 system prompt 混淆
   */
  private injectReinforceText(
    context: AssembledContext,
    reinforceText: string
  ): AssembledContext {
    const reinforcedSystem = [...context.system];

    // 在 system 区最后添加强化段
    // 注：system 区排序后，SYSTEM_RULES 在最前，但注入到尾部让 AI 最近读到
    reinforcedSystem.push({
      priority: ContextPriority.SYSTEM_RULES,
      content: reinforceText,
      tokenCount: this.estimateTokens(reinforceText),
      isCompressed: false,
      metadata: {
        source: 'reinforcement_layer',
        timestamp: Date.now(),
        importance: 0.95,
        tags: ['reinforcement', 'instruction'],
      },
    });

    return {
      ...context,
      system: reinforcedSystem,
      metadata: {
        ...context.metadata,
        totalTokens: context.metadata.totalTokens + this.estimateTokens(reinforceText),
      },
    };
  }

  /**
   * 获取当前所有规则的强化状态（用于调试/监控）
   */
  getReinforceStatus(): ReinforceStatus[] {
    return this.rules.map(rule => ({
      ruleId: rule.id,
      ruleType: rule.type,
      lastReinforcedTurn: this.lastReinforced.get(rule.id) ?? 0,
      turnsSinceReinforce: this.turnCounter - (this.lastReinforced.get(rule.id) ?? 0),
      interval: rule.interval,
      targetAttention: this.attentionManager.getAttention(rule.targetLayer),
      attentionThreshold: rule.attentionThreshold,
      needsReinforce: this.getRulesNeedingReinforce().includes(rule),
    }));
  }

  /**
   * Token 估算
   */
  private estimateTokens(text: string): number {
    if (!text) return 0;
    const cnChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const otherChars = text.length - cnChars;
    return Math.ceil(cnChars / 1.5 + otherChars / 4);
  }
}

export interface ReinforceStatus {
  ruleId: string;
  ruleType: ReinforceRule['type'];
  lastReinforcedTurn: number;
  turnsSinceReinforce: number;
  interval: number;
  targetAttention: number;
  attentionThreshold: number;
  needsReinforce: boolean;
}

export default ReinforcementLayer;
