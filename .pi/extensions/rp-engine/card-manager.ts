/**
 * RP Engine - 卡片管理器（依赖注入版）
 *
 * 统一管理角色卡片的导入、激活、状态。
 * CardManager class + 向后兼容的模块级函数包装。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { CardRegistry, CardEntry } from "./types";

// ============================================================
// CardManager class
// ============================================================

export class CardManager {
  private registryPath: string;
  private projectCwd: string;
  private cachedRegistry: CardRegistry | null = null;

  constructor(cwd: string) {
    this.projectCwd = cwd;
    this.registryPath = join(cwd, ".pi", "cards", "registry.json");
  }

  // ---- 注册表读写 ----

  getRegistry(): CardRegistry {
    if (this.cachedRegistry) return this.cachedRegistry;

    if (!existsSync(this.registryPath)) {
      this.cachedRegistry = { cards: {}, active: [] };
      return this.cachedRegistry;
    }

    try {
      const raw = readFileSync(this.registryPath, "utf-8");
      const parsed = JSON.parse(raw);
      const active = Array.isArray(parsed.active)
        ? parsed.active
        : (parsed.active ? [parsed.active] : []);

      this.cachedRegistry = {
        cards: parsed.cards || {},
        active,
      };
    } catch {
      this.cachedRegistry = { cards: {}, active: [] };
    }

    return this.cachedRegistry;
  }

  saveRegistry(registry: CardRegistry): void {
    const dir = join(this.projectCwd, ".pi", "cards");
    mkdirSync(dir, { recursive: true });
    writeFileSync(this.registryPath, JSON.stringify(registry, null, 2), "utf-8");
    this.cachedRegistry = registry;
  }

  // ---- 激活卡片查询 ----

  getActiveCardIds(): string[] {
    const reg = this.getRegistry();
    return [...reg.active];
  }

  getActiveCards(): CardEntry[] {
    const reg = this.getRegistry();
    return reg.active
      .map((id) => reg.cards[id])
      .filter((c): c is CardEntry => c !== undefined);
  }

  getCardWorldbookDirs(): string[] {
    const cards = this.getActiveCards();
    return cards.map((card) => join(card.dir, "worldbook")).filter((d) => existsSync(d));
  }

  getCardWorldbookDir(cardId: string): string | null {
    const reg = this.getRegistry();
    const card = reg.cards[cardId];
    if (!card) return null;
    const dir = join(card.dir, "worldbook");
    return existsSync(dir) ? dir : null;
  }

  getCardTavernScriptDirs(): string[] {
    const cards = this.getActiveCards();
    return cards.map((card) => join(card.dir, "tavern_scripts")).filter((d) => existsSync(d));
  }

  /**
   * 检查卡片是否包含新结构世界书（4 文件夹）
   */
  getCardWorldbookFolders(cardId: string): { triggered: string; constant: string } | null {
    const reg = this.getRegistry();
    const card = reg.cards[cardId];
    if (!card) return null;
    const wbDir = join(card.dir, "worldbook");
    if (!existsSync(wbDir)) return null;
    const triggered = join(wbDir, "[触发]关键词");
    const constant = join(wbDir, "[常开]设定");
    return {
      triggered: existsSync(triggered) ? triggered : "",
      constant: existsSync(constant) ? constant : "",
    };
  }

  getCardVectorsDir(cardId: string): string | null {
    const reg = this.getRegistry();
    const card = reg.cards[cardId];
    if (!card) return null;
    const dir = join(card.dir, "vectors");
    return existsSync(dir) ? dir : null;
  }

  getCardVectorsDirs(): string[] {
    return this.getActiveCards()
      .map((card) => join(card.dir, "vectors"))
      .filter((d) => existsSync(d));
  }

  getActiveCardCharacterNames(): { cardId: string; names: string[] }[] {
    const cards = this.getActiveCards();
    return cards.map((card) => {
      const statePath = join(card.dir, "state.json");
      const names: string[] = [];
      if (existsSync(statePath)) {
        try {
          const cardState = JSON.parse(readFileSync(statePath, "utf-8"));
          for (const key of Object.keys(cardState)) {
            if (key.startsWith("_") || key === "世界" || key === "{{user}}") continue;
            if (typeof cardState[key] === "object" && cardState[key]?.基本信息?.姓名) {
              names.push(key);
            }
          }
        } catch { /* 忽略解析错误 */ }
      }
      return { cardId: card.id, names };
    });
  }

  // ---- 卡片切换 ----

  activateCards(cardIds: string[]): string[] {
    const reg = this.getRegistry();
    const validIds: string[] = [];

    for (const id of cardIds) {
      if (reg.cards[id]) {
        if (!reg.active.includes(id)) {
          reg.active.push(id);
        }
        validIds.push(id);
      }
    }

    this.saveRegistry(reg);
    return validIds;
  }

  deactivateCards(cardIds: string[]): void {
    const reg = this.getRegistry();
    reg.active = reg.active.filter((id) => !cardIds.includes(id));
    this.saveRegistry(reg);
  }

  setActiveCard(cardId: string): boolean {
    const reg = this.getRegistry();
    if (!reg.cards[cardId]) return false;
    reg.active = [cardId];
    this.saveRegistry(reg);
    return true;
  }

  // ---- 卡片元信息 ----

  getCardName(cardId: string): string {
    const reg = this.getRegistry();
    const card = reg.cards[cardId];
    if (!card) return cardId;

    const configPath = join(card.dir, "config.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        if (config.character?.name) return config.character.name;
      } catch { /* 忽略 */ }
    }

    return basename(card.dir);
  }
}

// ============================================================
// 向后兼容的模块级函数包装
// ============================================================

let _defaultInstance: CardManager | null = null;

function getInstance(): CardManager {
  if (!_defaultInstance) throw new Error("CardManager 未初始化，请先调用 initCardManager(cwd)");
  return _defaultInstance;
}

export function initCardManager(cwd: string): void {
  _defaultInstance = new CardManager(cwd);
}

export function getRegistry(): CardRegistry {
  return getInstance().getRegistry();
}

export function saveRegistry(registry: CardRegistry): void {
  getInstance().saveRegistry(registry);
}

export function getActiveCardIds(): string[] {
  return getInstance().getActiveCardIds();
}

export function getActiveCards(): CardEntry[] {
  return getInstance().getActiveCards();
}

export function getCardWorldbookDirs(): string[] {
  return getInstance().getCardWorldbookDirs();
}

export function getCardWorldbookDir(cardId: string): string | null {
  return getInstance().getCardWorldbookDir(cardId);
}

export function getActiveCardCharacterNames(): { cardId: string; names: string[] }[] {
  return getInstance().getActiveCardCharacterNames();
}

export function activateCards(cardIds: string[]): string[] {
  return getInstance().activateCards(cardIds);
}

export function deactivateCards(cardIds: string[]): void {
  getInstance().deactivateCards(cardIds);
}

export function setActiveCard(cardId: string): boolean {
  return getInstance().setActiveCard(cardId);
}

export function getCardName(cardId: string): string {
  return getInstance().getCardName(cardId);
}

export function getCardTavernScriptDirs(): string[] {
  return getInstance().getCardTavernScriptDirs();
}

export function getCardWorldbookFolders(cardId: string): ReturnType<CardManager["getCardWorldbookFolders"]> {
  return getInstance().getCardWorldbookFolders(cardId);
}

export function getCardVectorsDir(cardId: string): string | null {
  return getInstance().getCardVectorsDir(cardId);
}

export function getCardVectorsDirs(): string[] {
  return getInstance().getCardVectorsDirs();
}
