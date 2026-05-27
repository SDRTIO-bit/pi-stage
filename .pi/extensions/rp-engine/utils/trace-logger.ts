/**
 * RP Engine - 追踪日志写入器
 *
 * 将所有 Pipeline 追踪日志写入独立文件，避免和 AI 流式输出在终端交错。
 * 日志文件：{stateDir}/logs/engine-trace.log
 * 同时保留 console.log 输出（可能被流式文本淹没，但对终端监控仍有帮助）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let _logDir: string | null = null;

export function initTraceLogger(stateDir: string): void {
  _logDir = join(stateDir, "logs");
  mkdirSync(_logDir, { recursive: true });
  _write("=== session start ===");
}

function _write(msg: string): void {
  if (!_logDir) return;
  try {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}\n`;
    appendFileSync(join(_logDir, "engine-trace.log"), line, "utf-8");
  } catch {}
}

export function traceLog(...args: unknown[]): void {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(" ");
  _write(msg);
  console.log(msg);
}
