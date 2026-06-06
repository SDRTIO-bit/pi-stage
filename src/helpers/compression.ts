// ============================================================
// 对话历史压缩
// 保留最近 N 轮完整对话，早期轮次压缩为摘要
// 只作用于对话历史（user/assistant），不碰 skill/预设
// ============================================================

/**
 * 压缩对话历史。
 * 保留最近 `keepRounds` 轮完整消息，早期轮次截断为摘要。
 * @param history  原始历史字符串数组，格式: ["user: ...", "assistant: ...", ...]
 * @param keepRounds 保留的完整轮数（默认 5）
 * @param threshold  触发压缩的最小条目数（默认 20，即 ~10 轮）
 */
export function compressHistory(
  history: string[],
  keepRounds: number = 5,
  threshold: number = 20,
): string[] {
  if (history.length <= threshold) return history

  const preserve = keepRounds * 3 // 留余量应对轮次边界的非标准条目
  const splitAt = Math.max(0, history.length - preserve)

  const oldEntries = history.slice(0, splitAt)
  const recentEntries = history.slice(splitAt)

  // 提取关键信息生成摘要
  const summaryBullets: string[] = []
  for (const entry of oldEntries) {
    if (entry.startsWith("user: ")) {
      const text = entry.slice(6).trim()
      summaryBullets.push(`[早期] 用户: ${text.length > 120 ? text.slice(0, 120) + "..." : text}`)
    } else if (entry.startsWith("assistant: ")) {
      const text = entry.slice(11).trim()
      summaryBullets.push(`[早期] AI: ${text.length > 200 ? text.slice(0, 200) + "..." : text}`)
    } else if (entry.startsWith("system: ")) {
      summaryBullets.push(`[早期] 系统: ${entry.slice(8).trim()}`)
    }
  }

  // 取最后 keepRounds*2 条摘要，避免太长的摘要块
  const trimmedSummaries = summaryBullets.slice(-keepRounds * 2)

  const result: string[] = []

  if (trimmedSummaries.length > 0) {
    result.push(
      `[历史摘要 — 早期对话概要，保留关键信息]\n${trimmedSummaries.join("\n")}\n[近期对话保留完整如下]`,
    )
  }

  result.push(...recentEntries)

  return result
}

/** 获取历史中的轮次数（按 "user: " 前缀计数） */
export function getRoundCount(history: string[]): number {
  return history.filter((e) => e.startsWith("user: ")).length
}
