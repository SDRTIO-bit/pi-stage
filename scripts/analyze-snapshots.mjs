#!/usr/bin/env node
/**
 * Snapshot 分析工具 — 统计 prompt 各层占比、命中率、截断率
 * 用法: node scripts/analyze-snapshots.mjs [--session=all|sid]
 */
import { readdirSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const SNAPSHOTS_DIR = join(process.cwd(), ".pi", "snapshots")
const args = process.argv.slice(2)
const sessionFilter = args.find(a => a.startsWith("--session="))?.split("=")[1] ?? "all"

if (!existsSync(SNAPSHOTS_DIR)) {
  console.log("❌ 无快照目录。请先运行 RP 扩展产生数据。")
  process.exit(0)
}

// 收集所有快照
const allSnapshots = []
for (const sid of readdirSync(SNAPSHOTS_DIR)) {
  if (sessionFilter !== "all" && sid !== sessionFilter) continue
  const sessionDir = join(SNAPSHOTS_DIR, sid)
  if (!existsSync(sessionDir)) continue
  for (const f of readdirSync(sessionDir)) {
    if (!f.endsWith(".json")) continue
    try {
      allSnapshots.push({
        sessionId: sid,
        file: f,
        ...JSON.parse(readFileSync(join(sessionDir, f), "utf-8")),
      })
    } catch { /* skip corrupt files */ }
  }
}

if (allSnapshots.length === 0) {
  console.log("❌ 无有效快照")
  process.exit(0)
}

// ═══════════════════════════════════════
// 统计
// ═══════════════════════════════════════
const sessions = new Map()
for (const s of allSnapshots) {
  if (!sessions.has(s.sessionId)) sessions.set(s.sessionId, [])
  sessions.get(s.sessionId).push(s)
}

const TOKEN_DIVISOR = 2.0 // bytes → tokens 粗略估算

function bytesToTokens(bytes) {
  return Math.round(bytes / TOKEN_DIVISOR)
}

function fmt(n) {
  return String(n).padStart(6)
}

console.log("═".repeat(72))
console.log("  PI RP Engine — Snapshot 分析报告")
console.log("═".repeat(72))
console.log(`  快照总数: ${allSnapshots.length}`)
console.log(`  Session 数: ${sessions.size}`)
console.log()

// 全局统计
let totalReady = 0
let sumPromptBytes = 0
let sumCollectorBytes = {}
let sumDropped = 0
let sumSummarized = 0
let sumTotalBytes = 0

for (const s of allSnapshots) {
  const phase = s.pipelinePhase
  if (phase?.phase !== "ready") continue
  totalReady++

  const promptBytes = new TextEncoder().encode(phase.prompt || "").byteLength
  sumPromptBytes += promptBytes
  sumTotalBytes += phase.status?.totalBytesUsed ?? 0

  // Collector breakdown
  if (phase.collectorBytes) {
    for (const [k, v] of Object.entries(phase.collectorBytes)) {
      sumCollectorBytes[k] = (sumCollectorBytes[k] ?? 0) + v
    }
  }

  // Degradation stats
  const trace = phase.status?.trace ?? []
  for (const t of trace) {
    if (t.action === "dropped") sumDropped++
    if (t.action === "summarized") sumSummarized++
  }
}

console.log("── 全局 Token 分布（估算） ──")
console.log(`  指标                         平均值`)
console.log(`  ────────────────────────────────────`)
console.log(`  Prompt 总 Token               ${fmt(bytesToTokens(sumPromptBytes / totalReady))}`)

// Sort collectors by size
const sortedCollectors = Object.entries(sumCollectorBytes)
  .sort((a, b) => b[1] - a[1])
const collectorLabels = {
  "card-base": "系统提示",
  "format-rules": "格式规则",
  "rp-skills": "Skill 文件",
  "worldbook-trigger": "世界书触发",
  "state-variables": "角色状态",
  "other": "其他",
}

let accountedBytes = 0
for (const [key, totalBytes] of sortedCollectors) {
  const avgBytes = Math.round(totalBytes / totalReady)
  const avgTokens = bytesToTokens(avgBytes)
  const pct = ((totalBytes / sumTotalBytes) * 100).toFixed(1)
  accountedBytes += avgBytes
  const label = collectorLabels[key] ?? key
  console.log(`  ${label.padEnd(24)}  ${fmt(avgTokens)} (${String(pct).padStart(5)}%)`)
}

// Unaccounted (prompt overhead beyond collector content)
const avgPromptBytes = Math.round(sumPromptBytes / totalReady)
const unaccounted = avgPromptBytes - accountedBytes
if (unaccounted > 100) {
  console.log(`  ${"(prompt 结构开销)".padEnd(24)}  ${fmt(bytesToTokens(unaccounted))}`)
}

console.log()
console.log("── 调度统计 ──")
console.log(`  平均 drop/轮:       ${(sumDropped / totalReady).toFixed(1)}`)
console.log(`  平均 summarize/轮:   ${(sumSummarized / totalReady).toFixed(1)}`)
console.log(`  预算使用率:          ${((sumTotalBytes / totalReady / 40960) * 100).toFixed(0)}% (hard=40960)`)

// 世界书触发命中率
let worldHits = 0
let worldTotalBytes = 0
let worldHitRounds = 0
for (const s of allSnapshots) {
  const phase = s.pipelinePhase
  if (phase?.phase !== "ready") continue
  const wbBytes = phase.collectorBytes?.["worldbook-trigger"] ?? 0
  worldTotalBytes += wbBytes
  if (wbBytes > 0) worldHitRounds++
}
worldHits = worldHitRounds

console.log()
console.log("── 世界书检索 ──")
console.log(`  命中率:              ${((worldHitRounds / totalReady) * 100).toFixed(0)}%`)
console.log(`  平均注入/轮:          ${bytesToTokens(Math.round(worldTotalBytes / totalReady))} tokens`)

// 各 session 趋势
console.log()
console.log("── 各 Session 摘要 ──")
console.log(`  Session                        轮数   平均Prompt  世界书   状态`)
for (const [sid, snaps] of sessions) {
  const readySnaps = snaps.filter(s => s.pipelinePhase?.phase === "ready")
  if (readySnaps.length === 0) continue
  const avgP = Math.round(readySnaps.reduce((s, x) => s + new TextEncoder().encode(x.pipelinePhase.prompt || "").byteLength, 0) / readySnaps.length)
  const avgW = Math.round(readySnaps.reduce((s, x) => s + (x.pipelinePhase.collectorBytes?.["worldbook-trigger"] ?? 0), 0) / readySnaps.length)
  const avgSt = Math.round(readySnaps.reduce((s, x) => s + (x.pipelinePhase.collectorBytes?.["state-variables"] ?? 0), 0) / readySnaps.length)
  const shortSid = sid.length > 28 ? sid.slice(0, 25) + "..." : sid
  console.log(`  ${shortSid.padEnd(30)}  ${String(readySnaps.length).padStart(3)}  ${fmt(bytesToTokens(avgP)).padStart(8)}  ${fmt(bytesToTokens(avgW)).padStart(6)}  ${fmt(bytesToTokens(avgSt)).padStart(6)}`)
}

console.log()
console.log("═".repeat(72))
