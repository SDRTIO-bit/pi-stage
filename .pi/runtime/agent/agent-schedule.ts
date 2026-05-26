/**
 * agent-schedule.ts - Agent 日程表系统
 *
 * Agent 不再只在用户输入时"存在"。
 * 他们有日程：什么时间在哪里、做什么、和谁。
 *
 * 支持：
 * - 周期性日程（每天/每周/特定时间）
 * - 单次事件（预约）
 * - 条件触发（需求/关系/事件触发）
 * - 日程冲突检测
 * - 优先级调度
 * - 打断/恢复
 */

export type ScheduleEntryType = 'daily' | 'weekly' | 'once' | 'conditional' | 'recurring';

export interface ScheduleSlot {
  id: string;
  type: ScheduleEntryType;
  /** 活动名称 */
  activity: string;
  /** 地点 */
  location: string;
  /** 参与的其他 Agent */
  participants: string[];
  /** 开始时间（游戏内分钟，0=午夜） */
  startMinute: number;
  /** 持续时间（分钟） */
  duration: number;
  /** 优先级 0-10 */
  priority: number;
  /** 每周的星期几（仅 weekly 类型） */
  dayOfWeek?: number;
  /** 条件触发条件（仅 conditional 类型） */
  condition?: string;
  /** 条件评估函数（运行时注入） */
  conditionEval?: () => boolean;
  /** 是否可被打断 */
  interruptible: boolean;
  /** 关联的需求类型（活动满足哪个需求） */
  satisfiesNeed?: string;
  /** 活动标签 */
  tags: string[];
  /** 自定义数据 */
  metadata: Record<string, any>;
}

export interface ScheduleConfig {
  /** 一天的开始时间（分钟） */
  dayStartMinute: number;
  /** 一天的结束时间（分钟） */
  dayEndMinute: number;
  /** 最小日程间隔（分钟） */
  minScheduleGap: number;
  /** 默认日程长度（分钟） */
  defaultDuration: number;
}

const DEFAULT_SCHEDULE_CONFIG: ScheduleConfig = {
  dayStartMinute: 6 * 60,    // 6:00
  dayEndMinute: 22 * 60,     // 22:00
  minScheduleGap: 15,
  defaultDuration: 60,
};

export class AgentSchedule {
  private slots: ScheduleSlot[] = [];
  private config: ScheduleConfig;

  /** 当前正在进行的活动 */
  private currentActivity: ScheduleSlot | null = null;
  /** 当前活动的剩余分钟数 */
  private currentActivityRemaining: number = 0;

  /** 被打断的活动栈（支持恢复） */
  private interruptedStack: Array<{ slot: ScheduleSlot; remaining: number }> = [];

  constructor(config?: Partial<ScheduleConfig>) {
    this.config = { ...DEFAULT_SCHEDULE_CONFIG, ...config };
  }

  /**
   * 添加日程条目
   */
  addSlot(slot: Omit<ScheduleSlot, 'id'>): string {
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.slots.push({ ...slot, id });
    this.sortSlots();
    return id;
  }

  /**
   * 批量设置每日日程
   */
  setDailySchedule(activities: Array<{
    activity: string;
    location: string;
    startMinute: number;
    duration?: number;
    priority?: number;
  }>): void {
    // 清除 old daily 日程
    this.slots = this.slots.filter(s => s.type !== 'daily');

    for (const act of activities) {
      this.slots.push({
        id: `daily_${act.startMinute}_${Date.now()}`,
        type: 'daily',
        activity: act.activity,
        location: act.location,
        participants: [],
        startMinute: act.startMinute,
        duration: act.duration ?? this.config.defaultDuration,
        priority: act.priority ?? 5,
        interruptible: true,
        tags: ['daily'],
        metadata: {},
      });
    }

    this.sortSlots();
  }

  /**
   * 每 tick 调用：推进时间，检查日程状态
   * 
   * @param currentMinute 当前游戏时间（分钟）
   * @param gameDay 当前游戏日期
   * @param dayOfWeek 当前星期几
   */
  tick(currentMinute: number, gameDay: number, dayOfWeek: number): ScheduleTickResult {
    const result: ScheduleTickResult = {
      newActivity: null,
      activityEnded: false,
      activityChanged: false,
      current: this.currentActivity?.activity ?? null,
    };

    // 如果有当前活动，检查是否结束
    if (this.currentActivity) {
      this.currentActivityRemaining -= 10; // 每次 tick 推进 10 分钟
      if (this.currentActivityRemaining <= 0) {
        this.currentActivity = null;
        this.currentActivityRemaining = 0;
        result.activityEnded = true;
        result.activityChanged = true;
      }
    }

    // 检查是否有新的日程开始
    const nextSlot = this.findNextSlot(currentMinute, dayOfWeek);
    if (nextSlot && !this.currentActivity) {
      this.currentActivity = nextSlot;
      this.currentActivityRemaining = nextSlot.duration;
      result.newActivity = nextSlot;
      result.activityChanged = true;
    }

    // 检查是否有高优先级打断
    if (this.currentActivity?.interruptible) {
      const interrupting = this.findInterrupting(currentMinute, dayOfWeek);
      if (interrupting) {
        this.interruptedStack.push({
          slot: this.currentActivity,
          remaining: this.currentActivityRemaining,
        });
        this.currentActivity = interrupting;
        this.currentActivityRemaining = interrupting.duration;
        result.newActivity = interrupting;
        result.activityChanged = true;
      }
    }

    return result;
  }

  /**
   * 查找当前时间开始的日程
   */
  private findNextSlot(currentMinute: number, dayOfWeek: number): ScheduleSlot | null {
    for (const slot of this.slots) {
      // 检查类型
      if (slot.type === 'daily') {
        // 每日日程：检查时间范围
        if (Math.abs(slot.startMinute - currentMinute) <= this.config.minScheduleGap) {
          return slot;
        }
      } else if (slot.type === 'weekly') {
        // 每周日程：检查星期几和时间
        if (slot.dayOfWeek === dayOfWeek &&
            Math.abs(slot.startMinute - currentMinute) <= this.config.minScheduleGap) {
          return slot;
        }
      } else if (slot.type === 'once' || slot.type === 'recurring') {
        if (Math.abs(slot.startMinute - currentMinute) <= this.config.minScheduleGap) {
          return slot;
        }
      } else if (slot.type === 'conditional') {
        if (slot.conditionEval?.() && 
            Math.abs(slot.startMinute - currentMinute) <= this.config.minScheduleGap) {
          return slot;
        }
      }
    }
    return null;
  }

  /**
   * 查找可打断当前活动的高优先级日程
   */
  private findInterrupting(currentMinute: number, dayOfWeek: number): ScheduleSlot | null {
    if (!this.currentActivity) return null;

    for (const slot of this.slots) {
      if (slot.id === this.currentActivity.id) continue;
      if (slot.priority <= (this.currentActivity.priority + 2)) continue;
      if (slot.startMinute >= currentMinute - this.config.minScheduleGap &&
          slot.startMinute <= currentMinute + this.config.minScheduleGap) {
        return slot;
      }
    }
    return null;
  }

  /**
   * 恢复被打断的活动
   */
  resumeInterrupted(): boolean {
    if (this.interruptedStack.length === 0) return false;
    const prev = this.interruptedStack.pop()!;
    this.currentActivity = prev.slot;
    this.currentActivityRemaining = prev.remaining;
    return true;
  }

  /**
   * 获取当前活动
   */
  getCurrentActivity(): ScheduleSlot | null {
    return this.currentActivity;
  }

  /**
   * 获取当前活动信息描述
   */
  getCurrentActivityDescription(): string {
    if (!this.currentActivity) return '空闲';
    return `${this.currentActivity.activity} 在 ${this.formatTime(this.currentActivity.startMinute)}`;
  }

  /**
   * 获取所有日程
   */
  getAllSlots(): ScheduleSlot[] {
    return [...this.slots];
  }

  /**
   * 获取指定时间的日程
   */
  getSlotsAt(minute: number): ScheduleSlot[] {
    return this.slots.filter(s =>
      s.startMinute <= minute && minute <= s.startMinute + s.duration
    );
  }

  /**
   * 清空日程
   */
  clear(): void {
    this.slots = [];
    this.currentActivity = null;
    this.currentActivityRemaining = 0;
    this.interruptedStack = [];
  }

  /**
   * 按时间排序
   */
  private sortSlots(): void {
    this.slots.sort((a, b) => a.startMinute - b.startMinute);
  }

  /**
   * 格式化时间
   */
  private formatTime(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
  }
}

export interface ScheduleTickResult {
  newActivity: ScheduleSlot | null;
  activityEnded: boolean;
  activityChanged: boolean;
  current: string | null;
}

export default AgentSchedule;
