/**
 * Attention Evaluator
 *
 * Phase 3.5 — Runtime Validation & Telemetry
 *
 * 评估注意力系统效果：
 * - token allocation effectiveness  Token 分配效率
 * - reinforcement effectiveness    指令强化效果
 * - context saturation              上下文饱和检测
 * - instruction preservation         跨轮指令保持率
 */

// 本模块使用内联定义而非引用运行时模块，以保持 evaluation 的模块独立性

// PipelineLog 最小子集
interface PipelineLog {
  stageName: string;
  inputSize: number;
  outputSize: number;
  durationMs: number;
}
// ============================================================
// 类型定义
// ============================================================

export interface AttentionEvalResult {
  timestamp: number;
  /** Token 分配效率（0~1） */
  tokenAllocEffectiveness: number;
  /** 指令强化效果（0~1） */
  reinforceEffectiveness: number;
  /** 上下文饱和度（0~1，1 = 完全饱和） */
  contextSaturation: number;
  /** 指令跨轮保持率（0~1） */
  instructionPreservation: number;
  details: AttentionEvalDetail[];
}

export interface AttentionEvalDetail {
  dimension: 'token_alloc' | 'reinforce' | 'saturation' | 'preservation';
  score: number;
  detail: string;
  evidence?: string[];
}

export interface AttentionCheckpoint {
  id: string;
  timestamp: number;
  turnIndex: number;
  pipelineLog: PipelineLog[];
  attentionSnapshot: Record<string, number>;
  evalResult: AttentionEvalResult;
}

// ============================================================
// 配置
// ============================================================

export interface AttentionEvaluatorConfig {
  /** 各层权重参考（优先级层 → 期望 Token 占比） */
  layerWeightExpectations?: Partial<Record<string, number>>;
  /** 期望 Token 总预算 */
  expectedTotalBudget?: number;
  /** 强化跟踪的规则 ID 列表 */
  trackedRules?: string[];
  /** 饱和阈值（超过此值认为上下文已满） */
  saturationThreshold?: number;      // 默认 0.8
  /** 指令保持跟踪的关键词 */
  preservationKeywords?: string[];
}

// ============================================================
// AttentionEvaluator 主类
// ============================================================

export class AttentionEvaluator {
  private config: Required<AttentionEvaluatorConfig>;
  private checkpoints: AttentionCheckpoint[] = [];
  /** 跨轮指令保持记录 */
  private preservationLog: { turnIndex: number; keyword: string; present: boolean }[] = [];

  constructor(config: AttentionEvaluatorConfig = {}) {
    // 默认各层权重期待（优先级越高的层期望得到更多预算）
    const defaultLayerWeights: Record<string, number> = {
      system: 0.9,
      instruction: 0.8,
      worldbook: 0.6,
      user: 0.5,
      history: 0.4,
      chat: 0.3,
      lore: 0.3,
    };

    this.config = {
      layerWeightExpectations: config.layerWeightExpectations || defaultLayerWeights,
      expectedTotalBudget: config.expectedTotalBudget ?? 8000,
      trackedRules: config.trackedRules || [],
      saturationThreshold: config.saturationThreshold ?? 0.8,
      preservationKeywords: config.preservationKeywords || [],
    };
  }

  /**
   * 评估一次注意力分配的效果
   */
  evaluate(
    turnIndex: number,
    pipelineLogs: PipelineLog[],
    attentionSnapshot: Record<string, number>
  ): AttentionCheckpoint {
    const tokenAllocEffectiveness = this.calcTokenAllocEffectiveness(pipelineLogs, attentionSnapshot);
    const reinforceEffectiveness = this.calcReinforceEffectiveness(pipelineLogs);
    const contextSaturation = this.calcContextSaturation(pipelineLogs);
    const instructionPreservation = this.calcInstructionPreservation(turnIndex);

    const evalResult: AttentionEvalResult = {
      timestamp: Date.now(),
      tokenAllocEffectiveness,
      reinforceEffectiveness,
      contextSaturation,
      instructionPreservation,
      details: [
        {
          dimension: 'token_alloc',
          score: tokenAllocEffectiveness,
          detail: `Token 分配效率 ${(tokenAllocEffectiveness * 100).toFixed(0)}%`,
        },
        {
          dimension: 'reinforce',
          score: reinforceEffectiveness,
          detail: `指令强化效果 ${(reinforceEffectiveness * 100).toFixed(0)}%`,
        },
        {
          dimension: 'saturation',
          score: contextSaturation,
          detail: `上下文饱和度 ${(contextSaturation * 100).toFixed(0)}%${contextSaturation >= this.config.saturationThreshold ? ' ⚠️ 饱和' : ''}`,
        },
        {
          dimension: 'preservation',
          score: instructionPreservation,
          detail: `指令跨轮保持率 ${(instructionPreservation * 100).toFixed(0)}%`,
        },
      ],
    };

    const checkpoint: AttentionCheckpoint = {
      id: `attn_eval_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      turnIndex,
      pipelineLog: pipelineLogs,
      attentionSnapshot,
      evalResult,
    };

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Token 分配效率
   *
   * 比较各优先级层的实际压缩率 vs 期望权重。
   * 如果高优先级层（如 system）的 inputSize/outputSize 比值更接近 1（未压缩），
   * 低优先级层被压缩更多，则分配高效。
   */
  private calcTokenAllocEffectiveness(
    logs: PipelineLog[],
    snapshot: Record<string, number>
  ): number {
    if (logs.length === 0) return 0;

    // 找 compress 和 prioritize 阶段的日志
    const compressLog = logs.find(l => l.stageName === 'compress');
    const prioritizeLog = logs.find(l => l.stageName === 'prioritize');

    if (!compressLog && !prioritizeLog) return 0.5; // 无数据时中性评分

    let score = 0;
    let checks = 0;

    // 检查：compress 阶段的压缩率（越低越好，但不要 < 0.1）
    if (compressLog) {
      const ratio = compressLog.inputSize > 0
        ? compressLog.outputSize / compressLog.inputSize
        : 1;
      // 理想压缩率 0.3~0.7
      if (ratio >= 0.3 && ratio <= 0.7) score += 1;
      else if (ratio < 0.3) score += 0.5; // 过度压缩
      else score += 0.3; // 压缩不足
      checks++;
    }

    // 检查：注意力分布是否与权重期望一致
    const expectations = this.config.layerWeightExpectations;
    for (const [layerName, ew] of Object.entries(expectations)) {
      const expectedWeight = ew as number;
      const actual = snapshot[layerName] ?? 0;
      if (expectedWeight > 0) {
        const ratio = Math.min(actual / expectedWeight, 2);
        if (ratio >= 0.5 && ratio <= 1.5) score += 1;
        else score += 0.3;
        checks++;
      }
    }

    return checks > 0 ? Math.round(score / checks * 100) / 100 : 0.5;
  }

  /**
   * 指令强化效果
   *
   * 检查 reinforce 阶段的输出是否包含强化指令。
   */
  private calcReinforceEffectiveness(logs: PipelineLog[]): number {
    const reinforceLog = logs.find(l => l.stageName === 'reinforce');
    if (!reinforceLog) return 0;

    // 强化阶段 inputSize 和 outputSize 的变化量反映强化指令的注入量
    const delta = reinforceLog.outputSize - reinforceLog.inputSize;
    const expectedDelta = 200; // 期望注入 200 token 的强化指令

    if (delta <= 0) return 0;
    return Math.min(delta / expectedDelta, 1);
  }

  /**
   * 上下文饱和度
   *
   * 基于 pipeline 各阶段的 inputSize 趋势判断上下文是否已满。
   * 如果多个阶段的 inputSize 接近 expectedTotalBudget，则视为饱和。
   */
  private calcContextSaturation(logs: PipelineLog[]): number {
    if (logs.length === 0) return 0;

    const budget = this.config.expectedTotalBudget;
    const inputSizes = logs.filter(l => l.stageName !== 'render').map(l => l.inputSize);

    if (inputSizes.length === 0) return 0;

    const avgInput = inputSizes.reduce((a, b) => a + b, 0) / inputSizes.length;
    const saturation = Math.min(avgInput / budget, 1);

    return Math.round(saturation * 100) / 100;
  }

  /**
   * 指令跨轮保持率
   *
   * 跟踪 preservationKeywords 在每轮注意力快照中的存在情况。
   */
  private calcInstructionPreservation(turnIndex: number): number {
    const keywords = this.config.preservationKeywords;
    if (keywords.length === 0) return 1; // 无跟踪时默认满分

    // 检查最近 N 轮中关键词的保持情况
    const recent = this.preservationLog.filter(
      l => l.turnIndex > turnIndex - 10 && l.turnIndex <= turnIndex
    );

    if (recent.length === 0) return 1;

    // 按关键词分组统计
    const keywordStats: Record<string, { total: number; present: number }> = {};
    for (const entry of recent) {
      if (!keywordStats[entry.keyword]) {
        keywordStats[entry.keyword] = { total: 0, present: 0 };
      }
      keywordStats[entry.keyword].total++;
      if (entry.present) keywordStats[entry.keyword].present++;
    }

    const scores = Object.values(keywordStats).map(s => s.present / s.total);
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * 记录一条指令保持的观测
   */
  recordPreservation(turnIndex: number, keyword: string, present: boolean): void {
    this.preservationLog.push({ turnIndex, keyword, present });
  }

  /**
   * 获取平均评估结果
   */
  getAverageResult(n?: number): AttentionEvalResult | null {
    const recent = this.checkpoints.slice(-(n ?? 10));
    if (recent.length === 0) return null;

    const avg: AttentionEvalResult = {
      timestamp: Date.now(),
      tokenAllocEffectiveness: 0,
      reinforceEffectiveness: 0,
      contextSaturation: 0,
      instructionPreservation: 0,
      details: [],
    };

    for (const cp of recent) {
      avg.tokenAllocEffectiveness += cp.evalResult.tokenAllocEffectiveness;
      avg.reinforceEffectiveness += cp.evalResult.reinforceEffectiveness;
      avg.contextSaturation += cp.evalResult.contextSaturation;
      avg.instructionPreservation += cp.evalResult.instructionPreservation;
    }

    const count = recent.length;
    avg.tokenAllocEffectiveness = Math.round(avg.tokenAllocEffectiveness / count * 100) / 100;
    avg.reinforceEffectiveness = Math.round(avg.reinforceEffectiveness / count * 100) / 100;
    avg.contextSaturation = Math.round(avg.contextSaturation / count * 100) / 100;
    avg.instructionPreservation = Math.round(avg.instructionPreservation / count * 100) / 100;

    return avg;
  }

  /**
   * 导出
   */
  export(): { checkpoints: AttentionCheckpoint[]; preservationLog: { turnIndex: number; keyword: string; present: boolean }[] } {
    return { checkpoints: [...this.checkpoints], preservationLog: [...this.preservationLog] };
  }

  /**
   * 清除
   */
  clear(): void {
    this.checkpoints = [];
    this.preservationLog = [];
  }
}

export default AttentionEvaluator;
