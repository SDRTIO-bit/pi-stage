// ============================================================
// 卡片注册表 — JSON 持久化
// ============================================================

import type { CardMeta } from "../types.js"

export interface CardRegistryEntry {
  meta: CardMeta
  path: string // 卡片目录路径
  activatedAt?: number
}

export class CardRegistry {
  private entries = new Map<string, CardRegistryEntry>()

  /** 注册卡片到注册表 */
  register(entry: CardRegistryEntry): void {
    if (this.entries.has(entry.meta.id)) {
      throw new Error(`Card ${entry.meta.id} already in registry`)
    }
    this.entries.set(entry.meta.id, entry)
  }

  /** 从注册表注销 */
  unregister(cardId: string): boolean {
    return this.entries.delete(cardId)
  }

  /** 获取注册条目 */
  get(cardId: string): CardRegistryEntry | undefined {
    return this.entries.get(cardId)
  }

  /** 列出所有注册卡片 */
  list(): CardRegistryEntry[] {
    return [...this.entries.values()]
  }

  /** 序列化为 JSON（持久化用） */
  toJSON(): string {
    const data = [...this.entries.values()].map((e) => ({
      meta: e.meta,
      path: e.path,
      activatedAt: e.activatedAt,
    }))
    return JSON.stringify(data, null, 2)
  }

  /** 从 JSON 恢复 */
  static fromJSON(json: string): CardRegistry {
    const registry = new CardRegistry()
    const data: CardRegistryEntry[] = JSON.parse(json)
    for (const entry of data) {
      registry.register(entry)
    }
    return registry
  }
}

export const cardRegistry = new CardRegistry()
