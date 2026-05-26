/**
 * agent-emotions.ts - Agent 情绪演化系统
 *
 * Agent 不是静态的。
 * 情绪会随时间演化、受事件影响、影响行为选择。
 *
 * 情绪模型（基于 PAD 三维模型简化）：
 * - valence（效价）：愉悦 - 不愉悦
 * - arousal（唤醒度）：兴奋 - 平静
 * - dominance（支配度）：控制 - 被控制
 *
 * 派生出具体情绪：
 * - happy / sad / angry / fearful / surprised / disgusted / neutral
 *
 * 支持：
 * - 情绪自然衰减（回归基线）
 * - 事件触发情绪变化
 * - 关系变化影响
 * - 需求不满导致负面情绪
 */

export type EmotionLabel = 'happy' | 'sad' | 'angry' | 'fearful' | 'surprised' | 'disgusted' | 'neutral' | 'excited' | 'anxious' | 'content' | 'frustrated';

export interface PADState {
  /** 效价 -1 ~ 1 */
  valence: number;
  /** 唤醒度 0 ~ 1 */
  arousal: number;
  /** 支配度 0 ~ 1 */
  dominance: number;
}

export interface EmotionEvent {
  type: string;
  intensity: number;       // 0-1
  target?: string;
  description?: string;
}

export interface EmotionConfig {
  /** 情绪回归基线的速率 */
  decayRate: number;
  /** 情绪惯性（事件结束后情绪的保持程度） */
  inertia: number;
  /** 情绪对记忆重要性的影响因子 */
  memoryImportanceFactor: number;
  /** 基线 PAD 状态 */
  baseline: PADState;
  /** 各类事件对 PAD 的影响 */
  eventEffects: Record<string, {
    valence: number;
    arousal: number;
    dominance: number;
  }>;
}

const DEFAULT_EMOTION_CONFIG: EmotionConfig = {
  decayRate: 0.05,
  inertia: 0.3,
  memoryImportanceFactor: 0.4,
  baseline: { valence: 0.3, arousal: 0.3, dominance: 0.4 },
  eventEffects: {
    conversation:   { valence: 0.1, arousal: 0.05, dominance: 0.0 },
    conflict:       { valence: -0.3, arousal: 0.4, dominance: -0.2 },
    compliment:     { valence: 0.4, arousal: 0.1, dominance: 0.1 },
    insult:         { valence: -0.4, arousal: 0.3, dominance: -0.3 },
    goal_complete:  { valence: 0.5, arousal: 0.3, dominance: 0.3 },
    goal_fail:      { valence: -0.4, arousal: 0.2, dominance: -0.3 },
    surprise:       { valence: 0.1, arousal: 0.6, dominance: -0.1 },
    danger:         { valence: -0.3, arousal: 0.5, dominance: -0.4 },
    rest:           { valence: 0.2, arousal: -0.3, dominance: 0.1 },
    loneliness:     { valence: -0.3, arousal: -0.1, dominance: -0.1 },
    achievement:    { valence: 0.4, arousal: 0.2, dominance: 0.4 },
    rejection:      { valence: -0.4, arousal: 0.1, dominance: -0.2 },
    affection:      { valence: 0.5, arousal: 0.2, dominance: 0.0 },
    betrayal:       { valence: -0.5, arousal: 0.3, dominance: -0.3 },
    neutral:        { valence: 0.0, arousal: 0.0, dominance: 0.0 },
  },
};

export class AgentEmotions {
  private current: PADState;
  private config: EmotionConfig;

  /** 情绪历史轨迹（用于调试和 salience 计算） */
  private history: PADState[] = [];
  private readonly MAX_HISTORY = 100;

  /** 当前主导情绪 */
  private dominantEmotion: EmotionLabel = 'neutral';

  /** 事件记忆（最近 N 个情绪事件） */
  private recentEvents: EmotionEvent[] = [];
  private readonly MAX_EVENTS = 10;

  constructor(config?: Partial<EmotionConfig>) {
    this.config = { ...DEFAULT_EMOTION_CONFIG, ...config };
    this.current = { ...this.config.baseline };
    this.history.push({ ...this.current });
  }

  /**
   * 每 tick 调用：情绪自然衰减回基线
   */
  tick(): void {
    // 向基线回归
    this.current.valence += (this.config.baseline.valence - this.current.valence) * this.config.decayRate;
    this.current.arousal += (this.config.baseline.arousal - this.current.arousal) * this.config.decayRate;
    this.current.dominance += (this.config.baseline.dominance - this.current.dominance) * this.config.decayRate;

    this.updateDominantEmotion();
    this.recordHistory();
  }

  /**
   * 事件触发情绪变化
   */
  applyEvent(event: EmotionEvent): void {
    const effect = this.config.eventEffects[event.type] ?? this.config.eventEffects.neutral;
    const intensity = Math.min(1, event.intensity);

    // 惯性：已有情绪影响新情绪的吸收
    const inertiaFactor = 1 - this.config.inertia;

    this.current.valence += effect.valence * intensity * inertiaFactor;
    this.current.arousal += effect.arousal * intensity * inertiaFactor;
    this.current.dominance += effect.dominance * intensity * inertiaFactor;

    // 钳制
    this.current.valence = Math.max(-1, Math.min(1, this.current.valence));
    this.current.arousal = Math.max(0, Math.min(1, this.current.arousal));
    this.current.dominance = Math.max(0, Math.min(1, this.current.dominance));

    this.updateDominantEmotion();
    this.recordHistory();

    // 记录事件
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.MAX_EVENTS) {
      this.recentEvents.pop();
    }
  }

  /**
   * 应用关系变化对情绪的影响
   */
  applySocialEffect(relationChange: number): void {
    // 关系改善 → 正面情绪
    if (relationChange > 0) {
      this.applyEvent({
        type: 'affection',
        intensity: Math.abs(relationChange) * 0.5,
      });
    } else if (relationChange < 0) {
      this.applyEvent({
        type: 'rejection',
        intensity: Math.abs(relationChange) * 0.5,
      });
    }
  }

  /**
   * 需求不满触发负面情绪
   */
  applyNeedFrustration(needType: string, strength: number): void {
    this.applyEvent({
      type: needType === 'social' ? 'loneliness'
        : needType === 'achievement' ? 'goal_fail'
        : needType === 'survival' ? 'danger'
        : 'frustrated',
      intensity: strength * 0.5,
    });
  }

  /**
   * 获取当前情绪影响下的记忆重要性乘数
   */
  getMemoryImportanceMultiplier(): number {
    // 高 arousal + 高 valence = 高重要性
    const arousalFactor = Math.abs(this.current.valence) * this.current.arousal;
    return 1 + arousalFactor * this.config.memoryImportanceFactor;
  }

  /**
   * 获取 PAD 状态
   */
  getPAD(): PADState {
    return { ...this.current };
  }

  /**
   * 获取当前主导情绪
   */
  getDominantEmotion(): EmotionLabel {
    return this.dominantEmotion;
  }

  /**
   * 更新主导情绪标签
   */
  private updateDominantEmotion(): void {
    const { valence, arousal, dominance } = this.current;

    if (arousal > 0.6) {
      if (valence > 0.5) this.dominantEmotion = 'excited';
      else if (valence < -0.3) this.dominantEmotion = 'angry';
      else if (dominance < 0.3) this.dominantEmotion = 'anxious';
      else this.dominantEmotion = 'surprised';
    } else if (arousal < 0.3) {
      if (valence > 0.3) this.dominantEmotion = 'content';
      else if (valence < -0.3) this.dominantEmotion = 'sad';
      else this.dominantEmotion = 'neutral';
    } else {
      if (valence > 0.4) this.dominantEmotion = 'happy';
      else if (valence < -0.4) this.dominantEmotion = 'frustrated';
      else if (dominance < 0.3) this.dominantEmotion = 'fearful';
      else this.dominantEmotion = 'neutral';
    }
  }

  /**
   * 记录历史轨迹
   */
  private recordHistory(): void {
    this.history.push({ ...this.current });
    if (this.history.length > this.MAX_HISTORY) {
      this.history.shift();
    }
  }

  /**
   * 获取情绪历史轨迹（用于调试和 salience 计算）
   */
  getHistory(): PADState[] {
    return [...this.history];
  }

  /**
   * 获取最近情绪事件
   */
  getRecentEvents(): EmotionEvent[] {
    return [...this.recentEvents];
  }

  /**
   * 重置情绪到基线
   */
  reset(): void {
    this.current = { ...this.config.baseline };
    this.dominantEmotion = 'neutral';
    this.recentEvents = [];
  }
}

export default AgentEmotions;
