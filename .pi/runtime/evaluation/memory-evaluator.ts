/**
 * Memory Evaluator
 *
 * Phase 3.5 — Runtime Validation & Telemetry
 *
 * 评估记忆系统质量：
 * - recall precision     召回精度（检索到的记忆是否相关）
 * - recall relevance    召回相关性（检索到的记忆是否与上下文匹配）
 * - memory hallucination 记忆幻觉（AI 提及的记忆是否存在于存储中）
 * - memory persistence   记忆持久性（关键记忆在多次轮转后是否仍被召回）
 */

// ============================================================
// 本模块使用内联定义而非引用运行时模块，
// 以保持 evaluation 的模块独立性和可测试性。
// ============================================================

// 内存查询（最小子集）
export interface MemoryQuery {
  keywords: string[];
  limit: number;
  minRelevance: number;
}

// 检索到的记忆（最小子集）
export interface RetrievedMemory {
  id: string;
  content: string;
  relevance: number;
  source: string;
}

// ============================================================
// 类型定义
// ============================================================

export interface MemoryEvalResult {
  /** 评估时间戳 */
  timestamp: number;
  /** 召回精度（0~1） */
  precision: number;
  /** 召回相关性（0~1） */
  relevance: number;
  /** 记忆幻觉率（0~1，1 = 全部幻觉） */
  hallucinationRate: number;
  /** 记忆持久性（0~1） */
  persistence: number;
  /** 各维度细项 */
  details: MemoryEvalDetail[];
}

export interface MemoryEvalDetail {
  dimension: 'precision' | 'relevance' | 'hallucination' | 'persistence';
  score: number;
  detail: string;
}

export interface MemoryCheckpoint {
  id: string;
  timestamp: number;
  turnIndex: number;
  query: MemoryQuery;
  results: RetrievedMemory[];
  evalResult: MemoryEvalResult;
}

// ============================================================
// 配置
// ============================================================

export interface MemoryEvaluatorConfig {
  /** 关键记忆清单（需要被持久保留的记忆 ID 或内容片段） */
  criticalMemories?: string[];
  /** 记忆幻觉的已知事实库 */
  groundTruth?: string[];
  /** 相关性判定阈值 */
  relevanceThreshold?: number;    // 默认 0.3
}

// ============================================================
// MemoryEvaluator 主类
// ============================================================

export class MemoryEvaluator {
  private config: Required<MemoryEvaluatorConfig>;
  private checkpoints: MemoryCheckpoint[] = [];

  constructor(config: MemoryEvaluatorConfig = {}) {
    this.config = {
      criticalMemories: config.criticalMemories || [],
      groundTruth: config.groundTruth || [],
      relevanceThreshold: config.relevanceThreshold ?? 0.3,
    };
  }

  /**
   * 评估一次记忆召回的质量
   */
  evaluate(
    query: MemoryQuery,
    results: RetrievedMemory[],
    contextTurnIndex: number
  ): MemoryCheckpoint {
    const precision = this.calcPrecision(query, results);
    const relevance = this.calcRelevance(query, results);
    const hallucinationRate = this.calcHallucinationRate(results);
    const persistence = this.calcPersistence(results);

    const evalResult: MemoryEvalResult = {
      timestamp: Date.now(),
      precision,
      relevance,
      hallucinationRate,
      persistence,
      details: [
        {
          dimension: 'precision',
          score: precision,
          detail: `召回 ${results.length} 条，精度 ${(precision * 100).toFixed(0)}%`,
        },
        {
          dimension: 'relevance',
          score: relevance,
          detail: `相关性得分 ${(relevance * 100).toFixed(0)}%`,
        },
        {
          dimension: 'hallucination',
          score: 1 - hallucinationRate,
          detail: `幻觉率 ${(hallucinationRate * 100).toFixed(0)}%`,
        },
        {
          dimension: 'persistence',
          score: persistence,
          detail: `关键记忆持久性 ${(persistence * 100).toFixed(0)}%${this.config.criticalMemories.length === 0 ? '（未配置关键记忆）' : ''}`,
        },
      ],
    };

    const checkpoint: MemoryCheckpoint = {
      id: `mem_eval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      turnIndex: contextTurnIndex,
      query,
      results,
      evalResult,
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * 召回精度
   *
   * 基于查询关键词在结果中的命中率。
   * query.keywords 中的词在结果中出现得越多，精度越高。
   */
  private calcPrecision(query: MemoryQuery, results: RetrievedMemory[]): number {
    const keywords = query.keywords || [];
    if (keywords.length === 0 || results.length === 0) return 0;

    let totalHits = 0;
    let totalChecks = 0;

    for (const result of results) {
      const content = result.content || '';
      for (const kw of keywords) {
        totalChecks++;
        if (content.toLowerCase().includes(kw.toLowerCase())) {
          totalHits++;
        }
      }
    }

    return totalChecks > 0 ? totalHits / totalChecks : 0;
  }

  /**
   * 召回相关性
   *
   * 评估结果内容与查询意图的语义匹配程度。
   * 如果结果包含 query.minRelevance 以上的条目数量较多，则相关性高。
   */
  private calcRelevance(query: MemoryQuery, results: RetrievedMemory[]): number {
    if (results.length === 0) return 0;

    // 使用 result.relevance 字段（由记忆层提供）
    const relevantResults = results.filter(r => {
      if (typeof r.relevance === 'number') {
        return r.relevance >= this.config.relevanceThreshold;
      }
      // 如果没有 relevance 字段，按内容长度粗略判定
      return (r.content?.length || 0) > 20;
    });

    return relevantResults.length / results.length;
  }

  /**
   * 记忆幻觉率
   *
   * 检查结果中的内容是否与已知事实矛盾或不在知识库中。
   * 仅在有 groundTruth 配置时生效。
   */
  private calcHallucinationRate(results: RetrievedMemory[]): number {
    const truth = this.config.groundTruth;
    if (truth.length === 0) return 0; // 无法判定时不扣分

    let hallucinated = 0;
    for (const result of results) {
      const content = result.content || '';
      // 检查结果中是否有与任何 groundTruth 匹配的内容
      const matchesTruth = truth.some(t => content.includes(t));
      if (!matchesTruth && content.length > 50) {
        // 长内容但无已知事实匹配 → 疑似幻觉
        hallucinated++;
      }
    }

    return results.length > 0 ? hallucinated / results.length : 0;
  }

  /**
   * 记忆持久性
   *
   * 检查关键记忆在当前召回结果中是否出现。
   */
  private calcPersistence(results: RetrievedMemory[]): number {
    const critical = this.config.criticalMemories;
    if (critical.length === 0) return 1; // 未配置关键记忆，默认满分

    const allContent = results.map(r => r.content || '').join(' ');
    let found = 0;
    for (const mem of critical) {
      if (allContent.includes(mem)) {
        found++;
      }
    }

    return found / critical.length;
  }

  /**
   * 获取平均评估结果（最近 N 次）
   */
  getAverageResult(n?: number): MemoryEvalResult | null {
    const recent = this.checkpoints.slice(-(n ?? 10));
    if (recent.length === 0) return null;

    let precision = 0;
    let relevance = 0;
    let hallucinationRate = 0;
    let persistence = 0;

    for (const cp of recent) {
      precision += cp.evalResult.precision;
      relevance += cp.evalResult.relevance;
      hallucinationRate += cp.evalResult.hallucinationRate;
      persistence += cp.evalResult.persistence;
    }

    const count = recent.length;
    const result: MemoryEvalResult = {
      timestamp: Date.now(),
      precision: Math.round(precision / count * 100) / 100,
      relevance: Math.round(relevance / count * 100) / 100,
      hallucinationRate: Math.round(hallucinationRate / count * 100) / 100,
      persistence: Math.round(persistence / count * 100) / 100,
      details: [],
    };

    return result;
  }

  /**
   * 更新关键记忆列表
   */
  setCriticalMemories(memories: string[]): void {
    this.config.criticalMemories = memories;
  }

  /**
   * 更新已知事实库
   */
  setGroundTruth(truth: string[]): void {
    this.config.groundTruth = truth;
  }

  /**
   * 导出所有检查点
   */
  export(): MemoryCheckpoint[] {
    return [...this.checkpoints];
  }

  /**
   * 清除历史
   */
  clear(): void {
    this.checkpoints = [];
  }
}

export default MemoryEvaluator;
