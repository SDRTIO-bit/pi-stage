/**
 * motivation-trace.ts - 动机追踪（调试/可视化）
 *
 * 记录动机系统的所有状态变化：
 * - 需求强度随时间变化（雷达图数据）
 * - 欲望的增减和满足
 * - 恐惧的激活/取消激活
 * - 依恋强度的变化
 * - 抱负的推进
 *
 * 可观察：
 * - 哪些事件导致了动机突变
 * - 主导动机的演变
 * - 需求满足/不满的模式
 */

import type { NeedType, Desire, Fear, Attachment, Ambition } from '../../planning/motivation-engine';

export type MotivationTraceEventType =
  | 'motivation:needs_changed'
  | 'motivation:desire_added'
  | 'motivation:desire_satisfied'
  | 'motivation:fear_activated'
  | 'motivation:fear_deactivated'
  | 'motivation:fear_added'
  | 'motivation:attachment_changed'
  | 'motivation:attachment_added'
  | 'motivation:ambition_added'
  | 'motivation:ambition_progressed'
  | 'motivation:behavior_applied'
  | 'motivation:candidates_generated'
  ;

export interface MotivationTraceEntry {
  id: string;
  timestamp: number;
  eventType: MotivationTraceEventType;
  /** 需求状态快照（全部维度的当前值） */
  needsSnapshot?: Record<NeedType, number>;
  /** 变化详情 */
  data: Record<string, any>;
  /** 关联的事件或触发源 */
  trigger?: string;
  description: string;
}

export class MotivationTracer {
  private entries: MotivationTraceEntry[] = [];
  /** 需求历史数据点（用于生成雷达图时间序列） */
  private needHistory: Array<{ timestamp: number; needs: Record<NeedType, number> }> = [];
  private readonly MAX_ENTRIES = 2000;
  private readonly MAX_HISTORY_POINTS = 500;
  private idCounter: number = 0;

  /**
   * 记录需求变化
   */
  needsChanged(needs: Record<NeedType, number>, changes: Array<{ type: NeedType; oldValue: number; newValue: number; reason: string }>): void {
    this.addEntry({
      eventType: 'motivation:needs_changed',
      needsSnapshot: { ...needs },
      data: { changes },
      description: `需求变化: ${changes.map(c => `${c.type}: ${(c.oldValue * 100).toFixed(0)}→${(c.newValue * 100).toFixed(0)}%`).join(', ')}`,
    });

    // 记录历史数据点
    this.needHistory.push({
      timestamp: Date.now(),
      needs: { ...needs },
    });
    if (this.needHistory.length > this.MAX_HISTORY_POINTS) {
      this.needHistory.shift();
    }
  }

  /**
   * 记录欲望添加
   */
  desireAdded(desire: Desire): void {
    this.addEntry({
      eventType: 'motivation:desire_added',
      data: { desireId: desire.id, name: desire.name, strength: desire.strength, targetType: desire.targetType, targetId: desire.targetId },
      description: `新欲望: "${desire.name}" (强度: ${(desire.strength * 100).toFixed(0)}%)`,
    });
  }

  /**
   * 记录欲望满足
   */
  desireSatisfied(desire: Desire): void {
    this.addEntry({
      eventType: 'motivation:desire_satisfied',
      data: { desireId: desire.id, name: desire.name },
      description: `欲望满足: "${desire.name}"`,
    });
  }

  /**
   * 记录恐惧激活
   */
  fearActivated(fear: Fear): void {
    this.addEntry({
      eventType: 'motivation:fear_activated',
      data: { fearId: fear.id, name: fear.name, strength: fear.strength },
      description: `恐惧激活: "${fear.name}" (强度: ${(fear.strength * 100).toFixed(0)}%)`,
    });
  }

  /**
   * 记录恐惧取消激活
   */
  fearDeactivated(fear: Fear): void {
    this.addEntry({
      eventType: 'motivation:fear_deactivated',
      data: { fearId: fear.id, name: fear.name },
      description: `恐惧消退: "${fear.name}"`,
    });
  }

  /**
   * 记录新恐惧
   */
  fearAdded(fear: Fear): void {
    this.addEntry({
      eventType: 'motivation:fear_added',
      data: { fearId: fear.id, name: fear.name, strength: fear.strength, targetType: fear.targetType },
      description: `新恐惧: "${fear.name}" (强度: ${(fear.strength * 100).toFixed(0)}%)`,
    });
  }

  /**
   * 记录依恋变化
   */
  attachmentChanged(attachment: Attachment, oldStrength: number, reason: string): void {
    this.addEntry({
      eventType: 'motivation:attachment_changed',
      data: { attachmentId: attachment.id, name: attachment.name, oldStrength, newStrength: attachment.strength, reason },
      description: `依恋变化: "${attachment.name}" ${(oldStrength * 100).toFixed(0)}% → ${(attachment.strength * 100).toFixed(0)}% (${reason})`,
    });
  }

  /**
   * 记录新依恋
   */
  attachmentAdded(attachment: Attachment): void {
    this.addEntry({
      eventType: 'motivation:attachment_added',
      data: { attachmentId: attachment.id, name: attachment.name, strength: attachment.strength, targetType: attachment.targetType, targetId: attachment.targetId },
      description: `新依恋: "${attachment.name}" (强度: ${(attachment.strength * 100).toFixed(0)}%)`,
    });
  }

  /**
   * 记录新抱负
   */
  ambitionAdded(ambition: Ambition): void {
    this.addEntry({
      eventType: 'motivation:ambition_added',
      data: { ambitionId: ambition.id, name: ambition.name, strength: ambition.strength, category: ambition.category },
      description: `新抱负: "${ambition.name}" (${ambition.category})`,
    });
  }

  /**
   * 记录抱负进展
   */
  ambitionProgressed(ambition: Ambition, delta: number): void {
    this.addEntry({
      eventType: 'motivation:ambition_progressed',
      data: { ambitionId: ambition.id, name: ambition.name, oldProgress: ambition.progress - delta, newProgress: ambition.progress, delta },
      description: `抱负推进: "${ambition.name}" ${((ambition.progress - delta) * 100).toFixed(0)}% → ${(ambition.progress * 100).toFixed(0)}%`,
    });
  }

  /**
   * 记录行为反馈
   */
  behaviorApplied(behavior: string, intensity: number, needEffects: Array<{ type: NeedType; delta: number }>): void {
    this.addEntry({
      eventType: 'motivation:behavior_applied',
      data: { behavior, intensity, needEffects },
      description: `行为反馈: ${behavior} (强度: ${intensity}) → ${needEffects.map(e => `${e.type}: ${(e.delta * 100).toFixed(0)}%`).join(', ')}`,
    });
  }

  /**
   * 记录候选目标生成
   */
  candidatesGenerated(count: number, sources: string[]): void {
    this.addEntry({
      eventType: 'motivation:candidates_generated',
      data: { count, sources },
      description: `生成 ${count} 个候选目标: ${sources.join(', ')}`,
    });
  }

  // ============================================================
  // 查询接口
  // ============================================================

  /**
   * 获取需求历史数据（用于可视化雷达图/折线图）
   */
  getNeedHistory(): Array<{ timestamp: number; needs: Record<NeedType, number> }> {
    return [...this.needHistory];
  }

  /**
   * 获取指定需求维度的历史变化
   */
  getNeedTrend(needType: NeedType): Array<{ timestamp: number; value: number }> {
    return this.needHistory.map(point => ({
      timestamp: point.timestamp,
      value: point.needs[needType],
    }));
  }

  /**
   * 获取所有追踪条目
   */
  getEntries(filter?: {
    eventType?: MotivationTraceEventType;
    limit?: number;
  }): MotivationTraceEntry[] {
    let result = [...this.entries];

    if (filter?.eventType) result = result.filter(e => e.eventType === filter.eventType);

    result.sort((a, b) => b.timestamp - a.timestamp);
    return filter?.limit ? result.slice(0, filter.limit) : result;
  }

  /**
   * 获取摘要
   */
  getSummary(): string {
    const byType: Record<string, number> = {};
    for (const e of this.entries) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

    // 最新需求快照
    const latestNeeds = this.needHistory[this.needHistory.length - 1];

    return [
      `=== Motivation Trace 摘要 ===`,
      `总追踪条目: ${this.entries.length}`,
      `历史数据点: ${this.needHistory.length}`,
      ``,
      latestNeeds ? `最新需求状态:` : '',
      ...(latestNeeds
        ? Object.entries(latestNeeds.needs).map(([type, val]) =>
          `  ${type}: ${(val * 100).toFixed(0)}%`
        )
        : ['  (暂无数据)']),
      ``,
      `事件分布:`,
      ...Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `  ${t}: ${c} 次`),
    ].join('\n');
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
    this.needHistory = [];
  }

  private addEntry(data: Omit<MotivationTraceEntry, 'id' | 'timestamp'>): void {
    this.entries.push({
      id: `mtrace_${++this.idCounter}`,
      timestamp: Date.now(),
      ...data,
    });

    if (this.entries.length > this.MAX_ENTRIES) {
      this.entries.shift();
    }
  }
}

export default MotivationTracer;
