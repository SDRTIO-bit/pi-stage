/**
 * RP Engine - 状态存储管理（卡片隔离版 v4）
 *
 * 架构：
 * - 主 .pi/state.json 只存 _meta + activeCards + __runtime__
 * - 每张卡片的运行时角色数据独立存储：卡片目录/runtime_state.json
 * - 卡片模板 state.json 作为只读模板，不受运行时修改影响
 * - /reset 只重置指定卡片
 *
 * v4 → v5 变更：工厂函数 → StateStore class，API 不变。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HistoryRecord, CardState } from "./types";
import { deepClone } from "./utils";
import { HistoryWriter } from "./persistence/history-writer";

/** 卡片运行时状态文件路径 */
function getCardRuntimePath(cardsDir: string, cardId: string): string {
  return join(cardsDir, "cards", cardId, "runtime_state.json");
}

// ============================================================
// StateStore class
// ============================================================

export class StateStore {
  private stateDir = "";
  /** 主 state：只有 _meta + activeCards + __runtime__ */
  private state: Record<string, any> = {};
  /** 卡片运行时内存缓存：cardId → { characters, world, flags } */
  private cardRuntimes: Record<string, Record<string, any>> = {};

  /** 历史记录写入器（缓冲→批量刷写） */
  private historyWriter = new HistoryWriter();

  // ---- state 写入防抖 ----
  private saveStateTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly SAVE_DEBOUNCE_MS = 300;
  private pendingSave = false;

  // ============================================================
  // 目录与路径
  // ============================================================

  setDirectories(dir: string): void {
    this.stateDir = dir;
    this.state["_stateDir"] = dir;

    // 初始化历史记录写入器
    this.historyWriter.setHistoryPath(dir);
    this.historyWriter.onBeforeFlush = (record) => {
      if (record.char !== '__runtime__' || record.field !== 'turn_summary') return;
      try {
        const runtimeInfo = typeof record.newValue === 'string'
          ? JSON.parse(record.newValue)
          : record.newValue;
        this.state['__runtime__'] = {
          ...(this.state['__runtime__'] || {}),
          ...runtimeInfo,
          lastUpdated: record.timestamp,
        };
      } catch { /* 解析失败不影响主流程 */ }
    };
  }

  private getStatePath(): string {
    return join(this.stateDir, "state.json");
  }

  getHistoryPath(): string {
    return this.historyWriter.getHistoryPath();
  }

  // ============================================================
  // 加载
  // ============================================================

  loadState(activeCardIds?: string[]): void {
    const p = this.getStatePath();

    if (existsSync(p)) {
      try {
        this.state = JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        this.state = {};
      }
    }

    const ids = activeCardIds || (this.state.activeCards || []);
    this.state.activeCards = ids;
    this.cardRuntimes = {};

    for (const cardId of ids) {
      this.loadCardRuntime(cardId);
    }

    // 从旧 state.cardStates 迁移
    this.migrateLegacyCardStates();

    this.rebuildCardStatesView();

    // 将顶层世界状态同步为当前激活卡片的数据
    this.syncGlobalWorldState();
  }

  /**
   * 从当前激活卡片的 runtime world 同步顶层 state["世界"]
   * 防止切换角色卡后残留旧卡的世界数据
   */
  syncGlobalWorldState(): void {
    delete this.state["世界"];
    delete this.state.global?.世界;

    const activeIds: string[] = this.state.activeCards || [];
    for (const cardId of activeIds) {
      const runtime = this.cardRuntimes[cardId];
      if (runtime?.world && typeof runtime.world === "object" && Object.keys(runtime.world).length > 0) {
        this.state["世界"] = deepClone(runtime.world);
        return;
      }
    }
  }

  private loadCardRuntime(cardId: string): void {
    const runtimePath = getCardRuntimePath(this.stateDir, cardId);
    if (existsSync(runtimePath)) {
      try {
        this.cardRuntimes[cardId] = JSON.parse(readFileSync(runtimePath, "utf-8"));
        return;
      } catch {
        this.cardRuntimes[cardId] = { characters: {}, world: {}, flags: {} };
        return;
      }
    }

    // 从卡片模板初始化
    const templatePath = join(this.stateDir, "cards", cardId, "state.json");
    if (!existsSync(templatePath)) {
      this.cardRuntimes[cardId] = { characters: {}, world: {}, flags: {} };
      return;
    }

    try {
      const template = JSON.parse(readFileSync(templatePath, "utf-8"));
      const characters: Record<string, any> = {};
      for (const [charName, charData] of Object.entries(template)) {
        if (charName === "_meta" || charName === "事件") continue;
        if (typeof charData === "object" && (charData as any).基本信息) {
          characters[charName] = deepClone(charData);
        }
      }
      this.cardRuntimes[cardId] = {
        characters,
        world: template["世界"] ? deepClone(template["世界"]) : {},
        flags: {},
        _meta: { initializedAt: new Date().toISOString(), templateVersion: template._meta?.version || 1 },
      };
      mkdirSync(join(this.stateDir, "cards", cardId), { recursive: true });
      writeFileSync(runtimePath, JSON.stringify(this.cardRuntimes[cardId], null, 2), "utf-8");
    } catch {
      this.cardRuntimes[cardId] = { characters: {}, world: {}, flags: {} };
    }
  }

  private migrateLegacyCardStates(): void {
    const legacyCardStates = this.state.cardStates;
    if (!legacyCardStates || typeof legacyCardStates !== "object") return;

    let migratedCount = 0;
    for (const [cardId, cardData] of Object.entries(legacyCardStates as Record<string, any>)) {
      if (this.cardRuntimes[cardId] && Object.keys(this.cardRuntimes[cardId].characters || {}).length > 0) continue;
      if (!cardData.characters || typeof cardData.characters !== "object") continue;

      const chars = cardData.characters;
      const charCount = Object.keys(chars).length;
      if (charCount === 0) continue;

      this.cardRuntimes[cardId] = {
        characters: deepClone(chars),
        world: cardData.world ? deepClone(cardData.world) : {},
        flags: cardData.flags ? deepClone(cardData.flags) : {},
        _meta: { migratedFrom: "legacy_state.json", migratedAt: new Date().toISOString(), charCount },
      };
      const runtimePath = getCardRuntimePath(this.stateDir, cardId);
      mkdirSync(join(this.stateDir, "cards", cardId), { recursive: true });
      writeFileSync(runtimePath, JSON.stringify(this.cardRuntimes[cardId], null, 2), "utf-8");
      migratedCount += charCount;
    }

    if (migratedCount > 0) {
      console.log(`[RP] 已迁移旧 state.json 数据 → runtime_state.json（${migratedCount} 个角色）`);
    }
    delete this.state.cardStates;
  }

  /** 从 cardRuntimes 重建 state.cardStates 虚映射 */
  private rebuildCardStatesView(): void {
    const cardStates: Record<string, any> = {};
    for (const [cardId, runtime] of Object.entries(this.cardRuntimes)) {
      cardStates[cardId] = {
        meta: { name: cardId, route: cardId, started: true },
        characters: runtime.characters || {},
        world: runtime.world || {},
        flags: runtime.flags || {},
      };
    }
    this.state.cardStates = cardStates;
  }

  // ============================================================
  // 保存
  // ============================================================

  private clearTimers(): void {
    this.historyWriter.clearTimers();
    if (this.saveStateTimer) { clearTimeout(this.saveStateTimer); this.saveStateTimer = null; }
  }

  private saveStateNow(): void {
    // 防御：stateDir 尚未初始化时不写入（turn_end 可能早于 session_start 触发）
    if (!this.stateDir) return;

    this.rebuildCardStatesView();

    const mainState: Record<string, any> = {
      _stateDir: this.state["_stateDir"],
      _meta: {
        ...(this.state["_meta"] || {}),
        lastUpdated: new Date().toISOString(),
      },
      activeCards: this.state.activeCards || [],
      __runtime__: this.state.__runtime__ || undefined,
    };

    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.getStatePath(), JSON.stringify(mainState, null, 2), "utf-8");

    for (const [cardId, runtime] of Object.entries(this.cardRuntimes)) {
      const runtimePath = getCardRuntimePath(this.stateDir, cardId);
      try {
        mkdirSync(join(this.stateDir, "cards", cardId), { recursive: true });
        writeFileSync(runtimePath, JSON.stringify(runtime, null, 2), "utf-8");
      } catch (e) {
        console.warn(`[RP] 写入卡片 ${cardId} runtime_state 失败:`, (e as Error).message);
      }
    }

    this.pendingSave = false;
  }

  saveState(immediate = false): void {
    if (immediate) {
      if (this.saveStateTimer) { clearTimeout(this.saveStateTimer); this.saveStateTimer = null; }
      this.saveStateNow();
      return;
    }
    this.pendingSave = true;
    if (!this.saveStateTimer) {
      this.saveStateTimer = setTimeout(() => {
        this.saveStateTimer = null;
        if (this.pendingSave) this.saveStateNow();
      }, this.SAVE_DEBOUNCE_MS);
    }
  }

  flushAll(): void {
    this.clearTimers();
    if (this.pendingSave) this.saveStateNow();
    this.historyWriter.flushNow();
  }

  // ============================================================
  // 历史记录（委托给 HistoryWriter）
  // ============================================================

  appendHistory(record: HistoryRecord): void {
    this.historyWriter.append(record);
  }

  // ============================================================
  // 状态访问
  // ============================================================

  getState(): Record<string, any> {
    this.rebuildCardStatesView();
    return this.state;
  }

  setState(newState: Record<string, any>): void {
    this.state = newState;
  }

  getCardState(cardId: string): CardState | null {
    const runtime = this.cardRuntimes[cardId];
    if (!runtime) return null;
    return {
      meta: { name: cardId, route: cardId, started: true },
      characters: runtime.characters || {},
      flags: runtime.flags || {},
    };
  }

  getCardCharacter(cardId: string, charName: string): Record<string, any> | null {
    const runtime = this.cardRuntimes[cardId];
    if (!runtime) return null;
    return runtime.characters?.[charName] || null;
  }

  updateCardCharacter(cardId: string, charName: string, updates: Record<string, any>): boolean {
    const runtime = this.cardRuntimes[cardId];
    if (!runtime) return false;
    if (!runtime.characters) runtime.characters = {};
    if (!runtime.characters[charName]) {
      runtime.characters[charName] = updates;
    } else {
      Object.assign(runtime.characters[charName], updates);
    }
    return true;
  }

  getAllCharacterNames(): { cardId: string; name: string }[] {
    const result: { cardId: string; name: string }[] = [];
    for (const [cardId, runtime] of Object.entries(this.cardRuntimes)) {
      for (const name of Object.keys(runtime.characters || {})) {
        result.push({ cardId, name });
      }
    }
    return result;
  }

  getCardRuntime(cardId: string): Record<string, any> | null {
    return this.cardRuntimes[cardId] || null;
  }

  resetCardFromTemplate(cardId: string): number {
    const templatePath = join(this.stateDir, "cards", cardId, "state.json");
    if (!existsSync(templatePath)) return 0;

    try {
      const template = JSON.parse(readFileSync(templatePath, "utf-8"));
      const characters: Record<string, any> = {};
      let count = 0;

      for (const [charName, charData] of Object.entries(template)) {
        if (charName === "_meta" || charName === "事件") continue;
        if (typeof charData === "object" && (charData as any).基本信息) {
          characters[charName] = deepClone(charData);
          count++;
        }
      }

      this.cardRuntimes[cardId] = {
        characters,
        world: template["世界"] ? deepClone(template["世界"]) : (this.cardRuntimes[cardId]?.world || {}),
        flags: {},
        _meta: {
          initializedAt: new Date().toISOString(),
          templateVersion: template._meta?.version || 1,
          resetAt: new Date().toISOString(),
        },
      };

      const runtimePath = getCardRuntimePath(this.stateDir, cardId);
      writeFileSync(runtimePath, JSON.stringify(this.cardRuntimes[cardId], null, 2), "utf-8");
      return count;
    } catch {
      return 0;
    }
  }

  // ============================================================
  // Session 快照
  // ============================================================

  saveSessionSnapshot(pi: any): void {
    try {
      this.rebuildCardStatesView();
      pi.appendEntry("rp-state", {
        snapshot: deepClone(this.state),
        cardRuntimes: deepClone(this.cardRuntimes),
        timestamp: Date.now(),
      });
    } catch {}
  }

  reconstructFromSession(ctx: ExtensionContext): void {
    let latestSnapshot: any = null;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "rp-state") {
        latestSnapshot = entry.data?.snapshot;
      }
    }
    if (!latestSnapshot) return;

    // 只恢复 __runtime__ 等运行时元信息，不恢复卡数据
    const runtimeOnly: Record<string, any> = {
      __runtime__: latestSnapshot.__runtime__,
      activeCards: this.state.activeCards || latestSnapshot.activeCards || [],
    };
    this.state = { ...this.state, ...runtimeOnly };

    // 从磁盘重新加载当前卡片的运行时数据（防止旧卡数据污染）
    const activeIds: string[] = this.state.activeCards || [];
    this.cardRuntimes = {};
    for (const cardId of activeIds) {
      this.loadCardRuntime(cardId);
    }
    this.rebuildCardStatesView();
    this.syncGlobalWorldState();
  }
}
