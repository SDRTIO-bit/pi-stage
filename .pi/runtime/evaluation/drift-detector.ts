/**
 * Drift Detector
 *
 * Phase 3.5 — Runtime Validation & Telemetry
 *
 * 检测四种漂移：
 * - role drift     角色设定偏离
 * - style drift    文风偏离
 * - instruction drift  指令遵守率下降
 * - formatting drift   格式规范偏离
 *
 * 每条输出附带 drift score（0~1），1 = 完全漂移。
 */

import type { AssembledContext } from '../context/context-controller';
import type { PipelineLog } from '../context/pipeline-executor';

// ============================================================
// 类型定义
// ============================================================

export interface DriftScore {
  /** 总体漂移分（加权平均） */
  overall: number;
  /** 各维度细项 */
  items: DriftItem[];
}

export interface DriftItem {
  dimension: 'role' | 'style' | 'instruction' | 'formatting';
  score: number;          // 0~1
  detail: string;         // 人可读说明
  evidence: string[];     // 导致漂移的文本片段
}

export interface DriftCheckpoint {
  /** 漂移记录 id */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 检查来源（benchmark / inline / manual） */
  source: string;
  /** 轮数编号 */
  turnIndex: number;
  /** 该轮漂移分 */
  score: DriftScore;
  /** 附加的环境快照 */
  contextSnapshot?: {
    segmentsCount: number;
    totalTokens: number;
    compressionRatio?: number;
    attentionDecay?: number;
  };
}

export type DriftDimension = DriftItem['dimension'];

// ============================================================
// 配置
// ============================================================

export interface DriftDetectorConfig {
  /** 角色设定参考文本（通常为系统提示中的角色定义段） */
  roleReference?: string;
  /** 文风参考样本（3~5 条高质量回复） */
  styleSamples?: string[];
  /** 有效指令关键词列表 */
  instructionKeywords?: string[];
  /** 格式规范标记列表（如 <choice>、<content>、## 等） */
  formattingMarkers?: string[];
  /** 漂移严重阈值（>= 此值触发告警） */
  alertThreshold?: number;   // 默认 0.4
  /** 历史窗口大小（用于滑动平均） */
  historyWindow?: number;    // 默认 5 轮
}

// ============================================================
// 评估策略接口
// ============================================================

export interface DriftStrategy {
  evaluate(text: string, context: DriftContext): DriftItem;
}

export interface DriftContext {
  roleReference?: string;
  styleSamples?: string[];
  instructionKeywords?: string[];
  formattingMarkers?: string[];
  pipelineLog?: PipelineLog | null;
}

// ============================================================
// 默认策略实现
// ============================================================

/**
 * 角色漂移检测
 *
 * 策略：检查回复中角色特质关键词命中率。
 * 如果参考文本包含 "温柔""害羞""冷淡" 等特质词，
 * 回复中连续缺失则视为角色漂移。
 */
export class RoleDriftStrategy implements DriftStrategy {
  evaluate(text: string, ctx: DriftContext): DriftItem {
    const ref = ctx.roleReference || '';
    const evidence: string[] = [];

    // 从参考文本提取特质词（去掉高频虚词）
    const traitWords = this.extractTraits(ref);

    if (traitWords.length === 0) {
      return {
        dimension: 'role',
        score: 0,
        detail: '无角色参考文本，跳过角色漂移检测',
        evidence: [],
      };
    }

    let hits = 0;
    for (const word of traitWords) {
      if (text.includes(word)) {
        hits++;
      } else {
        // 连续缺失 3 个特质词才记证据
        if (evidence.length < 3) {
          evidence.push(`未检测到特质词「${word}」`);
        }
      }
    }

    // score = 1 - (命中率 / 期望命中率)
    // 期望在回复中至少出现 60% 的特质词
    const hitRate = traitWords.length > 0 ? hits / traitWords.length : 0;
    const expectedRate = 0.6;
    const score = Math.max(0, Math.min(1, 1 - hitRate / expectedRate));

    return {
      dimension: 'role',
      score: Math.round(score * 100) / 100,
      detail: `角色特质词命中 ${hits}/${traitWords.length}（期望 ≥${Math.round(expectedRate * traitWords.length)}），漂移分 ${Math.round(score * 100)}%`,
      evidence: evidence.slice(0, 3),
    };
  }

  /** 从参考文本中提取可能的特质词 */
  private extractTraits(text: string): string[] {
    // 简单策略：提取非中/英文停用词的双字及以上词
    // 此处用启发式：取长度 2~6 的字符段，排除频率最高的 30 个虚词
    const stopWords = new Set([
      '一个','可以','这个','那个','什么','没有','不是','就是',
      '但是','如果','因为','所以','而且','然后','虽然','还是',
      '只是','或者','已经','知道','觉得','开始','出现','感觉',
      '应该','不能','可能','需要','看到','成为',
    ]);

    const words: string[] = [];
    // 按中英文混合割词：中文按字滑动，英文按空格
    const segments = text.split(/[\s,，。！？、；：""''【】《》（）\n\r]+/);
    for (const seg of segments) {
      if (seg.length >= 2 && seg.length <= 6 && !stopWords.has(seg)) {
        words.push(seg);
      }
    }
    // 去重
    return [...new Set(words)];
  }
}

/**
 * 文风漂移检测
 *
 * 策略：比较回复的句长分布、语气词频率、对话占比。
 */
export class StyleDriftStrategy implements DriftStrategy {
  evaluate(text: string, ctx: DriftContext): DriftItem {
    const samples = ctx.styleSamples || [];
    const evidence: string[] = [];

    if (samples.length === 0) {
      return {
        dimension: 'style',
        score: 0,
        detail: '无文风参考样本，跳过文风漂移检测',
        evidence: [],
      };
    }

    // 1. 句长分布对比
    const refAvgSentLen = this.averageSentenceLength(samples.join('\n'));
    const respAvgSentLen = this.averageSentenceLength(text);
    const sentLenRatio = refAvgSentLen > 0
      ? Math.min(respAvgSentLen / refAvgSentLen, 2)
      : 1;
    const sentLenScore = Math.abs(1 - sentLenRatio);

    // 2. 对话占比对比
    const refDialogueRatio = this.dialogueRatio(samples.join('\n'));
    const respDialogueRatio = this.dialogueRatio(text);
    const dialRatioDiff = Math.abs(refDialogueRatio - respDialogueRatio);
    const dialScore = Math.min(dialRatioDiff / 0.3, 1); // 容忍 30% 偏差

    // 3. 语气词频率对比
    const refParticleFreq = this.particleFrequency(samples.join('\n'));
    const respParticleFreq = this.particleFrequency(text);
    const particleDiff = Math.abs(refParticleFreq - respParticleFreq);
    const particleScore = Math.min(particleDiff / 0.15, 1); // 容忍 15% 偏差

    // 加权平均
    const score = Math.round((sentLenScore * 0.3 + dialScore * 0.4 + particleScore * 0.3) * 100) / 100;

    if (sentLenScore > 0.3) {
      evidence.push(`句长偏离（参考 ${refAvgSentLen.toFixed(1)} 字/句 → 当前 ${respAvgSentLen.toFixed(1)} 字/句）`);
    }
    if (dialScore > 0.3) {
      evidence.push(`对话占比偏离（参考 ${(refDialogueRatio * 100).toFixed(0)}% → 当前 ${(respDialogueRatio * 100).toFixed(0)}%）`);
    }

    return {
      dimension: 'style',
      score: Math.min(score, 1),
      detail: `句长 ${sentLenScore.toFixed(2)} / 对话 ${dialScore.toFixed(2)} / 语气词 ${particleScore.toFixed(2)}，综合漂移分 ${(score * 100).toFixed(0)}%`,
      evidence: evidence.slice(0, 3),
    };
  }

  private averageSentenceLength(text: string): number {
    const sentences = text.split(/[。！？\n]+/).filter(s => s.trim().length > 0);
    if (sentences.length === 0) return 0;
    return sentences.reduce((sum, s) => sum + s.length, 0) / sentences.length;
  }

  private dialogueRatio(text: string): number {
    // 对话定义为包含「」或 "" 或 '' 的内容
    const dialogueChars = (text.match(/[""「」""''『』]/g) || []).length;
    return text.length > 0 ? dialogueChars / text.length : 0;
  }

  private particleFrequency(text: string): number {
    const particles = ['的','了','吗','啊','呢','吧','哦','嗯','嘛','呀','啦'];
    let count = 0;
    for (const p of particles) {
      count += (text.match(new RegExp(p, 'g')) || []).length;
    }
    return text.length > 0 ? count / text.length : 0;
  }
}

/**
 * 指令漂移检测
 *
 * 策略：检查回复中是否包含指令关键词要求的内容。
 */
export class InstructionDriftStrategy implements DriftStrategy {
  evaluate(text: string, ctx: DriftContext): DriftItem {
    const keywords = ctx.instructionKeywords || [];
    const evidence: string[] = [];

    if (keywords.length === 0) {
      return {
        dimension: 'instruction',
        score: 0,
        detail: '无指令关键词列表，跳过指令漂移检测',
        evidence: [],
      };
    }

    let hits = 0;
    const missing: string[] = [];
    for (const kw of keywords) {
      if (
        text.toLowerCase().includes(kw.toLowerCase()) ||
        // 也检查等价语义模式
        this.semanticMatch(text, kw)
      ) {
        hits++;
      } else {
        if (missing.length < 3) missing.push(kw);
      }
    }

    const score = keywords.length > 0
      ? Math.round((1 - hits / keywords.length) * 100) / 100
      : 0;

    if (missing.length > 0) {
      evidence.push(`未遵守指令关键词：${missing.join('、')}`);
    }

    return {
      dimension: 'instruction',
      score,
      detail: `指令关键词遵守 ${hits}/${keywords.length}，漂移分 ${(score * 100).toFixed(0)}%`,
      evidence,
    };
  }

  /** 简单的语义等价匹配 */
  private semanticMatch(text: string, keyword: string): boolean {
    // 同义词扩展（硬编码常用 RP 指令映射）
    const synonymMap: Record<string, string[]> = {
      '选择': ['选项','挑选','决定','choice'],
      '思考': ['想','觉得','认为','内心','mind'],
      '行动': ['做','动作','act','做'],
      '对话': ['说','说话','讲','开口','say'],
    };
    const synonyms = synonymMap[keyword] || [];
    for (const syn of synonyms) {
      if (text.includes(syn)) return true;
    }
    return false;
  }
}

/**
 * 格式漂移检测
 *
 * 策略：检查回复是否包含必要的格式标记。
 */
export class FormattingDriftStrategy implements DriftStrategy {
  evaluate(text: string, ctx: DriftContext): DriftItem {
    const markers = ctx.formattingMarkers || [];
    const evidence: string[] = [];

    if (markers.length === 0) {
      return {
        dimension: 'formatting',
        score: 0,
        detail: '无格式标记列表，跳过格式漂移检测',
        evidence: [],
      };
    }

    let hits = 0;
    for (const marker of markers) {
      if (text.includes(marker)) {
        hits++;
      } else {
        if (evidence.length < 2) {
          evidence.push(`缺失格式标记「${marker}」`);
        }
      }
    }

    const score = markers.length > 0
      ? Math.round((1 - hits / markers.length) * 100) / 100
      : 0;

    return {
      dimension: 'formatting',
      score,
      detail: `格式标记 ${hits}/${markers.length}，漂移分 ${(score * 100).toFixed(0)}%`,
      evidence: evidence.slice(0, 3),
    };
  }
}

// ============================================================
// DriftDetector 主类
// ============================================================

export class DriftDetector {
  private config: Required<DriftDetectorConfig>;
  private history: DriftCheckpoint[] = [];
  private strategies: DriftStrategy[];

  constructor(config: DriftDetectorConfig = {}) {
    this.config = {
      roleReference: config.roleReference || '',
      styleSamples: config.styleSamples || [],
      instructionKeywords: config.instructionKeywords || [],
      formattingMarkers: config.formattingMarkers || [],
      alertThreshold: config.alertThreshold ?? 0.4,
      historyWindow: config.historyWindow ?? 5,
    };

    this.strategies = [
      new RoleDriftStrategy(),
      new StyleDriftStrategy(),
      new InstructionDriftStrategy(),
      new FormattingDriftStrategy(),
    ];
  }

  /**
   * 对一段回复执行全维度漂移检测
   */
  evaluate(
    response: string,
    context?: {
      source?: string;
      turnIndex?: number;
      pipelineLog?: PipelineLog | null;
    }
  ): DriftCheckpoint {
    const driftCtx: DriftContext = {
      roleReference: this.config.roleReference,
      styleSamples: this.config.styleSamples,
      instructionKeywords: this.config.instructionKeywords,
      formattingMarkers: this.config.formattingMarkers,
      pipelineLog: context?.pipelineLog || null,
    };

    const items: DriftItem[] = [];
    for (const strategy of this.strategies) {
      items.push(strategy.evaluate(response, driftCtx));
    }

    const overall = Math.round(
      items.reduce((sum, item) => sum + item.score, 0) / items.length * 100
    ) / 100;

    const checkpoint: DriftCheckpoint = {
      id: `drift_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      source: context?.source || 'inline',
      turnIndex: context?.turnIndex ?? 0,
      score: { overall, items },
      contextSnapshot: context?.pipelineLog
        ? {
            segmentsCount: 0,
            totalTokens: 0,
          }
        : undefined,
    };

    this.history.push(checkpoint);

    return checkpoint;
  }

  /**
   * 获取滑动平均漂移分
   */
  getAverageDrift(window?: number): number {
    const size = window ?? this.config.historyWindow;
    const recent = this.history.slice(-size);
    if (recent.length === 0) return 0;
    return recent.reduce((sum, cp) => sum + cp.score.overall, 0) / recent.length;
  }

  /**
   * 获取各维度趋势数据
   */
  getTrend(dimension?: DriftDimension): { turnIndex: number; score: number }[] {
    return this.history.map(cp => ({
      turnIndex: cp.turnIndex,
      score: dimension
        ? cp.score.items.find(i => i.dimension === dimension)?.score ?? 0
        : cp.score.overall,
    }));
  }

  /**
   * 检查最近 N 轮是否有漂移告警
   */
  hasAlert(window?: number): boolean {
    return this.getAverageDrift(window) >= this.config.alertThreshold;
  }

  /**
   * 获取最近的漂移告警详情
   */
  getAlerts(threshold?: number): DriftCheckpoint[] {
    const t = threshold ?? this.config.alertThreshold;
    return this.history.filter(cp => cp.score.overall >= t);
  }

  /**
   * 导出完整漂移历史
   */
  export(): DriftCheckpoint[] {
    return [...this.history];
  }

  /**
   * 清除历史
   */
  clear(): void {
    this.history = [];
  }

  /**
   * 更新配置（运行时动态调整）
   */
  updateConfig(config: Partial<DriftDetectorConfig>): void {
    Object.assign(this.config, config);
  }
}

export default DriftDetector;
