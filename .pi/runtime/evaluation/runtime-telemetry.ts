/**
 * Runtime Telemetry
 *
 * Phase 3.5 — Runtime Validation & Telemetry
 *
 * 记录运行时遥测数据，支持时间轴回放。
 *
 * 数据分类：
 * - token usage      Token 用量
 * - attention score  注意力分数
 * - memory recall    记忆召回
 * - salience ranking 显著性排名
 * - goal activation  目标激活
 * - scheduler activity 调度器活动
 */

import type { PipelineLog } from '../context/pipeline-executor';
import type { MemoryQuery, RetrievedMemory } from '../context/active-memory';

// ============================================================
// 遥测记录类型
// ============================================================

/** 遥测事件类型 */
export type TelemetryEventType =
  | 'token_usage'
  | 'attention_score'
  | 'memory_recall'
  | 'salience_ranking'
  | 'goal_activation'
  | 'scheduler_activity';

/** 基础遥测记录 */
export interface TelemetryRecord {
  /** 记录 id */
  id: string;
  /** 时间戳 */
  timestamp: number;
  /** 游戏轮数 */
  turnIndex: number;
  /** 事件类型 */
  type: TelemetryEventType;
  /** 来源模块标识 */
  source: string;
  /** 具体数据 */
  data: TelemetryData;
}

/** 各类型数据联合 */
export type TelemetryData =
  | TokenUsageData
  | AttentionScoreData
  | MemoryRecallData
  | SalienceRankingData
  | GoalActivationData
  | SchedulerActivityData;

// --- 各类型数据结构 ---

export interface TokenUsageData {
  stage: string;               // 'pipeline' | 'attention' | 'autonomous'
  totalTokens: number;
  budgetLimit: number;
  utilizationRate: number;     // totalTokens / budgetLimit
  details?: {
    systemTokens?: number;
    worldbookTokens?: number;
    historyTokens?: number;
    userTokens?: number;
  };
}

export interface AttentionScoreData {
  layer: string;
  before: number;
  after: number;
  delta: number;
  reason: string;              // 'tick' | 'reinforce' | 'decay' | 'inject'
}

export interface MemoryRecallData {
  query: MemoryQuery;
  resultCount: number;
  totalResults: number;
  avgRelevance: number;
  topKeywords: string[];
}

export interface SalienceRankingData {
  dimensions: Record<string, number>;
  topDimension: string;
  topScore: number;
  totalScore: number;
}

export interface GoalActivationData {
  goalId: string;
  goalName: string;
  activationScore: number;
  priority: number;
  trigger: string;             // 触发原因
}

export interface SchedulerActivityData {
  tickType: string;            // 'agent' | 'memory' | 'goal' | 'event' | 'background'
  agentCount?: number;
  durationMs: number;
  tasksQueued: number;
  tasksCompleted: number;
}

// ============================================================
// TelemetrySnapshot — 某个时间点的全状态快照
// ============================================================

export interface TelemetrySnapshot {
  timestamp: number;
  turnIndex: number;
  /** 累计 Token 消耗 */
  totalTokensUsed: number;
  /** 当前上下文 Token 用量 */
  currentContextTokens: number;
  /** 各层注意力分数 */
  attention: Record<string, number>;
  /** 累计记忆召回次数 */
  totalMemoryRecalls: number;
  /** 活跃 Agent 数 */
  activeAgentCount: number;
  /** 调度器状态 */
  scheduler: {
    totalTicks: number;
    pendingTasks: number;
    lastTickDuration: number;
  };
}

// ============================================================
// 时间轴回放接口
// ============================================================

export interface TimelineFrame {
  turnIndex: number;
  timestamp: number;
  records: TelemetryRecord[];
  snapshot: TelemetrySnapshot | null;
}

// ============================================================
// RuntimeTelemetry 主类
// ============================================================

export class RuntimeTelemetry {
  private records: TelemetryRecord[] = [];
  private snapshots: TelemetrySnapshot[] = [];
  /** 累计计数器 */
  private counters = {
    totalTokens: 0,
    totalMemoryRecalls: 0,
    totalSchedulerTicks: 0,
  };

  // ============================================================
  // 记录方法
  // ============================================================

  /**
   * 记录 Token 用量
   */
  recordTokenUsage(
    turnIndex: number,
    source: string,
    data: TokenUsageData
  ): TelemetryRecord {
    const record = this.createRecord(turnIndex, 'token_usage', source, data);
    this.counters.totalTokens += data.totalTokens;
    return record;
  }

  /**
   * 记录注意力分数变化
   */
  recordAttentionScore(
    turnIndex: number,
    source: string,
    data: AttentionScoreData
  ): TelemetryRecord {
    return this.createRecord(turnIndex, 'attention_score', source, data);
  }

  /**
   * 记录记忆召回
   */
  recordMemoryRecall(
    turnIndex: number,
    source: string,
    data: MemoryRecallData
  ): TelemetryRecord {
    const record = this.createRecord(turnIndex, 'memory_recall', source, data);
    this.counters.totalMemoryRecalls++;
    return record;
  }

  /**
   * 记录显著性排名
   */
  recordSalienceRanking(
    turnIndex: number,
    source: string,
    data: SalienceRankingData
  ): TelemetryRecord {
    return this.createRecord(turnIndex, 'salience_ranking', source, data);
  }

  /**
   * 记录目标激活
   */
  recordGoalActivation(
    turnIndex: number,
    source: string,
    data: GoalActivationData
  ): TelemetryRecord {
    return this.createRecord(turnIndex, 'goal_activation', source, data);
  }

  /**
   * 记录调度器活动
   */
  recordSchedulerActivity(
    turnIndex: number,
    source: string,
    data: SchedulerActivityData
  ): TelemetryRecord {
    const record = this.createRecord(turnIndex, 'scheduler_activity', source, data);
    this.counters.totalSchedulerTicks++;
    return record;
  }

  // ============================================================
  // 快照方法
  // ============================================================

  /**
   * 记录一个时间点快照
   */
  recordSnapshot(
    turnIndex: number,
    currentContextTokens: number,
    attention: Record<string, number>,
    activeAgentCount: number,
    pendingTasks: number,
    lastTickDuration: number
  ): TelemetrySnapshot {
    const snapshot: TelemetrySnapshot = {
      timestamp: Date.now(),
      turnIndex,
      totalTokensUsed: this.counters.totalTokens,
      currentContextTokens,
      attention,
      totalMemoryRecalls: this.counters.totalMemoryRecalls,
      activeAgentCount,
      scheduler: {
        totalTicks: this.counters.totalSchedulerTicks,
        pendingTasks,
        lastTickDuration,
      },
    };
    this.snapshots.push(snapshot);
    return snapshot;
  }

  // ============================================================
  // 查询方法
  // ============================================================

  /**
   * 按类型查询遥测记录
   */
  queryByType(type: TelemetryEventType, limit?: number): TelemetryRecord[] {
    const filtered = this.records.filter(r => r.type === type);
    return limit ? filtered.slice(-limit) : filtered;
  }

  /**
   * 按轮数范围查询
   */
  queryByTurnRange(start: number, end: number): TelemetryRecord[] {
    return this.records.filter(r => r.turnIndex >= start && r.turnIndex <= end);
  }

  /**
   * 按来源查询
   */
  queryBySource(source: string, limit?: number): TelemetryRecord[] {
    const filtered = this.records.filter(r => r.source === source);
    return limit ? filtered.slice(-limit) : filtered;
  }

  // ============================================================
  // 时间轴回放
  // ============================================================

  /**
   * 生成时间轴帧序列（用于回放）
   */
  generateTimeline(): TimelineFrame[] {
    // 按 turnIndex 分组
    const turnGroups = new Map<number, TelemetryRecord[]>();
    for (const record of this.records) {
      if (!turnGroups.has(record.turnIndex)) {
        turnGroups.set(record.turnIndex, []);
      }
      turnGroups.get(record.turnIndex)!.push(record);
    }

    const timeline: TimelineFrame[] = [];
    for (const [turnIndex, records] of turnGroups) {
      const snapshot = this.snapshots.find(s => s.turnIndex === turnIndex) || null;
      timeline.push({
        turnIndex,
        timestamp: records[0]?.timestamp ?? Date.now(),
        records,
        snapshot,
      });
    }

    // 按 turnIndex 排序
    timeline.sort((a, b) => a.turnIndex - b.turnIndex);
    return timeline;
  }

  /**
   * 生成摘要统计
   */
  getSummary(): string {
    const totalRecords = this.records.length;
    const totalSnapshots = this.snapshots.length;
    const typeCounts: Record<string, number> = {};

    for (const r of this.records) {
      typeCounts[r.type] = (typeCounts[r.type] || 0) + 1;
    }

    const lines = [
      '== Runtime Telemetry Summary ==',
      `总记录数: ${totalRecords}`,
      `总快照数: ${totalSnapshots}`,
      `累计 Token 消耗: ${this.counters.totalTokens}`,
      `累计记忆召回: ${this.counters.totalMemoryRecalls}`,
      `累计调度器 Ticks: ${this.counters.totalSchedulerTicks}`,
      '',
      '按类型分布:',
    ];

    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${type}: ${count}`);
    }

    return lines.join('\n');
  }

  /**
   * 导出全部数据
   */
  export(): {
    records: TelemetryRecord[];
    snapshots: TelemetrySnapshot[];
    counters: { totalTokens: number; totalMemoryRecalls: number; totalSchedulerTicks: number };
  } {
    return {
      records: [...this.records],
      snapshots: [...this.snapshots],
      counters: { ...this.counters },
    };
  }

  /**
   * 清除数据
   */
  clear(): void {
    this.records = [];
    this.snapshots = [];
    this.counters = { totalTokens: 0, totalMemoryRecalls: 0, totalSchedulerTicks: 0 };
  }

  // ============================================================
  // 内部方法
  // ============================================================

  private createRecord(
    turnIndex: number,
    type: TelemetryEventType,
    source: string,
    data: TelemetryData
  ): TelemetryRecord {
    const record: TelemetryRecord = {
      id: `tel_${type}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      turnIndex,
      type,
      source,
      data,
    };
    this.records.push(record);
    return record;
  }
}

export default RuntimeTelemetry;
