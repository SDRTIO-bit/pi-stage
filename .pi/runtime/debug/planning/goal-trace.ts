/**
 * goal-trace.ts - 目标追踪（调试/可视化）
 *
 * 记录每个 Goal 的完整生命周期时间线：
 * - 创建 → 激活 → 阻塞 → 完成/放弃/演化
 * - 提供 whyCreated(goalId) 回溯触发原因
 * - 提供目标状态变化的历史图表数据
 */

import type { GoalType, GoalStatus, GoalTrigger } from '../../planning/goal-planner';

export type GoalTraceEventType =
  | 'goal:created'
  | 'goal:activated'
  | 'goal:blocked'
  | 'goal:progressed'
  | 'goal:completed'
  | 'goal:abandoned'
  | 'goal:transformed'
  | 'goal:priority_changed'
  | 'goal:conflict_detected'
  ;

export interface GoalTraceEntry {
  id: string;
  timestamp: number;
  eventType: GoalTraceEventType;
  goalId: string;
  goalDescription: string;
  goalType: GoalType;
  /** 目标状态快照 */
  snapshot: {
    status: GoalStatus;
    priority: number;
    progress: number;
  };
  /** 变化详情 */
  changes: Record<string, any>;
  /** 触发源 */
  trigger?: GoalTrigger;
  /** 关联的目标 ID（如冲突、演化涉及的其他目标） */
  relatedGoalIds?: string[];
  description: string;
}

export class GoalTracer {
  private entries: GoalTraceEntry[] = [];
  /** 按 goalId 索引的时间线 */
  private timelines: Map<string, GoalTraceEntry[]> = new Map();
  private readonly MAX_ENTRIES = 2000;
  private idCounter: number = 0;

  /**
   * 记录目标创建
   */
  goalCreated(goalId: string, description: string, type: GoalType, priority: number, trigger: GoalTrigger): void {
    this.addEntry({
      eventType: 'goal:created',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'created', priority, progress: 0 },
      changes: { trigger },
      trigger,
      description: `目标创建: "${description}" (${type}) — 触发: ${trigger.description}`,
    });
  }

  /**
   * 记录目标激活
   */
  goalActivated(goalId: string, description: string, type: GoalType, priority: number): void {
    this.addEntry({
      eventType: 'goal:activated',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'active', priority, progress: 0 },
      changes: { previousStatus: 'created' },
      description: `目标激活: "${description}" — 优先级 ${(priority * 100).toFixed(0)}%`,
    });
  }

  /**
   * 记录目标阻塞
   */
  goalBlocked(goalId: string, description: string, type: GoalType, priority: number, reason: string): void {
    this.addEntry({
      eventType: 'goal:blocked',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'blocked', priority, progress: 0 },
      changes: { reason },
      description: `目标阻塞: "${description}" — 原因: ${reason}`,
    });
  }

  /**
   * 记录进度更新
   */
  goalProgressed(goalId: string, description: string, type: GoalType, oldProgress: number, newProgress: number, priority: number): void {
    this.addEntry({
      eventType: 'goal:progressed',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'active', priority, progress: newProgress },
      changes: { oldProgress, newProgress, delta: newProgress - oldProgress },
      description: `目标推进: "${description}" — ${(oldProgress * 100).toFixed(0)}% → ${(newProgress * 100).toFixed(0)}%`,
    });
  }

  /**
   * 记录目标完成
   */
  goalCompleted(goalId: string, description: string, type: GoalType, finalProgress: number, duration: number): void {
    this.addEntry({
      eventType: 'goal:completed',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'completed', priority: 0, progress: 1 },
      changes: { duration },
      description: `目标完成: "${description}" — 耗时 ${(duration / 1000).toFixed(1)}s`,
    });
  }

  /**
   * 记录目标放弃
   */
  goalAbandoned(goalId: string, description: string, type: GoalType, reason: string, finalProgress: number): void {
    this.addEntry({
      eventType: 'goal:abandoned',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'abandoned', priority: 0, progress: finalProgress },
      changes: { reason, finalProgress },
      description: `目标放弃: "${description}" — 原因: ${reason} (进度: ${(finalProgress * 100).toFixed(0)}%)`,
    });
  }

  /**
   * 记录目标演化
   */
  goalTransformed(goalId: string, description: string, type: GoalType, newGoalId: string, newDescription: string): void {
    this.addEntry({
      eventType: 'goal:transformed',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'transformed', priority: 0, progress: 1 },
      changes: { newGoalId, newDescription },
      relatedGoalIds: [newGoalId],
      description: `目标演化: "${description}" → "${newDescription}"`,
    });
  }

  /**
   * 记录优先级变化
   */
  priorityChanged(goalId: string, description: string, type: GoalType, oldPriority: number, newPriority: number, reason: string): void {
    this.addEntry({
      eventType: 'goal:priority_changed',
      goalId, goalDescription: description, goalType: type,
      snapshot: { status: 'active', priority: newPriority, progress: 0 },
      changes: { oldPriority, newPriority, delta: newPriority - oldPriority, reason },
      description: `优先级变化: "${description}" — ${(oldPriority * 100).toFixed(0)}% → ${(newPriority * 100).toFixed(0)}% (${reason})`,
    });
  }

  /**
   * 记录冲突检测
   */
  conflictDetected(goalIdA: string, goalIdB: string, descA: string, descB: string, winner: string): void {
    const now = Date.now();
    this.addEntry({
      eventType: 'goal:conflict_detected',
      goalId: goalIdA,
      goalDescription: descA,
      goalType: 'short_term',
      snapshot: { status: 'blocked', priority: 0, progress: 0 },
      changes: { conflictingGoalId: goalIdB, conflictingDescription: descB, winner },
      relatedGoalIds: [goalIdB],
      description: `目标冲突: "${descA}" ↔ "${descB}" — ${winner === goalIdA ? descA : descB} 胜出`,
    });
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取目标完整时间线
   */
  getGoalTimeline(goalId: string): GoalTraceEntry[] {
    return this.timelines.get(goalId) ?? [];
  }

  /**
   * 回溯目标创建原因
   */
  whyCreated(goalId: string): GoalTraceEntry | undefined {
    const timeline = this.timelines.get(goalId);
    if (!timeline) return undefined;
    return timeline.find(e => e.eventType === 'goal:created');
  }

  /**
   * 获取所有追踪条目
   */
  getEntries(filter?: {
    eventType?: GoalTraceEventType;
    goalId?: string;
    limit?: number;
  }): GoalTraceEntry[] {
    let result = [...this.entries];

    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);
    if (filter?.goalId) result = result.filter(e => e.goalId === filter.goalId);

    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  /**
   * 获取摘要
   */
  getSummary(): string {
    const byType: Record<string, number> = {};
    for (const e of this.entries) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

    // 唯一目标数
    const uniqueGoals = new Set(this.entries.map(e => e.goalId)).size;

    const completed = byType['goal:completed'] ?? 0;
    const abandoned = byType['goal:abandoned'] ?? 0;
    const total = completed + abandoned;

    return [
      `=== Goal Trace 摘要 ===`,
      `总追踪条目: ${this.entries.length}`,
      `追踪目标数: ${uniqueGoals}`,
      `完成: ${completed} | 放弃: ${abandoned}`,
      `完成率: ${total > 0 ? ((completed / total) * 100).toFixed(1) : 'N/A'}%`,
      ``,
      `事件分布:`,
      ...Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `  ${t}: ${c} 次`),
      ``,
      `最近 5 条:`,
      ...this.entries.slice(-5).map(e =>
        `  [${new Date(e.timestamp).toLocaleTimeString()}] ${e.description}`
      ),
    ].join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
    this.timelines.clear();
  }

  private addEntry(data: Omit<GoalTraceEntry, 'id' | 'timestamp'>): void {
    const entry: GoalTraceEntry = {
      id: `gtrace_${++this.idCounter}`,
      timestamp: Date.now(),
      ...data,
    };

    this.entries.push(entry);

    // 更新目标时间线
    if (!this.timelines.has(entry.goalId)) {
      this.timelines.set(entry.goalId, []);
    }
    this.timelines.get(entry.goalId)!.push(entry);

    // 限制条目数
    if (this.entries.length > this.MAX_ENTRIES) {
      const removed = this.entries.shift()!;
      const timeline = this.timelines.get(removed.goalId);
      if (timeline) {
        const idx = timeline.indexOf(removed);
        if (idx >= 0) timeline.splice(idx, 1);
      }
    }
  }
}

export default GoalTracer;
