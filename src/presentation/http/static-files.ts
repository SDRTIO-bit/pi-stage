// ============================================================
// 静态文件服务 — 前端 HTML/CSS/JS
// ============================================================

import * as fs from "node:fs"
import * as path from "node:path"
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
    const ext = path.extname(filePath)
    // 禁用缓存，确保前端修改立即可见
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
    })
    res.end(fs.readFileSync(filePath))
    return true
  }

  if (pathname === "/") {
    return serveFile(path.join(FRONTEND_DIR, "index.html"))
  }
  return serveFile(path.join(FRONTEND_DIR, pathname))
}