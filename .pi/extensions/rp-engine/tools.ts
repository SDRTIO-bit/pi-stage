/**
 * RP Engine - 工具注册（read_state, update_state, advance_time, load_worldbook）
 *
 * 每个工具定义为独立对象，通过 ToolRegistry 收集后批量注册到 pi API。
 * 后续加新工具只需：① 在此文件或新文件中定义 ② 加入 toolRegistry.register()。
 */

import { Type } from "typebox";
import { basename, join } from "node:path";
import type { HistoryRecord } from "./types";
import type { WorldState } from "./game-types";
import { getNested, setNested, clamp } from "./utils";
import { findWorldbookFiles, findWorldbookFilesMulti, searchWorldbook, readWorldbookIndexMulti, getAllConstantEntries } from "./worldbook";
import { getActiveCardIds, getCardVectorsDirs, getCardWorldbookDirs } from "./card-manager";
import { processPeriodicEvents } from "./periodic-events";
import { ToolRegistry, type ToolDefinition } from "./registry";

/**
 * 创建所有工具定义，返回注册表
 */
export function createToolRegistry(
  getState: () => Record<string, any>,
  saveState: () => void,
  appendHistory: (record: HistoryRecord) => void,
  getWorldbookDirs: () => string[],
  getVariableSchemas?: () => Record<string, Record<string, Record<string, string>>> // cardId → charName → fieldName → type
): ToolRegistry {
  const registry = new ToolRegistry();
  const stateRef = getState; // 每次执行时重新获取 state 引用

  // --------------------------------------------------
  // 1. read_state - 读取角色状态
  // --------------------------------------------------
  registry.register({
    name: "read_state",
    label: "读取状态",
    description: "读取指定角色的当前状态数据。char 为角色名，fields 可选（指定要读取的字段路径）。",
    parameters: Type.Object({
      char: Type.String({ description: "角色名，如 {{user}}、世界 或角色姓名" }),
      fields: Type.Optional(
        Type.Array(Type.String(), { description: "要读取的字段路径数组，留空读取全部" })
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = stateRef();
      let charData: any = null;
      let sourceCardId = "";

      // ★ 优先从 cardStates 查找（card runtime 是权威源），再回退顶层
      if (state.cardStates) {
        for (const [cardId, cardData] of Object.entries(state.cardStates as Record<string, any>)) {
          const chars = cardData.characters || {};
          if (chars[params.char]) {
            charData = chars[params.char];
            sourceCardId = cardId;
            break;
          }
          if (params.char === "世界" && cardData.world) {
            charData = cardData.world;
            sourceCardId = cardId;
            break;
          }
        }
      }
      if (!charData) {
        charData = state[params.char];
      }

      if (!charData) {
        return {
          content: [{ type: "text", text: `角色 "${params.char}" 不存在` }],
          details: { error: `角色 ${params.char} 不存在` },
        };
      }

      if (params.fields && params.fields.length > 0) {
        const result: Record<string, any> = {};
        for (const f of params.fields) {
          result[f] = getNested(charData, f);
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { char: params.char, cardId: sourceCardId, fields: result },
        };
      }

      console.log(`[RP] read_state → ${params.char} (${sourceCardId || 'top-level'})`);
      return {
        content: [{ type: "text", text: JSON.stringify(charData, null, 2) }],
        details: { char: params.char, cardId: sourceCardId, data: charData },
      };
    },
  });

  // --------------------------------------------------
  // 2. update_state - 更新角色状态
  // --------------------------------------------------
  registry.register({
    name: "update_state",
    label: "更新状态",
    description: "更新指定角色的状态变量。updates 为键值对，键是字段路径（如 归属值），值是新值。变量类型根据卡片的 variable_schema.json 校验。",
    parameters: Type.Object({
      char: Type.String({ description: "角色名" }),
      updates: Type.Record(Type.String(), Type.Any(), { description: "要更新的字段路径→新值" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = stateRef();
      let charData: any = null;
      let sourceCardId = "";

      // ★ 优先从 cardStates 查找（card runtime 是权威源），再回退顶层
      if (state.cardStates) {
        for (const [cardId, cardData] of Object.entries(state.cardStates as Record<string, any>)) {
          const chars = cardData.characters || {};
          if (chars[params.char]) {
            charData = chars[params.char];
            sourceCardId = cardId;
            break;
          }
          if (params.char === "世界" && cardData.world) {
            charData = cardData.world;
            sourceCardId = cardId;
            break;
          }
        }
      }
      if (!charData) {
        charData = state[params.char];
        if (charData) sourceCardId = "top-level";
      }

      if (!charData) {
        // ★ 角色不存在时自动创建（写入激活卡片的 runtime）
        const activeIds: string[] = state.activeCards || [];
        if (activeIds.length > 0 && state.cardStates?.[activeIds[0]]) {
          state.cardStates[activeIds[0]].characters[params.char] = {};
          charData = state.cardStates[activeIds[0]].characters[params.char];
          sourceCardId = activeIds[0];
          console.log(`[RP] 自动创建角色 "${params.char}" → ${activeIds[0]}`);
        } else {
          state[params.char] = {};
          charData = state[params.char];
          console.log(`[RP] 自动创建角色 "${params.char}" → top-level`);
        }
      }

      // 加载变量 Schema（按 sourceCardId 隔离）
      const varSchemas = getVariableSchemas ? getVariableSchemas() : {};
      // 按 cardId 查找该角色的 schema
      let charSchema: Record<string, string> = {};
      if (sourceCardId && varSchemas[sourceCardId]) {
        charSchema = varSchemas[sourceCardId][params.char] || {};
      } else {
        // 兜底：遍历所有卡片找
        for (const [, cardSchemas] of Object.entries(varSchemas)) {
          if (cardSchemas[params.char]) {
            charSchema = cardSchemas[params.char];
            break;
          }
        }
      }

      const historyRecords: HistoryRecord[] = [];
      const timestamp = new Date().toISOString();

      for (const [path, value] of Object.entries(params.updates)) {
        const oldValue = getNested(charData, path);
        let newValue: any = value;

        // 根据 variable_schema.json 动态校验类型
        const varType = charSchema[path];
        if (varType === "number") {
          newValue = Number(newValue);
          if (isNaN(newValue)) continue;
        } else if (varType === "boolean") {
          newValue = Boolean(newValue);
        } else if (varType === "string") {
          newValue = String(newValue);
        }
        // 未知类型直接透传（向后兼容旧字段）

        setNested(charData, path, newValue);
        historyRecords.push({ timestamp, char: params.char, field: path, oldValue, newValue });
      }

      saveState();

      // 日志：工具调用反馈
      console.log(`[RP] update_state → ${params.char}:`, JSON.stringify(params.updates));

      // 写历史记录（走 HistoryWriter 缓冲刷写）
      // tool_result 事件作为冗余兜底，不依赖 PI 版本是否支持该事件
      for (const r of historyRecords) {
        appendHistory(r);
      }

      return {
        content: [{ type: "text", text: `✅ ${params.char} 状态已更新` }],
        details: { updated: params.updates, history: historyRecords },
      };
    },
  });

  // --------------------------------------------------
  // 3. advance_time - 推进时间
  // --------------------------------------------------
  registry.register({
    name: "advance_time",
    label: "推进时间",
    description: "推进游戏内时间。days 为推进天数（1-30）。会自动触发周期事件。",
    parameters: Type.Object({
      days: Type.Integer({ description: "推进的天数", minimum: 1, maximum: 30 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const state = stateRef();
      const world = state["世界"] as WorldState;
      if (!world || !world.当前日期) {
        return {
          content: [{ type: "text", text: "错误：世界状态中缺少日期信息" }],
          details: { error: "缺少日期" },
        };
      }

      const currentDate = new Date(world.当前日期);
      if (isNaN(currentDate.getTime())) {
        return {
          content: [{ type: "text", text: `错误：无法解析日期 "${world.当前日期}"` }],
          details: { error: "日期格式错误" },
        };
      }

      currentDate.setDate(currentDate.getDate() + params.days);
      const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
      world.当前日期 = currentDate.toISOString().slice(0, 10);
      world.当前星期 = weekdays[currentDate.getDay()];

      const events = processPeriodicEvents(state, params.days, appendHistory);
      saveState();
      console.log('[RP] advance_time → +' + params.days + '天 → ' + world.当前日期 + ' ' + world.当前星期);

      const eventText = events.length > 0 ? `\n\n## 周期事件\n${events.join("\n")}` : "";

      return {
        content: [{
          type: "text",
          text: `⏰ 时间推进至 ${world.当前日期} ${world.当前星期}${eventText}`,
        }],
        details: { newDate: world.当前日期, events },
      };
    },
  });

  // --------------------------------------------------
  // 4. load_worldbook - 加载世界书（支持按卡片过滤）
  // --------------------------------------------------
  registry.register({
    name: "load_worldbook",
    label: "加载世界书",
    description: "按关键字从世界书中加载设定条目。keyword 为搜索关键词。可选 cardId 过滤指定卡片（不提供则搜索所有激活卡片）。",
    parameters: Type.Object({
      keyword: Type.String({ description: "搜索关键词" }),
      cardId: Type.Optional(Type.String({ description: "限定卡片 id，不填则搜索所有激活卡片" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const dirs = getWorldbookDirs();
      if (dirs.length === 0) {
        return {
          content: [{ type: "text", text: "世界书目录未就绪。请先激活至少一张角色卡。" }],
          details: { error: "无世界书目录" },
        };
      }

      // 优先向量搜索（语义），回退关键词搜索
      const vectorsDirs = getCardVectorsDirs();
      let results: { file: string; content: string; score: number; sourceCard: string }[];
      if (vectorsDirs.length > 0) {
        results = searchWorldbook(params.keyword, vectorsDirs, dirs);
      } else {
        results = findWorldbookFilesMulti(params.keyword, dirs, params.cardId);
      }
      if (results.length === 0) {
        // 没有匹配结果时，返回目录索引供 agent 参考
        const index = readWorldbookIndexMulti(dirs);
        if (index.trim()) {
          return {
            content: [{ type: "text", text: `未找到与 "${params.keyword}" 直接匹配的条目。以下是可用世界书目录：\n\n${index.slice(0, 3000)}` }],
            details: { keyword: params.keyword, cardId: params.cardId, count: 0, index: true },
          };
        }
        const activeIds = getActiveCardIds();
        const hint = params.cardId
          ? `在卡片 "${params.cardId}" 中`
          : `在当前 ${activeIds.length} 张激活卡片中`;
        return {
          content: [{ type: "text", text: `${hint}未找到与 "${params.keyword}" 相关的世界书条目` }],
          details: { keyword: params.keyword, cardId: params.cardId, count: 0 },
        };
      }

      const text = results
        .slice(0, 5)
        .map((r) => `--- [${r.sourceCard}] ${r.file} ---\n${r.content.slice(0, 3000)}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: {
          keyword: params.keyword,
          cardId: params.cardId,
          files: results.map((r) => ({ sourceCard: r.sourceCard, file: r.file })),
          count: results.length,
        },
      };
    },
  });

  // --------------------------------------------------
  // 5. load_constant_worldbook - 按顺序读取常开世界书
  // --------------------------------------------------
  registry.register({
    name: "load_constant_worldbook",
    label: "加载常开世界书",
    description: "按优先级顺序读取常开世界书设定（基础世界观、地理、物价、神秘学等）。必须先用此工具按照编号顺序（0001→0083...）读完所有常开条目后，才用 load_worldbook 搜索关键词。无参数时从第1条开始，返回3条。",
    parameters: Type.Object({
      start: Type.Optional(Type.Number({ description: "起始序号（不填则从第1条开始）" })),
      count: Type.Optional(Type.Number({ description: "读取条数（默认3，最大10）" })),
      cardId: Type.Optional(Type.String({ description: "限定卡片 id" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const dirs = getWorldbookDirs();
      if (dirs.length === 0) {
        return {
          content: [{ type: "text", text: "世界书目录未就绪。请先激活至少一张角色卡。" }],
          details: { error: "无世界书目录" },
        };
      }

      let filteredDirs = dirs;
      if (params.cardId) {
        filteredDirs = dirs.filter((d) => {
          try { return basename(join(d, "..")) === params.cardId; } catch { return false; }
        });
      }

      const allEntries = getAllConstantEntries(filteredDirs);
      if (allEntries.length === 0) {
        return {
          content: [{ type: "text", text: "当前没有常开世界书条目。" }],
          details: { count: 0 },
        };
      }

      const startIdx = Math.max(0, (params.start || 1) - 1);
      const limit = Math.min(params.count || 3, 10);
      const entries = allEntries.slice(startIdx, startIdx + limit);

      const total = allEntries.length;
      const range = `${startIdx + 1}-${Math.min(startIdx + limit, total)}/${total}`;

      let text = `## 常开世界书 (${range})\n\n`;
      for (const e of entries) {
        const fileName = e.file.replace(/^\[常开\]设定\//, "");
        text += `--- [${e.sourceCard}] ${fileName} ---\n${e.content.slice(0, 2000)}\n\n`;
      }

      if (startIdx + limit < total) {
        text += `---\n还有 ${total - startIdx - limit} 条未读。使用 start=${startIdx + limit + 1} 继续读取。\n`;
      }

      return {
        content: [{ type: "text", text }],
        details: {
          cardId: params.cardId,
          total,
          start: startIdx + 1,
          count: entries.length,
        },
      };
    },
  });

  return registry;
}

// 保留旧的 registerTools 导出以兼容
export { createToolRegistry as registerTools };
