/**
 * RP Engine - tavern_helper (JS-Slash-Runner) 兼容层
 *
 * 在 Node.js 端模拟 SillyTavern 的 tavern_helper 扩展运行时，
 * 让导入的 PNG 角色卡中的 JS 脚本可直接执行，无需修改。
 *
 * 支持的脚本格式：
 *   - ESM import（CDN 模块）
 *   - `<script>` YAML front matter（trigger_event + script_content）
 *   - EJS `<% %>` 模板
 *   - 纯 JS
 *
 * 支持的 ST API：
 *   - getVariables / updateVariablesWith（MVU 兼容）
 *   - createChatMessages（系统消息 → steerParts）
 *   - getvar（EJS 宏）
 *   - toastr
 *   - eventOn
 *   - registerMvuSchema
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import _ from "lodash";
import * as z from "zod";

import type { StateStore } from "./state-store";
import { applyJsonPatch, type JsonPatchOperation } from "./utils/json-patch";

// ============================================================
// 类型定义
// ============================================================

/** 原始 tavern_helper 脚本条目 */
interface RawTavernScript {
  type: string;
  enabled: boolean;
  name: string;
  id?: string;
  content: string;
  button?: { enabled: boolean; buttons: { name: string; visible: boolean }[] };
  info?: string;
  data?: Record<string, any>;
}

/** 编译后的可执行脚本 */
interface CompiledTavernScript {
  name: string;
  phase: "init" | "message";
  execute: () => Promise<void>;
  source: string;
}

/** TavernRunner 依赖 */
export interface TavernRunnerDeps {
  store: StateStore;
  /** 获取激活卡片的 tavern_scripts 目录列表 */
  getScriptDirs: () => string[];
}

// ============================================================
// 简易 YAML front matter 解析（仅用于 \<script\> 块）
// ============================================================

interface ScriptMeta {
  trigger_event?: string;
  title?: string;
  description?: string;
  script_content?: string;
}

function parseScriptTag(content: string): ScriptMeta | null {
  const match = content.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) return null;
  const inner = match[1];

  const meta: ScriptMeta = {};
  const titleMatch = inner.match(/^title:\s*(.+)$/m);
  if (titleMatch) meta.title = titleMatch[1].trim();
  const triggerMatch = inner.match(/^trigger_event:\s*(.+)$/m);
  if (triggerMatch) meta.trigger_event = triggerMatch[1].trim();
  const scMatch = inner.match(/script_content:\s*\|\s*\n([\s\S]*)$/);
  if (scMatch) meta.script_content = scMatch[1].trim();

  return meta;
}

// ============================================================
// 脚本编译
// ============================================================

function compileScript(
  raw: RawTavernScript,
  sandbox: Record<string, any>
): CompiledTavernScript | null {
  if (!raw.enabled) return null;

  let content = raw.content.trim();
  if (!content) return null;

  const hasTopLevelImport = /^import(?:\s|['"])/.test(content);

  // 检测 <script> 标签格式
  const scriptMeta = parseScriptTag(content);
  if (scriptMeta?.script_content) {
    content = scriptMeta.script_content;
  }

  // 检测 EJS 模板：提取 <% ... %> 中的 JS
  if (content.includes("<%") && content.includes("%>")) {
    content = content.replace(/<%(=| )?\s*([\s\S]*?)\s*%>/g, (_, eq, code) => {
      return eq ? code : code;
    });
  }

  // 确定执行阶段
  let phase: "init" | "message" = "message";
  if (scriptMeta?.trigger_event) {
    phase = scriptMeta.trigger_event.includes("MESSAGE_RECEIVED") ? "message" : "init";
  }
  if (hasTopLevelImport && !scriptMeta) phase = "init";
  if (content.includes("registerMvuSchema") || content.includes("registerVariableSchema")) phase = "init";
  if (raw.name === "mvu" || raw.name === "MVU") phase = "init";

  /** 将 import/export 语句转为可在 vm.Script 中运行的代码 */
  function transpileForVm(code: string): string {
    // import { x, y as z } from 'url' → const { x, y: z } = globalThis
    // import x from 'url' → const x = globalThis.x ?? {}
    // import * as x from 'url' → const x = globalThis
    // import 'url' → /* removed */
    // export const/function/class → const/function/class
    let result = code
      .replace(/^import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]\s*;?\s*/gm, (_, named) => {
        const names = named.split(",").map((s: string) => s.trim().replace(/\s+as\s+/g, ":")).filter(Boolean);
        const fields = names.map((n: string) => {
          const [local, target] = n.split(":");
          return target ? `${target}: ${local}` : local;
        }).join(", ");
        return fields ? `const { ${fields} } = globalThis;` : "";
      })
      .replace(/^import\s*(\w+)\s+from\s*['"][^'"]+['"]\s*;?\s*/gm, (_, name) => {
        return `const ${name} = globalThis.${name} ?? {};`;
      })
      .replace(/^import\s*['"][^'"]+['"]\s*;?\s*/gm, "")
      .replace(/^export\s+(default\s+)?/gm, "") // strip export keyword
      .trim();
    return result;
  }

  const execute = async () => {
    // 先尝试 fetch CDN 内容到沙箱（仅 side-effect imports，不阻塞主脚本）
    if (hasTopLevelImport) {
      const allUrls = [...content.matchAll(/['"](https?:\/\/[^'"]+)['"]/g)].map(m => m[1]);
      for (const url of allUrls) {
        try {
          const resp = await fetch(url);
          if (resp.ok) {
            const code = await resp.text();
            // 执行 CDN 模块代码（可能在沙箱中注册全局变量）
            try {
              const script = new vm.Script(code, { filename: `cdn:${url}` });
              await script.runInNewContext(sandbox, { timeout: 10000 });
            } catch {
              // ignore CDN execution failures — shims handle the API surface
            }
          }
        } catch {
          // CDN 不可达，shim 兜底
        }
      }
    }

    // 转换 import/export 语句为 vm 兼容格式
    const safeCode = transpileForVm(hasTopLevelImport ? content : "");

    const codeToRun = hasTopLevelImport
      ? (safeCode || "")
      : content;

    if (!codeToRun.trim()) return; // 纯 import 脚本，无需执行额外代码

    try {
      const script = new vm.Script(`(async () => {\n${codeToRun}\n})()`, {
        filename: `tavern:${raw.name}`,
      });
      await script.runInNewContext(sandbox, { timeout: 5000 });
    } catch (err) {
      console.warn(`[Tavern] 脚本执行失败 (${raw.name}):`, (err as Error).message);
    }
  };

  return { name: raw.name, phase, execute, source: content };
}

// ============================================================
// 沙箱工厂 — 为脚本提供 SillyTavern API 模拟
// ============================================================

function createSandbox(
  deps: TavernRunnerDeps,
  pendingMessages: { role: string; message: string }[]
): Record<string, any> {
  let mvuSchema: any = null;

  /**
   * 将引擎的 cardStates 结构扁平化为 tavern 脚本期待的 stat_data 格式
   * cardStates = { 回响乐园: { characters: { 夏小雀: {...}, ... }, world: {...} } }
   * → stat_data = { 世界: {...}, 夏小雀: {...}, ... }
   */
  function flattenCardStates(state: Record<string, any>): Record<string, any> {
    const stat_data: Record<string, any> = {};
    const cardStates = state.cardStates as Record<string, any> | undefined;
    if (!cardStates) return stat_data;

    for (const cardData of Object.values(cardStates)) {
      if (!cardData) continue;
      if (cardData.world && typeof cardData.world === "object") {
        stat_data["世界"] = { ...stat_data["世界"], ..._.cloneDeep(cardData.world) };
      }
      if (cardData.characters && typeof cardData.characters === "object") {
        for (const [charName, charData] of Object.entries(cardData.characters as Record<string, any>)) {
          stat_data[charName] = _.cloneDeep(charData);
        }
      }
    }
    return stat_data;
  }

  /**
   * 将 tavern 脚本更新后的 stat_data 写回引擎的 cardStates
   */
  function writeBackStatData(state: Record<string, any>, updated: Record<string, any>): void {
    const cardStates = state.cardStates as Record<string, any> | undefined;
    if (!cardStates) {
      for (const [key, value] of Object.entries(updated)) {
        if (state[key] && typeof state[key] === "object" && typeof value === "object") {
          _.merge(state[key], value);
        } else {
          state[key] = _.cloneDeep(value);
        }
      }
      return;
    }

    for (const [key, value] of Object.entries(updated)) {
      if (key === "世界") {
        for (const cardData of Object.values(cardStates) as any[]) {
          if (cardData.world && typeof value === "object") {
            _.merge(cardData.world, value);
          }
        }
      } else {
        let found = false;
        for (const cardData of Object.values(cardStates) as any[]) {
          if (cardData.characters?.[key]) {
            if (typeof value === "object") {
              _.merge(cardData.characters[key], value);
            } else {
              cardData.characters[key] = _.cloneDeep(value);
            }
            found = true;
            break;
          }
        }
        if (!found) {
          if (state[key] && typeof state[key] === "object" && typeof value === "object") {
            _.merge(state[key], value);
          } else {
            state[key] = _.cloneDeep(value);
          }
        }
      }
    }
  }

  return {
    // 工具库
    _: _,
    z: z,

    // jQuery 桩（立即执行回调）
    $: (fn: Function) => {
      if (typeof fn === "function") fn();
      return { ready: (f: Function) => f() };
    },
    jQuery: (fn: Function) => {
      if (typeof fn === "function") fn();
      return { ready: (f: Function) => f() };
    },

    // 宿主环境
    console,
    setTimeout,
    setInterval,
    clearTimeout,
    clearInterval,
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Error,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    encodeURI,
    decodeURI,
    encodeURIComponent,
    decodeURIComponent,

    // ============================
    // 变量系统
    // ============================


    getVariables: (opts: { type: string }) => {
      const state = deps.store.getState();
      const stat_data = flattenCardStates(state);
      return { stat_data };
    },

    updateVariablesWith: async (opts: { type: string }, fn: (vars: any) => any) => {
      const state = deps.store.getState();
      const stat_data = flattenCardStates(state);
      const current = { stat_data };

      const updated = await fn(current);
      if (!updated?.stat_data) return;

      writeBackStatData(state, updated.stat_data);
      deps.store.saveState();
    },

    getvar: (path: string) => {
      if (!path) return undefined;
      const parts = path.split(".");
      let current: any = deps.store.getState();
      for (const part of parts) {
        if (current == null || typeof current !== "object") return undefined;
        current = current[part];
      }
      return current;
    },

    // ============================
    // 消息系统 — 收集到 pendingMessages，由 TavernRunner 取走
    // ============================

    createChatMessages: async (msgs: { role: string; message: string }[]) => {
      for (const msg of msgs) {
        pendingMessages.push({ role: msg.role || "system", message: msg.message });
      }
    },

    // ============================
    // 通知
    // ============================

    toastr: {
      error: (msg: string, title?: string) => console.error(`[Tavern] ${title || "错误"}: ${msg}`),
      warning: (msg: string, title?: string) => console.warn(`[Tavern] ${title || "警告"}: ${msg}`),
      success: (msg: string, title?: string) => console.info(`[Tavern] ${title || ""}: ${msg}`),
      info: (msg: string, title?: string) => console.info(`[Tavern] ${title || "信息"}: ${msg}`),
    },

    // ============================
    // MVU 事件系统（简化 — 仅存储回调但不自动触发）
    // ============================

    eventOn: (name: string, cb: (...args: any[]) => void) => {
      // 简化为无操作存储，MVU 事件由 CDN bundle 自己管理
      console.debug(`[Tavern] 事件注册: ${name}`);
    },

    // ============================
    // MVU Schema 注册
    // ============================

    registerMvuSchema: (schema: any) => { mvuSchema = schema; },
    registerVariableSchema: (schema: any, opts?: any) => { mvuSchema = schema; },

    // ============================
    // JSON Patch (RFC 6902) 本地实现
    // ============================

    jsonPatch: {
      apply: (target: any, patch: JsonPatchOperation[]) => applyJsonPatch(target, patch),
    },
    applyJsonPatch: (target: any, patch: JsonPatchOperation[]) => applyJsonPatch(target, patch),

    _getMvuSchema: () => mvuSchema,
  };
}

// ============================================================
// TavernRunner — 主类
// ============================================================

export class TavernRunner {
  private scripts: CompiledTavernScript[] = [];
  private deps: TavernRunnerDeps;
  private sandbox: Record<string, any> | null = null;
  private pendingMessages: { role: string; message: string }[] = [];

  constructor(deps: TavernRunnerDeps) {
    this.deps = deps;
  }

  /**
   * 从激活卡片的 tavern_scripts 目录加载并编译脚本
   */
  loadScripts(): void {
    this.scripts = [];
    this.sandbox = null;
    this.pendingMessages = [];
    const dirs = this.deps.getScriptDirs();

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          if (!f.endsWith(".json")) continue;
          const rawScripts: RawTavernScript[] = JSON.parse(
            readFileSync(join(dir, f), "utf-8")
          );
          for (const raw of rawScripts) {
            const compiled = compileScript(raw, this.getSandbox());
            if (compiled) this.scripts.push(compiled);
          }
        }
      } catch (err) {
        console.warn(`[Tavern] 加载脚本失败 (${dir}):`, (err as Error).message);
      }
    }

    console.log(`[Tavern] 已加载 ${this.scripts.length} 个脚本` +
      ` (${this.scripts.filter(s => s.phase === "init").length} init` +
      ` + ${this.scripts.filter(s => s.phase === "message").length} message)`);
  }

  private getSandbox(): Record<string, any> {
    if (!this.sandbox) {
      this.pendingMessages = [];
      this.sandbox = createSandbox(this.deps, this.pendingMessages);
    }
    return this.sandbox;
  }

  /**
   * 执行所有 init 阶段脚本
   * 顺序：先纯 import 脚本（CDN 依赖），后其他
   */
  async runInitScripts(): Promise<void> {
    const inits = this.scripts.filter(s => s.phase === "init");
    if (inits.length === 0) return;
    for (const s of inits.filter(s => /^import\s/.test(s.source))) await s.execute();
    for (const s of inits.filter(s => !/^import\s/.test(s.source))) await s.execute();
  }

  /**
   * 执行 message 阶段脚本 + 刷新系统消息
   * @returns 脚本生成的系统消息文本数组（供注入 steer）
   */
  async runMessageScripts(): Promise<string[]> {
    const msgs = this.scripts.filter(s => s.phase === "message");
    if (msgs.length === 0) return [];

    const prevCount = this.pendingMessages.length;
    for (const s of msgs) {
      await s.execute();
    }
    // 取本次新增的
    const newMessages = this.pendingMessages.slice(prevCount);
    return newMessages.map(m => `[系统事件]\n${m.message}`);
  }

  /**
   * 获取引擎内部已注册的 MVU schema
   */
  getMvuSchema(): any {
    try { return (this.getSandbox() as any)._getMvuSchema?.(); } catch { return null; }
  }

  clear(): void {
    this.scripts = [];
    this.sandbox = null;
    this.pendingMessages = [];
  }
}
