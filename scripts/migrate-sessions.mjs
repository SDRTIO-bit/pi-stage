/**
 * migrate-sessions — 将会话从全局目录迁移到项目目录
 *
 * 旧位置: ~/.pi/agent/sessions/<encoded-cwd>/
 * 新位置: <projectRoot>/.pi/sessions/<encoded-cwd>/
 *
 * 用法: node scripts/migrate-sessions.mjs [projectRoot]
 */

import { readdirSync, copyFileSync, existsSync, mkdirSync, statSync, readFileSync } from "node:fs"
import { join, basename } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline"

const projectRoot = process.argv[2] || process.cwd()
const cwd = process.cwd()

/** 编码函数（与 pi-jsonl-storage 统一） */
function encodePath(path) {
  const normalized = path.replace(/\\/g, "/")
  const noDrive = normalized.replace(/^([A-Za-z]):/, "$1")
  return "--" + noDrive.replace(/\//g, "-") + "--"
}

/** 旧版编码（rp-web-server 旧版） */
function encodePathOld(path) {
  const encoded = path
    .replace(/:\\/g, "--")
    .replace(/[\/\\]/g, "-")
    .replace(/:/g, "")
  return "--" + encoded + "--"
}

const oldBase = join(homedir(), ".pi", "agent", "sessions")
const newBase = join(projectRoot, ".pi", "sessions")

// 尝试两种编码找到旧目录
let oldDir = null
for (const encodeFn of [encodePath, encodePathOld]) {
  const candidate = join(oldBase, encodeFn(cwd))
  if (existsSync(candidate)) {
    oldDir = candidate
    break
  }
}

if (!oldDir) {
  console.log("未找到全局会话目录（可能没有旧会话需要迁移）")
  console.log(`  检查路径: ${join(oldBase, encodePath(cwd))}`)
  console.log(`  检查路径: ${join(oldBase, encodePathOld(cwd))}`)
  process.exit(0)
}

const newDir = join(newBase, encodePath(cwd))

// 检查新目录是否已有会话
const oldFiles = readdirSync(oldDir).filter((f) => f.endsWith(".jsonl"))
if (oldFiles.length === 0) {
  console.log("旧目录中没有 .jsonl 会话文件")
  process.exit(0)
}

mkdirSync(newDir, { recursive: true })
const existingNewFiles = new Set(
  existsSync(newDir) ? readdirSync(newDir).filter((f) => f.endsWith(".jsonl")) : [],
)

let migrated = 0
let skipped = 0

for (const file of oldFiles) {
  if (existingNewFiles.has(file)) {
    console.log(`  SKIP: ${file} (已存在于目标目录)`)
    skipped++
    continue
  }
  const src = join(oldDir, file)
  const dst = join(newDir, file)
  copyFileSync(src, dst)

  // 验证文件内容（读取首行确认是有效 JSONL）
  try {
    const content = readFileSync(dst, "utf-8")
    const firstLine = content.split("\n")[0]
    JSON.parse(firstLine)
  } catch {
    console.log(`  WARN: ${file} 复制后验证失败，但文件已复制`)
  }

  const size = statSync(src).size
  console.log(`  COPY: ${file} (${(size / 1024).toFixed(1)}KB)`)
  migrated++
}

console.log()
console.log(`迁移完成: ${migrated} 个会话已复制, ${skipped} 个已跳过`)
console.log(`  旧目录: ${oldDir}`)
console.log(`  新目录: ${newDir}`)
console.log()
console.log("旧目录中的会话文件未被删除。确认新目录工作正常后可手动删除:")
console.log(`  rm -rf "${oldDir}"`)
