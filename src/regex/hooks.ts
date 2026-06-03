// ============================================================
// 正则双阶段：引擎层 prompt 剥离 + 前端 display 替换
// 通过 WebSocket 下发到 Web UI
// ============================================================

export type RegexPhase = "prompt" | "display"

export interface RegexHook {
  id: string
  name: string
  pattern: string // 正则表达式字符串
  replacement: string // 替换模板
  phase: RegexPhase // 作用阶段
  enabled: boolean
  cardId?: string // 可选：仅对特定卡片生效
}

export class RegexEngine {
  private hooks: RegexHook[] = []

  /** 加载正则钩子 */
  load(hooks: RegexHook[]): void {
    this.hooks = hooks
  }

  /** 卡片独立配置 */
  loadForCard(cardId: string, hooks: RegexHook[]): void {
    const withCardId = hooks.map((h) => ({ ...h, cardId }))
    this.hooks.push(...withCardId)
  }

  /** 执行指定阶段的所有钩子 */
  apply(input: string, phase: RegexPhase, cardId?: string): string {
    let result = input

    const active = this.hooks.filter(
      (h) => h.enabled && h.phase === phase && (!h.cardId || h.cardId === cardId),
    )

    for (const hook of active) {
      try {
        const regex = new RegExp(hook.pattern, "gs")
        result = result.replace(regex, hook.replacement)
      } catch {
        // 跳过不可用的正则
        continue
      }
    }

    return result
  }

  /** 获取所有钩子（供 WebSocket 下发） */
  getHooks(): RegexHook[] {
    return this.hooks
  }

  /** 清空 */
  clear(): void {
    this.hooks = []
  }
}

export const regexEngine = new RegexEngine()
