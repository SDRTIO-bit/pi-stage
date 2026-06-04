// ============================================================
// pi rp-engine — 完整前端应用 (Alpine.js)
// 功能: 会话管理、角色卡选择、聊天、状态面板
// ============================================================

document.addEventListener("alpine:init", () => {
  Alpine.data("chat", () => ({
    // ---- 状态 ----
    input: "",
    messages: [],
    loading: false,
    loadingInit: true,
    loadingCards: false,
    sidebarCollapsed: false,
    activeTab: "cards",

    // Session
    sessionId: "",
    get shortId() {
      return this.sessionId ? this.sessionId.slice(0, 22) + "..." : "-";
    },

    // Cards
    cards: [],
    cardName: "",
    selectedCardId: "",

    // Sessions list
    allSessions: [],
    filteredSessions: [],
    sessionSearch: "",

    // Status
    historyCount: 0,
    phase: "idle",
    activeCards: 0,
    nodeCount: 0,
    degraded: "no",
    tokens: 0,
    statusText: "ready",
    statusDot: "",

    // ---- 初始化 ----
    async init() {
      // 尝试从 localStorage 恢复会话
      const saved = localStorage.getItem("rp-session");
      if (saved) {
        try {
          const r = await fetch("/session/" + saved);
          if (r.ok) {
            const d = await r.json();
            this.sessionId = d.sessionId;
            this.selectedCardId = d.cardId || "";
            this.cardName = d.cardName || d.cardId || "";
            this.restoreHistory(d.history || []);
            this.applyStatus(d);
            this.loadingInit = false;
            // 后台加载卡片列表
            this.loadCards();
            return;
          }
        } catch { /* server not ready */ }
        // 会话过期
        localStorage.removeItem("rp-session");
      }
      this.loadingInit = false;
      await this.loadCards();
    },

    // ---- 恢复历史消息 ----
    restoreHistory(history) {
      if (!history || history.length === 0) return;
      this.messages = [];
      for (const entry of history) {
        if (entry.startsWith("user: ")) {
          this.messages.push({ type: "user", text: entry.slice(6) });
        } else if (entry.startsWith("assistant: ")) {
          this.messages.push({ type: "assistant", text: entry.slice(11) });
        } else if (entry.startsWith("system: ")) {
          this.messages.push({ type: "system", text: entry.slice(8) });
        } else {
          this.messages.push({ type: "system", text: entry });
        }
      }
    },

    // ---- 加载卡片 ----
    async loadCards() {
      this.loadingCards = true;
      try {
        const r = await fetch("/cards");
        if (r.ok) this.cards = await r.json();
      } catch { /* ignore */ }
      this.loadingCards = false;
    },

    // ---- 选择卡片 ----
    async selectCard(cardId) {
      this.loading = true;
      try {
        const r = await fetch("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId }),
        });
        const d = await r.json();
        if (!r.ok) {
          this.pushMsg("error", d.error || "创建会话失败");
          return;
        }
        this.sessionId = d.sessionId;
        this.selectedCardId = d.cardId;
        this.cardName = d.cardName || d.cardId;
        localStorage.setItem("rp-session", this.sessionId);
        this.messages = [];
        this.pushMsg("system", "已加载角色卡: " + this.cardName);
        this.pushMsg("system", "Session: " + this.sessionId);
        this.activeTab = "status";
        this.refreshStatus();
      } catch (err) {
        this.pushMsg("error", err.message);
      } finally {
        this.loading = false;
      }
    },

    // ---- 加载历史会话 ----
    async loadSessions() {
      try {
        const r = await fetch("/sessions");
        if (!r.ok) return;
        const ids = await r.json();
        const list = [];
        for (const id of ids) {
          const sr = await fetch("/session/" + id);
          if (!sr.ok) continue;
          const sd = await sr.json();
          list.push({
            id: sd.sessionId,
            preview: this.getSessionPreview(sd.history),
            turns: sd.historyCount || sd.history?.length || 0,
            date: this.formatDate(sd.startedAt || sd.sessionId),
          });
        }
        this.allSessions = list;
        this.filterSessions();
      } catch { /* ignore */ }
    },

    getSessionPreview(history) {
      if (!history || history.length === 0) return "";
      for (const entry of history) {
        if (entry.startsWith("user: ")) return entry.slice(6);
      }
      return history[history.length - 1] || "";
    },

    formatDate(id) {
      // Try to extract timestamp from session ID
      const ts = parseInt(id.replace(/[^0-9]/g, ""));
      if (!ts || ts < 1e12) return "";
      const d = new Date(ts);
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return Math.floor(diff / 60000) + "分钟前";
      if (diff < 86400000) return Math.floor(diff / 3600000) + "小时前";
      if (diff < 604800000) return Math.floor(diff / 86400000) + "天前";
      return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
    },

    filterSessions() {
      const q = this.sessionSearch.toLowerCase().trim();
      if (!q) {
        this.filteredSessions = [...this.allSessions];
        return;
      }
      this.filteredSessions = this.allSessions.filter(
        (s) => s.preview.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
      );
    },

    // ---- 加载会话到聊天 ----
    async loadSession(sid) {
      if (sid === this.sessionId) return;
      this.loading = true;
      try {
        // 如果当前有 session，先创建新 session 再加载历史
        if (this.sessionId && this.selectedCardId) {
          const r = await fetch("/session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ cardId: this.selectedCardId }),
          });
          if (!r.ok) throw new Error("创建会话失败");
          const d = await r.json();
          this.sessionId = d.sessionId;
          localStorage.setItem("rp-session", this.sessionId);
          this.messages = [];
        }

        // 加载目标 session 的历史到当前 session
        const r = await fetch("/session/" + sid);
        if (!r.ok) throw new Error("加载会话失败");
        const d = await r.json();

        // 通过发送消息逐个重新注入历史
        this.pushMsg("system", "已加载会话: " + sid.slice(0, 22));
        this.restoreHistory(d.history || []);
        this.applyStatus(d);
        this.activeTab = "status";
      } catch (err) {
        this.pushMsg("error", err.message);
      } finally {
        this.loading = false;
      }
    },

    // ---- 删除会话 ----
    async deleteSession(sid) {
      if (!confirm("确定删除会话 " + sid.slice(0, 18) + "？")) return;
      try {
        await fetch("/session/" + sid, { method: "DELETE" });
        this.allSessions = this.allSessions.filter((s) => s.id !== sid);
        this.filterSessions();
        if (sid === this.sessionId) this.newSession();
      } catch { /* ignore */ }
    },

    // ---- 发送消息 ----
    async send() {
      const text = this.input.trim();
      if (!text || !this.sessionId) return;
      this.input = "";

      if (text.startsWith("/")) {
        if (text === "/new") { this.newSession(); return; }
        if (text === "/clear") { this.clearMessages(); return; }
        this.pushMsg("cmd", text);
        await this.execCommand(text);
        return;
      }

      this.pushMsg("user", text);
      this.loading = true;
      this.statusText = "thinking...";
      this.statusDot = "pulse";
      this.phase = "thinking";

      try {
        const r = await fetch("/session/" + this.sessionId + "/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (!r.ok) throw new Error(r.status + ": " + (await r.text()));

        const d = await r.json();
        this.pushMsg("assistant", d.display || "[ok] prompt=" + (d.prompt || "").length + "c");

        if (d.worldbookTriggered?.length) {
          this.pushMsg("system", "触发世界书: " + d.worldbookTriggered.map((w) => w.name).join(", "));
        }
        for (const a of d.agentActions || []) {
          this.pushMsg("system", a.type + ": " + a.description);
        }

        this.historyCount = d.turn || 0;
        this.tokens = (d.prompt || "").length + (d.display || "").length;
        this.nodeCount = d.nodeCount || 0;
        this.degraded = d.degraded ? "yes" : "no";
        this.statusText = "ready";
        this.statusDot = "";
        this.phase = "ready";
      } catch (err) {
        this.pushMsg("error", err.message);
        this.statusText = "error";
        this.statusDot = "off";
        this.phase = "idle";
      } finally {
        this.loading = false;
      }
    },

    // ---- 执行命令 ----
    async execCommand(text) {
      try {
        const r = await fetch("/session/" + this.sessionId + "/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        if (!r.ok) throw new Error(r.status);
        const d = await r.json();
        const result = d.display || d.prompt || "ok";
        this.pushMsg("cmd", result.length > 500 ? result.slice(0, 500) + "..." : result);
        this.refreshStatus();
      } catch (err) {
        this.pushMsg("error", "Command: " + err.message);
      }
    },

    // ---- 插入快捷命令 ----
    insertCmd(cmd) {
      this.input = cmd + " ";
      this.$nextTick(() => {
        const input = document.querySelector(".input-row input");
        if (input) { input.focus(); input.setSelectionRange(cmd.length + 1, cmd.length + 1); }
      });
    },

    // ---- 消息渲染 ----
    renderMsg(msg) {
      // Escape HTML
      const esc = (s) => {
        const d = document.createElement("div");
        d.textContent = s || "";
        return d.innerHTML;
      };
      let html = esc(msg.text);
      // Simple markdown for code blocks
      html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
      // Links
      html = html.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      return html;
    },

    // ---- 消息队列 ----
    pushMsg(type, text) {
      this.messages.push({ type, text });
      this.$nextTick(() => {
        const el = this.$refs.messages;
        if (el) el.scrollTop = el.scrollHeight;
      });
    },

    // ---- 刷新状态 ----
    async refreshStatus() {
      if (!this.sessionId) return;
      try {
        const r = await fetch("/session/" + this.sessionId);
        if (!r.ok) return;
        this.applyStatus(await r.json());
      } catch { /* ignore */ }
    },

    applyStatus(d) {
      this.historyCount = d.historyCount ?? this.historyCount;
      this.phase = d.phase ?? this.phase;
      this.activeCards = d.activeCards ?? this.activeCards;
      this.nodeCount = d.nodeCount ?? this.nodeCount;
      this.degraded = d.degradationApplied ? "yes" : "no";
      if (d.cardName) this.cardName = d.cardName;
    },

    // ---- 操作 ----
    newSession() {
      localStorage.removeItem("rp-session");
      this.sessionId = "";
      this.selectedCardId = "";
      this.cardName = "";
      this.messages = [];
      this.historyCount = 0;
      this.phase = "idle";
      this.activeCards = 0;
      this.nodeCount = 0;
      this.degraded = "no";
      this.tokens = 0;
      this.loadCards();
    },

    clearMessages() {
      this.messages = [];
      this.pushMsg("system", "对话已清空，session 仍在");
    },

    closeAllPanels() {
      // Close any open overlays (ESC key)
    },
  }));
});