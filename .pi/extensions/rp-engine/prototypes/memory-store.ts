/**
 * RP Engine - MemoryStore 原型
 *
 * 基于 Open-Theatre 4层记忆系统的 TypeScript 移植。
 * 为 state-store.ts 补充事件流存储与语义检索能力。
 *
 * 架构：
 * - MemoryStore 为独立模块，与 state-store 共存而非重写
 * - state-store 负责当前状态快照，MemoryStore 负责历史事件流
 * - 4层存储: Global(设定/档案) / Event(对话/事件) / Summary(摘要) / Archive(归档)
 * - 检索: BM25关键词 + 可选向量语义 + 重要性加权 + 场景衰减
 *
 * 注意：此文件为类骨架原型，尚未接入主流程。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// 记忆文本内容清洗
// ============================================================

/** 清洗记忆文本：移除 XML 标签、标准化空白 */
export function sanitizeMemoryText(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<choice>[\s\S]*?<\/choice>/gi, '')
    .replace(/<content>[\s\S]*?<\/content>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
// 类型定义
// ============================================================

export type Visibility = 'public' | 'scene_only' | 'private';

export interface MemoryEntry {
  id: number;
  text: string;
  layer: 'global' | 'event' | 'summary' | 'archive';
  tag: string;
  sceneId: string;
  cardId: string;
  sourceAgent: string;
  importance: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  /** 事件涉及的角色（用于角色桶分发） */
  relatedCharacters?: string[];
  /** 可见性 */
  visibility?: Visibility;
}

export interface MemoryChunk {
  id: number;
  entries: MemoryEntry[];
  text: string;
  layer: string;
  tag: string;
  sceneId: string;
  cardId: string;
  importance: number;
  createdAt: number;
}

export interface MemoryQueryResult {
  chunk: MemoryChunk;
  score: number;
  source: string;
}

export interface QueryOptions {
  targetLayers?: string[];
  topK?: number;
  currentSceneId?: string;
  cardId?: string;
  useSemantic?: boolean;
  /** 按角色检索（直接查角色桶） */
  characterFilter?: string;
  /** 按可见性筛选 */
  visibilityFilter?: Visibility;
}

export interface MemoryStoreConfig {
  chunkMaxEntries: number;
  chunkMaxLength: number;
  chunkOverlap: number;
  topK: number;
  bm25Weight: number;
  vectorWeight: number;
  importanceWeight: number;
  sceneDecayAlpha: number;
  dialogueDecayBeta: number;
  summaryBatchSize: number;
  retrieveThreshold: number;
}

export const DEFAULT_MEMORY_CONFIG: MemoryStoreConfig = {
  chunkMaxEntries: 5,
  chunkMaxLength: 800,
  chunkOverlap: 1,
  topK: 5,
  bm25Weight: 0.3,
  vectorWeight: 0.5,
  importanceWeight: 0.2,
  sceneDecayAlpha: 0.25,
  dialogueDecayBeta: 0.005,
  summaryBatchSize: 5,
  retrieveThreshold: 6,
};

// ============================================================
// 子存储（单层）
// ============================================================

class MemorySubStorage {
  readonly layer: string;
  readonly tagWeights: Record<string, number>;
  private chunks: Map<number, MemoryChunk> = new Map();
  private nextId = 1;

  constructor(layer: string, tagWeights?: Record<string, number>) {
    this.layer = layer;
    this.tagWeights = tagWeights ?? {};
  }

  /** 获取当前层所有 chunk */
  getAllChunks(): MemoryChunk[] {
    return Array.from(this.chunks.values());
  }

  /** 按 sceneId 筛选 chunk */
  getChunksByScene(sceneId: string): MemoryChunk[] {
    return this.getAllChunks().filter((c) => c.sceneId === sceneId);
  }

  /** 追加 entry 到现有 chunk 或创建新 chunk */
  appendEntry(entry: MemoryEntry, config: MemoryStoreConfig): void {
    // 找可追加的chunk：同layer+同tag+同scene
    const candidates = this.getAllChunks()
      .filter((c) => c.tag === entry.tag && c.sceneId === entry.sceneId)
      .sort((a, b) => b.id - a.id);

    for (const chunk of candidates) {
      if (chunk.text.length + entry.text.length + 1 <= config.chunkMaxLength &&
          chunk.entries.length < config.chunkMaxEntries) {
        chunk.entries.push(entry);
        chunk.text = chunk.entries.map((e) => e.text).join('\n');
        chunk.importance = Math.max(chunk.importance, entry.importance);
        return;
      }
    }

    // 无可用chunk → 创建新chunk（含overlap）
    const overlap: MemoryEntry[] = [];
    if (config.chunkOverlap > 0) {
      const allHere = this.getAllChunks()
        .flatMap((c) => c.entries)
        .filter((e) => e.tag === entry.tag && e.sceneId === entry.sceneId);
      const start = Math.max(0, allHere.length - config.chunkOverlap);
      for (let i = start; i < allHere.length; i++) {
        overlap.push(allHere[i]);
      }
    }

    const newChunk: MemoryChunk = {
      id: this.nextId++,
      entries: [...overlap, entry],
      text: [...overlap, entry].map((e) => e.text).join('\n'),
      layer: this.layer,
      tag: entry.tag,
      sceneId: entry.sceneId,
      cardId: entry.cardId,
      importance: entry.importance,
      createdAt: entry.createdAt,
    };
    this.chunks.set(newChunk.id, newChunk);
  }

  /** 移除 chunk */
  removeChunk(id: number): boolean {
    return this.chunks.delete(id);
  }

  /** 直接插入chunk（归档用） */
  addChunkDirect(chunk: MemoryChunk): void {
    chunk.id = this.nextId++;
    this.chunks.set(chunk.id, chunk);
  }

  /** 清空当前层 */
  clear(): void {
    this.chunks.clear();
    this.nextId = 1;
  }

  /** BM25 简化检索（无外部依赖的关键词匹配） */
  queryBM25(queryText: string, topK: number): { chunk: MemoryChunk; score: number }[] {
    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) return [];

    const scored: { chunk: MemoryChunk; score: number }[] = [];
    for (const chunk of this.chunks.values()) {
      const docTokens = this.tokenize(chunk.text);
      let score = 0;
      for (const qt of queryTokens) {
        const freq = docTokens.filter((t) => t === qt).length;
        if (freq > 0) {
          score += Math.log(1 + freq) * Math.log((this.chunks.size + 1) / 1);
        }
      }
      if (score > 0) scored.push({ chunk, score });
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /** 简化 tokenizer */
  private tokenize(text: string): string[] {
    const cleaned = text.toLowerCase().replace(/[^\w一-鿿]/g, ' ');
    const tokens: string[] = [];
    // 中文分词：单字
    for (const ch of cleaned) {
      if (ch >= '一' && ch <= '鿿') {
        tokens.push(ch);
      }
    }
    // 英文按空白分割
    for (const word of cleaned.split(/\s+/)) {
      if (word.length >= 2 && !(word >= '一' && word <= '鿿')) {
        tokens.push(word);
      }
    }
    return tokens;
  }

  /** 检索入口（BM25 + 重要性加权 + 场景衰减） */
  retrieve(
    queryText: string,
    currentSceneId: string | undefined,
    config: MemoryStoreConfig
  ): MemoryQueryResult[] {
    const bm25Results = this.queryBM25(queryText, config.topK * 3);
    const tagWeight = (tag: string) => this.tagWeights[tag] ?? 1.0;
    const layerWeight = this.layer === 'archive' ? 0.1 : 1.0;

    const results: MemoryQueryResult[] = bm25Results.map((r) => {
      let score = config.bm25Weight * r.score + config.importanceWeight * r.chunk.importance;

      score *= layerWeight * tagWeight(r.chunk.tag);

      // 场景间衰减
      if (currentSceneId && r.chunk.sceneId && r.chunk.sceneId !== currentSceneId) {
        const sceneDiff = Math.abs(
          parseInt(r.chunk.sceneId) - parseInt(currentSceneId)
        );
        score /= 1 + config.sceneDecayAlpha * (isNaN(sceneDiff) ? 1 : sceneDiff);
      }

      return { chunk: r.chunk, score, source: this.layer };
    });

    return results.sort((a, b) => b.score - a.score).slice(0, config.topK);
  }
}

// ============================================================
// 检索器
// ============================================================

class Retriever {
  constructor(private config: MemoryStoreConfig) {}

  retrieve(
    queryText: string,
    storages: MemorySubStorage[],
    currentSceneId?: string
  ): MemoryQueryResult[] {
    const all: MemoryQueryResult[] = [];
    for (const storage of storages) {
      const results = storage.retrieve(queryText, currentSceneId, this.config);
      all.push(...results);
    }
    return all.sort((a, b) => b.score - a.score).slice(0, this.config.topK);
  }

  /** 格式化检索结果为 prompt 上下文文本 */
  formatContext(results: MemoryQueryResult[]): string {
    if (results.length === 0) return '';
    const lines = results.map((r) => {
      const tag = r.chunk.tag;
      const text = r.chunk.text.slice(0, 200);
      return `[${r.source}:${tag}](重要性:${r.chunk.importance.toFixed(2)}) ${text}`;
    });
    return `相关记忆:\n${lines.join('\n')}`;
  }
}

// ============================================================
// 摘要器
// ============================================================

type SummarizeFn = (texts: string[]) => Promise<string>;

class Summarizer {
  constructor(private config: MemoryStoreConfig) {}

  async summarizeScene(
    eventStorage: MemorySubStorage,
    summaryStorage: MemorySubStorage,
    archiveStorage: MemorySubStorage,
    sceneId: string,
    summarizeFn: SummarizeFn
  ): Promise<void> {
    const chunks = eventStorage.getChunksByScene(sceneId);
    if (chunks.length === 0) return;

    const batchSize = this.config.summaryBatchSize;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const combined = batch.map((c) => c.text).join('\n---\n');

      try {
        const summary = await summarizeFn([combined]);
        // 摘要写入 Summary 层
        summaryStorage.appendEntry(
          {
            id: 0,
            text: summary,
            layer: 'summary',
            tag: 'summary_conversation',
            sceneId,
            cardId: batch[0].cardId,
            sourceAgent: '__summarizer__',
            importance: 0.5,
            metadata: {},
            createdAt: Date.now(),
          },
          this.config
        );
      } catch {
        // summarize 失败 → 跳过，保留原文
      }
    }

    // 原始 chunk 从 Event 移到 Archive
    for (const chunk of chunks) {
      eventStorage.removeChunk(chunk.id);
      chunk.layer = 'archive';
      chunk.tag = `archived_${chunk.tag}`;
      archiveStorage.addChunkDirect(chunk);
    }
  }
}

// ============================================================
// MemoryStore 主类
// ============================================================

export class MemoryStore {
  readonly global: MemorySubStorage;
  readonly event: MemorySubStorage;
  readonly summary: MemorySubStorage;
  readonly archive: MemorySubStorage;

  private retriever: Retriever;
  private summarizer: Summarizer;
  private config: MemoryStoreConfig;
  private totalEntries = 0;
  private summarizeFn: SummarizeFn | null = null;

  private _cardId = '';
  private _initialized = false;
  private _activeSessionId = '';
  private _memoryBasePath = '';

  /** 角色桶：角色名 → 专属 MemorySubStorage */
  private characterBuckets: Map<string, MemorySubStorage> = new Map();

  /** addEvent 调用计数（前 3 次调试用） */
  private _addEventCallCount = 0;

  /** 标签自动分类映射表 */
  private readonly TAG_AUTO_MAP: Record<string, string> = {
    'plot': 'plot',
    'character': 'character_action',
    'environment': 'environment',
    'ambient': 'ambient',
    'thought': 'thought',
    'action': 'action',
    'conversation': 'conversation',
    'round_summary': 'round_summary',
    'summary_conversation': 'summary_conversation',
    'world_event': 'world_event',
  };

  constructor(config?: Partial<MemoryStoreConfig>) {
    this.config = { ...DEFAULT_MEMORY_CONFIG, ...config };

    this.global = new MemorySubStorage('global', {
      profile: 1.5,
      scene_init: 1.3,
      scene_objective: 1.4,
    });
    this.event = new MemorySubStorage('event', {
      conversation: 1.0,
      action: 1.0,
      thought: 1.0,
    });
    this.summary = new MemorySubStorage('summary', {
      summary_conversation: 1.2,
      summary_scene_init: 1.1,
      summary_scene_objective: 1.3,
    });
    this.archive = new MemorySubStorage('archive', {
      archived_conversation: 0.2,
      archived_scene_init: 0.1,
      archived_scene_objective: 0.1,
    });

    this.retriever = new Retriever(this.config);
    this.summarizer = new Summarizer(this.config);
  }

  /** 注入 LLM 摘要函数 */
  setSummarizeFn(fn: SummarizeFn): void {
    this.summarizeFn = fn;
  }

  /** 获取初始化状态 */
  get initialized(): boolean { return this._initialized; }

  /** 获取关联的 cardId */
  get cardId(): string { return this._cardId; }

  // ============================================================
  // 写入
  // ============================================================

  /** 核心写入入口（含内容清洗） */
  addEvent(
    text: string,
    layer: 'global' | 'event' | 'summary' | 'archive',
    tag: string,
    sceneId: string,
    cardId: string,
    sourceAgent: string,
    relatedCharacters?: string[],
    visibility?: Visibility
  ): void {
    const cleanText = sanitizeMemoryText(text);
    if (!cleanText) return;

    const isDebug = this._addEventCallCount < 3;
    this._addEventCallCount++;

    // ⭐ 自动分类标签：根据 sourceAgent 和内容 [type] 前缀推断
    const autoTag = this.autoClassifyTag(cleanText, sourceAgent, tag);
    if (isDebug && autoTag !== tag) {
      console.log(`[MemoryStore] 标签自动分类: "${tag}" → "${autoTag}" (source=${sourceAgent})`);
    }

    const entry: MemoryEntry = {
      id: this.totalEntries++,
      text: cleanText,
      layer,
      tag: autoTag,
      sceneId,
      cardId,
      sourceAgent,
      importance: 0,
      metadata: {},
      createdAt: Date.now(),
      relatedCharacters,
      visibility,
    };

    const storage = this.getStorage(layer);
    storage.appendEntry(entry, this.config);

    // ⭐ 角色桶分发：为每个相关角色写入专属桶
    if (relatedCharacters && relatedCharacters.length > 0) {
      const uniqueChars = [...new Set(relatedCharacters)];
      for (const charName of uniqueChars) {
        let bucket = this.characterBuckets.get(charName);
        if (!bucket) {
          bucket = new MemorySubStorage('event', { conversation: 1.0 });
          this.characterBuckets.set(charName, bucket);
        }
        bucket.appendEntry({...entry, layer: 'event'}, this.config);
      }
    }

    if (isDebug) {
      console.log(`[MemoryStore] addEvent layer=${layer} tag=${autoTag} source=${sourceAgent} text="${cleanText.slice(0, 80)}"`);
    }
  }

  /**
   * 根据 sourceAgent 和内容 [type] 前缀自动分类标签
   */
  private autoClassifyTag(text: string, sourceAgent: string, defaultTag: string): string {
    // 1. 内容以 [xxx] 开头 → 提取类型
    const match = text.match(/^\[(\w+)\]/);
    if (match) {
      const typeStr = match[1].toLowerCase();
      return this.TAG_AUTO_MAP[typeStr] || typeStr;
    }

    // 2. 根据 sourceAgent 推断
    if (sourceAgent === 'user' || sourceAgent === 'assistant') return 'conversation';
    if (sourceAgent === 'world_agent') return 'world_event';
    if (sourceAgent === '__summarizer__') return 'summary';

    return defaultTag;
  }

  // ============================================================
  // 检索
  // ============================================================

  /** 当前会话事件层条目数（用于判断是否需要回溯归档） */
  get currentSessionEventCount(): number {
    return this.event.getAllChunks()
      .reduce((sum, c) => sum + c.entries.length, 0);
  }

  /** 检索接口（默认只查当前 session 的 event 层） */
  query(inputText: string, options?: QueryOptions): MemoryQueryResult[] {
    const characterFilter = options?.characterFilter;
    const visibilityFilter = options?.visibilityFilter;

    // ⭐ characterFilter：直接查角色桶，不经过全局层
    if (characterFilter) {
      return this.queryCharacterBucket(inputText, characterFilter, options?.topK ?? this.config.topK, visibilityFilter);
    }

    const targetLayers = options?.targetLayers ?? ['global', 'event', 'summary'];
    const topK = options?.topK ?? this.config.topK;
    const currentSceneId = options?.currentSceneId;

    const storages = targetLayers
      .map((l) => this.getStorage(l))
      .filter(Boolean) as MemorySubStorage[];

    const config = { ...this.config, topK };
    const retriever = new Retriever(config);
    let results = retriever.retrieve(inputText, storages, currentSceneId);

    // ⭐ visibilityFilter：对场景可见性做后过滤
    if (visibilityFilter && results.length > 0) {
      results = results.filter((r) => {
        // 取该 chunk 中最近条目的 visibility
        const lastEntry = r.chunk.entries[r.chunk.entries.length - 1];
        const vis = (lastEntry as any)?.visibility;
        if (!vis) return true; // 无可见性标记 → 兼容旧数据
        if (visibilityFilter === 'public') return vis === 'public';
        if (visibilityFilter === 'scene_only') return vis === 'public' || vis === 'scene_only';
        if (visibilityFilter === 'private') return vis === 'private' || vis === 'scene_only';
        return true;
      });
    }

    // 兜底：当前 session 事件 < 5 条且结果为空时，回溯最近归档
    if (results.length === 0 && this.currentSessionEventCount < 5) {
      results = this._fallbackToArchived(inputText, config, currentSceneId);
    }

    return results;
  }

  /** 回溯最近一次归档 */
  private _fallbackToArchived(
    inputText: string,
    config: MemoryStoreConfig,
    currentSceneId?: string
  ): MemoryQueryResult[] {
    try {
      const sessionDir = join(this._memoryBasePath, 'memory', 'sessions');
      if (!existsSync(sessionDir)) return [];

      const files = readdirSync(sessionDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse();

      if (files.length === 0) return [];
      const latest = files[0];
      const raw = readFileSync(join(sessionDir, latest), 'utf-8');
      const data = JSON.parse(raw);
      const archivedChunks: MemoryChunk[] = (data.chunks || []).map((c: any) => ({
        id: 0,
        text: c.text || '',
        layer: 'archive',
        tag: c.tag || 'archived_conversation',
        sceneId: c.sceneId || '',
        cardId: c.cardId || '',
        importance: c.importance || 0,
        createdAt: c.createdAt || 0,
        entries: (c.entries || []).map((e: any) => ({
          id: 0,
          text: e.text || '',
          layer: 'archive',
          tag: e.tag || 'archived_conversation',
          sceneId: e.sceneId || '',
          cardId: e.cardId || '',
          sourceAgent: e.sourceAgent || '',
          importance: e.importance || 0,
          metadata: e.metadata || {},
          createdAt: e.createdAt || 0,
        })),
      }));

      if (archivedChunks.length === 0) return [];

      const tempStorage = new MemorySubStorage('archive', { archived_conversation: 0.15 });
      for (const chunk of archivedChunks) {
        for (const entry of chunk.entries) {
          tempStorage.appendEntry(entry, config);
        }
      }

      const archivedRetriever = new Retriever(config);
      return archivedRetriever.retrieve(inputText, [tempStorage], currentSceneId);
    } catch {
      return [];
    }
  }

  /** ⭐ 角色桶检索：查指定角色的专属桶 */
  private queryCharacterBucket(
    inputText: string,
    characterName: string,
    topK: number,
    visibilityFilter?: Visibility
  ): MemoryQueryResult[] {
    const bucket = this.characterBuckets.get(characterName);
    if (!bucket) return [];

    const config = { ...this.config, topK };
    let results = bucket.retrieve(inputText, undefined, config);

    // visibility 后过滤
    if (visibilityFilter && results.length > 0) {
      results = results.filter((r) => {
        const lastEntry = r.chunk.entries[r.chunk.entries.length - 1];
        const vis = (lastEntry as any)?.visibility;
        if (!vis) return true;
        if (visibilityFilter === 'public') return vis === 'public';
        if (visibilityFilter === 'scene_only') return vis === 'public' || vis === 'scene_only';
        if (visibilityFilter === 'private') return vis === 'private' || vis === 'scene_only';
        return true;
      });
    }

    return results;
  }

  /** 场景切换时摘要归档 */
  async summarize(sceneId: string): Promise<void> {
    if (!this.summarizeFn) return;
    await this.summarizer.summarizeScene(
      this.event,
      this.summary,
      this.archive,
      sceneId,
      this.summarizeFn
    );
  }

  /** 格式化检索结果为 prompt 上下文 */
  getContextForAgent(
    agentId: string,
    currentSceneId?: string,
    topK?: number
  ): string {
    const results = this.query(agentId, {
      targetLayers: ['global', 'event', 'summary'],
      currentSceneId,
      topK,
    });

    return this.retriever.formatContext(results);
  }

  // ============================================================
  // 会话生命周期
  // ============================================================

  /**
   * 异步初始化（会话感知）
   * - global 层从 memory/global.json 加载（跨会话永久保留）
   * - summary + archive 从 memory/active.json 继承
   * - event 层：同一 sessionId 则恢复，不同则归档旧会话+清空
   */
  async initialize(basePath: string, cardId: string, sessionId?: string): Promise<void> {
    this._cardId = cardId;
    this._activeSessionId = sessionId || `session_${Date.now()}`;
    this._memoryBasePath = basePath;
    const memoryDir = join(basePath, 'memory');
    mkdirSync(memoryDir, { recursive: true });
    mkdirSync(join(memoryDir, 'sessions'), { recursive: true });

    // 1. Load global (cross-session, permanent)
    const globalPath = join(memoryDir, 'global.json');
    if (existsSync(globalPath)) {
      try {
        const raw = readFileSync(globalPath, 'utf-8');
        this._restoreLayerFromChunks('global', JSON.parse(raw));
      } catch (e) {
        console.warn('[MemoryStore] global.json 读取失败:', (e as Error).message);
      }
    }

    // ⭐ 角色桶加载 → memory/characters/<角色名>.json
    const charsDir = join(memoryDir, 'characters');
    if (existsSync(charsDir)) {
      try {
        const charFiles = readdirSync(charsDir).filter((f: string) => f.endsWith('.json'));
        for (const f of charFiles) {
          const charName = f.replace(/\.json$/, '');
          const raw = readFileSync(join(charsDir, f), 'utf-8');
          const data = JSON.parse(raw);
          const bucket = new MemorySubStorage('event', { conversation: 1.0 });
          for (const chunk of data) {
            for (const entry of (chunk.entries || [])) {
              bucket.appendEntry({
                id: this.totalEntries++,
                text: entry.text || '',
                layer: 'event',
                tag: entry.tag || 'conversation',
                sceneId: entry.sceneId || '',
                cardId: entry.cardId || this._cardId,
                sourceAgent: entry.sourceAgent || '',
                importance: entry.importance ?? 0,
                metadata: entry.metadata ?? {},
                createdAt: entry.createdAt ?? 0,
                relatedCharacters: [charName],
                visibility: entry.visibility,
              }, this.config);
            }
          }
          this.characterBuckets.set(charName, bucket);
          console.log(`[MemoryStore] 已加载角色桶: ${charName} (${data.length} chunks)`);
        }
      } catch (e) {
        console.warn('[MemoryStore] 角色桶加载失败:', (e as Error).message);
      }
    }
    const activePath = join(memoryDir, 'active.json');
    if (existsSync(activePath)) {
      try {
        const raw = readFileSync(activePath, 'utf-8');
        const data = JSON.parse(raw);

        if (data.sessionId === this._activeSessionId) {
          // Same session → restore all layers
          this._restoreLayerFromChunks('event', data.event || []);
          this._restoreLayerFromChunks('summary', data.summary || []);
          this._restoreLayerFromChunks('archive', data.archive || []);
          this.totalEntries = data.totalEntries ?? 0;
          console.log(`[MemoryStore] 恢复会话 ${this._activeSessionId}: ${this.totalEntries} 条`);
        } else {
          // Different session → archive old event, carry forward summary+archive
          console.log(`[MemoryStore] 新会话 ${this._activeSessionId}，归档旧会话 ${data.sessionId || 'unknown'}`);
          this._archiveEventLayer(memoryDir, data.sessionId || 'unknown');
          this._restoreLayerFromChunks('summary', data.summary || []);
          this._restoreLayerFromChunks('archive', data.archive || []);
          this.totalEntries = 0;
        }
      } catch (e) {
        console.warn('[MemoryStore] active.json 解析失败，从空状态开始:', (e as Error).message);
      }
    }

    // 3. 旧格式兼容：仅在 active.json 不存在时迁移（避免归档后又重复加载）
    if (!existsSync(activePath)) {
      const oldPath = join(memoryDir, '..', 'memory-store.json');
      if (existsSync(oldPath)) {
        try {
          const raw = readFileSync(oldPath, 'utf-8');
          const data = JSON.parse(raw);
          this._restoreLayerFromChunks('event', data.event || []);
          console.log(`[MemoryStore] 迁移旧 memory-store.json: ${data.event?.length || 0} chunks`);
        } catch {}
      }
    }

    this._initialized = true;
    console.log(`[MemoryStore] 初始化完成: card=${cardId} session=${this._activeSessionId}`);
  }

  /**
   * 归档当前会话的事件层和摘要层（由外部在 session 切换时调用）
   * 保存 event + summary 层到 memory/sessions/<sessionId>.json，然后清空
   */
  archiveCurrentSession(): void {
    if (!this._initialized || !this._activeSessionId) return;
    const memoryDir = join(this._memoryBasePath, 'memory');
    this._archiveSessionLayers(memoryDir, this._activeSessionId);
  }

  /** 内部：将 event + summary 层写入归档文件并清空 */
  private _archiveSessionLayers(memoryDir: string, sessionId: string): void {
    const eventChunks = this.event.getAllChunks();
    const summaryChunks = this.summary.getAllChunks();
    if (eventChunks.length === 0 && summaryChunks.length === 0) return;

    const sessionDir = join(memoryDir, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, `${sessionId}.json`);

    const serializeChunks = (chunks: MemoryChunk[]) =>
      chunks.map(c => ({
        text: c.text,
        layer: c.layer,
        tag: c.tag,
        sceneId: c.sceneId,
        cardId: c.cardId,
        importance: c.importance,
        createdAt: c.createdAt,
        entries: c.entries.map(e => ({
          text: e.text,
          layer: e.layer,
          tag: e.tag,
          sceneId: e.sceneId,
          cardId: e.cardId,
          sourceAgent: e.sourceAgent,
          importance: e.importance,
          createdAt: e.createdAt,
        })),
      }));

    const data = {
      sessionId,
      archivedAt: Date.now(),
      event: serializeChunks(eventChunks),
      summary: serializeChunks(summaryChunks),
    };

    writeFileSync(sessionPath, JSON.stringify(data, null, 2), 'utf-8');
    const totalChunks = eventChunks.length + summaryChunks.length;
    console.log(`[MemoryStore] 已归档: sessions/${sessionId}.json (event=${eventChunks.length} summary=${summaryChunks.length})`);

    // 清空两层
    this.event.clear();
    this.summary.clear();
  }

  /** 内部：将 event 层写入归档文件并清空 */
  private _archiveEventLayer(memoryDir: string, sessionId: string): void {
    const chunks = this.event.getAllChunks();
    if (chunks.length === 0) return;

    const sessionDir = join(memoryDir, 'sessions');
    mkdirSync(sessionDir, { recursive: true });
    const sessionPath = join(sessionDir, `${sessionId}.json`);

    const data = {
      sessionId,
      archivedAt: Date.now(),
      chunks: chunks.map(c => ({
        text: c.text,
        layer: c.layer,
        tag: c.tag,
        sceneId: c.sceneId,
        cardId: c.cardId,
        importance: c.importance,
        createdAt: c.createdAt,
        entries: c.entries.map(e => ({
          text: e.text,
          layer: e.layer,
          tag: e.tag,
          sceneId: e.sceneId,
          cardId: e.cardId,
          sourceAgent: e.sourceAgent,
          importance: e.importance,
          createdAt: e.createdAt,
        })),
      })),
    };

    writeFileSync(sessionPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[MemoryStore] 已归档: sessions/${sessionId}.json (${chunks.length} chunks)`);

    // 清空 event 层
    this.event.clear();
  }

  // ============================================================
  // 持久化
  // ============================================================

  /** 刷写所有层到磁盘 */
  flush(basePath: string): void {
    if (!this._initialized) return;
    try {
      const memoryDir = join(basePath, 'memory');
      mkdirSync(memoryDir, { recursive: true });
      mkdirSync(join(memoryDir, 'sessions'), { recursive: true });

      // global → memory/global.json
      const globalData = this._serializeStorage(this.global);
      writeFileSync(join(memoryDir, 'global.json'), JSON.stringify(globalData, null, 2), 'utf-8');

      // event + summary + archive → memory/active.json（含 sessionId）
      const activeData: Record<string, any> = {
        sessionId: this._activeSessionId,
        totalEntries: this.totalEntries,
        event: this._serializeStorage(this.event),
        summary: this._serializeStorage(this.summary),
        archive: this._serializeStorage(this.archive),
      };
      writeFileSync(join(memoryDir, 'active.json'), JSON.stringify(activeData, null, 2), 'utf-8');

      // ⭐ 角色桶持久化 → memory/characters/<角色名>.json
      if (this.characterBuckets.size > 0) {
        const charsDir = join(memoryDir, 'characters');
        mkdirSync(charsDir, { recursive: true });
        for (const [charName, bucket] of this.characterBuckets) {
          const data = this._serializeStorage(bucket);
          writeFileSync(join(charsDir, `${charName}.json`), JSON.stringify(data, null, 2), 'utf-8');
        }
      }

      console.log(`[MemoryStore] 已保存: global.json + active.json (${this.totalEntries} 条)${this.characterBuckets.size > 0 ? ` + ${this.characterBuckets.size} 个角色桶` : ''}`);
    } catch (e) {
      console.warn('[MemoryStore] 持久化失败:', (e as Error).message);
    }
  }

  /** 序列化一个存储层为可持久化的 chunk 数组 */
  private _serializeStorage(storage: MemorySubStorage): any[] {
    return storage.getAllChunks().map(c => ({
      text: c.text,
      layer: c.layer,
      tag: c.tag,
      sceneId: c.sceneId,
      cardId: c.cardId,
      importance: c.importance,
      createdAt: c.createdAt,
      entries: c.entries.map(e => ({
        text: e.text,
        layer: e.layer,
        tag: e.tag,
        sceneId: e.sceneId,
        cardId: e.cardId,
        sourceAgent: e.sourceAgent,
        importance: e.importance,
        createdAt: e.createdAt,
      })),
    }));
  }

  /** 从 chunk 数组恢复层数据 */
  private _restoreLayerFromChunks(layer: string, chunks: any[]): void {
    if (!chunks || !Array.isArray(chunks)) return;
    const storage = this.getStorage(layer);
    for (const chunk of chunks) {
      for (const entry of (chunk.entries || [])) {
        storage.appendEntry({
          id: this.totalEntries++,
          text: entry.text || '',
          layer: entry.layer || layer,
          tag: entry.tag || 'conversation',
          sceneId: entry.sceneId || '',
          cardId: entry.cardId || this._cardId,
          sourceAgent: entry.sourceAgent || '',
          importance: entry.importance ?? 0,
          metadata: entry.metadata ?? {},
          createdAt: entry.createdAt ?? 0,
        }, this.config);
      }
    }
  }

  // ============================================================
  // 兼容：旧 saveSnapshot / loadSnapshot（供 tests 等外部使用）
  // ============================================================

  /** 保存快照（序列化所有层） */
  saveSnapshot(): Record<string, unknown> {
    return {
      global: this._serializeStorage(this.global),
      event: this._serializeStorage(this.event),
      summary: this._serializeStorage(this.summary),
      archive: this._serializeStorage(this.archive),
      totalEntries: this.totalEntries,
    };
  }

  /** 从快照恢复 */
  loadSnapshot(data: Record<string, unknown>): void {
    this._restoreLayerFromChunks('global', (data as any).global || []);
    this._restoreLayerFromChunks('event', (data as any).event || []);
    this._restoreLayerFromChunks('summary', (data as any).summary || []);
    this._restoreLayerFromChunks('archive', (data as any).archive || []);
    this.totalEntries = (data as any).totalEntries ?? 0;
  }

  private getStorage(layer: string): MemorySubStorage {
    switch (layer) {
      case 'global': return this.global;
      case 'event': return this.event;
      case 'summary': return this.summary;
      case 'archive': return this.archive;
      default: throw new Error(`Unknown layer: ${layer}`);
    }
  }
}
