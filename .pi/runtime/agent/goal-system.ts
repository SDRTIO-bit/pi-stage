/**
 * Goal System - 占位实现（Phase 1）
 * 
 * 负责目标的追踪和驱动。Phase 2 实现完整的目标生命周期（创建/评估/完成/失败）。
 * Phase 1 仅提供接口定义和空实现，确保导入路径有效。
 */

export interface Goal {
  id: string;
  name: string;
  description: string;
  priority: number;
  status: 'active' | 'completed' | 'failed' | 'suspended';
  progress: number; // 0-1
  createdAt: number;
  updatedAt: number;
  dependencies: string[];
  metadata: Record<string, any>;
}

export class GoalSystem {
  private goals: Map<string, Goal> = new Map();

  async getActiveGoals(): Promise<Goal[]> {
    return Array.from(this.goals.values()).filter(g => g.status === 'active');
  }

  async evaluateDrives(): Promise<{ drive: string; strength: number }[]> {
    return [];
  }

  async updateGoal(id: string, updates: Partial<Goal>): Promise<void> {
    const goal = this.goals.get(id);
    if (goal) {
      Object.assign(goal, updates, { updatedAt: Date.now() });
    }
  }

  async createGoal(name: string, description: string, priority: number = 0): Promise<string> {
    const id = `goal_${Date.now()}`;
    this.goals.set(id, {
      id,
      name,
      description,
      priority,
      status: 'active',
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      dependencies: [],
      metadata: {},
    });
    return id;
  }

  async completeGoal(id: string): Promise<void> {
    await this.updateGoal(id, { status: 'completed', progress: 1 });
  }
}

export default GoalSystem;
