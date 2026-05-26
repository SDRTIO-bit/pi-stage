/**
 * RP Engine - 周期事件处理
 *
 * 纯通用世界事件，不绑定任何卡片特定字段。
 * 卡片特有的事件逻辑（如花开蒂落、怀孕等）由 AI 通过工具自行驱动。
 */

import type { WorldState } from "./game-types";

/**
 * 处理周期事件，返回事件描述字符串数组。
 * 仅处理通用世界级事件，卡片特定事件由 AI 通过工具处理。
 */
export function processPeriodicEvents(
  state: Record<string, any>,
  daysPassed: number,
  _appendHistory?: (record: any) => void
): string[] {
  const events: string[] = [];
  const world = state["世界"] as WorldState;
  if (!world) return events;

  const currentDate = new Date(world.当前日期);
  if (isNaN(currentDate.getTime())) return events;

  // 通用周期事件（所有卡片共享）
  if (daysPassed >= 7 || (currentDate.getDate() % 7 === 0)) {
    events.push("【周期事件】一周过去了。");
  }

  return events;
}
