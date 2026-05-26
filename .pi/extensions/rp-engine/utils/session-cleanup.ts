/**
 * RP Engine - Session 文件清理工具
 *
 * 清理旧的 session 文件（.jsonl），按数量和总大小限制。
 */

import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 15;
const MAX_SIZE = 15 * 1024 * 1024; // 15 MB

/** 递归扫描目录下所有 .jsonl 文件（不含 .summary） */
function collectSessionFiles(dir: string): { name: string; path: string; size: number; mtime: number }[] {
  const result: { name: string; path: string; size: number; mtime: number }[] = [];
  try {
    for (const f of readdirSync(dir)) {
      const fp = join(dir, f);
      const stat = statSync(fp);
      if (stat.isDirectory()) {
        result.push(...collectSessionFiles(fp));
      } else if (f.endsWith(".jsonl") && !f.endsWith(".summary")) {
        result.push({ name: f, path: fp, size: stat.size, mtime: stat.mtimeMs });
      }
    }
  } catch {}
  return result;
}

export function cleanupOldSessions(sessionsDir: string): void {
  if (!existsSync(sessionsDir)) return;
  try {
    const files = collectSessionFiles(sessionsDir)
      .sort((a, b) => b.mtime - a.mtime);

    let totalSize = 0;
    const toRemove: string[] = [];

    for (let i = 0; i < files.length; i++) {
      if (i >= MAX_FILES) {
        toRemove.push(files[i].path);
      } else {
        totalSize += files[i].size;
      }
    }

    if (totalSize > MAX_SIZE) {
      const keep = files.slice(0, MAX_FILES);
      for (let i = keep.length - 1; i >= 0; i--) {
        if (totalSize <= MAX_SIZE) break;
        totalSize -= keep[i].size;
        toRemove.push(keep[i].path);
      }
    }

    for (const p of toRemove) {
      try { rmSync(p, { force: true }); } catch {}
      try { rmSync(p + ".summary", { force: true }); } catch {}
    }
    if (toRemove.length > 0) {
      console.log(`[RP] 清理了 ${toRemove.length} 个旧 session 文件`);
    }
  } catch {}
}
