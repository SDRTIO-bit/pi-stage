// ============================================================
// pi rp-engine — Console UI (Alpine.js)
// ============================================================

document.addEventListener("alpine:init", () => {
  Alpine.data("chat", () => ({
    input: "",
    messages: [],
    loading: false,
    loadingCards: false,
    sidebarCollapsed: false,

    // Session
    sessionId: localStorage.getItem("rp-session") || "",
    get shortId() {
      return this.sessionId.slice(0, 18) || "—"
    },

    // Card
    cards: [],
    cardName: "",
    selectedCardId: "",

    // Status
    historyCount: 0,
    phase: "idle",
    activeCards: 0,
    nodeCount: 0,
    degraded: "no",
    tokens: 0,
    statusText: "engine ready",
    statusDot: "pulse",

    // ===== Init =====
    async ensureSession() {
      if (this.sessionId) {
        try {
          const r = await fetch(`/session/${this.sessionId}`)
          if (r.ok) {
            const d = await r.json()
            if (d.cardId) {
              this.selectedCardId = d.cardId
              this.cardName = d.cardName || d.cardId
            }
            // 从 history[] 恢复对话消息
            const history = d.history || []
            if (history.length > 0 && this.messages.length === 0) {
              for (const entry of history) {
                if (entry.startsWith("user: ")) {
                  this.messages.push({ type: "user", text: entry.slice(6) })
                } else if (entry.startsWith("system: ")) {
                  this.messages.push({ type: "system", text: entry.slice(8) })
                } else {
                  this.messages.push({ type: "system", text: entry })
                }
              }
            }
            this.refreshStatus()
            return
          }
        } catch { /* server not ready */ }
        // session expired — clear and show card selection
        localStorage.removeItem("rp-session")
        this.sessionId = ""
      }
      // No session — show card selection
      await this.loadCards()
    },

    async loadCards() {
      this.loadingCards = true
      try {
        const r = await fetch("/cards")
        if (r.ok) this.cards = await r.json()
      } catch { /* server not ready */ }
      this.loadingCards = false
    },

    // ===== Card Selection =====
    async selectCard(cardId) {
      this.loading = true
      try {
        const r = await fetch("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cardId }),
        })
        const d = await r.json()
        if (!r.ok) {
          this.pushMsg("error", d.error || "Failed to create session")
          return
        }
        this.sessionId = d.sessionId
        this.selectedCardId = d.cardId
        this.cardName = d.cardName || d.cardId
        localStorage.setItem("rp-session", this.sessionId)
        this.pushMsg("system", `已加载角色卡: ${this.cardName}`)
        this.pushMsg("system", `Session: ${this.sessionId}`)
        this.refreshStatus()
      } catch (err) {
        this.pushMsg("error", err.message)
      } finally {
        this.loading = false
      }
    },

    // ===== Send =====
    async send() {
      const text = this.input.trim()
      if (!text) return
      this.input = ""

      if (!this.sessionId) return

      if (text.startsWith("/")) {
        this.pushMsg("cmd", text)
        await this.execCommand(text)
        return
      }

      this.pushMsg("user", text)
      this.loading = true
      this.statusText = "thinking..."
      this.statusDot = "pulse"

      try {
        const r = await fetch(`/session/${this.sessionId}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        })
        if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
        const d = await r.json()

        this.pushMsg("assistant", `[ok] prompt=${(d.prompt || "").length}c display=${(d.display || "").length}c`)
        if (d.worldbookTriggered?.length) {
          this.pushMsg("system", `世界书触发: ${d.worldbookTriggered.map(w => w.name).join(", ")}`)
        }
        for (const a of (d.agentActions || [])) {
          this.pushMsg("system", `Agent: ${a.description}`)
        }
        this.historyCount = d.turn || 0
        this.tokens = (d.prompt || "").length + (d.display || "").length
        this.nodeCount = d.nodeCount || 0
        this.degraded = d.degraded ? "yes" : "no"
        this.statusText = "ready"
        this.statusDot = ""
        this.refreshStatus()
      } catch (err) {
        this.pushMsg("error", err.message)
        this.statusText = "error"
        this.statusDot = "off"
      } finally {
        this.loading = false
      }
    },

    // ===== Command =====
    async execCommand(text) {
      try {
        const r = await fetch(`/session/${this.sessionId}/turn`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        })
        if (!r.ok) throw new Error(`${r.status}`)
        const d = await r.json()
        this.pushMsg("cmd", d.prompt || d.display || "ok")
        this.refreshStatus()
      } catch (err) {
        this.pushMsg("error", `Command: ${err.message}`)
      }
    },

    // ===== Messages =====
    pushMsg(type, text) {
      this.messages.push({ type, text })
      this.$nextTick(() => {
        const el = this.$refs.messages
        if (el) el.scrollTop = el.scrollHeight
      })
    },

    // ===== Status =====
    async refreshStatus() {
      if (!this.sessionId) return
      try {
        const r = await fetch(`/session/${this.sessionId}`)
        if (!r.ok) return
        const d = await r.json()
        this.historyCount = d.historyCount ?? 0
        this.phase = d.phase ?? "—"
        this.activeCards = d.activeCards ?? 0
        this.nodeCount = d.nodeCount ?? 0
        this.degraded = d.degradationApplied ? "yes" : "no"
        if (d.cardName) this.cardName = d.cardName
      } catch { /* ignore */ }
    },

    // ===== Actions =====
    newSession() {
      localStorage.removeItem("rp-session")
      this.sessionId = ""
      this.selectedCardId = ""
      this.cardName = ""
      this.messages = []
      this.historyCount = 0
      this.phase = "idle"
      this.activeCards = 0
      this.nodeCount = 0
      this.degraded = "no"
      this.tokens = 0
      this.loadCards()
    },

    clearMessages() {
      this.messages = []
      this.pushMsg("system", "对话已清空，session 仍在")
    },
  }))
})
