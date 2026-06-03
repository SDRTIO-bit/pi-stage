/**
 * RP Engine - 共享工具函数
 * 从 pi-stage-test 直接复制
 */

/** 数值钳制 */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v || 0, min), max)
}

/** 深拷贝 */
export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj))
}

/** 按点号路径设置嵌套对象值 */
export function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".")
  let current: Record<string, unknown> = obj
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {}
    current = current[keys[i]] as Record<string, unknown>
  }
  current[keys[keys.length - 1]] = value
}

/** 按点号路径读取嵌套对象值 */
export function getNested(obj: Record<string, unknown> | undefined | null, path: string): unknown {
  const keys = path.split(".")
  let current: unknown = obj
  for (const k of keys) {
    if (current === undefined || current === null) return undefined
    current = (current as Record<string, unknown>)[k]
  }
  return current
}
