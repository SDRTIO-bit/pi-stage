/**
 * Context Assembly Engine - 运行时压缩引擎
 *
 * 多层压缩策略：
 * 1. 截断压缩（truncate）- 从尾部裁剪
 * 2. 摘要压缩（summarize）- 提取核心信息
 * 3. 选择压缩（select）- 保留最重要的部分
 * 4. 占位符压缩（placeholder）- 替换为简要引用
 *
 * 压缩层级：
 * - scene_summary: 场景级摘要（当前正在发生什么）
 * - memory_abstraction: 记忆级抽象（过去发生了什么）
 * - relation_abstraction: 关系级抽象（角色间关系状态）
 * - history_compression: 对话历史压缩
 */

import type { ContextSegment, TokenBudget } from './context-controller';
import type { PriorityLayer, CompressionStrategy } from './priority-layer';

// ============================================================
// 压缩结果
// ============================================================

export interface CompressionResult {
  /** 压缩后的片段 */
  segment: ContextSegment;
  /** 压缩前 token 数 */
  originalTokens: number;
  /** 压缩后 token 数 */
  compressedTokens: number;
  /** 压缩比 */
  ratio: number;
  /** 压缩方法 */
  method: CompressionStrategy;
  /** 是否发生了信息丢失 */
  informationLoss: boolean;
  /** 丢失比例估计 (0-1) */
  lossEstimate: number;
}

// ============================================================
// 压缩引擎
// ============================================================

export class CompressionEngine {
  /**
   * 核心入口：对单个 ContextSegment 执行压缩
   */
  async compress(
    segment: ContextSegment,
    targetTokens: number,
    strategy: CompressionStrategy,
    layer: PriorityLayer
  ): Promise<CompressionResult> {
    const originalTokens = segment.tokenCount;

    if (originalTokens <= targetTokens) {
      return {
        segment,
        originalTokens,
        compressedTokens: originalTokens,
        ratio: 1,
        method: strategy,
        informationLoss: false,
        lossEstimate: 0,
      };
    }

    switch (strategy) {
      case 'none':
        return this.compressNone(segment, targetTokens);
      case 'truncate':
        return this.compressTruncate(segment, targetTokens);
      case 'summarize':
        return this.compressSummarize(segment, targetTokens);
      case 'select':
        return this.compressSelect(segment, targetTokens);
      case 'placeholder':
        return this.compressPlaceholder(segment, targetTokens);
      default:
        return this.compressTruncate(segment, targetTokens);
    }
  }

  /**
   * 不压缩（但可能根据目标截断）
   */
  private async compressNone(
    segment: ContextSegment,
    targetTokens: number
  ): Promise<CompressionResult> {
    const originalTokens = segment.tokenCount;
    return {
      segment,
      originalTokens,
      compressedTokens: originalTokens,
      ratio: 1,
      method: 'none',
      informationLoss: false,
      lossEstimate: 0,
    };
  }

  /**
   * 截断压缩：从尾部删除
   * 适用：短期记忆、历史记录
   */
  private async compressTruncate(
    segment: ContextSegment,
    targetTokens: number
  ): Promise<CompressionResult> {
    const originalTokens = segment.tokenCount;
    const ratio = targetTokens / originalTokens;
    const targetChars = Math.floor(segment.content.length * ratio);

    // 找到合适的截断点（段落末尾）
    const truncated = this.findTruncationPoint(segment.content, targetChars);

    const result: ContextSegment = {
      ...segment,
      content: truncated + '\n\n... (截断压缩，保留核心内容)',
      tokenCount: targetTokens,
      isCompressed: true,
      compressionRatio: ratio,
    };

    return {
      segment: result,
      originalTokens,
      compressedTokens: targetTokens,
      ratio,
      method: 'truncate',
      informationLoss: true,
      lossEstimate: 1 - ratio,
    };
  }

  /**
   * 寻找段落级截断点
   */
  private findTruncationPoint(content: string, targetChars: number): string {
    if (content.length <= targetChars) return content;

    const truncated = content.slice(0, targetChars);
    // 尝试在段落边界截断
    const lastParaBreak = truncated.lastIndexOf('\n\n');
    if (lastParaBreak > targetChars * 0.5) {
      return truncated.slice(0, lastParaBreak);
    }

    const lastLineBreak = truncated.lastIndexOf('\n');
    if (lastLineBreak > targetChars * 0.8) {
      return truncated.slice(0, lastLineBreak);
    }

    return truncated;
  }

  /**
   * 摘要压缩：提取核心信息
   * 适用：世界书条目、角色设定
   * 
   * 实际使用时应调用 LLM 生成摘要
   * 当前实现：启发式提取关键行
   */
  private async compressSummarize(
    segment: ContextSegment,
    targetTokens: number
  ): Promise<CompressionResult> {
    const originalTokens = segment.tokenCount;
    const lines = segment.content.split('\n');

    // 启发式：保留含有关键词的句子
    const importantKeywords = [
      '规则', '禁止', '必须', '不能', '核心', '重要',
      '身份', '角色', '设定', '世界观', '规则',
      '你叫', '你是', '你的', '你有',
      '通常', '默认', '基本',
    ];

    const importantLines: string[] = [];
    const lessImportantLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // 标题行优先保留
      if (trimmed.startsWith('#') || trimmed.startsWith('##') || trimmed.startsWith('###')) {
        importantLines.push(trimmed);
        continue;
      }

      // 含重要关键词的保留
      if (importantKeywords.some(kw => trimmed.includes(kw))) {
        importantLines.push(trimmed);
        continue;
      }

      // 含具体数值/状态的保留
      if (/\d+/.test(trimmed) || trimmed.includes('=') || trimmed.includes(':')) {
        importantLines.push(trimmed);
        continue;
      }

      lessImportantLines.push(trimmed);
    }

    // 尝试在预算内组合
    let summary = importantLines.join('\n');
    const summaryTokens = this.estimateTokens(summary);

    if (summaryTokens <= targetTokens) {
      // 还有余量，加入次要信息
      const remaining = targetTokens - summaryTokens;
      const lessImportantText = lessImportantLines.join('\n');
      const lessTokens = this.estimateTokens(lessImportantText);

      if (lessTokens <= remaining) {
        summary += '\n\n' + lessImportantText;
      } else {
        // 从次要信息中选重要的
        const targetChars = Math.floor(
          lessImportantText.length * (remaining / lessTokens)
        );
        summary += '\n\n' + lessImportantText.slice(0, targetChars);
      }
    } else {
      // 重要信息也超预算，进一步压缩
      const ratio = targetTokens / summaryTokens;
      summary = summary.slice(0, Math.floor(summary.length * ratio));
    }

    const result: ContextSegment = {
      ...segment,
      content: summary + '\n\n(摘要压缩)',
      tokenCount: targetTokens,
      isCompressed: true,
      compressionRatio: targetTokens / originalTokens,
    };

    return {
      segment: result,
      originalTokens,
      compressedTokens: targetTokens,
      ratio: targetTokens / originalTokens,
      method: 'summarize',
      informationLoss: true,
      lossEstimate: 0.3, // 摘要通常保留约 70% 信息
    };
  }

  /**
   * 选择压缩：只保留最重要的部分
   * 适用：目标列表、需求状态
   */
  private async compressSelect(
    segment: ContextSegment,
    targetTokens: number
  ): Promise<CompressionResult> {
    const originalTokens = segment.tokenCount;
    const lines = segment.content.split('\n').filter(l => l.trim());

    // 按行的重要性排序
    const scoredLines = lines.map(line => ({
      text: line,
      score: this.scoreLineImportance(line),
    }));
    scoredLines.sort((a, b) => b.score - a.score);

    // 从高到低选择
    const selected: string[] = [];
    let currentTokens = 0;

    for (const sl of scoredLines) {
      const lineTokens = this.estimateTokens(sl.text);
      if (currentTokens + lineTokens > targetTokens) break;
      selected.push(sl.text);
      currentTokens += lineTokens;
    }

    const result: ContextSegment = {
      ...segment,
      content: selected.join('\n') + '\n\n(选择压缩，保留优先级最高的内容)',
      tokenCount: currentTokens,
      isCompressed: true,
      compressionRatio: currentTokens / originalTokens,
    };

    return {
      segment: result,
      originalTokens,
      compressedTokens: currentTokens,
      ratio: currentTokens / originalTokens,
      method: 'select',
      informationLoss: true,
      lossEstimate: 1 - selected.length / lines.length,
    };
  }

  /**
   * 评估行的信息重要性
   */
  private scoreLineImportance(line: string): number {
    let score = 0;

    // 标题
    if (line.startsWith('#')) score += 3;
    if (line.startsWith('##')) score += 2;
    if (line.startsWith('###')) score += 1;

    // 含关键标记
    if (line.includes('⚠️') || line.includes('🔴') || line.includes('❗')) score += 3;
    if (line.includes('🟡') || line.includes('❗')) score += 2;

    // 含规则关键词
    const ruleKeywords = ['必须', '禁止', '不能', '需要', '规则', '核心'];
    if (ruleKeywords.some(kw => line.includes(kw))) score += 2;

    // 含数据
    if (/\d+/.test(line)) score += 1;

    // 含角色名称
    if (/[A-Z]\w+/.test(line) || line.includes(':')) score += 1;

    return score;
  }

  /**
   * 占位符压缩：替换为简要引用
   * 适用：历史摘要、远距离记忆
   */
  private async compressPlaceholder(
    segment: ContextSegment,
    targetTokens: number
  ): Promise<CompressionResult> {
    const originalTokens = segment.tokenCount;

    // 生成占位符文本
    const placeholder = this.generatePlaceholder(segment);

    const result: ContextSegment = {
      ...segment,
      content: placeholder,
      tokenCount: targetTokens,
      isCompressed: true,
      compressionRatio: targetTokens / originalTokens,
    };

    return {
      segment: result,
      originalTokens,
      compressedTokens: targetTokens,
      ratio: targetTokens / originalTokens,
      method: 'placeholder',
      informationLoss: true,
      lossEstimate: 0.8, // 占位符丢失大量细节
    };
  }

  /**
   * 生成占位符（提取关键摘要行 + 索引信息）
   */
  private generatePlaceholder(segment: ContextSegment): string {
    const lines = segment.content.split('\n').filter(l => l.trim());
    const firstLines = lines.slice(0, Math.min(3, lines.length));
    const totalLines = lines.length;

    return [
      ...firstLines,
      `... (共 ${totalLines} 行，已压缩为占位符。如需完整内容请使用 recall_memory 工具)`,
    ].join('\n');
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

// ============================================================
// 多层摘要工厂
// ============================================================

export class MultiLayerSummarizer {
  /**
   * 生成三层摘要
   * 
   * 1. scene_summary: 当前场景（最近 3-5 轮）
   * 2. memory_abstraction: 记忆抽象（过去重要事件）
   * 3. relation_abstraction: 关系抽象（角色间关系状态）
   */
  async generateSummaries(
    recentHistory: string[],
    memoryEntries: ContextSegment[],
    relationships: Map<string, number>
  ): Promise<Summaries> {
    const [scene, memory, relation] = await Promise.all([
      this.summarizeScene(recentHistory),
      this.abstractionMemory(memoryEntries),
      this.abstractionRelation(relationships),
    ]);

    return { scene, memory, relation };
  }

  private async summarizeScene(history: string[]): Promise<string> {
    if (history.length === 0) return '（无最近活动）';

    // 提取最近几轮的核心事件
    const recent = history.slice(-5);
    const lines: string[] = ['【当前场景】'];
    for (const turn of recent) {
      const firstLine = turn.split('\n')[0];
      if (firstLine) lines.push(`- ${firstLine.slice(0, 80)}`);
    }

    return lines.join('\n');
  }

  private async abstractionMemory(
    entries: ContextSegment[]
  ): Promise<string> {
    if (entries.length === 0) return '（无重要记忆）';

    const sorted = [...entries].sort(
      (a, b) => b.metadata.importance - a.metadata.importance
    );

    const topMemories = sorted.slice(0, 3);
    const lines: string[] = ['【重要记忆】'];
    for (const mem of topMemories) {
      const content = mem.content.split('\n')[0]?.slice(0, 60);
      if (content) lines.push(`- ${content}`);
    }

    return lines.join('\n');
  }

  private async abstractionRelation(
    relationships: Map<string, number>
  ): Promise<string> {
    if (relationships.size === 0) return '';

    const lines: string[] = ['【关系状态】'];
    for (const [name, value] of relationships) {
      const status = value >= 80 ? '亲密' : value >= 60 ? '友好' : value >= 40 ? '中立' : '疏远';
      lines.push(`- ${name}: ${status} (${value})`);
    }

    return lines.join('\n');
  }
}

export interface Summaries {
  scene: string;
  memory: string;
  relation: string;
}

export default CompressionEngine;
