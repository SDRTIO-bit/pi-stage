/**
 * motivation-engine.ts - 动机系统
 *
 * Agent 行为的内在驱动力来源：
 * - 需求（Needs）：生理/安全/归属/尊重/自我实现
 * - 欲望（Desires）：具体渴望的对象或状态
 * - 恐惧（Fears）：回避的对象或情境
 * - 依恋（Attachments）：对人物/地点/物品的情感绑定
 * - 抱负（Ambitions）：长期追求（权力、知识、完美关系等）
 *
 * 动机 → 目标映射：
 * 动机系统实时计算各维度强度，结合情绪、关系、世界状态，
 * 生成候选目标列表送入 GoalPlanner 进行优先级竞争。
 *
 * 整合：
 * - 与 AgentNeeds 整合：需求变化触发动机更新
 * - 与 AgentEmotions 整合：情绪调制动机强度
 * - 与 AgentRelations 整合：关系变化触发依恋相关动机
 * - 与 WorldState 整合：世界事件激活特定动机
 */

import type { GoalTrigger } from './goal-planner';

// ============================================================
// 类型定义
// ============================================================

export type NeedType = 'physiological' | 'safety' | 'belonging' | 'esteem' | 'self_actualization';

export interface NeedState {
  type: NeedType;
  /** 当前强度 0-1 */
  current: number;
  /** 增长率（每 tick） */
  growthRate: number;
  /** 产生驱动力的阈值 */
  driveThreshold: number;
}

export interface Desire {
  id: string;
  name: string;
  description: string;
  /** 渴望强度 0-1 */
  strength: number;
  /** 目标对象类型 */
  targetType: 'character' | 'item' | 'state' | 'ability' | 'event';
  /** 目标对象 ID */
  targetId?: string;
  /** 是否已满足 */
  satisfied: boolean;
  createdAt: number;
}

export interface Fear {
  id: string;
  name: string;
  description: string;
  /** 恐惧强度 0-1 */
  strength: number;
  /** 恐惧对象类型 */
  targetType: 'character' | 'situation' | 'event' | 'state';
  /** 恐惧对象 ID */
  targetId?: string;
  /** 触发条件 */
  triggerCondition?: string;
  /** 是否正被激活 */
  active: boolean;
  createdAt: number;
}

export interface Attachment {
  id: string;
  name: string;
  description: string;
  /** 依恋强度 0-1 */
  strength: number;
  /** 依恋对象类型 */
  targetType: 'character' | 'location' | 'item';
  /** 依恋对象 ID */
  targetId: string;
  /** 分离焦虑程度 */
  separationAnxiety: number;
  createdAt: number;
}

export interface Ambition {
  id: string;
  name: string;
  description: string;
  /** 抱负强度 0-1 */
  strength: number;
  /** 抱负类别 */
  category: 'power' | 'knowledge' | 'wealth' | 'relationship' | 'fame' | 'perfection' | 'freedom';
  /** 进度 0-1 */
  progress: number;
  /** 关联的目标模板描述 */
  goalTemplate: string;
  createdAt: number;
}

export interface MotivationProfile {
  needs: NeedState[];
  desires: Desire[];
  fears: Fear[];
  attachments: Attachment[];
  ambitions: Ambition[];
}

// ============================================================
// 候选目标描述
// ============================================================

export interface GoalCandidate {
  /** 目标类型 */
  type: 'long_term' | 'short_term' | 'hidden' | 'reactive';
  /** 自然语言描述 */
  description: string;
  /** 基础优先级 0-1 */
  priority: number;
  /** 触发源 */
  trigger: GoalTrigger;
  /** 关联的情绪影响 */
  emotionalInfluence: {
    anger?: number;
    fear?: number;
    joy?: number;
    sadness?: number;
    surprise?: number;
    trust?: number;
  };
  /** 关联的关系目标 */
  relationTarget?: string;
  /** 目标标签 */
  tags: string[];
}

// ============================================================
// MotivationEngine 配置
// ============================================================

export interface MotivationEngineConfig {
  /** 需求默认配置 */
  needDefaults: Record<NeedType, { initial: number; growthRate: number; driveThreshold: number }>;
  /** 需求到目标映射 */
  needGoalMappings: Record<NeedType, Array<{
    descriptionTemplate: string;
    priorityBase: number;
    tags: string[];
  }>>;
  /** 最大欲望数 */
  maxDesires: number;
  /** 最大恐惧数 */
  maxFears: number;
  /** 最大依恋数 */
  maxAttachments: number;
  /** 最大抱负数 */
  maxAmbitions: number;
  /** 动机更新间隔（tick 数） */
  updateInterval: number;
}

const DEFAULT_MOTIVATION_CONFIG: MotivationEngineConfig = {
  needDefaults: {
    physiological: { initial: 0.1, growthRate: 0.008, driveThreshold: 0.6 },
    safety:        { initial: 0.15, growthRate: 0.005, driveThreshold: 0.65 },
    belonging:     { initial: 0.3, growthRate: 0.015, driveThreshold: 0.55 },
    esteem:        { initial: 0.2, growthRate: 0.01, driveThreshold: 0.6 },
    self_actualization: { initial: 0.1, growthRate: 0.003, driveThreshold: 0.7 },
  },
  needGoalMappings: {
    physiological: [
      { descriptionTemplate: '满足生理需求', priorityBase: 0.8, tags: ['survival', 'basic'] },
    ],
    safety: [
      { descriptionTemplate: '寻求安全环境', priorityBase: 0.9, tags: ['safety', 'survival'] },
    ],
    belonging: [
      { descriptionTemplate: '加深与{target}的关系', priorityBase: 0.6, tags: ['social', 'relationship'] },
      { descriptionTemplate: '寻找归属感', priorityBase: 0.5, tags: ['social', 'belonging'] },
    ],
    esteem: [
      { descriptionTemplate: '获得{target}的认可', priorityBase: 0.5, tags: ['esteem', 'recognition'] },
      { descriptionTemplate: '证明自己的能力', priorityBase: 0.4, tags: ['esteem', 'achievement'] },
    ],
    self_actualization: [
      { descriptionTemplate: '追求{ambition}', priorityBase: 0.3, tags: ['growth', 'ambition'] },
    ],
  },
  maxDesires: 5,
  maxFears: 5,
  maxAttachments: 5,
  maxAmbitions: 3,
  updateInterval: 5,
};

// ============================================================
// MotivationEngine 实现
// ============================================================

export class MotivationEngine {
  private profile: MotivationProfile;
  private config: MotivationEngineConfig;
  private tickCounter: number = 0;

  /** 外部依赖引用（惰性注入） */
  private externalNeeds?: { getAllNeeds: () => Record<string, number>; getDominantDrive: () => { type: string; strength: number } | null };
  private externalEmotions?: { getDominantEmotion: () => string; getAllEmotions: () => Record<string, number> };
  private externalRelations?: { getRelationSummary: () => Array<{ characterId: string; value: number; trust: number; familiarity: number }> };

  constructor(config?: Partial<MotivationEngineConfig>) {
    this.config = { ...DEFAULT_MOTIVATION_CONFIG, ...config };
    this.profile = this.initializeProfile();
  }

  /**
   * 初始化动机画像
   */
  private initializeProfile(): MotivationProfile {
    const needs: NeedState[] = [];
    for (const [type, cfg] of Object.entries(this.config.needDefaults)) {
      needs.push({
        type: type as NeedType,
        current: cfg.initial,
        growthRate: cfg.growthRate,
        driveThreshold: cfg.driveThreshold,
      });
    }

    return {
      needs,
      desires: [],
      fears: [],
      attachments: [],
      ambitions: [],
    };
  }

  // ============================================================
  // 外部依赖注入
  // ============================================================

  /**
   * 注入 AgentNeeds 适配器
   */
  connectNeeds(adapter: { getAllNeeds: () => Record<string, number>; getDominantDrive: () => { type: string; strength: number } | null }): void {
    this.externalNeeds = adapter;
  }

  /**
   * 注入 AgentEmotions 适配器
   */
  connectEmotions(adapter: { getDominantEmotion: () => string; getAllEmotions: () => Record<string, number> }): void {
    this.externalEmotions = adapter;
  }

  /**
   * 注入关系系统适配器
   */
  connectRelations(adapter: { getRelationSummary: () => Array<{ characterId: string; value: number; trust: number; familiarity: number }> }): void {
    this.externalRelations = adapter;
  }

  // ============================================================
  // 主 tick
  // ============================================================

  /**
   * 每 tick 调用：推进所有动机维度
   */
  tick(): void {
    this.tickCounter++;
    this.updateNeeds();

    if (this.tickCounter % this.config.updateInterval === 0) {
      this.updateDesires();
      this.updateFears();
      this.updateAttachments();
      this.updateAmbitions();
    }
  }

  /**
   * 更新需求
   */
  /**
   * 更新欲望（模拟强度衰减和满足状态更新）
   */
  private updateDesires(): void {
    for (const desire of this.profile.desires) {
      if (!desire.satisfied) {
        // 欲望随时间自然衰减
        desire.strength = Math.max(0.1, desire.strength - 0.01);
      }
    }
  }

  /**
   * 更新恐惧（模拟恐惧强度衰减）
   */
  private updateFears(): void {
    for (const fear of this.profile.fears) {
      if (fear.active) {
        // 没有新刺激时恐惧逐渐消退
        fear.strength = Math.max(0.1, fear.strength - 0.02);
        if (fear.strength < 0.2) {
          fear.active = false;
        }
      }
    }
  }

  /**
   * 更新依恋（模拟依恋强度自然变化）
   */
  private updateAttachments(): void {
    for (const attachment of this.profile.attachments) {
      // 依恋缓慢衰减，需要互动维持
      attachment.strength = Math.max(0.1, attachment.strength - 0.005);
      attachment.separationAnxiety = Math.max(0, attachment.separationAnxiety - 0.01);
    }
  }

  /**
   * 更新抱负（保持不变，进度由外部事件推进）
   */
  private updateAmbitions(): void {
    // 抱负为长期驱动力，不主动衰减
    // 进度由 advanceAmbition 外部驱动
  }

  private updateNeeds(): void {
    for (const need of this.profile.needs) {
      // 对数增长
      const growth = need.growthRate * (1 - need.current * 0.5);
      need.current = Math.min(1, Math.max(0, need.current + growth));
    }

    // 如果关联了外部需求系统，同步强度
    if (this.externalNeeds) {
      const external = this.externalNeeds.getAllNeeds();
      // 将外部需求类型映射到内部 NeedType
      if (external['social'] !== undefined) {
        const belonging = this.profile.needs.find(n => n.type === 'belonging');
        if (belonging) belonging.current = Math.max(belonging.current, external['social']);
      }
      if (external['survival'] !== undefined) {
        const safety = this.profile.needs.find(n => n.type === 'safety');
        if (safety) safety.current = Math.max(safety.current, external['survival']);
      }
      if (external['achievement'] !== undefined) {
        const esteem = this.profile.needs.find(n => n.type === 'esteem');
        if (esteem) esteem.current = Math.max(esteem.current, external['achievement']);
      }
    }
  }

  // ============================================================
  // 候选目标生成（核心接口）
  // ============================================================

  /**
   * 根据当前动机状态生成候选目标列表
   * 这是 GoalPlanner 调用的主要接口
   */
  generateGoalCandidates(context?: {
    worldEvents?: Array<{ id: string; type: string; name: string; description: string }>;
    recentMemories?: Array<{ content: string; emotionalValence: number; tags: string[] }>;
  }): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    // 1. 需求驱动的目标
    candidates.push(...this.generateNeedBasedGoals());

    // 2. 欲望驱动的目标
    candidates.push(...this.generateDesireBasedGoals());

    // 3. 恐惧驱动的目标（回避型）
    candidates.push(...this.generateFearBasedGoals());

    // 4. 依恋驱动的目标
    candidates.push(...this.generateAttachmentBasedGoals());

    // 5. 抱负驱动的目标
    candidates.push(...this.generateAmbitionBasedGoals());

    // 6. 情绪驱动的目标
    if (this.externalEmotions) {
      candidates.push(...this.generateEmotionBasedGoals());
    }

    // 7. 世界事件驱动的目标
    if (context?.worldEvents) {
      candidates.push(...this.generateWorldEventGoals(context.worldEvents));
    }

    // 8. 记忆驱动的目标
    if (context?.recentMemories) {
      candidates.push(...this.generateMemoryDrivenGoals(context.recentMemories));
    }

    return candidates;
  }

  // ============================================================
  // 各维度目标生成
  // ============================================================

  /**
   * 需求驱动的目标生成
   */
  private generateNeedBasedGoals(): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const need of this.profile.needs) {
      if (need.current < need.driveThreshold) continue;

      const mappings = this.config.needGoalMappings[need.type];
      if (!mappings) continue;

      const driveStrength = (need.current - need.driveThreshold) / (1 - need.driveThreshold);

      for (const mapping of mappings) {
        let description = mapping.descriptionTemplate;

        // 如果模板包含占位符，尝试填充
        if (description.includes('{target}')) {
          // 如果有关系目标，使用关系目标名填充
          if (this.externalRelations) {
            const relations = this.externalRelations.getRelationSummary();
            if (relations.length > 0) {
              const closest = relations.reduce((a, b) =>
                Math.abs(a.value) > Math.abs(b.value) ? a : b
              );
              description = description.replace('{target}', closest.characterId);
            } else {
              description = description.replace('{target}', '他人');
            }
          } else {
            description = description.replace('{target}', '他人');
          }
        }
        if (description.includes('{ambition}')) {
          if (this.profile.ambitions.length > 0) {
            const top = this.profile.ambitions.sort((a, b) => b.strength - a.strength)[0];
            description = description.replace('{ambition}', top.description);
          } else {
            description = description.replace('{ambition}', '自我成长');
          }
        }

        candidates.push({
          type: 'short_term',
          description,
          priority: Math.min(1, mapping.priorityBase * driveStrength),
          trigger: {
            type: 'need',
            sourceId: need.type,
            description: `${need.type} 需求强度 ${(need.current * 100).toFixed(0)}% 超过阈值`,
            timestamp: Date.now(),
          },
          emotionalInfluence: need.type === 'safety' ? { fear: driveStrength * 0.5 }
            : need.type === 'belonging' ? { sadness: driveStrength * 0.3, trust: driveStrength * 0.2 }
            : need.type === 'esteem' ? { anger: driveStrength * 0.2, joy: driveStrength * 0.3 }
            : {},
          tags: [...mapping.tags],
        });
      }
    }

    return candidates;
  }

  /**
   * 欲望驱动的目标生成
   */
  private generateDesireBasedGoals(): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const desire of this.profile.desires) {
      if (desire.satisfied || desire.strength < 0.3) continue;

      candidates.push({
        type: desire.strength > 0.7 ? 'long_term' : 'short_term',
        description: `满足渴望: ${desire.description}`,
        priority: desire.strength * 0.7,
        trigger: {
          type: 'need',
          sourceId: desire.id,
          description: `欲望 "${desire.name}" 驱动`,
          timestamp: Date.now(),
        },
        emotionalInfluence: { joy: desire.strength * 0.3, trust: desire.strength * 0.1 },
        relationTarget: desire.targetType === 'character' ? desire.targetId : undefined,
        tags: ['desire', ...(desire.targetType === 'character' ? ['social'] : [])],
      });
    }

    return candidates;
  }

  /**
   * 恐惧驱动的目标生成（回避型）
   */
  private generateFearBasedGoals(): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const fear of this.profile.fears) {
      if (!fear.active || fear.strength < 0.3) continue;

      candidates.push({
        type: 'reactive',
        description: `避免: ${fear.description}`,
        priority: fear.strength * 0.9, // 恐惧优先级通常很高
        trigger: {
          type: 'emotion',
          sourceId: fear.id,
          description: `恐惧 "${fear.name}" 被激活 (强度 ${(fear.strength * 100).toFixed(0)}%)`,
          timestamp: Date.now(),
        },
        emotionalInfluence: { fear: fear.strength * 0.6 },
        relationTarget: fear.targetType === 'character' ? fear.targetId : undefined,
        tags: ['fear', 'avoidance'],
      });
    }

    return candidates;
  }

  /**
   * 依恋驱动的目标生成
   */
  private generateAttachmentBasedGoals(): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const attachment of this.profile.attachments) {
      if (attachment.strength < 0.3) continue;

      // 依恋强度高 → 接近/维护目标
      candidates.push({
        type: 'long_term',
        description: `维系与 ${attachment.name} 的联系`,
        priority: attachment.strength * 0.6,
        trigger: {
          type: 'relation',
          sourceId: attachment.id,
          description: `对 ${attachment.name} 的依恋驱动`,
          timestamp: Date.now(),
        },
        emotionalInfluence: { trust: attachment.strength * 0.4, joy: attachment.strength * 0.2 },
        relationTarget: attachment.targetType === 'character' ? attachment.targetId : undefined,
        tags: ['attachment', 'relationship', attachment.targetType],
      });

      // 分离焦虑
      if (attachment.separationAnxiety > 0.5) {
        candidates.push({
          type: 'short_term',
          description: `缓解与 ${attachment.name} 分离的不安`,
          priority: attachment.separationAnxiety * 0.7,
          trigger: {
            type: 'emotion',
            sourceId: attachment.id,
            description: `对 ${attachment.name} 的分离焦虑 (强度 ${(attachment.separationAnxiety * 100).toFixed(0)}%)`,
            timestamp: Date.now(),
          },
          emotionalInfluence: { fear: attachment.separationAnxiety * 0.4, sadness: attachment.separationAnxiety * 0.3 },
          relationTarget: attachment.targetType === 'character' ? attachment.targetId : undefined,
          tags: ['attachment', 'anxiety'],
        });
      }
    }

    return candidates;
  }

  /**
   * 抱负驱动的目标生成
   */
  private generateAmbitionBasedGoals(): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const ambition of this.profile.ambitions) {
      if (ambition.strength < 0.4) continue;

      const progressPenalty = 1 - ambition.progress; // 进度越低越紧迫
      candidates.push({
        type: 'long_term',
        description: ambition.goalTemplate,
        priority: ambition.strength * 0.5 * progressPenalty,
        trigger: {
          type: 'need',
          sourceId: ambition.id,
          description: `抱负 "${ambition.name}" 驱动`,
          timestamp: Date.now(),
        },
        emotionalInfluence: { joy: ambition.strength * 0.2 },
        tags: ['ambition', ambition.category],
      });
    }

    return candidates;
  }

  /**
   * 情绪驱动的目标生成
   */
  private generateEmotionBasedGoals(): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];
    if (!this.externalEmotions) return candidates;

    const dominant = this.externalEmotions.getDominantEmotion();
    const allEmotions = this.externalEmotions.getAllEmotions();

    switch (dominant) {
      case 'angry':
        if ((allEmotions['angry'] ?? 0) > 0.6) {
          candidates.push({
            type: 'reactive',
            description: '发泄愤怒',
            priority: (allEmotions['angry'] ?? 0) * 0.8,
            trigger: {
              type: 'emotion',
              sourceId: 'emotion_angry',
              description: '愤怒情绪驱动',
              timestamp: Date.now(),
            },
            emotionalInfluence: { anger: allEmotions['angry'] ?? 0 },
            tags: ['emotion', 'anger'],
          });
        }
        break;

      case 'sad':
        if ((allEmotions['sad'] ?? 0) > 0.5) {
          candidates.push({
            type: 'short_term',
            description: '寻求安慰',
            priority: (allEmotions['sad'] ?? 0) * 0.6,
            trigger: {
              type: 'emotion',
              sourceId: 'emotion_sad',
              description: '悲伤情绪驱动',
              timestamp: Date.now(),
            },
            emotionalInfluence: { sadness: allEmotions['sad'] ?? 0, trust: 0.3 },
            tags: ['emotion', 'comfort'],
          });
        }
        break;

      case 'happy':
        if ((allEmotions['happy'] ?? 0) > 0.7) {
          candidates.push({
            type: 'short_term',
            description: '分享快乐',
            priority: (allEmotions['happy'] ?? 0) * 0.4,
            trigger: {
              type: 'emotion',
              sourceId: 'emotion_happy',
              description: '快乐情绪驱动分享',
              timestamp: Date.now(),
            },
            emotionalInfluence: { joy: allEmotions['happy'] ?? 0 },
            tags: ['emotion', 'social'],
          });
        }
        break;

      case 'fearful':
        if ((allEmotions['fearful'] ?? 0) > 0.5) {
          candidates.push({
            type: 'reactive',
            description: '寻找安全庇护',
            priority: (allEmotions['fearful'] ?? 0) * 0.9,
            trigger: {
              type: 'emotion',
              sourceId: 'emotion_fear',
              description: '恐惧情绪驱动',
              timestamp: Date.now(),
            },
            emotionalInfluence: { fear: allEmotions['fearful'] ?? 0 },
            tags: ['emotion', 'safety'],
          });
        }
        break;

      case 'surprised':
        if ((allEmotions['surprised'] ?? 0) > 0.6) {
          candidates.push({
            type: 'short_term',
            description: '搞清楚发生了什么',
            priority: (allEmotions['surprised'] ?? 0) * 0.5,
            trigger: {
              type: 'emotion',
              sourceId: 'emotion_surprise',
              description: '惊讶情绪驱动探索',
              timestamp: Date.now(),
            },
            emotionalInfluence: { surprise: allEmotions['surprised'] ?? 0 },
            tags: ['emotion', 'curiosity'],
          });
        }
        break;
    }

    return candidates;
  }

  /**
   * 世界事件驱动的目标生成
   */
  private generateWorldEventGoals(events: Array<{ id: string; type: string; name: string; description: string }>): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const event of events) {
      // 不同类型的事件产生不同目标
      switch (event.type) {
        case 'conflict':
        case 'war':
          candidates.push({
            type: 'reactive',
            description: `应对冲突: ${event.name}`,
            priority: 0.8,
            trigger: {
              type: 'world_event',
              sourceId: event.id,
              description: `世界事件 "${event.name}" 触发`,
              timestamp: Date.now(),
            },
            emotionalInfluence: { fear: 0.4, anger: 0.3 },
            tags: ['world_event', 'conflict', 'survival'],
          });
          break;

        case 'celebration':
        case 'festival':
          candidates.push({
            type: 'short_term',
            description: `参加庆典: ${event.name}`,
            priority: 0.5,
            trigger: {
              type: 'world_event',
              sourceId: event.id,
              description: `世界事件 "${event.name}" 触发`,
              timestamp: Date.now(),
            },
            emotionalInfluence: { joy: 0.4, trust: 0.2 },
            tags: ['world_event', 'social', 'celebration'],
          });
          break;

        case 'disaster':
          candidates.push({
            type: 'reactive',
            description: `躲避灾难: ${event.name}`,
            priority: 0.95,
            trigger: {
              type: 'world_event',
              sourceId: event.id,
              description: `灾难事件 "${event.name}" 触发`,
              timestamp: Date.now(),
            },
            emotionalInfluence: { fear: 0.7, sadness: 0.3 },
            tags: ['world_event', 'survival', 'disaster'],
          });
          break;

        case 'opportunity':
          candidates.push({
            type: 'short_term',
            description: `抓住机遇: ${event.name}`,
            priority: 0.7,
            trigger: {
              type: 'world_event',
              sourceId: event.id,
              description: `机遇事件 "${event.name}" 触发`,
              timestamp: Date.now(),
            },
            emotionalInfluence: { joy: 0.3, surprise: 0.4 },
            tags: ['world_event', 'opportunity'],
          });
          break;

        default:
          candidates.push({
            type: 'reactive',
            description: `关注事件: ${event.name}`,
            priority: 0.4,
            trigger: {
              type: 'world_event',
              sourceId: event.id,
              description: `世界事件 "${event.name}" 触发`,
              timestamp: Date.now(),
            },
            emotionalInfluence: { surprise: 0.3 },
            tags: ['world_event'],
          });
      }
    }

    return candidates;
  }

  /**
   * 记忆驱动的目标生成
   */
  private generateMemoryDrivenGoals(memories: Array<{ content: string; emotionalValence: number; tags: string[] }>): GoalCandidate[] {
    const candidates: GoalCandidate[] = [];

    for (const mem of memories) {
      // 高情感强度的记忆可能触发目标
      const emotionalIntensity = Math.abs(mem.emotionalValence);
      if (emotionalIntensity < 0.6) continue;

      if (mem.emotionalValence > 0.6) {
        // 积极记忆 → 重温
        candidates.push({
          type: 'short_term',
          description: '重温美好经历',
          priority: emotionalIntensity * 0.4,
          trigger: {
            type: 'memory',
            sourceId: 'memory_trigger',
            description: `积极记忆触发重温愿望`,
            timestamp: Date.now(),
          },
          emotionalInfluence: { joy: emotionalIntensity * 0.3 },
          tags: ['memory', 'nostalgia', ...mem.tags],
        });
      } else if (mem.emotionalValence < -0.6) {
        // 消极记忆 → 避免
        candidates.push({
          type: 'reactive',
          description: '避免重蹈覆辙',
          priority: emotionalIntensity * 0.7,
          trigger: {
            type: 'memory',
            sourceId: 'memory_trigger',
            description: `消极记忆触发回避意愿`,
            timestamp: Date.now(),
          },
          emotionalInfluence: { fear: emotionalIntensity * 0.4, sadness: emotionalIntensity * 0.2 },
          tags: ['memory', 'avoidance', ...mem.tags],
        });
      }
    }

    return candidates;
  }

  // ============================================================
  // 动机维度操作方法
  // ============================================================

  /**
   * 添加欲望
   */
  addDesire(name: string, description: string, targetType: Desire['targetType'], targetId?: string, strength: number = 0.5): string {
    if (this.profile.desires.length >= this.config.maxDesires) {
      // 移除最弱的欲望
      this.profile.desires.sort((a, b) => a.strength - b.strength);
      this.profile.desires.shift();
    }

    const id = `desire_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.profile.desires.push({
      id, name, description, strength, targetType, targetId,
      satisfied: false,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * 添加恐惧
   */
  addFear(name: string, description: string, targetType: Fear['targetType'], targetId?: string, strength: number = 0.5): string {
    if (this.profile.fears.length >= this.config.maxFears) {
      this.profile.fears.sort((a, b) => a.strength - b.strength);
      this.profile.fears.shift();
    }

    const id = `fear_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.profile.fears.push({
      id, name, description, strength, targetType, targetId,
      active: false,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * 激活/取消激活恐惧
   */
  activateFear(fearId: string, active: boolean): void {
    const fear = this.profile.fears.find(f => f.id === fearId);
    if (fear) fear.active = active;
  }

  /**
   * 通过条件自动激活恐惧
   */
  checkFearTriggers(context: Record<string, any>): void {
    for (const fear of this.profile.fears) {
      if (fear.triggerCondition) {
        try {
          // 简单条件匹配：检查 context 中是否包含触发关键词
          const shouldActivate = Object.values(context).some(v =>
            String(v).toLowerCase().includes(fear.triggerCondition!.toLowerCase())
          );
          fear.active = shouldActivate;
        } catch {
          // 静默失败
        }
      }
    }
  }

  /**
   * 添加依恋
   */
  addAttachment(name: string, description: string, targetType: Attachment['targetType'], targetId: string, strength: number = 0.5): string {
    if (this.profile.attachments.length >= this.config.maxAttachments) {
      this.profile.attachments.sort((a, b) => a.strength - b.strength);
      this.profile.attachments.shift();
    }

    const id = `attach_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.profile.attachments.push({
      id, name, description, strength, targetType, targetId,
      separationAnxiety: strength * 0.5,
      createdAt: Date.now(),
    });
    return id;
  }

  /**
   * 添加抱负
   */
  addAmbition(name: string, description: string, category: Ambition['category'], goalTemplate: string, strength: number = 0.5): string {
    if (this.profile.ambitions.length >= this.config.maxAmbitions) {
      this.profile.ambitions.sort((a, b) => a.strength - b.strength);
      this.profile.ambitions.shift();
    }

    const id = `ambition_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.profile.ambitions.push({
      id, name, description, strength, category, progress: 0, goalTemplate, createdAt: Date.now(),
    });
    return id;
  }

  /**
   * 推进抱负进度
   */
  advanceAmbition(ambitionId: string, delta: number): void {
    const ambition = this.profile.ambitions.find(a => a.id === ambitionId);
    if (ambition) {
      ambition.progress = Math.min(1, ambition.progress + delta);
    }
  }

  // ============================================================
  // 应用行为反馈
  // ============================================================

  /**
   * 应用行为对动机的影响
   */
  applyBehaviorFeedback(behavior: string, intensity: number, targetCharacter?: string): void {
    // 行为对需求的影响
    const needEffects: Partial<Record<string, Partial<Record<NeedType, number>>>> = {
      conversation: { belonging: -0.3, esteem: -0.1 },
      conflict: { safety: 0.1, esteem: 0.1 },
      exploration: { safety: 0.05, self_actualization: -0.1 },
      rest: { physiological: -0.3 },
      help: { belonging: -0.2, esteem: -0.1 },
      alone: { belonging: 0.1 },
    };

    const effects = needEffects[behavior];
    if (effects) {
      for (const [type, delta] of Object.entries(effects)) {
        const need = this.profile.needs.find(n => n.type === type as NeedType);
        if (need) {
          need.current = Math.max(0, Math.min(1, need.current + delta * intensity));
        }
      }
    }

    // 行为对欲望的影响（满足或增强）
    if (targetCharacter) {
      for (const desire of this.profile.desires) {
        if (desire.targetId === targetCharacter && behavior === 'conversation') {
          desire.strength *= 0.9; // 社交满足减弱欲望
          if (desire.strength < 0.2) desire.satisfied = true;
        }
      }
    }

    // 行为对依恋的影响
    if (targetCharacter) {
      for (const attachment of this.profile.attachments) {
        if (attachment.targetId === targetCharacter) {
          if (behavior === 'conversation' || behavior === 'help') {
            attachment.strength = Math.min(1, attachment.strength + 0.05 * intensity);
            attachment.separationAnxiety = Math.max(0, attachment.separationAnxiety - 0.1 * intensity);
          } else if (behavior === 'conflict') {
            attachment.strength = Math.max(0, attachment.strength - 0.1 * intensity);
            attachment.separationAnxiety = Math.min(1, attachment.separationAnxiety + 0.15 * intensity);
          }
        }
      }
    }
  }

  // ============================================================
  // 脉冲更新（外部事件触发）
  // ============================================================

  /**
   * 关系变化触发动机更新
   */
  onRelationChange(characterId: string, delta: number): GoalCandidate[] {
    // 关系大幅下降 → 修复关系目标
    if (delta < -0.2) {
      return [{
        type: 'short_term',
        description: `修复与 ${characterId} 的关系`,
        priority: Math.abs(delta) * 0.7,
        trigger: {
          type: 'relation',
          sourceId: characterId,
          description: `与 ${characterId} 的关系下降 ${(delta * 100).toFixed(0)}%`,
          timestamp: Date.now(),
        },
        emotionalInfluence: { sadness: Math.abs(delta) * 0.4, trust: -Math.abs(delta) * 0.2 },
        relationTarget: characterId,
        tags: ['relationship', 'repair'],
      }];
    }

    // 关系大幅上升 → 加深关系目标
    if (delta > 0.2) {
      return [{
        type: 'short_term',
        description: `加深与 ${characterId} 的关系`,
        priority: delta * 0.5,
        trigger: {
          type: 'relation',
          sourceId: characterId,
          description: `与 ${characterId} 的关系上升 ${(delta * 100).toFixed(0)}%`,
        timestamp: Date.now(),
      },
      emotionalInfluence: { joy: delta * 0.3, trust: delta * 0.2 },
      relationTarget: characterId,
      tags: ['relationship', 'deepen'],
    }];
  }

  return [];
}

// ============================================================
// 获取动机画像（外部接口）
// ============================================================

/**
 * 获取完整的动机画像
 */
getProfile(): MotivationProfile {
  return this.profile;
}

// ============================================================
// 调试/统计
// ============================================================

/**
 * 获取统计信息
 */
getStats(): MotivationEngineStats {
  return {
    totalDesires: this.profile.desires.length,
    totalFears: this.profile.fears.length,
    totalAttachments: this.profile.attachments.length,
    totalAmbitions: this.profile.ambitions.length,
    activeFears: this.profile.fears.filter(f => f.active).length,
    satisfiedDesires: this.profile.desires.filter(d => d.satisfied).length,
  };
}
}

export interface MotivationEngineStats {
  totalDesires: number;
  totalFears: number;
  totalAttachments: number;
  totalAmbitions: number;
  activeFears: number;
  satisfiedDesires: number;
}

export default MotivationEngine;