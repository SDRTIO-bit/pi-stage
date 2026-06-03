/**
 * RP Web State — 数据驱动状态管理
 *
 * - 页面加载时通过 WebSocket 请求 state.json
 * - 解析后动态生成角色列表和属性，不硬编码任何字段名
 * - 提供 getCharacters() / getWorld() / getMeta() 访问器
 */

export class RPStateManager {
  constructor() {
    /** @type {Object|null} 完整的 state.json 数据 */
    this._rawState = null;

    /** @type {boolean} 是否已加载 */
    this._loaded = false;

    /** @type {Array<{key: string, name: string, data: Object}>} 角色列表 */
    this._characters = [];

    /** @type {Object|null} 世界状态 */
    this._world = null;

    /** @type {Object|null} 元数据 */
    this._meta = null;

    /** @type {Set<Function>} 状态变更监听器 */
    this._listeners = new Set();

    /** @type {Object|null} 上下文信息（token 使用量、模型上限等） */
    this._contextInfo = null;
  }

  /**
   * 从 state.json 数据加载状态
   * @param {Object} data - state.json 的完整 JSON
   */
  loadState(data) {
    if (!data || typeof data !== 'object') return;

    this._rawState = data;
    this._loaded = true;

    // 提取世界状态
    this._world = data['世界'] || {};

    // 提取元数据
    this._meta = data['_meta'] || {};

    // 动态提取角色列表（排除系统键）
    const systemKeys = new Set(['世界', '_meta', '{{user}}']);
    this._characters = [];

    for (const [key, value] of Object.entries(data)) {
      if (systemKeys.has(key)) continue;
      if (typeof value !== 'object' || value === null) continue;

      // 提取角色显示名
      const name = this._extractCharName(key, value);
      this._characters.push({ key, name, data: value });
    }

    // 如果有 trackedCharacters 元数据，按该顺序排列
    const tracked = this._meta?.trackedCharacters;
    if (Array.isArray(tracked) && tracked.length > 0) {
      const orderMap = new Map();
      tracked.forEach((name, idx) => orderMap.set(name, idx));
      this._characters.sort((a, b) => {
        const orderA = orderMap.get(a.key) ?? 999;
        const orderB = orderMap.get(b.key) ?? 999;
        return orderA - orderB;
      });
    }

    this._notify();
  }

  /**
   * 更新上下文信息
   * @param {Object} info - { totalTokens, maxTokens, usagePercent }
   */
  updateContext(info) {
    this._contextInfo = { ...this._contextInfo, ...info };
    this._notify();
  }

  /**
   * 从角色数据中提取显示名
   */
  _extractCharName(key, data) {
    if (data['基本信息']?.姓名) return data['基本信息'].姓名;
    if (data['公民芯片']?.姓名) return data['公民芯片'].姓名;
    if (data['姓名']) return data['姓名'];
    if (data['name']) return data['name'];
    return key;
  }

  /**
   * 获取所有角色
   * @returns {Array<{key: string, name: string, data: Object}>}
   */
  getCharacters() {
    return this._characters;
  }

  /**
   * 获取世界状态
   */
  getWorld() {
    return this._world;
  }

  /**
   * 获取元数据
   */
  getMeta() {
    return this._meta;
  }

  /**
   * 获取上下文信息
   */
  getContext() {
    return this._contextInfo;
  }

  /**
   * 获取原始状态
   */
  getRawState() {
    return this._rawState;
  }

  /**
   * 是否已加载
   */
  isLoaded() {
    return this._loaded;
  }

  /**
   * 注册监听器
   */
  addListener(fn) {
    this._listeners.add(fn);
  }

  /**
   * 移除监听器
   */
  removeListener(fn) {
    this._listeners.delete(fn);
  }

  /**
   * 通知所有监听器
   */
  _notify() {
    for (const fn of this._listeners) {
      try { fn(this); } catch (e) { console.error('RPState listener error:', e); }
    }
  }

  /**
   * 重置
   */
  reset() {
    this._rawState = null;
    this._loaded = false;
    this._characters = [];
    this._world = null;
    this._meta = null;
    this._contextInfo = null;
    this._notify();
  }
}
