/**
 * RP Engine - 历史记录写入器
 *
 * 负责历史记录的缓冲、批量刷写、定时持久化。
 * 独立模块，不依赖 StateStore。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HistoryRecord } from "../types";

export class HistoryWriter {
  private buffer: HistoryRecord[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly FLUSH_INTERVAL = 5000;
  private readonly FLUSH_SIZE = 10;
  private historyPath = "";

  /** 每条记录写入前的外部队调（用于 __runtime__ 等特殊记录的处理） */
  onBeforeFlush?: (record: HistoryRecord) => void;

  setHistoryPath(stateDir: string): void {
    this.historyPath = join(stateDir, "state_history.jsonl");
  }

  getHistoryPath(): string {
    return this.historyPath;
  }

  append(record: HistoryRecord): void {
    this.buffer.push(record);

    // 特殊记录：turn_summary → 回调通知
    if (record.char === '__runtime__' && record.field === 'turn_summary') {
      this.onBeforeFlush?.(record);
    }

    if (this.buffer.length >= this.FLUSH_SIZE) {
      this.flushNow();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushNow();
      }, this.FLUSH_INTERVAL);
    }
  }

  flushNow(): void {
    if (this.buffer.length === 0) return;
    if (!this.historyPath) return;

    const dir = this.historyPath.replace(/[/\\][^/\\]*$/, '');
    mkdirSync(dir, { recursive: true });

    const batch = this.buffer.map(r => JSON.stringify(r) + "\n").join("");
    appendFileSync(this.historyPath, batch, "utf-8");
    this.buffer = [];
  }

  clearTimers(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  get pendingCount(): number {
    return this.buffer.length;
  }
}
