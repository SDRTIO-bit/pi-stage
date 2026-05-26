/**
 * RP Engine - AI Agent 控制接口
 *
 * 为外部 AI Agent 提供程序化控制接口（REST API）。
 * 与 WebSocket 前端共享状态，但使用独立的 API Key 认证。
 *
 * 设计原则：
 *   - 独立 HTTP 端点，JSON 请求/响应
 *   - API Key 持久化存储在 .rpconfig.json
 *   - 结构化响应，方便 Agent 解析
 *   - 权限分层（只读 / 对话 / 管理）
 */

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomBytes as randomBytesCrypto } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getRegistry, getActiveCardIds, getActiveCards, getCardName, activateCards, deactivateCards, setActiveCard } from "./card-manager";
import { deepClone } from "./utils";

// ============================================================
// 类型定义
// ============================================================

/** Agent API 配置 */
export interface AgentApiConfig {
  /** 是否启用 Agent API */
  enabled: boolean;
  /** API 监听端口（默认 3013，与 Web UI 3012 分离） */
  port: number;
  /** 监听地址 */
  host: string;
  /** API Key（32 位 hex，持久化在 .rpconfig.json） */
  apiKey: string;
  /** 权限级别：readonly | dialogue | full */
  permission: "readonly" | "dialogue" | "full";
}

/** API 请求格式 */
interface AgentRequest {
  action: string;
  params?: Record<string, any>;
}

/** API 响应格式 */
interface AgentResponse {
  success: boolean;
  action: string;
  data?: any;
  error?: string;
  timestamp: string;
}

// ============================================================
// 默认配置
// ============================================================

const DEFAULT_AGENT_CONFIG: AgentApiConfig = {
  enabled: false,
  port: 3013,
  host: "127.0.0.1",
  apiKey: "",
  permission: "dialogue",
};

// ============================================================
// Agent API 服务器
// ============================================================

export function createAgentApiServer(
  pi: ExtensionAPI,
  getStateDir: () => string,
  getState: () => Record<string, any>,
  getRPConfig: () => Record<string, any>
) {
  let config: AgentApiConfig = { ...DEFAULT_AGENT_CONFIG };
  let server: any = null;
  let latestCtx: any = null;

  // ========== 配置加载 ==========

  function loadConfig(): void {
    const rpConfig = getRPConfig();
    const agentConfig = rpConfig?.agent_api;
    if (agentConfig) {
      config = {
        enabled: agentConfig.enabled ?? DEFAULT_AGENT_CONFIG.enabled,
        port: agentConfig.port ?? DEFAULT_AGENT_CONFIG.port,
        host: agentConfig.host ?? DEFAULT_AGENT_CONFIG.host,
        apiKey: agentConfig.api_key ?? DEFAULT_AGENT_CONFIG.apiKey,
        permission: agentConfig.permission ?? DEFAULT_AGENT_CONFIG.permission,
      };
    }
    // 如果没有配置 API Key，自动生成一个
    if (!config.apiKey && config.enabled) {
      config.apiKey = randomBytesCrypto(16).toString("hex");
      console.log(`[Agent-API] 自动生成 API Key: ${config.apiKey}`);
      console.log(`[Agent-API] 请保存此 Key，不会再次显示。可写入 .rpconfig.json 的 agent_api.api_key 字段固化。`);
    }
  }

  // ========== 工具函数 ==========

  function setLatestCtx(ctx: any): void {
    latestCtx = ctx;
  }

  /** 发送 JSON 响应 */
  function sendJson(res: any, statusCode: number, body: AgentResponse): void {
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
    });
    res.end(json);
  }

  /** 验证 API Key */
  function validateApiKey(req: any, res: any): boolean {
    const apiKey = req.headers["x-api-key"] || "";
    if (!config.apiKey || apiKey !== config.apiKey) {
      sendJson(res, 401, {
        success: false,
        action: "auth",
        error: "无效的 API Key，请在请求头 X-API-Key 中提供正确密钥",
        timestamp: new Date().toISOString(),
      });
      return false;
    }
    return true;
  }

  /** 检查权限 */
  function checkPermission(required: "readonly" | "dialogue" | "full", res: any): boolean {
    const levels = { readonly: 1, dialogue: 2, full: 3 };
    if (levels[config.permission] < levels[required]) {
      sendJson(res, 403, {
        success: false,
        action: "permission",
        error: `权限不足。当前级别: ${config.permission}，需要: ${required}`,
        timestamp: new Date().toISOString(),
      });
      return false;
    }
    return true;
  }

  // ========== Action 处理器 ==========

  /**
   * 操作：获取角色状态
   * 权限：readonly
   */
  function handleGetState(res: any, params?: Record<string, any>): void {
    const state = deepClone(getState());
    const cardId = params?.cardId as string | undefined;
    const charName = params?.charName as string | undefined;

    let result: any;

    if (cardId && charName) {
      // 查询指定卡片下的指定角色
      const cardStates = state.cardStates;
      if (!cardStates || !cardStates[cardId]) {
        sendJson(res, 404, {
          success: false, action: "get_state",
          error: `卡片 "${cardId}" 不存在`, timestamp: new Date().toISOString(),
        });
        return;
      }
      const chars = cardStates[cardId].characters;
      result = chars[charName] || null;
      if (!result) {
        sendJson(res, 404, {
          success: false, action: "get_state",
          error: `角色 "${charName}" 在卡片 "${cardId}" 中不存在`, timestamp: new Date().toISOString(),
        });
        return;
      }
    } else if (cardId) {
      // 查询指定卡片下的所有角色
      const cardStates = state.cardStates;
      if (!cardStates || !cardStates[cardId]) {
        sendJson(res, 404, {
          success: false, action: "get_state",
          error: `卡片 "${cardId}" 不存在`, timestamp: new Date().toISOString(),
        });
        return;
      }
      result = cardStates[cardId];
    } else {
      // 返回完整状态
      result = {
        world: state.global || state["世界"] || {},
        cards: state.cardStates || {},
        activeCards: getActiveCardIds(),
      };
    }

    sendJson(res, 200, {
      success: true, action: "get_state",
      data: result, timestamp: new Date().toISOString(),
    });
  }

  /**
   * 操作：获取卡片列表
   * 权限：readonly
   */
  function handleListCards(res: any): void {
    const reg = getRegistry();
    const activeIds = getActiveCardIds();
    const cards: any[] = [];

    for (const [id, entry] of Object.entries(reg.cards)) {
      const name = getCardName(id);
      cards.push({
        id,
        name,
        active: activeIds.includes(id),
        importedAt: (entry as any).imported_at || "",
        characterCount: getCharacterCountForCard(id),
      });
    }

    sendJson(res, 200, {
      success: true, action: "list_cards",
      data: { cards, activeIds }, timestamp: new Date().toISOString(),
    });
  }

  /** 获取卡片内角色数量 */
  function getCharacterCountForCard(cardId: string): number {
    try {
      const stateDir = getStateDir();
      const templatePath = join(stateDir, "cards", cardId, "state.json");
      if (!existsSync(templatePath)) return 0;
      const data = JSON.parse(readFileSync(templatePath, "utf-8"));
      return Object.keys(data).filter(k =>
        !k.startsWith("_") && k !== "{{user}}" && k !== "事件" && k !== "世界"
      ).length;
    } catch {
      return 0;
    }
  }

  /**
   * 操作：发送消息给 AI（核心操作）
   * 权限：dialogue
   *
   * 这是 Agent 控制 AI 对话的主入口。
   * 发送消息后，等待 AI 回复，然后以结构化 JSON 返回。
   *
   * 参数：
   *   - message: string（要发送的消息）
   *   - waitForReply: boolean（是否等待 AI 回复，默认 true）
   *   - timeout: number（等待超时毫秒，默认 60000）
   *   - systemHint: string（可选，注入 steer 消息的额外上下文）
   */
  async function handleSendMessage(res: any, params?: Record<string, any>): Promise<void> {
    const message = params?.message;
    if (!message || typeof message !== "string") {
      sendJson(res, 400, {
        success: false, action: "send_message",
        error: "缺少 message 参数", timestamp: new Date().toISOString(),
      });
      return;
    }

    const waitForReply = params?.waitForReply !== false;
    const timeout = params?.timeout ?? 60000;
    const systemHint = params?.systemHint as string | undefined;

    try {
      // 如果有系统提示，先注入 steer
      if (systemHint) {
        pi.sendUserMessage(systemHint, { deliverAs: "steer" });
      }

      // 发送用户消息
      pi.sendUserMessage(message);

      if (!waitForReply) {
        sendJson(res, 200, {
          success: true, action: "send_message",
          data: { sent: true, waiting: false, message: "消息已发送，未等待回复" },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // 等待 AI 回复完成
      const reply = await waitForAgentReply(timeout);

      sendJson(res, 200, {
        success: true, action: "send_message",
        data: {
          sent: true,
          reply: reply?.content || null,
          replyRaw: reply || null,
          usage: reply?.usage || null,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      sendJson(res, 500, {
        success: false, action: "send_message",
        error: e.message || "发送消息失败",
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 等待 AI 回复完成
   */
  function waitForAgentReply(timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("等待 AI 回复超时"));
      }, timeout);

      let latestMessage: any = null;

      function onMessageEnd(event: any) {
        if (event?.message?.role === "assistant") {
          latestMessage = {
            role: "assistant",
            content: typeof event.message.content === "string"
              ? event.message.content
              : (Array.isArray(event.message.content)
                ? event.message.content.map((b: any) => b.text || "").join("")
                : ""),
            usage: event.message.usage || null,
          };
          cleanup();
          resolve(latestMessage);
        }
      }

      function cleanup() {
        clearTimeout(timer);
        pi.off("message_end", onMessageEnd);
      }

      pi.on("message_end", onMessageEnd);
    });
  }

  /**
   * 操作：获取对话历史
   * 权限：readonly
   */
  function handleGetHistory(res: any, params?: Record<string, any>): void {
    const stateDir = getStateDir();
    const sessionsDir = join(stateDir, "sessions");
    const limit = params?.limit ?? 20;
    const sessionFile = params?.sessionFile as string | undefined;

    if (!existsSync(sessionsDir)) {
      sendJson(res, 200, {
        success: true, action: "get_history",
        data: { messages: [], total: 0 }, timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      let targetFile: string;

      if (sessionFile) {
        targetFile = join(sessionsDir, sessionFile);
        if (!existsSync(targetFile)) {
          sendJson(res, 404, {
            success: false, action: "get_history",
            error: `Session 文件 "${sessionFile}" 不存在`, timestamp: new Date().toISOString(),
          });
          return;
        }
      } else {
        // 找到最新的 session 文件
        const allFiles: { name: string; path: string; mtime: number }[] = [];
        function scanDir(dir: string, prefix: string) {
          for (const f of readdirSync(dir)) {
            const fp = join(dir, f);
            const stat = statSync(fp);
            if (stat.isDirectory()) {
              scanDir(fp, prefix ? prefix + "/" + f : f);
            } else if (f.endsWith(".jsonl")) {
              allFiles.push({ name: prefix ? prefix + "/" + f : f, path: fp, mtime: stat.mtimeMs });
            }
          }
        }
        scanDir(sessionsDir, "");
        allFiles.sort((a, b) => b.mtime - a.mtime);
        if (allFiles.length === 0) {
          sendJson(res, 200, {
            success: true, action: "get_history",
            data: { messages: [], total: 0 }, timestamp: new Date().toISOString(),
          });
          return;
        }
        targetFile = allFiles[0].path;
      }

      const rawEntries: any[] = [];
      const lines = readFileSync(targetFile, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try { rawEntries.push(JSON.parse(line)); } catch {}
      }

      // 提取用户和助手消息
      const messages: any[] = [];
      for (const entry of rawEntries) {
        if (entry.type === "message" && entry.message) {
          const role = entry.message.role;
          if (role !== "user" && role !== "assistant") continue;
          let text = "";
          const c = entry.message.content;
          if (typeof c === "string") {
            text = c;
          } else if (Array.isArray(c)) {
            text = c.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
          }
          // 过滤系统 steer 消息
          if (text.startsWith("[系统 ·")) continue;
          messages.push({ role, content: text });
        }
      }

      // 取最近 limit 条
      const recent = messages.slice(-limit);

      sendJson(res, 200, {
        success: true, action: "get_history",
        data: { messages: recent, total: messages.length },
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      sendJson(res, 500, {
        success: false, action: "get_history",
        error: e.message, timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 操作：列出 session 文件
   * 权限：readonly
   */
  function handleListSessions(res: any): void {
    const stateDir = getStateDir();
    const sessionsDir = join(stateDir, "sessions");

    if (!existsSync(sessionsDir)) {
      sendJson(res, 200, {
        success: true, action: "list_sessions",
        data: { sessions: [] }, timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const allFiles: any[] = [];
      function scanDir(dir: string, prefix: string) {
        for (const f of readdirSync(dir)) {
          const fp = join(dir, f);
          const stat = statSync(fp);
          if (stat.isDirectory()) {
            scanDir(fp, prefix ? prefix + "/" + f : f);
          } else if (f.endsWith(".jsonl")) {
            let preview = "";
            try {
              const content = readFileSync(fp, "utf-8");
              const lines = content.split("\n").filter(Boolean);
              for (const line of lines) {
                try {
                  const entry = JSON.parse(line);
                  const msg = entry.message;
                  if (msg?.role === "user") {
                    const c = msg.content;
                    if (typeof c === "string") { preview = c.slice(0, 80); break; }
                    if (Array.isArray(c)) {
                      for (const b of c) {
                        if (b.type === "text") { preview = b.text.slice(0, 80); break; }
                      }
                      if (preview) break;
                    }
                  }
                } catch {}
              }
            } catch {}
            allFiles.push({
              name: prefix ? prefix + "/" + f : f,
              size: stat.size,
              mtime: stat.mtimeMs,
              preview,
            });
          }
        }
      }
      scanDir(sessionsDir, "");
      allFiles.sort((a, b) => b.mtime - a.mtime);

      sendJson(res, 200, {
        success: true, action: "list_sessions",
        data: { sessions: allFiles }, timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      sendJson(res, 500, {
        success: false, action: "list_sessions",
        error: e.message, timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 操作：加载历史 session
   * 权限：dialogue
   */
  function handleLoadSession(res: any, params?: Record<string, any>): void {
    const sessionFile = params?.sessionFile as string | undefined;
    if (!sessionFile) {
      sendJson(res, 400, {
        success: false, action: "load_session",
        error: "缺少 sessionFile 参数", timestamp: new Date().toISOString(),
      });
      return;
    }

    const stateDir = getStateDir();
    const fullPath = join(stateDir, "sessions", sessionFile);
    if (!existsSync(fullPath)) {
      sendJson(res, 404, {
        success: false, action: "load_session",
        error: `Session 文件 "${sessionFile}" 不存在`, timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      const rawEntries: any[] = [];
      const lines = readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try { rawEntries.push(JSON.parse(line)); } catch {}
      }

      // 构建历史提示注入
      const dialogPairs: { role: string; text: string }[] = [];
      for (const entry of rawEntries) {
        if (entry.type === "message" && entry.message) {
          const role = entry.message.role;
          if (role !== "user" && role !== "assistant") continue;
          let text = "";
          const c = entry.message.content;
          if (typeof c === "string") text = c;
          else if (Array.isArray(c)) {
            for (const b of c) {
              if (b.type === "text") {
                const match = b.text.match(/<content>([\s\S]*?)<\/content>/);
                text += match ? match[1] : b.text;
              }
            }
          }
          if (text.trim()) dialogPairs.push({ role, text: text.trim() });
        }
      }

      const recentPairs = dialogPairs.slice(-10);
      let hint = "\n";
      hint += "[历史记录加载] 用户正在继续之前的对话。\n";
      hint += "历史文件: " + sessionFile + "\n";
      hint += "[最近对话]\n";
      for (const p of recentPairs) {
        const label = p.role === "user" ? "用户" : "助手";
        hint += label + ": " + p.text.slice(0, 800) + "\n";
      }
      hint += "[以上为历史上下文，请严格遵循输出格式规范继续推进剧情]\n";

      if (latestCtx) {
        pi.sendUserMessage(hint, { deliverAs: "steer" });
      } else {
        pi.sendUserMessage(hint);
      }

      sendJson(res, 200, {
        success: true, action: "load_session",
        data: { sessionFile, entriesLoaded: rawEntries.length, recentMessages: dialogPairs.length },
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      sendJson(res, 500, {
        success: false, action: "load_session",
        error: e.message, timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 操作：执行斜杠命令
   * 权限：full
   */
  function handleExecuteCommand(res: any, params?: Record<string, any>): void {
    const command = params?.command as string | undefined;
    if (!command) {
      sendJson(res, 400, {
        success: false, action: "execute_command",
        error: "缺少 command 参数", timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      pi.sendUserMessage(command);

      // 如果是卡片切换命令，额外处理
      if (command.startsWith("/card ")) {
        const parts = command.slice(6).trim().split(/\s+/);
        const subCmd = parts[0];
        if (subCmd === "activate" || subCmd === "set") {
          const cardIds = parts.slice(1);
          if (cardIds.length > 0) {
            if (subCmd === "set") {
              setActiveCard(cardIds[0]);
            } else {
              activateCards(cardIds);
            }
          }
        }
      }

      sendJson(res, 200, {
        success: true, action: "execute_command",
        data: { command, executed: true },
        timestamp: new Date().toISOString(),
      });
    } catch (e: any) {
      sendJson(res, 500, {
        success: false, action: "execute_command",
        error: e.message, timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * 操作：获取运行状态
   * 权限：readonly
   */
  function handleGetStatus(res: any): void {
    const state = getState();
    sendJson(res, 200, {
      success: true, action: "get_status",
      data: {
        activeCards: getActiveCardIds(),
        lastUpdated: state._meta?.lastUpdated || null,
        isStreaming: latestCtx ? !latestCtx.isIdle() : false,
        model: latestCtx?.model || null,
      },
      timestamp: new Date().toISOString(),
    });
  }

  // ========== 路由分发 ==========

  async function handleRequest(req: any, res: any): Promise<void> {
    // CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
      });
      res.end();
      return;
    }

    // 验证 API Key
    if (!validateApiKey(req, res)) return;

    // 仅支持 POST（除了健康检查）
    if (req.method === "GET") {
      if (req.url === "/health") {
        sendJson(res, 200, {
          success: true, action: "health",
          data: { status: "ok", config: { permission: config.permission } },
          timestamp: new Date().toISOString(),
        });
      } else {
        sendJson(res, 405, {
          success: false, action: "method",
          error: "仅支持 POST 方法。健康检查请用 GET /health",
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, {
        success: false, action: "method",
        error: "仅支持 POST 方法",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // 解析请求体
    let body: string;
    try {
      body = await readRequestBody(req);
    } catch {
      sendJson(res, 400, {
        success: false, action: "parse",
        error: "请求体解析失败", timestamp: new Date().toISOString(),
      });
      return;
    }

    let request: AgentRequest;
    try {
      request = JSON.parse(body);
    } catch {
      sendJson(res, 400, {
        success: false, action: "parse",
        error: "JSON 解析失败", timestamp: new Date().toISOString(),
      });
      return;
    }

    // 路由
    const { action, params } = request;

    switch (action) {
      case "get_state":
        if (!checkPermission("readonly", res)) return;
        handleGetState(res, params);
        break;

      case "list_cards":
        if (!checkPermission("readonly", res)) return;
        handleListCards(res);
        break;

      case "get_history":
        if (!checkPermission("readonly", res)) return;
        handleGetHistory(res, params);
        break;

      case "list_sessions":
        if (!checkPermission("readonly", res)) return;
        handleListSessions(res);
        break;

      case "get_status":
        if (!checkPermission("readonly", res)) return;
        handleGetStatus(res);
        break;

      case "send_message":
        if (!checkPermission("dialogue", res)) return;
        await handleSendMessage(res, params);
        break;

      case "load_session":
        if (!checkPermission("dialogue", res)) return;
        handleLoadSession(res, params);
        break;

      case "execute_command":
        if (!checkPermission("full", res)) return;
        handleExecuteCommand(res, params);
        break;

      case "activate_card":
        if (!checkPermission("full", res)) return;
        handleActivateCard(res, params);
        break;

      default:
        sendJson(res, 400, {
          success: false, action,
          error: `未知操作 "${action}"。支持的操作: get_state, list_cards, get_history, list_sessions, get_status, send_message, load_session, execute_command, activate_card`,
          timestamp: new Date().toISOString(),
        });
    }
  }

  /** 激活卡片 */
  function handleActivateCard(res: any, params?: Record<string, any>): void {
    const cardId = params?.cardId as string | undefined;
    if (!cardId) {
      sendJson(res, 400, {
        success: false, action: "activate_card",
        error: "缺少 cardId 参数", timestamp: new Date().toISOString(),
      });
      return;
    }
    const ok = setActiveCard(cardId);
    sendJson(res, ok ? 200 : 404, {
      success: ok, action: "activate_card",
      data: ok ? { cardId, activated: true } : undefined,
      error: ok ? undefined : `卡片 "${cardId}" 不存在`,
      timestamp: new Date().toISOString(),
    });
  }

  /** 读取请求体 */
  function readRequestBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: string) => { data += chunk; });
      req.on("end", () => resolve(data));
      req.on("error", (err: Error) => reject(err));
    });
  }

  // ========== 启动/关闭 ==========

  async function start(ctx: any): Promise<void> {
    loadConfig();

    if (!config.enabled) {
      console.log("[Agent-API] 未启用（agent_api.enabled = false）");
      return;
    }

    setLatestCtx(ctx);

    const http = await import("node:http");

    server = http.createServer((req: any, res: any) => {
      handleRequest(req, res).catch((err) => {
        console.error("[Agent-API] 请求处理异常:", err);
        sendJson(res, 500, {
          success: false, action: "internal",
          error: "内部错误", timestamp: new Date().toISOString(),
        });
      });
    });

    const host = config.host || "127.0.0.1";
    const port = config.port || 3013;

    return new Promise<void>((resolve, reject) => {
      server.listen(port, host, () => {
        console.log(`[Agent-API] AI Agent 控制接口已启动: http://${host}:${port}`);
        console.log(`[Agent-API] 权限级别: ${config.permission}`);
        console.log(`[Agent-API] 使用 X-API-Key 请求头进行认证`);
        resolve();
      });
      server.once("error", (err: any) => {
        if (err.code === "EADDRINUSE") {
          console.warn(`[Agent-API] 端口 ${port} 已被占用，尝试 ${port + 1}`);
          server.listen(port + 1, host, () => {
            console.log(`[Agent-API] 已启动在端口 ${port + 1}`);
            resolve();
          });
        } else {
          console.error("[Agent-API] 启动失败:", err.message);
          reject(err);
        }
      });
    });
  }

  async function shutdown(): Promise<void> {
    if (server) {
      server.close();
      server = null;
    }
  }

  return {
    start,
    shutdown,
    setLatestCtx,
  };
}
