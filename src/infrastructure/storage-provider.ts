// ============================================================
// StorageProvider — 持久化抽象接口
//
// 分离 StateStore 的文件 I/O 依赖，支持:
//   - FileSystemStorage: 默认实现，基于 node:fs
//   - MemoryStorage: 测试用，纯内存
// ============================================================

import {
  readFileSync,
  writeFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
} from "node:fs"
import { join } from "node:path"

/** 持久化存储接口 */
export interface StorageProvider {
  /** 读取 session 数据，不存在返回 null */
  read(key: string): string | null
  /** 写入 session 数据 */
  write(key: string, data: string): void
  /** 删除 session 数据 */
  delete(key: string): void
  /** 列出所有存储的 key */
  list(): string[]
}

// ============================================================
// FileSystemStorage — 文件系统实现
// ============================================================

export class FileSystemStorage implements StorageProvider {
  private directory: string

  constructor(directory: string) {
    this.directory = directory
    mkdirSync(this.directory, { recursive: true })
  }

  private filePath(key: string): string {
    return join(this.directory, `${key}.json`)
  }

  read(key: string): string | null {
    const fp = this.filePath(key)
    if (!existsSync(fp)) return null
    return readFileSync(fp, "utf-8")
  }

  write(key: string, data: string): void {
    mkdirSync(this.directory, { recursive: true })
    writeFileSync(this.filePath(key), data, "utf-8")
  }

  delete(key: string): void {
    const fp = this.filePath(key)
    if (existsSync(fp)) unlinkSync(fp)
  }

  list(): string[] {
    if (!existsSync(this.directory)) return []
    return readdirSync(this.directory)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(".json", ""))
  }
}

// ============================================================
// MemoryStorage — 内存实现（测试用）
// ============================================================

export class MemoryStorage implements StorageProvider {
  private store = new Map<string, string>()

  read(key: string): string | null {
    return this.store.get(key) ?? null
  }

  write(key: string, data: string): void {
    this.store.set(key, data)
  }

  delete(key: string): void {
    this.store.delete(key)
  }

  list(): string[] {
    return [...this.store.keys()]
  }
}
