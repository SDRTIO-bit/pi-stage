/**
 * Context Assembly Engine - 主动记忆检索
 *
 * 替代"全量发送历史"的旧模式，改为按需检索：
 * - 按相关性 (relevance)
 * - 按情感显著性 (emotional salience)
 * - 按当前目标 (current goals)
 * - 按时序重要性 (temporal importance)
 *
 * 核心原则：只给 AI 它当前需要记住的东西
 */

import { ContextPriority, type ContextSegment } from './context-controller';
import type { MemoryLayer, MemoryEntry } from '../memory/memory-layer';

// ============================================================
// 检索查询
// ============================================================

export interface MemoryQuery {
  /** 当前用户消息 */
  userMessage: string;
  /** 当前场景上下文 */
  sceneContext: string;
  /** 当前活跃目标（来自 Goal System） */
  activeGoals: string[];
  /** 当前 Agent ID */
  agentId: string;
  /** 检索模式 */
  mode: MemoryRetrievalMode;
  /** 最大返回记忆数 */
  maxResults: number;
  /** Token 预算 */
  tokenBudget: number;
}

export type MemoryRetrievalMode =
  /** 平衡模式：综合所有信号 */
  | 'balanced'
  /** 优先相关性 */
  | 'relevance_first'
  /** 优先情感显著事件 */
  | 'salience_first'
  /** 优先当前目标相关 */
  | 'goal_first'
  /** 紧急模式：仅检索最重要的 */
  | 'emergency';

// ============================================================
// 检索结果
// ============================================================

export interface RetrievedMemory {
  /** 原始记忆条目 */
  entry: MemoryEntry;
  /** 相关性得分 (0-1) */
  relevanceScore: number;
  /** 情感得分 (0-1) */
  salienceScore: number;
  /** 目标相关性 (0-1) */
  goalRelevance: number;
  /** 综合得分 */
  compositeScore: number;
  /** 检索来源 */
  source: 'episodic' | 'semantic' | 'working';
}

// ============================================================
// 主动记忆检索器
// ============================================================

export class ActiveMemoryRetriever {
  private memory: MemoryLayer;

  constructor(memory: MemoryLayer) {
    this.memory = memory;
  }

  /**
   * 核心入口：根据当前状态检索相关记忆
   */
  async retrieve(query: MemoryQuery): Promise<ContextSegment[]> {
    // 1. 从各层记忆源检索
    const [episodicMemories, semanticMemories, workingMemories] = await Promise.all([
      this.retrieveEpisodic(query),
      this.retrieveSemantic(query),
      this.retrieveWorking(query),
    ]);

    // 2. 合并所有检索结果
    const allMemories = [
      ...episodicMemories,
      ...semanticMemories,
      ...workingMemories,
    ];

    // 3. 按综合得分排序
    const sorted = this.scoreAndSort(allMemories, query);

    // 4. 按预算截断
    const budgeted = this.truncateByBudget(sorted, query.tokenBudget);

    // 5. 转为 ContextSegment
    return this.toContextSegments(budgeted);
  }

  /**
   * 检索情节记忆（发生了什么事）
   * - 按关键词相关性
   * - 按情感显著性
   * - 按与当前目标的关系
   */
  private async retrieveEpisodic(
    query: MemoryQuery
  ): Promise<RetrievedMemory[]> {
    const results = await this.memory.episodic.recall({
      agentId: query.agentId,
      keywords: this.extractKeywords(query.userMessage),
      type: 'episodic',
      importanceThreshold: 0.2,
      maxResults: query.maxResults * 2,
      timeRange: undefined, // 全时间范围
    });

    return results.map(entry => ({
      entry,
      relevanceScore: this.calcRelevance(entry, query),
      salienceScore: entry.importance * Math.abs(entry.emotionalValence),
      goalRelevance: this.calcGoalRelevance(entry, query.activeGoals),
      compositeScore: 0, // 稍后计算
      source: 'episodic' as const,
    }));
  }

  /**
   * 检索语义记忆（知道了什么事实）
   */
  private async retrieveSemantic(
    query: MemoryQuery
  ): Promise<RetrievedMemory[]> {
    const results = await this.memory.semantic.recall({
      agentId: query.agentId,
      keywords: this.extractKeywords(query.userMessage),
      type: 'semantic',
      importanceThreshold: 0.3,
      maxResults: query.maxResults,
    });

    return results.map(entry => ({
      entry,
      relevanceScore: this.calcRelevance(entry, query),
      salienceScore: entry.importance,
      goalRelevance: this.calcGoalRelevance(entry, query.activeGoals),
      compositeScore: 0,
      source: 'semantic' as const,
    }));
  }

  /**
   * 检索工作记忆（当前关注的事）
   */
  private async retrieveWorking(
    query: MemoryQuery
  ): Promise<RetrievedMemory[]> {
    const slots = await this.memory.working.getActiveSlots(query.agentId);

    return slots.map(slot => ({
      entry: {
        id: slot.id,
        type: 'working',
        timestamp: slot.createdAt,
        importance: slot.importance,
        emotionalValence: 0,
        content: slot.content,
        tags: slot.tags,
        associations: [],
        accessCount: 1,
        lastAccess: Date.now(),
      },
      relevanceScore: this.calcWorkingRelevance(slot, query),
      salienceScore: slot.importance,
      goalRelevance: this.calcGoalRelevance(
        { content: slot.content, tags: slot.tags } as MemoryEntry,
        query.activeGoals
      ),
      compositeScore: 0,
      source: 'working' as const,
    }));
  }

  /**
   * 评分排序
   */
  private scoreAndSort(
    memories: RetrievedMemory[],
    query: MemoryQuery
  ): RetrievedMemory[] {
    for (const m of memories) {
      switch (query.mode) {
        case 'relevance_first':
          m.compositeScore = m.relevanceScore * 0.6 +
                             m.salienceScore * 0.2 +
                             m.goalRelevance * 0.2;
          break;
        case 'salience_first':
          m.compositeScore = m.relevanceScore * 0.2 +
                             m.salienceScore * 0.6 +
                             m.goalRelevance * 0.2;
          break;
        case 'goal_first':
          m.compositeScore = m.relevanceScore * 0.2 +
                             m.salienceScore * 0.2 +
                             m.goalRelevance * 0.6;
          break;
        case 'emergency':
          m.compositeScore = m.entry.importance; // 只看重要性
          break;
        case 'balanced':
        default:
          m.compositeScore = m.relevanceScore * 0.4 +
                             m.salienceScore * 0.3 +
                             m.goalRelevance * 0.3;
          break;
      }
    }

    return memories.sort((a, b) => b.compositeScore - a.compositeScore);
  }

  /**
   * 按 Token 预算截断
   */
  private truncateByBudget(
    memories: RetrievedMemory[],
    budget: number
  ): RetrievedMemory[] {
    const result: RetrievedMemory[] = [];
    let totalTokens = 0;

    for (const mem of memories) {
      // 每条记忆的 token 估算
      const tokens = MemoryEntryTokenEstimate(mem.entry);
      if (totalTokens + tokens > budget) break;
      result.push(mem);
      totalTokens += tokens;
    }

    return result;
  }

  /**
   * 转为 ContextSegment
   */
  private toContextSegments(
    memories: RetrievedMemory[]
  ): ContextSegment[] {
    return memories.map(mem => ({
      priority: mem.source === 'working'
        ? ContextPriority.SHORT_TERM_MEMORY
        : ContextPriority.LONG_TERM_MEMORY,
      content: this.formatMemoryEntry(mem),
      tokenCount: MemoryEntryTokenEstimate(mem.entry),
      isCompressed: false,
      metadata: {
        source: `memory_${mem.source}`,
        timestamp: mem.entry.timestamp,
        importance: mem.compositeScore,
        tags: mem.entry.tags,
      },
    }));
  }

  /**
   * 格式化记忆条目为 LLM 可读文本
   */
  private formatMemoryEntry(mem: RetrievedMemory): string {
    const time = new Date(mem.entry.timestamp).toLocaleString('zh-CN');
    const tagStr = mem.entry.tags.length > 0
      ? `[${mem.entry.tags.join(', ')}]`
      : '';

    return `[${time}] ${tagStr} ${mem.entry.content}`;
  }

  /**
   * 计算相关性得分
   */
  private calcRelevance(entry: MemoryEntry, query: MemoryQuery): number {
    const keywords = this.extractKeywords(query.userMessage);
    if (keywords.length === 0) return 0.3; // 无关键词时的默认值

    let matchCount = 0;
    for (const kw of keywords) {
      if (entry.content.includes(kw) ||
          entry.tags.some(t => t.includes(kw))) {
        matchCount++;
      }
    }

    return Math.min(1.0, matchCount / keywords.length);
  }

  /**
   * 计算目标相关性
   */
  private calcGoalRelevance(
    entry: { content: string; tags: string[] },
    goals: string[]
  ): number {
    if (goals.length === 0) return 0.2;

    let matchCount = 0;
    for (const goal of goals) {
      if (entry.content.includes(goal) ||
          entry.tags.some(t => t.includes(goal))) {
        matchCount++;
      }
    }

    return Math.min(1.0, matchCount / goals.length);
  }

  /**
   * 计算工作记忆中条目的相关性
   * 工作记忆通常较短且有明确的时间范围
   */
  private calcWorkingRelevance(
    slot: { content: string; tags: string[]; createdAt: number },
    query: MemoryQuery
  ): number {
    const keywords = this.extractKeywords(query.userMessage);
    if (keywords.length === 0) return 0.5;

    let matchCount = 0;
    for (const kw of keywords) {
      if (slot.content.includes(kw) ||
          slot.tags.some(t => t.includes(kw))) {
        matchCount++;
      }
    }

    // 工作记忆有时间衰减：越近越相关
    const age = Date.now() - slot.createdAt;
    const timeDecay = Math.max(0.3, 1 - age / (30 * 60 * 1000)); // 30 分钟内线性衰减

    return Math.min(1.0, matchCount / keywords.length) * timeDecay;
  }

  /**
   * 从文本中提取关键词
   */
  private extractKeywords(text: string): string[] {
    if (!text) return [];
    // 简单分词：去掉停用词，保留名词/动词
    const stopWords = new Set([
      '的', '了', '在', '是', '我', '有', '和', '就', '不', '人',
      '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去',
      '你', '会', '着', '没有', '看', '好', '自己', '这', '他', '她',
      '它', '们', '那', '些', '什么', '怎么', '为什么', '如何',
    ]);

    const chars = text.split(/[\s,，。！？、；：""''（）\(\)\[\]【】]+/);
    const keywords = chars.filter(c => c.length >= 2 && !stopWords.has(c));

    // 去重
    return [...new Set(keywords)];
  }
}

/**
 * 估算记忆条目的 token 数
 */
export function MemoryEntryTokenEstimate(entry: MemoryEntry): number {
  const text = `${entry.content} ${entry.tags.join(' ')}`;
  // 中文 1.5 字/token，英文 4 字/token 的混合估算
  const cnChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherChars = text.length - cnChars;
  return Math.ceil(cnChars / 1.5 + otherChars / 4) + 20; // +20 overhead
}

export default ActiveMemoryRetriever;
