// ============================================================
// 静态文件服务 — 前端 HTML/CSS/JS
// 内存缓存 + ETag，减少磁盘 I/O
// ============================================================

import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import type * as http from "node:http"

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
}

const FRONTEND_DIR = path.resolve(import.meta.dirname!, "..", "..", "frontend")

interface CachedFile {
  content: Buffer
  etag: string
  mtime: number
}

const fileCache = new Map<string, CachedFile>()

function getCached(filePath: string): CachedFile | null {
  const cached = fileCache.get(filePath)
  if (!cached) return null
  try {
    const stat = fs.statSync(filePath)
    if (stat.mtimeMs !== cached.mtime) return null // 文件已修改，缓存失效
  } catch {
    return null
  }
  return cached
}

function setCached(filePath: string, content: Buffer): CachedFile {
  const mtime = fs.statSync(filePath).mtimeMs
  const etag = crypto.createHash("md5").update(content).digest("hex").slice(0, 12)
  const entry: CachedFile = { content, etag, mtime }
  fileCache.set(filePath, entry)
  return entry
}

export function serveStaticFile(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const parsedUrl = new URL(req.url ?? "", "http://localhost")
  let pathname = parsedUrl.pathname.replace(/\/$/, "") || "/"

  if (req.method !== "GET") return false

  // Silence favicon 404
  if (pathname === "/favicon.ico") {
    res.writeHead(204)
    res.end()
    return true
  }

  const serveFile = (filePath: string): boolean => {
    if (!fs.existsSync(filePath)) return false

    let cached = getCached(filePath)
    if (!cached) {
      cached = setCached(filePath, fs.readFileSync(filePath))
    }

    const ext = path.extname(filePath)
    const ifNoneMatch = req.headers["if-none-match"]

    // ETag 匹配 → 304 Not Modified
    if (ifNoneMatch === cached.etag) {
      res.writeHead(304, {
        "Cache-Control": "public, max-age=0, must-revalidate",
        ETag: cached.etag,
      })
      res.end()
      return true
    }

    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "public, max-age=0, must-revalidate",
      ETag: cached.etag,
    })
    res.end(cached.content)
    return true
  }

  if (pathname === "/") {
    return serveFile(path.join(FRONTEND_DIR, "index.html"))
  }
  return serveFile(path.join(FRONTEND_DIR, pathname))
}
