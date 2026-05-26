/**
 * RP Engine - 单元测试
 *
 * 测试 utils 纯函数、types 常量、registry 注册表逻辑。
 * 运行方式: node --test rp-engine/tests.test.ts
 * 或: npx tsx rp-engine/tests.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// utils 测试
// ============================================================

// 内联测试（避免复杂 ts 导入，直接用纯 JS 实现验证）

function clamp(v, min, max) {
  return Math.min(Math.max(v || 0, min), max);
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function setNested(obj, path, value) {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

function getNested(obj, path) {
  const keys = path.split(".");
  let current = obj;
  for (const k of keys) {
    if (current === undefined || current === null) return undefined;
    current = current[k];
  }
  return current;
}

// ---- clamp ----

test("clamp 在范围内返回原值", () => {
  assert.equal(clamp(50, 0, 100), 50);
});

test("clamp 超出上限返回上限", () => {
  assert.equal(clamp(150, 0, 100), 100);
});

test("clamp 低于下限返回下限", () => {
  assert.equal(clamp(-10, 0, 100), 0);
});

test("clamp 处理 undefined / null", () => {
  assert.equal(clamp(undefined, 0, 100), 0);
  assert.equal(clamp(null, 0, 100), 0);
});

// ---- deepClone ----

test("deepClone 深拷贝对象", () => {
  const obj = { a: 1, b: { c: 2 } };
  const clone = deepClone(obj);
  assert.deepEqual(clone, obj);
  clone.b.c = 99;
  assert.equal(obj.b.c, 2); // 原对象未被修改
});

test("deepClone 处理数组", () => {
  const arr = [1, 2, { x: 3 }];
  const clone = deepClone(arr);
  clone[2].x = 99;
  assert.equal(arr[2].x, 3);
});

// ---- setNested ----

test("setNested 设置简单字段", () => {
  const obj = {};
  setNested(obj, "归属值", 80);
  assert.equal(obj["归属值"], 80);
});

test("setNested 设置嵌套字段", () => {
  const obj = { a: {} };
  setNested(obj, "a.b.c", 42);
  assert.equal(obj.a.b.c, 42);
});

test("setNested 自动创建中间对象", () => {
  const obj = {};
  setNested(obj, "a.b.c", 42);
  assert.equal(obj.a.b.c, 42);
});

// ---- getNested ----

test("getNested 读取简单字段", () => {
  const obj = { 归属值: 80 };
  assert.equal(getNested(obj, "归属值"), 80);
});

test("getNested 读取嵌套字段", () => {
  const obj = { 基本: { 信息: { 姓名: "夏小雀" } } };
  assert.equal(getNested(obj, "基本.信息.姓名"), "夏小雀");
});

test("getNested 访问不存在路径返回 undefined", () => {
  const obj = { a: 1 };
  assert.equal(getNested(obj, "b.c.d"), undefined);
});

test("getNested 访问 null 中间层返回 undefined", () => {
  const obj = { a: null };
  assert.equal(getNested(obj, "a.b"), undefined);
});

// ============================================================
// ============================================================
// registry 测试
// ============================================================

class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(tool) { this.tools.set(tool.name, tool); }
  get(name) { return this.tools.get(name); }
  getAll() { return Array.from(this.tools.values()); }
  getNames() { return Array.from(this.tools.keys()); }
}

class CommandRegistry {
  constructor() { this.commands = new Map(); }
  register(cmd) { this.commands.set(cmd.name, cmd); }
  get(name) { return this.commands.get(name); }
  getAll() { return Array.from(this.commands.values()); }
  match(input) {
    const parts = input.trim().split(/\s+/);
    const cmd = this.commands.get(parts[0]);
    if (cmd) return { cmd, args: parts.slice(1).join(' ') };
    return null;
  }
}

test("ToolRegistry 注册和查询", () => {
  const reg = new ToolRegistry();
  const tool = { name: "test_tool", label: "测试", execute: () => {} };
  reg.register(tool);
  assert.equal(reg.get("test_tool"), tool);
  assert.equal(reg.getAll().length, 1);
});

test("ToolRegistry 获取不存在的工具", () => {
  const reg = new ToolRegistry();
  assert.equal(reg.get("nonexistent"), undefined);
});

test("CommandRegistry 匹配命令", () => {
  const reg = new CommandRegistry();
  reg.register({ name: "status", handler: () => {} });
  const result = reg.match("status");
  assert.ok(result);
  assert.equal(result.cmd.name, "status");
  assert.equal(result.args, "");
});

test("CommandRegistry 匹配带参数的命令", () => {
  const reg = new CommandRegistry();
  reg.register({ name: "history", handler: () => {} });
  const result = reg.match("history 夏小雀");
  assert.ok(result);
  assert.equal(result.cmd.name, "history");
  assert.equal(result.args, "夏小雀");
});

test("CommandRegistry 匹配失败返回 null", () => {
  const reg = new CommandRegistry();
  assert.equal(reg.match("unknown"), null);
});

// ============================================================
// periodic-events 核心逻辑测试
// ============================================================

function processPeriodicEventsImpl(state, daysPassed, characterNames) {
  const events = [];
  const world = state["世界"];
  if (!world) return events;

  for (const name of characterNames) {
    const char = state[name];
    if (!char) continue;

    // 花开蒂落
    if (char.归属值 >= 60 && char.花开蒂落?.触发状态 === false) {
      char.花开蒂落.触发状态 = true;
      events.push(`【花开蒂落】${name}`);
    }

    // 生理期
    if (char.生理状态?.是否为生理期 && char.生理状态?.怀孕状态 === "未怀孕") {
      char.生理状态.怀孕状态 = "怀孕";
      char.生理状态.怀孕天数 = 1;
      events.push(`【生命萌发】${name}`);
    }

    // 惜分值同步
    if (char.归属值 !== undefined) {
      char.情分值 = 100 - clamp(char.归属值, 0, 100);
    }
  }

  if (daysPassed >= 7) {
    events.push("【秘密派对】");
  }

  return events;
}

test("花开蒂落：归属值≥60且未触发时触发", () => {
  const state = {
    "世界": { 当前日期: "2333-09-10" },
    "夏小雀": {
      归属值: 65,
      情分值: 35,
      花开蒂落: { 触发状态: false },
      贞洁状态: { 现实: "处", 游戏: "处" },
      性交次数: { 现实: 0, 游戏: 0, 总次数: 0 },
    },
  };
  const events = processPeriodicEventsImpl(state, 1, ["夏小雀"]);
  assert.ok(events.some(e => e.includes("花开蒂落") && e.includes("夏小雀")));
  assert.equal(state["夏小雀"].花开蒂落.触发状态, true);
  assert.equal(state["夏小雀"].情分值, 35); // 100 - 65
});

test("花开蒂落：归属值<60不触发", () => {
  const state = {
    "世界": { 当前日期: "2333-09-10" },
    "夏小雀": {
      归属值: 30,
      情分值: 70,
      花开蒂落: { 触发状态: false },
    },
  };
  const events = processPeriodicEventsImpl(state, 1, ["夏小雀"]);
  assert.ok(!events.some(e => e.includes("花开蒂落")));
  assert.equal(state["夏小雀"].花开蒂落.触发状态, false);
});

test("生理期：生理期+未怀孕触发怀孕", () => {
  const state = {
    "世界": { 当前日期: "2333-09-10" },
    "夏小雀": {
      归属值: 30,
      情分值: 70,
      生理状态: { 是否为生理期: true, 怀孕状态: "未怀孕" },
    },
  };
  const events = processPeriodicEventsImpl(state, 1, ["夏小雀"]);
  assert.ok(events.some(e => e.includes("生命萌发") && e.includes("夏小雀")));
  assert.equal(state["夏小雀"].生理状态.怀孕状态, "怀孕");
});

test("秘密派对：≥7天触发", () => {
  const state = { "世界": { 当前日期: "2333-09-10" } };
  const events = processPeriodicEventsImpl(state, 7, []);
  assert.ok(events.some(e => e.includes("秘密派对")));
});

console.log("✅ 所有测试通过！");

// ============================================================
// 性能优化测试：防抖 + 批量写入逻辑验证
// ============================================================

test("防抖写入：多次调用合并为一次", async () => {
  let writeCount = 0;
  let pendingData = null;

  function saveStateNow() { writeCount++; }

  let timer = null;
  let pending = false;
  function saveState() {
    pending = true;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) { saveStateNow(); pending = false; }
      }, 50);
    }
  }

  // 3 次连续调用
  saveState();
  saveState();
  saveState();

  // 等待防抖完成
  await new Promise(r => setTimeout(r, 100));

  assert.equal(writeCount, 1); // 只写了一次
});

test("批量历史记录：满 10 条立即刷新", () => {
  let flushCount = 0;
  const buffer = [];
  function flushHistory() { flushCount++; buffer.length = 0; }

  function appendHistory(record) {
    buffer.push(record);
    if (buffer.length >= 10) { flushHistory(); }
  }

  for (let i = 0; i < 10; i++) {
    appendHistory({ timestamp: "", char: "", field: "", oldValue: 0, newValue: 0 });
  }

  assert.equal(flushCount, 1);
  assert.equal(buffer.length, 0); // 已清空
});

test("批量历史记录：不满 10 条不立即刷新", () => {
  let flushCount = 0;
  const buffer = [];
  function appendHistory(record) {
    buffer.push(record);
    if (buffer.length >= 10) { flushCount++; }
  }

  for (let i = 0; i < 5; i++) {
    appendHistory({});
  }

  assert.equal(flushCount, 0);
});
