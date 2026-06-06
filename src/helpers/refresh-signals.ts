// ============================================================
// 注意力刷新信号 — 轮换防止模型习惯化
// 高突兀度（视觉结构冲击）+ 不触发代码生成模式（无执行性语法）
// 不硬编码 RP 内容
// 所有信号 padding 到相同字节长度，保持 system prompt 静态可缓存
// ============================================================

const TARGET_BYTES = 410
const encoder = new TextEncoder()

function pad(signal: string): string {
  const current = encoder.encode(signal).byteLength
  if (current >= TARGET_BYTES) return signal
  return signal + " ".repeat(TARGET_BYTES - current)
}

const SIGNALS = [
  // 信号 A — 系统诊断框，等号线框风格
  pad(`══ SYSTEM PROTOCOL REFRESH ══
  pipeline  : draft_notes → gametxt → details.Auto → action
  triggers  : 判定 (combat / supernatural) | variables (turn_end)
  rules     : ALL presets + skills loaded & active
  directive : Follow full protocol chain. No stage skipped.
  ══════════════════════════════`),

  // 信号 B — 导演台本，元叙事视角
  pad(`【导演台本 · 开场前检查】
  1. 走 draft_notes 五步自查 → 不得省略
  2. gametxt 包裹正文 → 叙事完整性
  3. Auto 追踪 NPC 状态与行为链
  4. action 列出下一步可行动作
  5. 涉及非凡 / 战斗必须输出 判定 块
  6. 回合结束时更新状态变量
  以上全项确认，正式开拍。`),

  // 信号 C — QA 审计框，ASCII 线框风格（字节紧凑，与其他信号等长）
  pad(`+-----------------------------+
| RP OUTPUT GATE . 质量门禁  |
+-----------------------------+
| [ ] draft_notes  自查      |
| [ ] gametxt      正文      |
| [ ] Auto         NPC状态   |
| [ ] action       行动选项  |
| [ ] 判定         非凡/战斗 |
| [ ] variables    变量更新  |
+-----------------------------+
| 缺失任一项 -> 不合格       |
+-----------------------------+`),

  // 信号 D — 内务通告，简报风格
  pad(`◆ INTERNAL NOTICE · 本轮格式锚点 ◆
  输出序列: draft_notes ↦ gametxt ↦ Auto ↦ action
  强制约束: presets 规则全集持续生效
  变量纪律: 每回合结束须记录状态变更
  判定纪律: 超自然 / 战斗场景须输出完整判定块
  ◆ END NOTICE ◆`),
]

/**
 * 轮换: B → C → D → A → B → C → D → A → ...
 * 所有信号等长 → system prompt 静态可缓存
 */
export function getRefreshSignal(roundNumber: number): string | null {
  if (roundNumber <= 0) return null
  const idx = roundNumber % 4
  return SIGNALS[idx]!
}
