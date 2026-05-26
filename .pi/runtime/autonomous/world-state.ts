/**
 * world-state.ts - 世界状态运行时
 *
 * 世界不再是"背景描述"。
 * 世界是活的：
 * - 有地点（locations）
 * - 有势力（factions）
 * - 有事件（world events）
 * - 有环境（environment）
 * - 有经济（economy，预留）
 * - 有社会状态（social state，预留）
 *
 * 世界状态变化影响：
 * - Agent Goal（Agent 受世界变化驱动）
 * - Context Assembly（世界状态进入上下文）
 * - Memory Recall（世界事件是记忆的一部分）
 * - Attention Priority（世界变化影响注意力分配）
 */

// ============================================================
// 地点
// ============================================================

export interface WorldLocation {
  id: string;
  name: string;
  type: 'room' | 'building' | 'area' | 'region' | 'wilderness' | 'urban' | 'underworld';
  description: string;
  /** 当前在此处的 Agent ID 列表 */
  occupants: string[];
  /** 地点状态 */
  state: 'normal' | 'busy' | 'damaged' | 'destroyed' | 'restricted' | 'dangerous' | 'event_active';
  /** 关联的势力 ID */
  factionId?: string;
  /** 时段的描述变体（不同时间不同描述） */
  timeVariants?: Partial<Record<string, string>>;
  /** 地点属性标签 */
  tags: string[];
  /** 连接的其他地点 ID */
  connections: string[];
  /** 当前活跃事件 */
  activeEventIds: string[];
  /** 自定义状态 */
  customState: Record<string, any>;
  /** 最后更新时间 */
  updatedAt: number;
}

// ============================================================
// 势力（Faction）
// ============================================================

export interface WorldFaction {
  id: string;
  name: string;
  description: string;
  type: 'organization' | 'family' | 'cult' | 'government' | 'guild' | 'gang' | 'military' | 'other';
  /** 势力影响力 0-1 */
  influence: number;
  /** 对其他势力的关系 */
  relations: Record<string, number>; // factionId → value (-1 ~ 1)
  /** 成员 Agent ID 列表 */
  members: string[];
  /** 控制的地点 ID 列表 */
  controlledLocations: string[];
  /** 势力目标 */
  goals: string[];
  /** 势力状态 */
  state: 'stable' | 'expanding' | 'declining' | 'conflict' | 'dissolved';
  /** 势力资产（预留） */
  assets: Record<string, number>;
  /** 自定义数据 */
  customData: Record<string, any>;
  updatedAt: number;
}

// ============================================================
// 世界事件
// ============================================================

export type WorldEventStatus = 'impending' | 'active' | 'resolved' | 'failed' | 'evolved';
export type WorldEventScale = 'minor' | 'moderate' | 'major' | 'catastrophic';

export interface WorldEvent {
  id: string;
  name: string;
  description: string;
  type: string;
  scale: WorldEventScale;
  status: WorldEventStatus;
  /** 事件开始时间 */
  startTime: number;
  /** 事件持续时间（分钟，0=持久事件） */
  duration: number;
  /** 事件影响的范围（地点 ID 列表） */
  affectedLocations: string[];
  /** 受影响的 Agent ID */
  affectedAgents: string[];
  /** 事件产生的后果 */
  consequences: EventConsequence[];
  /** 事件进展阶段 */
  stages: EventStage[];
  /** 当前阶段索引 */
  currentStage: number;
  /** 事件是否已被处理（进入记忆） */
  processed: boolean;
  tags: string[];
  metadata: Record<string, any>;
}

export interface EventStage {
  name: string;
  description: string;
  /** 阶段持续时间（分钟） */
  duration: number;
  /** 阶段触发条件 */
  triggerCondition?: string;
  /** 进入此阶段时触发的事件 */
  onEnter?: () => void;
}

export interface EventConsequence {
  type: 'location_change' | 'agent_change' | 'faction_change' | 'relation_change' | 'environment_change';
  target: string;
  change: any;
  description: string;
}

// ============================================================
// 环境状态
// ============================================================

export interface EnvironmentState {
  /** 当前季节 */
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  /** 天气 */
  weather: string;
  /** 时间（游戏内分钟，0=午夜） */
  timeMinute: number;
  /** 日期 */
  day: number;
  /** 星期几 */
  dayOfWeek: number;
  /** 月份 */
  month: number;
  /** 年份 */
  year: number;
  /** 光线条件 */
  lightLevel: 'bright' | 'dim' | 'dark';
  /** 温度描述 */
  temperature: string;
  /** 特殊环境效果 */
  effects: string[];
}

// ============================================================
// World State Runtime
// ============================================================

export interface WorldStateSnapshot {
  environment: EnvironmentState;
  locationCount: number;
  factionCount: number;
  activeEventCount: number;
  totalOccupants: number;
  summary: string;
}

export class WorldStateRuntime {
  locations: Map<string, WorldLocation> = new Map();
  factions: Map<string, WorldFaction> = new Map();
  events: Map<string, WorldEvent> = new Map();
  environment: EnvironmentState;

  /** 事件历史（已解决的事件） */
  private eventHistory: WorldEvent[] = [];
  private readonly MAX_EVENT_HISTORY = 100;

  constructor() {
    this.environment = {
      season: 'spring',
      weather: '晴朗',
      timeMinute: 8 * 60,  // 8:00
      day: 1,
      dayOfWeek: 1,
      month: 3,
      year: 1,
      lightLevel: 'bright',
      temperature: '舒适',
      effects: [],
    };
  }

  // ============================================================
  // 地点管理
  // ============================================================

  addLocation(location: Omit<WorldLocation, 'updatedAt'>): string {
    this.locations.set(location.id, {
      ...location,
      updatedAt: Date.now(),
    });
    return location.id;
  }

  updateLocation(id: string, updates: Partial<WorldLocation>): void {
    const loc = this.locations.get(id);
    if (loc) {
      Object.assign(loc, updates, { updatedAt: Date.now() });
    }
  }

  getLocation(id: string): WorldLocation | undefined {
    return this.locations.get(id);
  }

  getLocationsByTag(tag: string): WorldLocation[] {
    return Array.from(this.locations.values()).filter(l => l.tags.includes(tag));
  }

  /**
   * Agent 进入地点
   */
  agentEnter(agentId: string, locationId: string): void {
    // 先从所有地点移除
    for (const loc of this.locations.values()) {
      loc.occupants = loc.occupants.filter(o => o !== agentId);
    }
    // 加入目标地点
    const loc = this.locations.get(locationId);
    if (loc && !loc.occupants.includes(agentId)) {
      loc.occupants.push(agentId);
      loc.updatedAt = Date.now();
    }
  }

  /**
   * Agent 离开地点
   */
  agentLeave(agentId: string, locationId: string): void {
    const loc = this.locations.get(locationId);
    if (loc) {
      loc.occupants = loc.occupants.filter(o => o !== agentId);
      loc.updatedAt = Date.now();
    }
  }

  // ============================================================
  // 势力管理
  // ============================================================

  addFaction(faction: Omit<WorldFaction, 'updatedAt'>): string {
    this.factions.set(faction.id, {
      ...faction,
      updatedAt: Date.now(),
    });
    return faction.id;
  }

  updateFaction(id: string, updates: Partial<WorldFaction>): void {
    const faction = this.factions.get(id);
    if (faction) {
      Object.assign(faction, updates, { updatedAt: Date.now() });
    }
  }

  getFaction(id: string): WorldFaction | undefined {
    return this.factions.get(id);
  }

  /**
   * 更新势力间关系
   */
  updateFactionRelation(fromId: string, toId: string, delta: number): void {
    const faction = this.factions.get(fromId);
    if (faction) {
      const current = faction.relations[toId] ?? 0;
      faction.relations[toId] = Math.max(-1, Math.min(1, current + delta));
      faction.updatedAt = Date.now();
    }
  }

  // ============================================================
  // 世界事件管理
  // ============================================================

  addEvent(event: WorldEvent): string {
    this.events.set(event.id, event);
    return event.id;
  }

  /**
   * 推进事件
   */
  advanceEvents(deltaMinutes: number): WorldEventProcessResult[] {
    const results: WorldEventProcessResult[] = [];

    for (const event of this.events.values()) {
      if (event.status !== 'active') continue;

      // 检查阶段推进
      if (event.stages.length > 0 && event.currentStage < event.stages.length - 1) {
        const currentStage = event.stages[event.currentStage];
        // 简化处理：达到阶段持续时间后推进
        if (deltaMinutes >= currentStage.duration) {
          event.currentStage++;
          const newStage = event.stages[event.currentStage];
          newStage.onEnter?.();
          results.push({
            eventId: event.id,
            eventName: event.name,
            stageName: newStage.name,
            description: newStage.description,
            type: 'stage_advance',
          });
        }
      }

      // 检查事件结束
      if (event.duration > 0) {
        event.duration -= deltaMinutes;
        if (event.duration <= 0) {
          event.status = 'resolved';
          event.processed = true;
          this.eventHistory.push(event);
          if (this.eventHistory.length > this.MAX_EVENT_HISTORY) {
            this.eventHistory.shift();
          }
          this.events.delete(event.id);
          results.push({
            eventId: event.id,
            eventName: event.name,
            description: `事件「${event.name}」已结束`,
            type: 'resolved',
          });
        }
      }
    }

    return results;
  }

  /**
   * 触发新事件
   */
  triggerEvent(eventData: Omit<WorldEvent, 'id' | 'status' | 'processed'>): WorldEvent {
    const event: WorldEvent = {
      ...eventData,
      id: `wevent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      status: 'active',
      processed: false,
    };
    this.events.set(event.id, event);
    return event;
  }

  getActiveEvents(): WorldEvent[] {
    return Array.from(this.events.values()).filter(e => e.status === 'active');
  }

  getEventsByLocation(locationId: string): WorldEvent[] {
    return Array.from(this.events.values())
      .filter(e => e.affectedLocations.includes(locationId) && e.status === 'active');
  }

  // ============================================================
  // 环境推进
  // ============================================================

  /**
   * 推进时间
   */
  advanceTime(minutes: number): EnvironmentChange {
    const before = { ...this.environment };
    const change: EnvironmentChange = {
      timeChanged: false,
      dayChanged: false,
      seasonChanged: false,
      weatherChanged: false,
      newTime: '',
    };

    this.environment.timeMinute = (this.environment.timeMinute + minutes) % (24 * 60);
    change.timeChanged = true;

    // 检查天数变化
    const dayDelta = Math.floor(this.environment.timeMinute / (24 * 60));
    if (dayDelta > 0) {
      this.environment.day += dayDelta;
      this.environment.dayOfWeek = (this.environment.dayOfWeek + dayDelta) % 7;
      change.dayChanged = true;
    }

    // 更新光线条件
    this.updateLightLevel();

    // 检查季节变化（每 90 天）
    const prevSeason = this.environment.season;
    this.environment.season = this.calculateSeason();
    if (prevSeason !== this.environment.season) {
      change.seasonChanged = true;
    }

    // 天气变化（随机）
    if (Math.random() < 0.1) {
      this.randomWeather();
      change.weatherChanged = true;
    }

    change.newTime = this.getTimeString();

    return change;
  }

  private updateLightLevel(): void {
    const m = this.environment.timeMinute;
    if (m < 6 * 60 || m > 20 * 60) {
      this.environment.lightLevel = 'dark';
    } else if (m < 7 * 60 || m > 19 * 60) {
      this.environment.lightLevel = 'dim';
    } else {
      this.environment.lightLevel = 'bright';
    }
  }

  private calculateSeason(): 'spring' | 'summer' | 'autumn' | 'winter' {
    const month = this.environment.month;
    if (month >= 3 && month <= 5) return 'spring';
    if (month >= 6 && month <= 8) return 'summer';
    if (month >= 9 && month <= 11) return 'autumn';
    return 'winter';
  }

  private randomWeather(): void {
    const weathers = ['晴朗', '多云', '阴天', '小雨', '大雨', '风暴', '雾'];
    this.environment.weather = weathers[Math.floor(Math.random() * weathers.length)];
  }

  // ============================================================
  // 查询
  // ============================================================

  /**
   * 获取当前位置的描述（考虑时间变体）
   */
  getLocationDescription(locationId: string): string {
    const loc = this.locations.get(locationId);
    if (!loc) return '未知地点';

    const timeKey = this.getTimePeriod();
    const timeDesc = loc.timeVariants?.[timeKey];
    const baseDesc = timeDesc ?? loc.description;

    const occupants = loc.occupants.length > 0
      ? `这里有 ${loc.occupants.length} 个人。`
      : '这里空无一人。';

    const activeEvents = this.getEventsByLocation(locationId);
    const eventDesc = activeEvents.length > 0
      ? `发生了事件：${activeEvents.map(e => e.name).join('、')}。`
      : '';

    return `${baseDesc} ${occupants}${eventDesc}时间：${this.getTimeString()}，天气：${this.environment.weather}`;
  }

  /**
   * 获取世界摘要（用于上下文注入）
   */
  getWorldSummary(): string {
    const locs = this.locations.size;
    const activeEvents = this.getActiveEvents().length;
    const factions = this.factions.size;

    const timeStr = this.getTimeString();
    const weatherStr = this.environment.weather;

    let summary = `世界状态：${timeStr}，${weatherStr}，第 ${this.environment.day} 天，${this.environment.season}。`;
    summary += ` 包含 ${locs} 个地点，${factions} 个势力，${activeEvents} 个活跃事件。`;

    if (activeEvents > 0) {
      summary += ' 当前事件：' +
        this.getActiveEvents().map(e => `「${e.name}」`).join('、');
    }

    return summary;
  }

  /**
   * 获取完整快照
   */
  getSnapshot(): WorldStateSnapshot {
    const totalOccupants = Array.from(this.locations.values())
      .reduce((sum, l) => sum + l.occupants.length, 0);

    return {
      environment: { ...this.environment },
      locationCount: this.locations.size,
      factionCount: this.factions.size,
      activeEventCount: this.getActiveEvents().length,
      totalOccupants,
      summary: this.getWorldSummary(),
    };
  }

  // ============================================================
  // 辅助函数
  // ============================================================

  getTimeString(): string {
    const h = Math.floor(this.environment.timeMinute / 60);
    const m = this.environment.timeMinute % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }

  getTimePeriod(): string {
    const m = this.environment.timeMinute;
    if (m < 6 * 60) return 'night';
    if (m < 12 * 60) return 'morning';
    if (m < 18 * 60) return 'afternoon';
    return 'evening';
  }

  /**
   * 重置世界
   */
  reset(): void {
    this.locations.clear();
    this.factions.clear();
    this.events.clear();
    this.eventHistory = [];
    this.environment = {
      season: 'spring',
      weather: '晴朗',
      timeMinute: 8 * 60,
      day: 1,
      dayOfWeek: 1,
      month: 3,
      year: 1,
      lightLevel: 'bright',
      temperature: '舒适',
      effects: [],
    };
  }
}

export interface EnvironmentChange {
  timeChanged: boolean;
  dayChanged: boolean;
  seasonChanged: boolean;
  weatherChanged: boolean;
  newTime: string;
}

export interface WorldEventProcessResult {
  eventId: string;
  eventName: string;
  stageName?: string;
  description: string;
  type: 'stage_advance' | 'resolved' | 'triggered';
}

export default WorldStateRuntime;
