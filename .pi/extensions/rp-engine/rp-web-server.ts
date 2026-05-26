/**
 * RP Engine - RP Web 服务器
 * 
 * 提供 HTTP 静态文件服务 + WebSocket 事件转发 + token 认证。
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { deepClone } from "./utils";
import { getRegistry, activateCards, getCardName, getActiveCardIds, getActiveCards, saveRegistry } from "./card-manager";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
};

/**
 * 创建 RP Web 服务器的共享状态和函数
 */
export function createRPWebServer(
  pi: ExtensionAPI,
  getStateDir: () => string,
  getState: () => Record<string, any>,
  getRegexHooks?: () => { prompt: { name: string; pattern: string; flags: string; replacement: string }[]; display: { name: string; pattern: string; flags: string; replacement: string }[] }
) {
  const RP_PORT = parseInt(process.env.RP_WEB_PORT || "3012");

  let rpServer: any = null;
  let rpWss: any = null;
  let rpClients = new Set<any>();
  let latestCtx: any = null;

  function setLatestCtx(ctx: any) {
    latestCtx = ctx;
  }

  function getRpWebDir(): string {
    return join(getStateDir(), "extensions", "rp-web");
  }

  /** 广播数据到所有已连接的 RP Web 客户端 */
  function broadcastToRP(data: any) {
    const json = JSON.stringify(data);
    for (const client of rpClients) {
      if (client.readyState === 1) {
        try { client.send(json); } catch {}
      }
    }
  }

  /** 发送数据到单个 WebSocket 客户端 */
  function sendToRP(ws: any, data: any) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  }

  /** 构建同步快照 */
  async function buildSnapshot() {
    const ctx = latestCtx;
    if (!ctx) return { type: "mirror_sync", entries: [], model: null, isStreaming: false };

    const entries = ctx.sessionManager.getEntries();
    const model = ctx.model;

    return {
      type: "mirror_sync",
      entries,
      model,
      isStreaming: !ctx.isIdle(),
    };
  }

  /** 静态文件服务，支持 token 注入 */
  function serveFile(urlPath: string, res: any, rpToken?: string) {
    let cleanPath = urlPath.split("?")[0];
    if (cleanPath === "/") cleanPath = "rp-web.html";
    if (cleanPath.startsWith("/")) cleanPath = cleanPath.slice(1);

    // favicon.ico 静默忽略
    if (cleanPath === "favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    const rpWebDir = getRpWebDir();
    const filePath = join(rpWebDir, cleanPath);

    if (!filePath.startsWith(rpWebDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    if (!existsSync(filePath)) {
      res.writeHead(404);
      res.end("Not Found: " + cleanPath);
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const ct = MIME[ext] || "application/octet-stream";

    let content = readFileSync(filePath);

    // 对 HTML 文件注入 token
    if (ext === ".html" && rpToken) {
      const tokenScript = `<script>window.RP_TOKEN = "${rpToken}";</script>`;
      content = Buffer.from(content.toString().replace('</head>', tokenScript + '</head>'));
    }

    res.writeHead(200, { "Content-Type": ct });
    res.end(content);
  }

  // ========== steer 系统消息前缀（不转发到前端） ==========

  const STEER_PREFIXES = ['[系统', '[工具流程检查]', '[叙事校准]', '[当前状态同步]', '[扮演边界确认]'];

  // ========== blocked 标签的服务端剥离 ==========

  const BLOCKED_TAGS_STRIP = [
    'UpdateVariable', 'update_state', 'read_state', 'load_worldbook', 'advance_time'
  ];

  let _strippedLogged = false;

  function stripBlockedTagsFromContent(content: string): { cleaned: string; stripped: string[] } {
    const stripped: string[] = [];
    let cleaned = content;
    for (const tag of BLOCKED_TAGS_STRIP) {
      const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
      let match;
      while ((match = regex.exec(cleaned)) !== null) {
        stripped.push(match[0].slice(0, 80) + (match[0].length > 80 ? '...' : ''));
      }
      cleaned = cleaned.replace(regex, '');
    }
    return { cleaned, stripped };
  }

  function sanitizeEventForBroadcast(event: any): any {
    if (!event) return null;
    const msg = event.message;
    if (!msg) return null;

    // 过滤 steer/system 消息（不转发到前端）
    if (msg.role === 'user') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      if (STEER_PREFIXES.some(p => content.startsWith(p))) {
        return null;
      }
      return event;
    }

    if (msg.role !== 'assistant') return event;

    if (typeof msg.content === 'string') {
      const { cleaned, stripped } = stripBlockedTagsFromContent(msg.content);
      if (stripped.length > 0 && !_strippedLogged) {
        console.log(`[RP-Web] 服务端剥离 blocked 标签: ${stripped.length} 个块`);
        _strippedLogged = true;
      }
      return { ...event, message: { ...msg, content: cleaned } };
    }

    if (Array.isArray(msg.content)) {
      let totalStripped = 0;
      const newContent = msg.content.map((block: any) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          const { cleaned, stripped } = stripBlockedTagsFromContent(block.text);
          totalStripped += stripped.length;
          return { ...block, text: cleaned };
        }
        return block;
      });
      if (totalStripped > 0 && !_strippedLogged) {
        console.log(`[RP-Web] 服务端剥离 blocked 标签: ${totalStripped} 个块`);
        _strippedLogged = true;
      }
      return { ...event, message: { ...msg, content: newContent } };
    }

    return event;
  }

  /** 注册 RP 事件转发（message_start/message_update/message_end 等） */
  function registerEventForwarding() {
    const rpEventTypes = [
      "agent_start", "agent_end",
      "turn_end",
      "message_start", "message_update", "message_end",
    ] as const;

    for (const eventType of rpEventTypes) {
      pi.on(eventType as any, async (event: any, _ctx: ExtensionContext) => {
        const sanitized = sanitizeEventForBroadcast(event);
        if (sanitized !== null) {
          broadcastToRP({ type: "event", event: { type: eventType, ...sanitized } });
        }
      });
    }
  }

  // ========== RP 命令处理 ==========

  async function handleRPCommand(ws: any, command: any) {
    const success = (cmd: string, data?: any) => ({ type: "response", command: cmd, success: true, id: command.id, data });
    const error = (cmd: string, msg: string) => ({ type: "response", command: cmd, success: false, error: msg, id: command.id });

    const stateDir = getStateDir();
    const state = getState();

    try {
      switch (command.type) {
        case "prompt":
          pi.sendUserMessage(command.message);
          sendToRP(ws, success("prompt"));
          break;

        case "abort":
          if (latestCtx) latestCtx.abort();
          sendToRP(ws, success("abort"));
          break;

        case "mirror_sync_request": {
          const snapshot = await buildSnapshot();
          sendToRP(ws, snapshot);
          break;
        }

        // ===== 卡片管理命令 =====
        case "list_cards": {
          const reg = getRegistry();
          const activeIds = getActiveCardIds();
          const cards: any[] = [];
          for (const [id, entry] of Object.entries(reg.cards)) {
            const name = getCardName(id);
            const active = activeIds.includes(id);
            cards.push({
              id,
              name,
              active,
              importedAt: (entry as any).imported_at || "",
              dir: (entry as any).dir || "",
            });
          }
          sendToRP(ws, { type: "card_list", cards, activeIds });
          break;
        }

        case "activate_cards": {
          const cardIds: string[] = command.cardIds || [];
          if (cardIds.length === 0) {
            sendToRP(ws, error("activate_cards", "没有指定卡片 id"));
            break;
          }
          // 清除旧激活，设置新的（当前：激活即替换）
          const reg = getRegistry();
          reg.active = [];
          saveRegistry(reg);
          const activated = activateCards(cardIds);
          if (activated.length === 0) {
            sendToRP(ws, error("activate_cards", "未找到有效卡片"));
          } else {
            const names = activated.map((id: string) => getCardName(id));
            console.log(`[RP-Web] 前端切换卡片: ${activated.join(", ")}`);
            sendToRP(ws, {
              type: "cards_activated",
              cardIds: activated,
              names,
              needRestart: true,
            });
          }
          break;
        }

        case "list_sessions": {
          const sessionsDir = join(stateDir, "sessions");
          const sessions: any[] = [];
          if (existsSync(sessionsDir)) {
            // 扫描根目录 + 所有子目录下的 .jsonl 文件
            const allFiles: { name: string; path: string }[] = [];
            function scanDir(dir: string, prefix: string) {
              for (const f of readdirSync(dir)) {
                const fp = join(dir, f);
                const stat = statSync(fp);
                if (stat.isDirectory()) {
                  scanDir(fp, prefix ? prefix + "/" + f : f);
                } else if (f.endsWith(".jsonl")) {
                  allFiles.push({ name: prefix ? prefix + "/" + f : f, path: fp });
                }
              }
            }
            scanDir(sessionsDir, "");
            // 按修改时间排序，取最近 30 个
            allFiles.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs);
            const files = allFiles.slice(0, 30);
            for (const { name: file, path: filePath } of files) {
              const stat = statSync(filePath);
              let preview = "";
              try {
                const content = readFileSync(filePath, "utf-8");
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
              sessions.push({ file, size: stat.size, mtime: stat.mtimeMs, preview });
            }
          }
          sendToRP(ws, { type: "sessions_list", sessions });
          break;
        }

        case "get_rp_state":
        case "get_state": {
          const stateCopy = deepClone(state);
          sendToRP(ws, { type: "rp_state", data: stateCopy });
          break;
        }

        case "get_append_system": {
          // 读活跃卡片的 APPEND_SYSTEM（按卡片目录优先级，回退到全局）
          const activeIds = getActiveCardIds();
          let content = "";
          // 优先用第一张激活卡片的 append_system
          for (const cardId of activeIds) {
            const cardPath = join(stateDir, "cards", cardId, "append_system.md");
            if (existsSync(cardPath)) {
              content = readFileSync(cardPath, "utf-8");
              break;
            }
          }
          // 回退到全局
          if (!content) {
            const globalPath = join(stateDir, "APPEND_SYSTEM.md");
            if (existsSync(globalPath)) {
              content = readFileSync(globalPath, "utf-8");
            }
          }
          sendToRP(ws, { type: "append_system_content", content });
          break;
        }

        case "load_session": {
          const sessionFile = command.file;
          if (!sessionFile) { sendToRP(ws, error("load_session", "no file")); break; }
          const fullPath = join(stateDir, "sessions", sessionFile);
          if (!existsSync(fullPath)) { sendToRP(ws, error("load_session", "file not found")); break; }
          try {
            const rawEntries: any[] = [];
            const lines = readFileSync(fullPath, "utf-8").split("\n").filter(Boolean);
            for (const line of lines) {
              try { rawEntries.push(JSON.parse(line)); } catch {}
            }
            const messages = rawEntries.filter((e: any) => e.type === "message" && e.message);

            // 滑动窗口 + 分段摘要
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

            let summary = "";
            const SUMMARY_PATH = join(stateDir, "sessions", sessionFile + ".summary");
            if (dialogPairs.length > 10) {
              if (existsSync(SUMMARY_PATH)) {
                summary = readFileSync(SUMMARY_PATH, "utf-8").trim();
              } else {
                const SEGMENT_SIZE = 10;
                const segments: string[] = [];
                const totalPairs = dialogPairs.length;
                const summaryEnd = Math.max(0, totalPairs - 10);
                const summaryPairs = dialogPairs.slice(0, summaryEnd);

                for (let start = 0; start < summaryPairs.length; start += SEGMENT_SIZE * 2) {
                  const end = Math.min(start + SEGMENT_SIZE * 2, summaryPairs.length);
                  const segment = summaryPairs.slice(start, end);
                  const userMsgs: string[] = [];
                  for (const p of segment) {
                    if (p.role === "user") {
                      const brief = p.text.replace(/<choice>[\s\S]*?<\/choice>/g, "").slice(0, 80);
                      if (brief.trim()) userMsgs.push(brief.trim());
                    }
                  }
                  if (userMsgs.length > 0) {
                    const roundStart = Math.floor(start / 2) + 1;
                    const roundEnd = Math.floor(end / 2);
                    segments.push("[第" + roundStart + "-" + roundEnd + "轮] " + userMsgs.join(" → ").slice(0, 300));
                  }
                }
                summary = segments.join("\n");
                try { writeFileSync(SUMMARY_PATH, summary, "utf-8"); } catch {}
              }
            }

            const recentPairs = dialogPairs.slice(-10);
            let recentText = "";
            for (const p of recentPairs) {
              const label = p.role === "user" ? "用户" : "助手";
              recentText += label + ": " + p.text.slice(0, 800) + "\n";
            }

            let hint = "\n";
            hint += "[历史记录加载] 用户正在继续之前的对话。\n";
            hint += "历史文件: " + sessionFile + "\n";
            if (summary) hint += "[剧情分段摘要]\n" + summary + "\n";
            hint += "[最近对话]\n";
            hint += recentText;
            hint += "[以上为历史上下文，请严格遵循输出格式规范继续推进剧情]\n";

            if (latestCtx) {
              pi.sendUserMessage(hint, { deliverAs: "steer" });
            } else {
              pi.sendUserMessage(hint);
            }

            sendToRP(ws, { type: "load_session_entries", entries: messages });
          } catch (e: any) {
            sendToRP(ws, error("load_session", e.message));
          }
          break;
        }

        case "new_session": {
          sendToRP(ws, { type: "new_session_started" });
          break;
        }

        case "compact": {
          if (!latestCtx) { sendToRP(ws, error("compact", "no ctx")); break; }
          try {
            const result = await latestCtx.compact(command.hint || "保留角色关系和最近对话。");
            sendToRP(ws, { type: "compact_result", success: true, result });
          } catch (e: any) {
            sendToRP(ws, { type: "compact_result", success: false, error: e.message });
          }
          break;
        }

        case "exec": {
          const code = command.code;
          if (!code) { sendToRP(ws, error("exec", "no code")); break; }
          try {
            if (code.startsWith('/')) {
              const parts = code.slice(1).split(/\s+/);
              const cmd = parts[0];
              switch (cmd) {
                case 'compact':
                  if (latestCtx) {
                    latestCtx.compact("保留角色关系、当前场景、最近对话细节。").then(() => {
                      sendToRP(ws, { type: "exec_result", success: true, message: "压缩完成" });
                    }).catch((e: any) => {
                      sendToRP(ws, { type: "exec_result", success: false, error: e.message });
                    });
                  }
                  break;
                default:
                  pi.sendUserMessage(code);
                  sendToRP(ws, { type: "exec_result", success: true, message: "已发送" });
              }
            } else {
              pi.sendUserMessage(code);
              sendToRP(ws, { type: "exec_result", success: true, message: "已发送" });
            }
          } catch (e: any) {
            sendToRP(ws, { type: "exec_result", success: false, error: e.message });
          }
          break;
        }

        default:
          sendToRP(ws, error(command.type, "Unknown command: " + command.type));
      }
    } catch (e: any) {
      sendToRP(ws, error(command.type || "unknown", e.message));
    }
  }

  // ========== 启动服务器 ==========

  async function start(ctx: any) {
    const http = await import("node:http");
    const crypto = await import("node:crypto");
    const { WebSocketServer } = await import("ws");

    const rpToken = crypto.randomBytes(16).toString('hex');
    console.log(`[RP-Web] Token: ${rpToken}`);

    rpServer = http.createServer((req: any, res: any) => {
      if (req.url === "/ws" || req.url?.startsWith("/ws?")) {
        return;
      }
      serveFile(req.url || "/", res, rpToken);
    });

    rpWss = new WebSocketServer({ noServer: true });

    rpServer.on("upgrade", (request: any, socket: any, head: any) => {
      const urlPath = request.url?.split('?')[0];
      if (urlPath !== "/ws") {
        socket.destroy();
        return;
      }

      const urlParams = new URLSearchParams(request.url?.split('?')[1] || '');
      const token = urlParams.get('token');
      if (token !== rpToken) {
        console.log(`[RP-Web] WebSocket 连接被拒绝：token 不匹配`);
        socket.destroy();
        return;
      }

      rpWss.handleUpgrade(request, socket, head, (ws: any) => {
        rpWss.emit("connection", ws, request);
      });
    });

    rpWss.on("connection", (ws: any) => {
      rpClients.add(ws);

      buildSnapshot().then((snapshot) => sendToRP(ws, snapshot));

      // 下发正则渲染钩子（供前端 display 阶段使用）
      if (getRegexHooks) {
        const hooks = getRegexHooks();
        if (hooks.display.length > 0) {
          sendToRP(ws, { type: "regex_hooks", hooks: hooks.display });
        }
      }

      // 下发卡片 UI 组件（供前端动态加载）
      try {
        const cards = getActiveCards();
        for (const card of cards) {
          const uiDir = join(card.dir, "ui");
          if (!existsSync(uiDir)) continue;
          const files: { name: string; content: string }[] = [];
          for (const f of readdirSync(uiDir)) {
            if (f.endsWith(".css") || f.endsWith(".js")) {
              files.push({
                name: f,
                content: readFileSync(join(uiDir, f), "utf-8"),
              });
            }
          }
          if (files.length > 0) {
            sendToRP(ws, { type: "card_ui", cardId: card.id, files });
            console.log(`[RP-Web] 卡片 UI 下发: ${card.id} (${files.map(f => f.name).join(", ")})`);
          }
        }
      } catch {}

      ws.on("message", (data: any) => {
        try {
          const cmd = JSON.parse(data.toString());
          handleRPCommand(ws, cmd);
        } catch {}
      });

      ws.on("close", () => { rpClients.delete(ws); });
      ws.on("error", () => { rpClients.delete(ws); });
    });

    const rpWebHost = process.env.RP_WEB_HOST || "0.0.0.0";
    const tryListen = (port: number, maxAttempts = 10) => {
      rpServer!.listen(port, rpWebHost, () => {
        console.log(`[RP-Web] RP 前端页面: http://${rpWebHost}:${port}`);
        try { ctx.ui.notify(`RP Web: http://${rpWebHost}:${port}`, "info"); } catch {}
      });
      rpServer!.once("error", (err: any) => {
        if (err.code === "EADDRINUSE" && port < RP_PORT + maxAttempts) {
          rpServer!.removeAllListeners("error");
          tryListen(port + 1, maxAttempts);
        } else {
          console.error(`[RP-Web] 启动失败:`, err.message);
        }
      });
    };

    tryListen(RP_PORT);
  }

  /** 关闭服务器 */
  async function shutdown() {
    if (rpWss) {
      for (const client of rpClients) {
        try { client.close(); } catch {}
      }
      rpClients.clear();
      rpWss.close();
      rpWss = null;
    }
    if (rpServer) {
      rpServer.close();
      rpServer = null;
    }
  }

  return {
    broadcastToRP,
    setLatestCtx,
    start,
    shutdown,
    registerEventForwarding,
  };
}
