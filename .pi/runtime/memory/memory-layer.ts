/**
 * Memory Layer - 精简实现（Phase 1）
 *
 * 三层记忆结构：
 * - episodic: 情节记忆（对话记录、事件序列）
 * - semantic: 语义记忆（概念、事实、关系）
 * - working: 工作记忆（当前活跃的上下文）
 *
 * Phase 1：仅实现基本存储和检索接口
 * Phase 2+：添加 decay、consolidation、情感标记
 */

export interface MemoryEntry {
  type: 'episodic' | 'semantic' | 'working';
  content: string;
  timestamp: number;
  importance: number;        // 0-1 重要性
  emotionalValence: number;  // -1 ~ 1 情感效价
  tags: string[];
  associations: string[];    // 关联的条目 ID
  accessCount: number;
  lastAccess: number;
  decayRate: number;         // 衰减速率
}

export interface MemoryQuery {
  type?: 'episodic' | 'semantic' | 'working';
  keywords?: string[];
  tags?: string[];
  minImportance?: number;
  limit?: number;
  timeRange?: [number, number]; // [start, end] timestamp
}

export class MemoryLayer {
  private entries: MemoryEntry[] = [];
  private idCounter = 0;

  /**
   * 存储一条记忆
   */
  async store(entry: Partial<MemoryEntry> & { content: string }): Promise<string> {
    const id = `mem_${++this.idCounter}_${Date.now()}`;
    const fullEntry: MemoryEntry = {
      type: entry.type || 'episodic',
      content: entry.content,
      timestamp: entry.timestamp || Date.now(),
      importance: entry.importance ?? 0.5,
      emotionalValence: entry.emotionalValence ?? 0,
      tags: entry.tags || [],
      associations: entry.associations || [],
      accessCount: 0,
      lastAccess: Date.now(),
      decayRate: entry.decayRate ?? 0.05,
    };

    this.entries.push(fullEntry);
    // 简单限制：最多保留 500 条
    if (this.entries.length > 500) {
      this.entries.sort((a, b) => b.importance * b.accessCount - a.importance * a.accessCount);
      this.entries = this.entries.slice(0, 500);
    }

    return id;
  }

  /**
   * 检索记忆
   */
  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    let results = [...this.entries];

    // 按类型过滤
    if (query.type) {
      results = results.filter(e => e.type === query.type);
    }

    // 按关键词检索（简单包含匹配）
    if (query.keywords && query.keywords.length > 0) {
      results = results.filter(e =>
        query.keywords!.some(kw =>
          e.content.toLowerCase().includes(kw.toLowerCase())
        )
      );
    }

    // 按标签过滤
    if (query.tags && query.tags.length > 0) {
      results = results.filter(e =>
        query.tags!.some(tag => e.tags.includes(tag))
      );
    }

    // 按重要性过滤
    if (query.minImportance !== undefined) {
      results = results.filter(e => e.importance >= query.minImportance!);
    }

    // 按时间范围过滤
    if (query.timeRange) {
      const [start, end] = query.timeRange;
      results = results.filter(e => e.timestamp >= start && e.timestamp <= end);
    }

    // 按 importance * accessCount 排序（相关性 = 重要性 × 访问频率）
    results.sort((a, b) => {
      const scoreA = a.importance * (1 + Math.log2(a.accessCount + 1)) * (1 + a.emotionalValence);
      const scoreB = b.importance * (1 + Math.log2(b.accessCount + 1)) * (1 + b.emotionalValence);
      return scoreB - scoreA;
    });

    // 更新 accessCount
    const limited = results.slice(0, query.limit || 10);
    for (const entry of limited) {
      entry.accessCount++;
      entry.lastAccess = Date.now();
    }

    return limited;
  }

  /**
   * 按相关性评分检索（供 ActiveMemoryRetriever 使用）
   */
  async retrieveByRelevance(
    query: string,
    options?: {
      mode?: 'balanced' | 'relevance_first' | 'salience_first';
      limit?: number;
    }
  ): Promise<{ entry: MemoryEntry; score: number }[]> {
    const mode = options?.mode || 'balanced';
    const limit = options?.limit || 10;
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);

    const scored = this.entries.map(entry => {
      let relevanceScore = 0;
      let salienceScore = entry.importance * (1 + Math.abs(entry.emotionalValence));

      // 关键词匹配
      if (queryWords.length > 0) {
        const content = entry.content.toLowerCase();
        const matches = queryWords.filter(w => content.includes(w));
        relevanceScore = matches.length / queryWords.length;
      }

      // 时间衰减
      const ageHours = (Date.now() - entry.timestamp) / (1000 * 60 * 60);
      const timeDecay = Math.max(0, 1 - ageHours / 72); // 3 天半衰期

      // 访问频率提升
      const frequencyBoost = Math.log2(entry.accessCount + 1) * 0.1;

      let finalScore: number;
      switch (mode) {
        case 'relevance_first':
          finalScore = relevanceScore * 0.6 + salienceScore * 0.2 + timeDecay * 0.15 + frequencyBoost * 0.05;
          break;
        case 'salience_first':
          finalScore = relevanceScore * 0.2 + salienceScore * 0.6 + timeDecay * 0.15 + frequencyBoost * 0.05;
          break;
        default: // balanced
          finalScore = relevanceScore * 0.4 + salienceScore * 0.3 + timeDecay * 0.2 + frequencyBoost * 0.1;
      }

      return { entry, score: finalScore };
    });

    scored.sort((a, b) => b.score - a.score);

    // 更新 accessCount
    for (const item of scored.slice(0, limit)) {
      item.entry.accessCount++;
      item.entry.lastAccess = Date.now();
    }

    return scored.slice(0, limit);
  }

  /**
   * 获取所有记忆
   */
  getAll(): MemoryEntry[] {
    return [...this.entries];
  }

  /**
   * 清除记忆
   */
  async clear(): Promise<void> {
    this.entries = [];
  }

  /**
   * 统计信息
   */
  getStats(): { total: number; episodic: number; semantic: number; working: number } {
    return {
      total: this.entries.length,
      episodic: this.entries.filter(e => e.type === 'episodic').length,
      semantic: this.entries.filter(e => e.type === 'semantic').length,
      working: this.entries.filter(e => e.type === 'working').length,
    };
  }
}

export default MemoryLayer;
