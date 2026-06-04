// ============================================================
// 卡片管理
// ============================================================

import type { CardMeta, CardState } from "./types.js"
import { StateStore, stateStore as _defaultStateStore } from "./state-store.js"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join, basename } from "node:path"

// ---- 文件持久化类型 ----

export interface CardEntry {
  id: string
  dir: string
  imported_at: string
}

export interface CardRegistryData {
  cards: Record<string, CardEntry>
  active: string[]
}

// ============================================================
// CardManager class
// ============================================================

export class CardManager {
  private registryPath: string
  private projectCwd: string
  private cachedRegistry: CardRegistryData | null = null
  private memMeta = new Map<string, CardMeta>()
  private activeOrder: string[] = []
  private _stateStore: StateStore

  private get stateStore(): StateStore {
    return this._stateStore
  }

  constructor(cwd?: string, stateStore?: StateStore) {
    this.projectCwd = cwd ?? process.cwd()
    this.registryPath = join(this.projectCwd, ".pi", "cards", "registry.json")
    this._stateStore = stateStore ?? _defaultStateStore
  }

  // ========== 文件持久化 API (from card-manager-new) ==========

  getRegistry(): CardRegistryData {
    if (this.cachedRegistry) return this.cachedRegistry
    if (!existsSync(this.registryPath)) {
      this.cachedRegistry = { cards: {}, active: [] }
      return this.cachedRegistry
    }
    try {
      const raw = JSON.parse(readFileSync(this.registryPath, "utf-8"))
      this.cachedRegistry = {
        cards: raw.cards || {},
        active: Array.isArray(raw.active) ? raw.active : raw.active ? [raw.active] : [],
      }
    } catch {
      this.cachedRegistry = { cards: {}, active: [] }
    }
    return this.cachedRegistry
  }

  saveRegistry(registry: CardRegistryData): void {
    const dir = join(this.projectCwd, ".pi", "cards")
    mkdirSync(dir, { recursive: true })
    writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf-8")
    this.cachedRegistry = registry
  }

  getActiveCardIds(): string[] {
    return [...this.getRegistry().active]
  }

  activateCards(cardIds: string[]): string[] {
    const reg = this.getRegistry()
    const validIds: string[] = []
    for (const id of cardIds) {
      if (reg.cards[id]) {
        if (!reg.active.includes(id)) reg.active.push(id)
        validIds.push(id)
      }
    }
    this.saveRegistry(reg)
    // 同步内存
    for (const id of validIds) {
      if (!this.activeOrder.includes(id)) this.activeOrder.push(id)
    }
    return validIds
  }

  deactivateCards(cardIds: string[]): void {
    const reg = this.getRegistry()
    reg.active = reg.active.filter((id) => !cardIds.includes(id))
    this.saveRegistry(reg)
    this.activeOrder = this.activeOrder.filter((id) => !cardIds.includes(id))
  }

  setActiveCard(cardId: string): boolean {
    const reg = this.getRegistry()
    if (!reg.cards[cardId]) return false
    reg.active = [cardId]
    this.saveRegistry(reg)
    return true
  }

  getCardName(cardId: string): string {
    const card = this.getRegistry().cards[cardId]
    if (!card) return cardId
    const configPath = join(card.dir, "config.json")
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"))
        if (config.character?.name) return config.character.name
      } catch {
        /* ignore */
      }
    }
    return basename(card.dir)
  }

  getCardWorldbookDir(cardId: string): string | null {
    const card = this.getRegistry().cards[cardId]
    if (!card) return null
    const dir = join(card.dir, "worldbook")
    return existsSync(dir) ? dir : null
  }

  getCardWorldbookDirs(): string[] {
    return this.getActiveCardIds()
      .map((id) => {
        const card = this.getRegistry().cards[id]
        if (!card) return null
        const dir = join(card.dir, "worldbook")
        return existsSync(dir) ? dir : null
      })
      .filter((d): d is string => d !== null)
  }

  // ========== 内存 API (from old card-manager, 向后兼容) ==========

  /** 编程式注册卡片（不写磁盘） */
  register(card: CardMeta): void {
    if (this.memMeta.has(card.id)) {
      throw new Error(`Card ${card.id} already registered`)
    }
    this.memMeta.set(card.id, { ...card, activatedAt: undefined })
  }

  /** 激活卡片（同步内存 + 文件注册表 + 可选 session state） */
  activate(cardId: string, sessionId?: string): void {
    const meta = this.memMeta.get(cardId)
    if (!meta) {
      const reg = this.getRegistry()
      if (!reg.cards[cardId]) throw new Error(`Card ${cardId} not registered`)
      this.memMeta.set(cardId, {
        id: cardId,
        name: this.getCardName(cardId),
        version: 1,
        tags: [],
      })
    }
    const m = this.memMeta.get(cardId)!
    m.activatedAt = Date.now()
    if (!this.activeOrder.includes(cardId)) {
      this.activeOrder.push(cardId)
    }

    // 同步到文件注册表
    try {
      const reg = this.getRegistry()
      if (reg.cards[cardId] && !reg.active.includes(cardId)) {
        reg.active.push(cardId)
        this.saveRegistry(reg)
      }
    } catch {
      // 文件操作失败不影响内存状态
    }

    if (sessionId) {
      const session = this.stateStore.getSession(sessionId)
      if (session && !session.activatedCards.has(cardId)) {
        session.activatedCards.set(cardId, {
          cardId,
          variables: {},
          lastUpdated: Date.now(),
        })
      }
    }
  }

  /** 停用卡片（同步内存 + 文件注册表） */
  deactivate(cardId: string): void {
    this.activeOrder = this.activeOrder.filter((id) => id !== cardId)
    const meta = this.memMeta.get(cardId)
    if (meta) meta.activatedAt = undefined

    // 同步到文件注册表
    try {
      const reg = this.getRegistry()
      if (reg.active.includes(cardId)) {
        reg.active = reg.active.filter((id) => id !== cardId)
        this.saveRegistry(reg)
      }
    } catch {
      // 文件操作失败不影响内存状态
    }
  }

  /** 当前激活卡片列表（合并内存 + 文件注册表） */
  getActiveCards(): CardMeta[] {
    const result: CardMeta[] = []
    for (const id of this.activeOrder) {
      const mem = this.memMeta.get(id)
      if (mem) {
        result.push(mem)
      } else {
        const name = this.getCardName(id)
        result.push({ id, name, version: 1, tags: [], activatedAt: Date.now() })
      }
    }
    return result
  }

  /** 获取注册表快照（合并内存 + 文件） */
  getAllRegistered(): CardMeta[] {
    const result: CardMeta[] = [...this.memMeta.values()]
    // 添加文件注册表中但不在内存的卡片
    const reg = this.getRegistry()
    for (const [id, entry] of Object.entries(reg.cards)) {
      if (!this.memMeta.has(id)) {
        result.push({
          id,
          name: this.getCardName(id),
          version: 1,
          tags: [],
        })
      }
    }
    return result
  }

  /** 读取卡片状态变量（委托给 StateStore） */
  getCardState(cardId: string, sessionId: string): CardState | undefined {
    return this.stateStore.getSession(sessionId)?.activatedCards.get(cardId)
  }

  /** 注销卡片 */
  unregister(cardId: string): void {
    this.deactivate(cardId)
    this.memMeta.delete(cardId)
  }
}
/** @deprecated 使用组合根 `createApp()` 或 `new CardManager(cwd, stateStore)` 替代 */
export const cardManager = new CardManager()
