// ============================================================
// 路由共享类型
// ============================================================

import type * as http from "node:http"
import type { App } from "../../../composition-root.js"

/** 路由注册上下文 */
export interface RouteContext {
  app: App
  /** 项目根目录 */
  projectRoot: string
  /** 安全读取请求 body */
  readBody(req: http.IncomingMessage): Promise<string>
  /** 发送 JSON 响应 */
  json(res: http.ServerResponse, code: number, data: unknown): void
  /** 安全 JSON 解析 */
  parseJson(body: string): Record<string, unknown> | null
}

export const MAX_BODY = 256 * 1024
