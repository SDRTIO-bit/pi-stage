/**
 * RP Web Settings — 设置面板
 *
 * 功能：
 * - Web 端修改 RP_AUTHOR_NOTE（通过 WebSocket 发送到后端）
 * - 显示当前上下文使用率估算（当前 token / 模型上限）
 * - 基础框架，后续可扩展更多设置项
 */

/**
 * 创建设置面板管理器
 * @param {Object} deps - 依赖注入
 * @param {Function} deps.sendCommand - WebSocket 发送命令函数
 * @param {Function} deps.getState - 获取 RPStateManager 实例的函数
 */
export function createSettingsPanel(deps = {}) {
  const { sendCommand, getState } = deps;

  // ============================================================
  // DOM 元素
  // ============================================================

  /** @type {HTMLElement|null} */
  let overlay = null;

  /** @type {HTMLElement|null} */
  let panel = null;

  /** @type {HTMLTextAreaElement|null} */
  let authorNoteInput = null;

  /** @type {HTMLElement|null} */
  let contextUsageEl = null;

  /** @type {boolean} */
  let isOpen = false;

  // ============================================================
  // 初始化：动态创建 DOM
  // ============================================================

  function init() {
    // 创建 overlay
    overlay = document.createElement('div');
    overlay.className = 'rp-settings-overlay';
    overlay.style.cssText = `
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.45);
      z-index: 1100;
      justify-content: center;
      align-items: center;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    `;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // 创建面板
    panel = document.createElement('div');
    panel.className = 'rp-settings-panel';
    panel.style.cssText = `
      background: #1a1a2e;
      border: 1px solid #0f3460;
      border-radius: 12px;
      max-width: 480px;
      width: 92%;
      max-height: 80vh;
      overflow-y: auto;
      padding: 20px;
      color: #e0e0e0;
      position: relative;
    `;

    // 标题栏
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      border-bottom: 1px solid #0f3460;
      padding-bottom: 10px;
    `;
    header.innerHTML = `
      <span style="font-size:16px;font-weight:bold;color:#aaccff;">⚙️ RP 设置</span>
      <button class="rp-settings-close" style="background:none;border:none;color:#7a9bcb;font-size:18px;cursor:pointer;">✕</button>
    `;
    header.querySelector('.rp-settings-close').addEventListener('click', close);
    panel.appendChild(header);

    // ===== Author Note 编辑区 =====
    const anSection = document.createElement('div');
    anSection.style.cssText = 'margin-bottom: 16px;';
    anSection.innerHTML = `
      <div style="font-size:11px;color:#7a9bcb;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
        📝 Author Note（作者注）
      </div>
      <div style="font-size:11px;color:#556688;margin-bottom:6px;">
        每轮对话自动注入到 AI 上下文，用于维持输出质量。修改后即时生效。
      </div>
    `;

    authorNoteInput = document.createElement('textarea');
    authorNoteInput.style.cssText = `
      width: 100%;
      min-height: 80px;
      background: #0d1b2a;
      border: 1px solid #0f3460;
      color: #c0d8f0;
      padding: 10px;
      font-family: 'Consolas', monospace;
      font-size: 12px;
      resize: vertical;
      border-radius: 6px;
    `;
    authorNoteInput.placeholder = '[系统指令：请以角色的身份，保持生动详细的描写，关注角色心理活动。回复长度应在800-1200字之间。]';
    anSection.appendChild(authorNoteInput);

    // 操作按钮行
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    btnRow.innerHTML = `
      <button class="rp-an-save" style="background:#0f3460;border:1px solid #1a5276;color:#fff;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;">💾 保存</button>
      <button class="rp-an-reset" style="background:transparent;border:1px solid #0f3460;color:#7a9bcb;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:12px;">↺ 重置</button>
    `;
    btnRow.querySelector('.rp-an-save').addEventListener('click', saveAuthorNote);
    btnRow.querySelector('.rp-an-reset').addEventListener('click', resetAuthorNote);
    anSection.appendChild(btnRow);

    panel.appendChild(anSection);

    // ===== 上下文使用率 =====
    const ctxSection = document.createElement('div');
    ctxSection.style.cssText = 'margin-bottom: 12px;';
    ctxSection.innerHTML = `
      <div style="font-size:11px;color:#7a9bcb;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">
        📊 上下文使用率
      </div>
    `;

    contextUsageEl = document.createElement('div');
    contextUsageEl.style.cssText = `
      background: #0d1b2a;
      border: 1px solid #0f3460;
      border-radius: 6px;
      padding: 12px;
    `;
    contextUsageEl.innerHTML = renderContextBar(0, 128000, 0);
    ctxSection.appendChild(contextUsageEl);

    panel.appendChild(ctxSection);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  // ============================================================
  // Author Note 操作
  // ============================================================

  function saveAuthorNote() {
    const text = authorNoteInput?.value?.trim();
    if (!text) return;
    sendCommand('set_author_note', { text });
    // 视觉反馈
    const btn = panel?.querySelector('.rp-an-save');
    if (btn) {
      const orig = btn.textContent;
      btn.textContent = '✅ 已保存';
      btn.style.background = '#1a5a2a';
      setTimeout(() => {
        btn.textContent = orig;
        btn.style.background = '#0f3460';
      }, 1500);
    }
  }

  function resetAuthorNote() {
    sendCommand('reset_author_note');
    if (authorNoteInput) {
      authorNoteInput.value = '';
      authorNoteInput.placeholder = '已重置为默认值';
    }
  }

  /**
   * 设置 Author Note 输入框的值（从后端回显）
   */
  function setAuthorNoteValue(text) {
    if (authorNoteInput && text) {
      authorNoteInput.value = text;
    }
  }

  // ============================================================
  // 上下文使用率渲染
  // ============================================================

  function renderContextBar(used, max, percent) {
    const ratio = max > 0 ? Math.min(100, Math.max(0, (used / max) * 100)) : 0;
    const color = ratio > 80 ? '#f87171' : ratio > 50 ? '#fbbf24' : '#34d399';
    const label = max > 0
      ? `${(used / 1000).toFixed(0)}K / ${(max / 1000).toFixed(0)}K`
      : '未获取';

    return `
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:11px;">
        <span style="color:#7a9bcb;">已使用</span>
        <span style="color:#c0d8f0;font-family:monospace;">${label}</span>
      </div>
      <div style="width:100%;height:8px;background:#0f1828;border-radius:4px;overflow:hidden;border:1px solid #0f3460;">
        <div style="width:${ratio}%;height:100%;background:${color};transition:width 0.5s;border-radius:3px;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:#556688;">
        <span>${ratio.toFixed(1)}%</span>
        <span>${ratio > 80 ? '⚠️ 接近上限' : ratio > 50 ? '⚡ 注意用量' : '✅ 充足'}</span>
      </div>
    `;
  }

  function updateContextDisplay() {
    if (!contextUsageEl) return;
    const state = getState?.();
    const ctx = state?.getContext?.() || {};
    const used = ctx.totalTokens || 0;
    const max = ctx.maxTokens || 128000;
    const percent = max > 0 ? (used / max) * 100 : 0;
    contextUsageEl.innerHTML = renderContextBar(used, max, percent);
  }

  // ============================================================
  // 打开/关闭
  // ============================================================

  function open() {
    if (!overlay) init();
    isOpen = true;
    overlay.style.display = 'flex';
    updateContextDisplay();
  }

  function close() {
    isOpen = false;
    if (overlay) overlay.style.display = 'none';
  }

  function toggle() {
    isOpen ? close() : open();
  }

  // 延迟初始化，避免在 DOM 未就绪时创建
  function ensureInit() {
    if (!overlay) init();
  }

  return {
    open,
    close,
    toggle,
    ensureInit,
    setAuthorNoteValue,
    updateContextDisplay,
    get isOpen() { return isOpen; },
  };
}
