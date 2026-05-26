/**
 * RP Engine - 状态存储管理（session-first 版 v5）
 *
 * 架构：
 * - ⭐ PI session 是状态权威源（通过 pi.appendEntry("rp-state", snapshot) 记录）
 * - 文件（state.json / runtime_state.json）仅作为启动加速缓存，不保证最新
 * - 每次 saveState() 自动比较状态变更，写入 session 事件
 * - loadFromSession(ctx) 优先从 PI session 分支恢复，文件为回退
 * - 旧格式兼容：data.snapshot（旧）和 data.state（新）均支持
 *
 * v4 → v5 变更：文件优先 → session 优先，saveSessionSnapshot 合并入 saveState
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

  /** PI API 引用，用于写 session 事件（session-first 架构） */
  private pi: ExtensionAPI | null = null;
  /** 上一次保存的状态 JSON（用于变更检测，避免写重复 session 事件） */
  private lastSaveCheckpoint: string = '';
  /** session 事件时间戳（重放时定位最新 checkpoint） */
  private sessionCheckpointTs: number = 0;

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

  /** 注入 PI API 引用，开启 session-first 模式 */
  setPI(pi: ExtensionAPI): void {
    this.pi = pi;
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

  /**
   * ⭐ 从 session 加载状态（session-first）
   *
   * 1. 读文件缓存作为初始状态（快速启动）
   * 2. 重放 session 事件，以最新全量快照覆盖文件缓存
   * 3. 文件缓存不再是权威源，session 事件才是
   */
  loadFromSession(ctx: ExtensionContext, activeCardIds?: string[]): void {
    // 第一步：读文件缓存作为初始状态（尽可能快）
    this.loadFileCache(activeCardIds);
    this.lastSaveCheckpoint = this.buildCheckpointJson();

    // 第二步：在 session 分支中查找最新状态快照
    let snapshotCount = 0;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== "rp-state") continue;
      const data = entry.data;
      if (!data) continue;

      // 兼容新旧格式
      const snapshotState = data.state || data.snapshot;
      if (!snapshotState) continue;

      // 用 session 快照覆盖文件缓存（session 是权威源）
      this.state = { ...snapshotState };
      if (data.cardRuntimes) {
        this.cardRuntimes = {};
        for (const [cid, rt] of Object.entries(data.cardRuntimes as Record<string, any>)) {
          this.cardRuntimes[cid] = { ...rt };
        }
      }
      this.stateDir = this.state["_stateDir"] || this.stateDir;
      this.sessionCheckpointTs = data.timestamp || 0;
      snapshotCount++;
    }

    if (snapshotCount > 0) {
      this.rebuildCardStatesView();
      this.syncGlobalWorldState();
    }

    // 确保 activeCards 是最新的
    const ids = activeCardIds || (this.state.activeCards || []);
    this.state.activeCards = ids;

    // 同步 checkpoint 防止下一轮 saveState 重复写相同快照
    this.lastSaveCheckpoint = this.buildCheckpointJson();
  }

  /** 从文件缓存加载状态（快速启动辅助，不保证最新） */
  private loadFileCache(activeCardIds?: string[]): void {
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

  /** 构建可比较的 checkpoint JSON，用于 session 事件变更检测 */
  private buildCheckpointJson(): string {
    try {
      return JSON.stringify({
        activeCards: this.state.activeCards,
        cardRuntimes: this.cardRuntimes,
        _meta: this.state._meta,
        __runtime__: this.state.__runtime__,
      });
    } catch {
      return '';
    }
  }

  /**
   * 将当前状态快照写入 PI session 事件（session-first 核心）
   * 只有状态实际变更时才写入，避免重复事件
   */
  private flushSessionCheckpoint(): void {
    if (!this.pi) return;

    this.rebuildCardStatesView();

    const currentJson = this.buildCheckpointJson();
    if (currentJson && currentJson === this.lastSaveCheckpoint) return;

    try {
      this.pi.appendEntry("rp-state", {
        state: deepClone(this.state),
        cardRuntimes: deepClone(this.cardRuntimes),
        timestamp: Date.now(),
      });
      this.lastSaveCheckpoint = currentJson;
    } catch (e) {
      console.warn("[RP] session 事件写入失败:", (e as Error).message);
    }
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

  /** 保存状态：先写 session 事件（权威源），再写文件缓存（加速启动） */
  saveState(immediate = false): void {
    // ① session 事件（权威源）：状态变更时同步写入 PI session
    // 文件系统可能损坏，但 session append 是原子的
    this.flushSessionCheckpoint();

    // ② 文件缓存（加速启动用）：防抖写入，非关键路径
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

  /** 刷写所有待处理数据：session 事件 → 文件缓存 → 历史记录 */
  flushAll(): void {
    // session 事件（先于文件刷写，确保状态已记录）
    this.flushSessionCheckpoint();

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
    // 触发 session 事件 + 文件缓存
    this.saveState();
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

      // 写入 session 事件 + 文件缓存
      this.saveState(true);
      return count;
    } catch {
      return 0;
    }
  }

  // ============================================================
  // Session 恢复（从 PI session 事件重放状态）
  // ============================================================

  /**
   * 从会话分支中恢复状态（调用 session_tree 时使用）
   * session-first：直接从 session 事件重建，文件缓存仅做速度优化
   */
  reconstructFromSession(ctx: ExtensionContext): void {
    this.loadFromSession(ctx, this.state.activeCards as string[] | undefined);

    // 恢复后也同步一次文件缓存
    this.saveState(true);
  }
}
