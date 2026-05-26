/**
 * RP Engine - JSON Patch (RFC 6902) 本地实现
 *
 * 在 Node.js 端实现标准 JSON Patch 操作，
 * 供 tavern_helper 脚本中的 MVU 变量更新使用。
 * 不需要 CDN 依赖。
 */

// ============================================================
// JSON Patch 操作类型
// ============================================================

export interface JsonPatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  value?: any;
  from?: string;
}

// ============================================================
// 路径工具
// ============================================================

/** 解析 JSON Pointer 路径为键数组 */
function parsePointer(path: string): string[] {
  if (!path || path === "") return [];
  if (path === "/") return [""];
  // RFC 6901: 去除开头 /，解码 ~1 → /, ~0 → ~
  const parts = path.replace(/^\//, "").split("/");
  return parts.map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/** 按指针路径读取值 */
function getByPointer(obj: any, path: string): any {
  const keys = parsePointer(path);
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

/** 按指针路径设置值（自动创建中间对象） */
function setByPointer(obj: any, path: string, value: any): void {
  const keys = parsePointer(path);
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
}

/** 按指针路径删除值 */
function removeByPointer(obj: any, path: string): any {
  const keys = parsePointer(path);
  if (keys.length === 0) return undefined;
  const parent = getByPointer(obj, "/" + keys.slice(0, -1).join("/"));
  if (parent == null || typeof parent !== "object") return undefined;
  const lastKey = keys[keys.length - 1];
  const removed = parent[lastKey];
  if (Array.isArray(parent)) {
    parent.splice(Number(lastKey), 1);
  } else {
    delete parent[lastKey];
  }
  return removed;
}

// ============================================================
// Patch 应用
// ============================================================

/**
 * 对目标对象应用单个 JSON Patch 操作
 */
function applyOperation(target: any, op: JsonPatchOperation): boolean {
  switch (op.op) {
    case "add": {
      const keys = parsePointer(op.path);
      if (keys.length === 0) {
        // 替换整个文档
        Object.keys(target).forEach(k => delete target[k]);
        Object.assign(target, op.value);
        return true;
      }
      const parentPath = "/" + keys.slice(0, -1).join("/");
      const lastKey = keys[keys.length - 1];
      const parent = getByPointer(target, parentPath);

      if (Array.isArray(parent)) {
        const idx = lastKey === "-" ? parent.length : Number(lastKey);
        parent.splice(idx, 0, op.value);
      } else if (parent != null && typeof parent === "object") {
        parent[lastKey] = op.value;
      }
      return true;
    }

    case "remove": {
      removeByPointer(target, op.path);
      return true;
    }

    case "replace": {
      setByPointer(target, op.path, op.value);
      return true;
    }

    case "move": {
      if (!op.from) return false;
      const value = removeByPointer(target, op.from);
      setByPointer(target, op.path, value);
      return true;
    }

    case "copy": {
      if (!op.from) return false;
      const value = getByPointer(target, op.from);
      setByPointer(target, op.path, value);
      return true;
    }

    case "test": {
      const current = getByPointer(target, op.path);
      return JSON.stringify(current) === JSON.stringify(op.value);
    }

    default:
      return false;
  }
}

/**
 * 应用 JSON Patch 到目标对象
 *
 * @param target 要修改的目标对象（会被原地修改）
 * @param patch JSON Patch 操作数组
 * @returns 操作成功/失败
 */
export function applyJsonPatch(target: any, patch: JsonPatchOperation[]): boolean {
  if (!Array.isArray(patch)) return false;
  for (const op of patch) {
    const result = applyOperation(target, op);
    if (op.op === "test" && !result) {
      return false; // test 失败 → patch 整体失败
    }
    if (!result) return false;
  }
  return true;
}

/**
 * 深度比较两个值是否相等（JSON 语义）
 */
export function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
