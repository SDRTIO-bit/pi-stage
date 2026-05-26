/**
 * agent-needs.ts - Agent 需求系统
 *
 * Agent 不只拥有目标，还拥有需求。
 * 需求是驱动行为的底层动力。
 *
 * 需求包括：
 * - social（社交需求：陪伴、对话、关系维系）
 * - survival（生存需求：安全、资源）
 * - curiosity（好奇心：探索、学习新事物）
 * - achievement（成就需求：完成任务、实现目标）
 * - power（权力需求：影响他人、控制局面）
 * - relaxation（放松需求：休息、娱乐）
 *
 * 每个需求有当前强度 0-1，随时间和行为变化。
 */

export type NeedType = 'social' | 'survival' | 'curiosity' | 'achievement' | 'power' | 'relaxation';

export interface AgentNeed {
  type: NeedType;
  /** 当前强度 0-1 */
  current: number;
  /** 默认增长率（每 tick） */
  growthRate: number;
  /** 满足阈值（低于此值产生 drive） */
  driveThreshold: number;
  /** 满溢阈值（高于此值产生负面效果） */
  overflowThreshold: number;
  /** 最后更新时间 */
  lastUpdated: number;
}

export interface NeedConfig {
  /** 各需求的初始值和参数 */
  needs: Record<NeedType, {
    initial: number;
    growthRate: number;
    driveThreshold: number;
    overflowThreshold: number;
  }>;
  /** 行为对需求的影响 */
  behaviorEffects: Record<string, Partial<Record<NeedType, number>>>;
  /** 关系对社交需求的影响因子 */
  relationSocialFactor: number;
}

const DEFAULT_NEED_CONFIG: NeedConfig = {
  needs: {
    social:      { initial: 0.3, growthRate: 0.02, driveThreshold: 0.6, overflowThreshold: 0.9 },
    survival:    { initial: 0.1, growthRate: 0.005, driveThreshold: 0.7, overflowThreshold: 0.95 },
    curiosity:   { initial: 0.4, growthRate: 0.01, driveThreshold: 0.5, overflowThreshold: 0.85 },
    achievement: { initial: 0.2, growthRate: 0.015, driveThreshold: 0.6, overflowThreshold: 0.9 },
    power:       { initial: 0.2, growthRate: 0.008, driveThreshold: 0.65, overflowThreshold: 0.9 },
    relaxation:  { initial: 0.3, growthRate: 0.025, driveThreshold: 0.5, overflowThreshold: 0.8 },
  },
  behaviorEffects: {
    conversation: { social: -0.3, curiosity: -0.1, relaxation: 0.05 },
    conflict:     { social: 0.1, power: -0.2, survival: 0.1 },
    exploration:  { curiosity: -0.4, relaxation: 0.1 },
    rest:         { relaxation: -0.5, social: 0.05 },
    goal_complete: { achievement: -0.4, curiosity: -0.1, power: -0.1 },
    goal_fail:    { achievement: 0.2, curiosity: 0.1 },
    socialize:    { social: -0.4, relaxation: 0.05 },
    alone:        { social: 0.1, relaxation: -0.15 },
  },
  relationSocialFactor: 0.3,
};

export class AgentNeeds {
  private needs: Map<NeedType, AgentNeed> = new Map();
  private config: NeedConfig;

  constructor(config?: Partial<NeedConfig>) {
    this.config = { ...DEFAULT_NEED_CONFIG, ...config };
    this.initialize();
  }

  private initialize(): void {
    for (const [type, cfg] of Object.entries(this.config.needs)) {
      const needType = type as NeedType;
      this.needs.set(needType, {
        type: needType,
        current: cfg.initial,
        growthRate: cfg.growthRate,
        driveThreshold: cfg.driveThreshold,
        overflowThreshold: cfg.overflowThreshold,
        lastUpdated: Date.now(),
      });
    }
  }

  /**
   * 每 tick 调用：所有需求自然增长
   */
  tick(deltaMinutes: number = 10): void {
    const ticks = deltaMinutes / 10;
    for (const need of this.needs.values()) {
      // 对数增长：越接近 1 增长越慢
      const growth = need.growthRate * ticks * (1 - need.current * 0.5);
      need.current = Math.min(1, Math.max(0, need.current + growth));
      need.lastUpdated = Date.now();
    }
  }

  /**
   * 应用行为对需求的影响
   */
  applyBehavior(behavior: string, intensity: number = 1.0): void {
    const effects = this.config.behaviorEffects[behavior];
    if (!effects) return;

    for (const [type, delta] of Object.entries(effects)) {
      const need = this.needs.get(type as NeedType);
      if (need) {
        need.current = Math.min(1, Math.max(0, need.current + delta * intensity));
      }
    }
  }

  /**
   * 应用关系变化对社交需求的影响
   */
  applySocialEffect(relationDelta: number): void {
    const social = this.needs.get('social');
    if (social) {
      social.current = Math.min(1, Math.max(0,
        social.current - relationDelta * this.config.relationSocialFactor
      ));
    }
  }

  /**
   * 获取当前最强驱动需求
   */
  getDominantDrive(): { type: NeedType; strength: number } | null {
    let dominant: { type: NeedType; strength: number } | null = null;

    for (const need of this.needs.values()) {
      if (need.current >= need.driveThreshold) {
        const driveStrength = (need.current - need.driveThreshold) / (1 - need.driveThreshold);
        if (!dominant || driveStrength > dominant.strength) {
          dominant = { type: need.type, strength: driveStrength };
        }
      }
    }

    return dominant;
  }

  /**
   * 获取所有超过阈值的驱动需求
   */
  getActiveDrives(): Array<{ type: NeedType; strength: number }> {
    const drives: Array<{ type: NeedType; strength: number }> = [];
    for (const need of this.needs.values()) {
      if (need.current >= need.driveThreshold) {
        drives.push({
          type: need.type,
          strength: (need.current - need.driveThreshold) / (1 - need.driveThreshold),
        });
      }
    }
    return drives.sort((a, b) => b.strength - a.strength);
  }

  /**
   * 获取需要紧急处理的需求（超过 overflowThreshold）
   */
  getOverflowNeeds(): NeedType[] {
    const overflows: NeedType[] = [];
    for (const need of this.needs.values()) {
      if (need.current >= need.overflowThreshold) {
        overflows.push(need.type);
      }
    }
    return overflows;
  }

  /**
   * 获取单个需求
   */
  getNeed(type: NeedType): AgentNeed | undefined {
    return this.needs.get(type);
  }

  /**
   * 获取所有需求快照
   */
  getAllNeeds(): Record<NeedType, number> {
    const snapshot: Record<string, number> = {};
    for (const [type, need] of this.needs) {
      snapshot[type] = need.current;
    }
    return snapshot as Record<NeedType, number>;
  }
}

export default AgentNeeds;
