// ============================================================
// Prompt Snapshot — 零侵入观测层
// 在 ContextPipeline.assemble() 完成后钩入，写入完整快照
// ============================================================

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { PipelinePhase } from "../context/pipeline.js"

export function logSnapshot(
  stateDir: string,
  sessionId: string,
  pipelinePhase: PipelinePhase,
): void {
  try {
    const dir = join(stateDir, "snapshots", sessionId)
    mkdirSync(dir, { recursive: true })

    const snapshot = {
      timestamp: Date.now(),
      sessionId,
      pipelinePhase,
    }

    writeFileSync(
      join(dir, `${Date.now()}.json`),
      JSON.stringify(snapshot, null, 2),
      "utf-8",
    )
  } catch {
    // 快照失败不影响主流程
  }
}
