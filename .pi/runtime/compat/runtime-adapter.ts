/**
 * Runtime Adapter - 桥接旧 RP Engine 和新 Runtime
 *
 * 核心功能：
 * 1. 将旧 store.getState() 的输出转为 RuntimeStateSnapshot
 * 2. 将旧 AuthorNote 注入方式桥接到 ReinforcementLayer
 * 3. 提供一个开关，在 buildSystemPrompt 和 ContextAssemblyEngine 之间切换
 */

import type { ContextAssemblyEngine, RuntimeStateSnapshot } from '../context';
import { AuthorNote } from '../../extensions/rp-engine/author-note';
import type { WorldState, CharacterState } from '../../extensions/rp-engine/types';

// ============================================================
// 状态适配器：旧 state → RuntimeStateSnapshot
// ============================================================

export function stateToRuntimeSnapshot(
  state: Record<string, any>,
  activeCardIds: string[],
  activeGoals: string[]
): RuntimeStateSnapshot {
  const world: WorldState | undefined = state['世界'];
  const cardStates = state.cardStates;

  const characters: {
    name: string;
    belonging: number;
    affection: number;
    location: string;
    status: string;
  }[] = [];

  if (cardStates && typeof cardStates === 'object') {
    // 新格式
    for (const [cardId, card] of Object.entries(cardStates as Record<string, any>)) {
      for (const [name, charData] of Object.entries(card.characters || {})) {
        const char = charData as CharacterState;
        if (!char?.基本信息) continue;
        characters.push({
          name: char.基本信息.姓名 || name,
          belonging: char.归属值 ?? 50,
          affection: char.情分值 ?? 100,
          location: char.当前状态?.所在地点 || '?',
          status: char.花开蒂落?.触发状态 ? '已花开' : '未触发',
        });
      }
    }
  } else {
    // 旧格式兼容
    const charNames = Object.keys(state).filter(
      k => k !== '世界' && k !== '{{user}}' && k !== '_meta' && k !== 'global' && k !== 'cardStates'
    );
    for (const name of charNames) {
      const char = state[name] as CharacterState;
      if (!char) continue;
      characters.push({
        name: char.基本信息?.姓名 || name,
        belonging: char.归属值 ?? 50,
        affection: char.情分值 ?? 100,
        location: char.当前状态?.所在地点 || '?',
        status: char.花开蒂落?.触发状态 ? '已花开' : '未触发',
      });
    }
  }

  return {
    worldDate: world?.当前日期 || '未知',
    worldTime: world?.当前时间 || '',
    location: world?.当前位置 || '',
    characters,
    activeGoals,
    relationships: new Map(),
  };
}

// ============================================================
// 双模式选择器
// ============================================================

export type ContextMode = 'legacy' | 'runtime' | 'auto';

export interface ContextModeConfig {
  /** 使用哪种上下文装配模式 */
  mode: ContextMode;
  /** auto 模式下切换的轮次阈值 */
  autoSwitchThreshold?: number;
}

/**
 * 决定使用哪种上下文装配模式
 */
export function decideContextMode(
  config: ContextModeConfig,
  currentTurn: number,
  totalTokens: number
): 'legacy' | 'runtime' {
  switch (config.mode) {
    case 'legacy':
      return 'legacy';
    case 'runtime':
      return 'runtime';
    case 'auto':
      // 自动模式：前5轮用旧系统（稳定起步），之后切换
      // 或 token 超 80% 上下文窗口时切换
      if (currentTurn <= 5) return 'legacy';
      if (totalTokens > 100000) return 'runtime'; // 128k 窗口的 80%
      return currentTurn > 5 ? 'runtime' : 'legacy';
    default:
      return 'legacy';
  }
}

// ============================================================
// 旧 AuthorNote 桥接到 ReinforcementLayer
// ============================================================

/**
 * 将旧 AuthorNote 的内容转为强化规则
 */
export function authorNoteToReinforceRule(authorNote: AuthorNote): string {
  const noteText = authorNote.getInjectionText();
  if (!noteText || noteText === '[系统指令：请以角色的身份，保持生动详细的描写，关注角色心理活动。回复长度应在800-1200字之间。]') {
    return ''; // 默认值无需强化
  }
  return `【作者注】${noteText}`;
}

export default stateToRuntimeSnapshot;
