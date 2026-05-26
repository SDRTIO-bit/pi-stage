/**
 * RP Engine - TUI 面板（状态面板 & 历史面板）
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import type { HistoryRecord } from "./types";
import type { WorldState } from "./game-types";

/**
 * 状态面板 - 显示所有角色状态概览
 */
export class StatusPanel {
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private getState: () => Record<string, any>;

  constructor(theme: Theme, onClose: () => void, getState: () => Record<string, any>) {
    this.theme = theme;
    this.onClose = onClose;
    this.getState = getState;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const state = this.getState();
    const lines: string[] = [];
    const w = Math.min(width, 80);

    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", th.bold("  ╭───────────────── 状态面板 ─────────────────╮")), w));
    lines.push("");

    const world = state["世界"] as WorldState;
    if (world) {
      lines.push(truncateToWidth(`  📅 ${world.当前日期} ${world.当前星期}  🕐 ${world.当前时间}  📍 ${world.当前位置}`, w));
      lines.push("");
    }

    // ─── Runtime 引擎状态（如果启用）───
    const runtimeState = state['__runtime__'];
    if (runtimeState) {
      lines.push(truncateToWidth(th.fg("accent", "  ╭─ Runtime 引擎 ─╮"), w));
      const phaseStr = runtimeState.phase === 'running' ? th.fg("success", "● 运行中") : th.fg("warning", "○ " + runtimeState.phase);
      lines.push(truncateToWidth(`  ${phaseStr}  |  Agent: ${runtimeState.agentCount || 0}  |  Turn: ${runtimeState.turn || 0}`, w));
      if (runtimeState.worldTick?.timeAdvanced) {
        lines.push(truncateToWidth(`  ${th.fg("dim", "⏱ " + String(runtimeState.worldTick.timeAdvanced) + "s 推进  |  " + (runtimeState.worldTick.eventsTriggered || 0) + " 事件触发")}`, w));
      }
      if (runtimeState.debugStats) {
        const ds = runtimeState.debugStats;
        lines.push(truncateToWidth(`  ${th.fg("dim", "追踪: " + (ds.totalEntries || 0) + " | 错误: " + (ds.errorCount || 0) + " | 警告: " + (ds.warningCount || 0))}`, w));
      }
      lines.push("");
    }

    // 动态获取所有角色
    const charNames = Object.keys(state).filter(k => k !== '世界' && k !== '{{user}}' && k !== '_meta' && k !== 'global' && k !== 'cardStates');
    for (const name of charNames) {
      const char = state[name] as Record<string, any>;
      if (!char) continue;

      // 动态显示角色标量字段
      const parts: string[] = [];
      for (const [k, v] of Object.entries(char)) {
        if (["基本信息", "当前状态", "_meta"].includes(k)) continue;
        if (typeof v === "number") parts.push(`${k}=${v}`);
      }
      const loc = char?.当前状态?.所在地点;
      if (loc) parts.push(`📍${loc}`);
      const fields = parts.join(" ");

      const nameStr = th.fg("text", name.padEnd(6));
      const valStr = th.fg("muted", fields || "（无数据）");
      lines.push(truncateToWidth(`  ${nameStr} ${valStr}`, w));
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "角色状态 · ESC 关闭")}`, w));
    lines.push(truncateToWidth(th.fg("accent", "  ╰────────────────────────────────────────╯"), w));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * 历史面板 - 查看指定角色的状态变更历史
 */
export class HistoryPanel {
  private charName: string;
  private theme: Theme;
  private onClose: () => void;
  private records: HistoryRecord[] = [];
  private cachedWidth?: number;
  private cachedLines?: string[];
  private getHistoryPath: () => string;

  constructor(charName: string, theme: Theme, onClose: () => void, getHistoryPath: () => string) {
    this.charName = charName;
    this.theme = theme;
    this.onClose = onClose;
    this.getHistoryPath = getHistoryPath;
    this.loadHistory();
  }

  private loadHistory(): void {
    const p = this.getHistoryPath();
    if (!existsSync(p)) return;
    const lines = readFileSync(p, "utf-8").trim().split("\n").filter(Boolean);
    this.records = lines
      .map((l: string) => {
        try {
          return JSON.parse(l) as HistoryRecord;
        } catch {
          return null;
        }
      })
      .filter((r: HistoryRecord | null): r is HistoryRecord => r !== null && r.char === this.charName)
      .slice(-30);
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lines: string[] = [];
    const w = Math.min(width, 80);

    lines.push("");
    lines.push(truncateToWidth(th.fg("accent", th.bold(`  ╭─ ${this.charName} 变更历史 ─╮`)), w));
    lines.push("");

    if (this.records.length === 0) {
      lines.push(truncateToWidth(`  ${th.fg("dim", "暂无变更记录")}`, w));
    } else {
      for (const r of this.records) {
        const time = new Date(r.timestamp).toLocaleString("zh-CN", { hour: "2-digit", minute: "2-digit" });
        const field = th.fg("muted", r.field);
        const oldV = th.fg("dim", String(r.oldValue));
        const newV = th.fg("accent", String(r.newValue));
        lines.push(truncateToWidth(`  ${th.fg("dim", time)} ${field}: ${oldV} → ${newV}`, w));
      }
    }

    lines.push("");
    lines.push(truncateToWidth(`  ${th.fg("dim", "ESC 关闭")}`, w));
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
