/**
 * debug/perception/index.ts — 感知调试模块统一导出
 *
 * Phase 5 调试模块，追踪 Perception Runtime 的完整状态。
 *
 * 组成：
 * - PerceptionTracer：感知过滤追踪
 * - AwarenessTracer：认知变化追踪
 * - BeliefTracer：信念变化追踪
 * - RumorTracer：谣言传播追踪
 *
 * 使用方式：
 *   import { PerceptionTracer, AwarenessTracer, BeliefTracer, RumorTracer }
 *     from '../debug/perception';
 */

export { PerceptionTracer } from './perception-trace';
export type { PerceptionTraceEntry, PerceptionTraceEventType } from './perception-trace';

export { AwarenessTracer } from './awareness-trace';
export type { AwarenessTraceEntry, AwarenessTraceEventType } from './awareness-trace';

export { BeliefTracer } from './belief-trace';
export type { BeliefTraceEntry, BeliefTraceEventType } from './belief-trace';

export { RumorTracer } from './rumor-trace';
export type { RumorTraceEntry, RumorTraceEventType } from './rumor-trace';

// ============================================================
// PerceptionDebugDashboard
// ============================================================

import { PerceptionTracer } from './perception-trace';
import { AwarenessTracer } from './awareness-trace';
import { BeliefTracer } from './belief-trace';
import { RumorTracer } from './rumor-trace';

export class PerceptionDebugDashboard {
  readonly perception: PerceptionTracer;
  readonly awareness: AwarenessTracer;
  readonly belief: BeliefTracer;
  readonly rumor: RumorTracer;

  constructor() {
    this.perception = new PerceptionTracer();
    this.awareness = new AwarenessTracer();
    this.belief = new BeliefTracer();
    this.rumor = new RumorTracer();
  }

  getFullSummary(): string {
    return [
      '╔══════════════════════════════════════════════════╗',
      '║          Perception Debug Dashboard              ║',
      '╚══════════════════════════════════════════════════╝',
      '',
      '--- Perception ---',
      `总追踪: ${this.perception['entries'].length} 条`,
      '',
      '--- Awareness ---',
      `总追踪: ${this.awareness['entries'].length} 条`,
      '',
      '--- Belief ---',
      `总追踪: ${this.belief['entries'].length} 条`,
      '',
      '--- Rumor ---',
      `总追踪: ${this.rumor['entries'].length} 条`,
    ].join('\n');
  }

  clearAll(): void {
    this.perception.clear();
    this.awareness.clear();
    this.belief.clear();
    this.rumor.clear();
  }
}

export default PerceptionDebugDashboard;
