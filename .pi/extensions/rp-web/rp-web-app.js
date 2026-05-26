/**
 * RP Web App - 乐园回响角色扮演专用 Web 前端
 *
 * 全部数据驱动：角色列表、属性表、状态面板均从 state.json 动态生成，
 * 不硬编码任何角色名或属性名。
 */

import { MessageRenderer } from './rp-web-message-renderer.js';
import { RPStateManager } from './rp-web-state.js';
import { createSettingsPanel } from './rp-web-settings.js';

// ============================================================
// 全局实例
// ============================================================

const rpState = new RPStateManager();

// ============================================================
// WebSocket 连接
// ============================================================

const rpToken = window.RP_TOKEN || '';
const wsUrl = rpToken
  ? `ws://${window.location.host}/ws?token=${encodeURIComponent(rpToken)}`
  : `ws://${window.location.host}/ws`;
let ws = null;
let reconnectTimer = null;
let isConnected = false;

const messageRenderer = new MessageRenderer(document.getElementById('messages'));

// UI elements
const messageInput = document.getElementById('message-input');
const chatForm = document.getElementById('chat-form');
const sendBtn = document.getElementById('send-btn');
const abortBtn = document.getElementById('abort-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');

// RP 模式
const rpModeBtn = document.getElementById('rp-mode-btn');
const rpStatusBtn = document.getElementById('rp-status-btn');
const rpStatusOverlay = document.getElementById('rp-status-overlay');
const rpStatusClose = document.getElementById('rp-status-close');
const rpStatusContent = document.getElementById('rp-status-content');

// 设置面板按钮
const rpSettingsBtn = document.getElementById('rp-settings-btn');

let rpMode = true;
let currentStreamingElement = null;
let currentStreamingText = '';
let hasShownPicker = false;
let cardPickerShown = false;
let selectedCardIds = [];  // 用户在卡片选择器中选中的卡片 id
let currentActiveCards = []; // 服务端返回的当前激活卡片

// ============================================================
// 代码片段存储
// ============================================================

const DEFAULT_SNIPPETS = [
  { label: '📊 角色状态', code: '/status' },
  { label: '📋 变更历史', code: '/history' },
  { label: 'ℹ️ RP帮助', code: '/rp' },
  { label: '🗺 查看路线', code: '/route' },
  { label: '🛤 选择路线', code: '/route' },
  { label: '🎭 卡片列表', code: '/card list' },
  { label: '🗜 压缩上下文', code: '/compact' },
  { label: '🌲 分支管理', code: '/tree' },
];

function loadSnippets() {
  try {
    const saved = localStorage.getItem('rp_snippets');
    if (saved) return JSON.parse(saved);
  } catch {}
  return [...DEFAULT_SNIPPETS];
}

function saveSnippets(snippets) {
  try {
    localStorage.setItem('rp_snippets', JSON.stringify(snippets));
  } catch {}
}

let currentSnippets = loadSnippets();

// ============================================================
// 设置面板
// ============================================================

const settingsPanel = createSettingsPanel({
  sendCommand,
  getState: () => rpState,
});

// 注册状态监听，自动更新上下文显示
rpState.addListener(() => {
  settingsPanel.updateContextDisplay();
});

// ============================================================
// 会话选择器
// ============================================================

const sessionPickerOverlay = document.getElementById('session-picker-overlay');
const sessionPickerList = document.getElementById('session-picker-list');
const sessionPickerNew = document.getElementById('session-picker-new');

function showSessionPicker() {
  sessionPickerOverlay.classList.add('open');
  sessionPickerList.innerHTML = '<div style="text-align:center;padding:20px;color:#8899bb;">加载中...</div>';
  sendCommand('list_sessions');
}

function hideSessionPicker() {
  sessionPickerOverlay.classList.remove('open');
}

function renderSessionPicker(sessions) {
  if (!sessions || sessions.length === 0) {
    sessionPickerList.innerHTML = '<div style="text-align:center;padding:30px;color:#8899bb;">暂无历史会话，点击下方按钮开始新会话</div>';
    return;
  }
  let html = '';
  for (const s of sessions) {
    const date = new Date(s.mtime).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const preview = s.preview ? s.preview.slice(0, 60) : '(空)';
    // 从 file 路径提取卡片目录名（如 "桃花村的公媳/rp-xxx.jsonl" → "桃花村的公媳"）
    const parts = s.file.split('/');
    const cardLabel = parts.length > 1 ? parts[0] : '';
    html += `<button class="session-picker-item" data-file="${escapeHtmlAttr(s.file)}">
      <span class="sp-date">${escapeHtml(date)}</span>
      ${cardLabel ? `<span class="sp-card">${escapeHtml(cardLabel)}</span>` : ''}
      <span class="sp-preview">${escapeHtml(preview)}</span>
      <span class="sp-size">${(s.size / 1024).toFixed(0)}KB</span>
    </button>`;
  }
  sessionPickerList.innerHTML = html;

  document.querySelectorAll('.session-picker-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const file = btn.dataset.file;
      hideSessionPicker();
      sendCommand('load_session', { file });
    });
  });
}

// ============================================================
// 卡片选择器
// ============================================================

const cardPickerOverlay = document.getElementById('card-picker-overlay');
const cardPickerList = document.getElementById('card-picker-list');
const cardPickerConfirm = document.getElementById('card-picker-confirm');

function showCardPicker() {
  cardPickerOverlay.classList.add('open');
  cardPickerList.innerHTML = '<div style="text-align:center;padding:20px;color:#8899bb;">加载中...</div>';
  sendCommand('list_cards');
}

function hideCardPicker() {
  cardPickerOverlay.classList.remove('open');
}

function renderCardPicker(cards, activeIds) {
  if (!cards || cards.length === 0) {
    cardPickerList.innerHTML = '<div style="text-align:center;padding:30px;color:#8899bb;">暂无角色卡。<br/>请使用 setup.mjs 导入角色卡。</div>';
    return;
  }

  // 自动显示卡片选择器
  if (!cardPickerShown) {
    cardPickerShown = true;
    showCardPicker();
  }

  let html = '';
  for (const card of cards) {
    const checked = selectedCardIds.includes(card.id) ? 'checked' : '';
    const activeMark = card.active ? ' 🟢' : '';
    html += `<label class="session-picker-item" style="cursor:pointer;align-items:flex-start;">
      <input type="checkbox" class="card-checkbox" data-card-id="${escapeHtmlAttr(card.id)}" ${checked} style="margin-top:3px;flex-shrink:0;">
      <div style="flex:1;">
        <div style="font-weight:bold;color:#e0e8f0;">${escapeHtml(card.name)}${activeMark}</div>
        <div style="font-size:11px;color:#556688;">${escapeHtml(card.id)} · ${escapeHtml(card.importedAt ? new Date(card.importedAt).toLocaleDateString('zh-CN') : '')}</div>
      </div>
    </label>`;
  }
  cardPickerList.innerHTML = html;

  // 绑定 checkbox 事件
  document.querySelectorAll('.card-checkbox').forEach(cb => {
    cb.addEventListener('change', () => {
      const cardId = cb.dataset.cardId;
      if (cb.checked) {
        if (!selectedCardIds.includes(cardId)) selectedCardIds.push(cardId);
      } else {
        selectedCardIds = selectedCardIds.filter(id => id !== cardId);
      }
    });
  });
}

// 确认选择按钮
cardPickerConfirm.addEventListener('click', () => {
  if (selectedCardIds.length === 0) {
    alert('请至少选择一张角色卡');
    return;
  }
  // 检查是否与当前激活不同
  const same = selectedCardIds.length === currentActiveCards.length &&
    selectedCardIds.every(id => currentActiveCards.includes(id));
  if (same) {
    hideCardPicker();
    if (!hasShownPicker) {
      hasShownPicker = true;
      showSessionPicker();
    }
    return;
  }
  sendCommand('activate_cards', { cardIds: selectedCardIds });
});

// 卡片按钮
const rpCardsBtn = document.getElementById('rp-cards-btn');
if (rpCardsBtn) {
  rpCardsBtn.addEventListener('click', showCardPicker);
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function escapeHtmlAttr(text) {
  return String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ============================================================
// WebSocket
// ============================================================

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    isConnected = true;
    statusIndicator.style.background = '#4caf50';
    statusText.textContent = 'Connected';
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // 先请求卡片列表
    sendCommand('list_cards');
    // 主动请求 state.json
    sendCommand('get_rp_state');
    sendCommand('mirror_sync_request');
    // 加载 APPEND_SYSTEM.md
    sendCommand('get_append_system');
  };

  ws.onclose = () => {
    isConnected = false;
    statusIndicator.style.background = '#f44336';
    statusText.textContent = 'Disconnected';
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };

  ws.onerror = () => {
    statusIndicator.style.background = '#ff9800';
    statusText.textContent = 'Error';
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };
}

function sendCommand(type, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...extra }));
}

// ============================================================
// 消息处理
// ============================================================

function handleMessage(msg) {
  switch (msg.type) {
    case 'mirror_sync':
      handleMirrorSync(msg);
      break;
    case 'event':
      handleRPCEvent(msg.event);
      break;
    case 'response':
      handleResponse(msg);
      break;
    case 'rp_state':
      handleRPState(msg);
      break;
    case 'card_list':
      currentActiveCards = msg.activeIds || [];
      selectedCardIds = [...currentActiveCards];
      renderCardPicker(msg.cards, msg.activeIds);
      break;
    case 'cards_activated':
      currentActiveCards = msg.cardIds || [];
      selectedCardIds = [...currentActiveCards];
      hideCardPicker();
      console.log('[RP] 卡片已切换:', msg.names?.join(', '));
      if (msg.needRestart) {
        // 提示用户刷新页面
        const welcome = document.querySelector('.welcome');
        if (welcome) {
          welcome.innerHTML = `<p>✅ 卡片已切换: ${(msg.names || []).join('、')}</p>
            <p class="hint">⚠️ 请刷新页面以使世界书和状态生效（F5 或 Ctrl+R）</p>`;
        }
      }
      break;
    case 'sessions_list':
      renderSessionPicker(msg.sessions);
      break;
    case 'new_session_started':
      messageRenderer.clear();
      messageRenderer.renderWelcome();
      break;
    case 'load_session_entries':
      messageRenderer.clear();
      if (msg.entries && Array.isArray(msg.entries)) {
        for (const entry of msg.entries) {
          if (entry.message) {
            const m = entry.message;
            if (m.role === 'user') {
              messageRenderer.renderUserMessage(m, true);
            } else if (m.role === 'assistant') {
              messageRenderer.renderAssistantMessage(m, false, true);
            }
          }
        }
      }
      hideSessionPicker();
      break;
    case 'regex_hooks':
      // 接收服务端下发的正则渲染钩子，注入到 messageRenderer
      if (msg.hooks && Array.isArray(msg.hooks)) {
        messageRenderer.setRegexHooks(msg.hooks);
        console.log('[RP] 渲染钩子已加载:', msg.hooks.length, '条');
      }
      break;
    case 'card_ui':
      // 接收服务端下发的卡片 UI 组件，动态加载 CSS/JS
      loadCardUI(msg.cardId, msg.files);
      break;
    case 'author_note_updated':
      if (msg.text !== undefined) {
        settingsPanel.setAuthorNoteValue(msg.text);
      }
      break;
    case 'append_system_content':
      // 服务端返回 APPEND_SYSTEM.md 内容
      if (msg.content !== undefined) {
        appendStyleContent = msg.content;
        console.log('[RP] APPEND_SYSTEM.md 已加载，共', msg.content.length, '字符');
        // 如果启用了自动附加，在状态栏显示标记
        if (appendStyleEnabled) {
          const indicator = document.getElementById('append-style-indicator');
          if (indicator) indicator.style.display = 'inline-flex';
        }
      }
      break;
    case 'system_event':
      // 来自 tavern_helper 脚本的系统事件（状态变化通知等）
      if (msg.text) {
        messageRenderer.renderSystemMessage(msg.text);
      }
      break;
    case 'context_info':
      rpState.updateContext({
        totalTokens: msg.totalTokens || 0,
        maxTokens: msg.maxTokens || 128000,
        usagePercent: msg.usagePercent || 0,
      });
      break;
    default:
      console.log('Unknown message type:', msg.type);
  }
}

function handleMirrorSync(data) {
  if (data.entries && Array.isArray(data.entries)) {
    messageRenderer.clear();
    let hasMessages = false;
    for (const entry of data.entries) {
      if (entry.type === 'message' && entry.message) {
        const msg = entry.message;
        if (msg.role === 'user') {
          messageRenderer.renderUserMessage(msg, true);
          hasMessages = true;
        } else if (msg.role === 'assistant') {
          messageRenderer.renderAssistantMessage(msg, false, true);
          hasMessages = true;
        }
      }
    }
    if (!hasMessages) {
      messageRenderer.renderWelcome();
    }
  }

  if (data.model) {
    const label = document.getElementById('model-dropdown-label');
    if (label) label.textContent = data.model.id || data.model;
  }

  isStreaming = data.isStreaming || false;
  updateUI();
}

function handleRPCEvent(event) {
  switch (event.type) {
    case 'agent_start':
      isStreaming = true;
      updateUI();
      break;
    case 'agent_end':
      isStreaming = false;
      currentStreamingElement = null;
      currentStreamingText = '';
      updateUI();
      break;
    case 'message_start':
      handleMessageStart(event.message);
      break;
    case 'message_update':
      handleMessageUpdate(event);
      break;
    case 'message_end':
      handleMessageEnd(event.message);
      break;
    case 'session_name':
      if (event.name) document.title = event.name + ' · RP';
      break;
  }
}

function handleMessageStart(message) {
  if (message.role === 'assistant') {
    currentStreamingText = '';
    currentStreamingElement = messageRenderer.renderAssistantMessage(
      { content: '' },
      true
    );
  } else if (message.role === 'user') {
    const text = getMessageText(message);
    // 过滤系统 steer 消息（以 [系统 · 开头），不渲染到前端
    if (text && !text.startsWith('[系统 ·')) {
      messageRenderer.renderUserMessage({ content: text });
    }
  }
}

function getMessageText(message) {
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else if (Array.isArray(message.content)) {
    text = message.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  // 剥离 APPEND_SYSTEM 附加的规范内容（前端不可见）
  // 规范内容以 '---\n[系统风格规范]' 标记开头，拼在消息末尾
  const styleMarker = '---\n[系统风格规范]';
  const idx = text.lastIndexOf(styleMarker);
  if (idx !== -1) {
    text = text.substring(0, idx).replace(/\n+$/, '');
  }
  return text;
}

function handleMessageUpdate(event) {
  const { assistantMessageEvent } = event;
  if (assistantMessageEvent.type === 'text_delta' && currentStreamingElement) {
    currentStreamingText += assistantMessageEvent.delta;
    messageRenderer.updateStreamingMessage(currentStreamingElement, currentStreamingText);
  }
}

function handleMessageEnd(message) {
  if (currentStreamingElement) {
    messageRenderer.finalizeStreamingMessage(currentStreamingElement, message?.usage, '');
    currentStreamingElement = null;
  }
}

function handleResponse(msg) {
  console.log('RPC response:', msg);
}

function handleRPState(msg) {
  const data = msg.data;
  if (!data) {
    rpStatusContent.innerHTML = '<div style="text-align:center;padding:20px;color:#888;">暂无角色数据</div>';
    return;
  }

  // 暴露到全局，供卡片 UI 组件读取
  window.__rpState = data;

  // 加载到 RPStateManager
  rpState.loadState(data);

  // 渲染状态面板
  renderStatusPanel();

  // 通知所有卡片 UI 组件更新
  updateCardUIs(data);
}

/** 通知所有已加载的卡片 UI 组件更新数据 */
function updateCardUIs(newState) {
  if (!window.__cardUI) return;
  for (const [cardId, ui] of Object.entries(window.__cardUI)) {
    if (typeof ui.update === 'function') {
      try { ui.update(newState); } catch {}
    }
  }
}

// ============================================================
// 代码片段面板
// ============================================================

const snippetOverlay = document.getElementById('snippet-overlay');
const snippetClose = document.getElementById('snippet-close');
const snippetPresets = document.getElementById('snippet-presets');
const snippetNewLabel = document.getElementById('snippet-new-label');
const snippetNewCode = document.getElementById('snippet-new-code');
const snippetAddBtn = document.getElementById('snippet-add-btn');
const snippetResetBtn = document.getElementById('snippet-reset-btn');
const snippetResult = document.getElementById('snippet-result');

function renderSnippets() {
  if (!snippetPresets) return;
  let html = '';
  for (let i = 0; i < currentSnippets.length; i++) {
    const s = currentSnippets[i];
    html += `<button class="rp-term-cmd snippet-btn" data-idx="${i}" title="${escapeHtmlAttr(s.code)}">${escapeHtml(s.label)}</button>`;
  }
  snippetPresets.innerHTML = html;

  // 绑定点击事件
  document.querySelectorAll('.snippet-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx);
      const snippet = currentSnippets[idx];
      if (snippet) {
        execSnippet(snippet);
      }
    });
    // 右键删除
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const idx = parseInt(btn.dataset.idx);
      if (confirm(`删除片段 "${currentSnippets[idx].label}"？`)) {
        currentSnippets.splice(idx, 1);
        saveSnippets(currentSnippets);
        renderSnippets();
        snippetResult.textContent = '✅ 已删除';
      }
    });
  });
}

function execSnippet(snippet) {
  const code = snippet.code.trim();
  if (!code) return;
  snippetResult.textContent = '执行中: ' + snippet.label;

  if (code.startsWith('/')) {
    // 斜杠命令：放到主输入框执行
    messageInput.value = code;
    messageInput.focus();
    messageInput.dispatchEvent(new Event('input'));
    snippetOverlay.classList.remove('open');
  } else {
    // 非斜杠文本：当作对话消息发送
    sendCommand('prompt', { message: code });
    snippetOverlay.classList.remove('open');
    snippetResult.textContent = '✅ 已发送';
  }
}

// 添加自定义片段
if (snippetAddBtn) {
  snippetAddBtn.addEventListener('click', () => {
    const label = snippetNewLabel.value.trim();
    const code = snippetNewCode.value.trim();
    if (!label || !code) {
      snippetResult.textContent = '⚠️ 标签和代码不能为空';
      return;
    }
    currentSnippets.push({ label, code });
    saveSnippets(currentSnippets);
    renderSnippets();
    snippetNewLabel.value = '';
    snippetNewCode.value = '';
    snippetResult.textContent = '✅ 已添加: ' + label;
  });
}

// 重置为默认
if (snippetResetBtn) {
  snippetResetBtn.addEventListener('click', () => {
    if (confirm('确定重置为默认代码片段？自定义片段将丢失。')) {
      currentSnippets = [...DEFAULT_SNIPPETS];
      saveSnippets(currentSnippets);
      renderSnippets();
      snippetResult.textContent = '✅ 已重置为默认';
    }
  });
}

// 关闭片段面板
if (snippetClose) {
  snippetClose.addEventListener('click', () => {
    snippetOverlay.classList.remove('open');
  });
}
if (snippetOverlay) {
  snippetOverlay.addEventListener('click', (e) => {
    if (e.target === snippetOverlay) snippetOverlay.classList.remove('open');
  });
}

// 初始渲染
renderSnippets();

// ============================================================
// ⭐ 数据驱动状态面板渲染
// ============================================================

/**
 * 渲染完整的动态状态面板
 * - 世界信息从 rpState.getWorld() 动态获取
 * - 角色列表从 rpState.getCharacters() 动态获取
 * - 每个角色的属性表通过 Object.entries 遍历
 */
function renderStatusPanel() {
  const world = rpState.getWorld() || {};
  const characters = rpState.getCharacters();

  let html = '';

  // ---- 世界信息 ----
  html += '<div class="rp-world-strip">';
  const worldFields = [
    { key: '当前日期', label: 'DATE' },
    { key: '当前星期', label: 'WEEK' },
    { key: '当前时间', label: 'TIME' },
    { key: '当前位置', label: 'LOC' },
  ];
  for (const f of worldFields) {
    html += `<div class="rp-world-item"><span class="label">${f.label}</span> ${escapeHtml(String(world[f.key] || '--'))}</div>`;
  }
  html += '</div>';

  if (characters.length === 0) {
    html += '<div style="text-align:center;padding:20px;color:#8899bb;">暂无角色数据</div>';
    rpStatusContent.innerHTML = html;
    return;
  }

  // ---- 角色 Tab（横向滚动，>4 时使用滚动布局） ----
  const useScroll = characters.length > 4;
  html += `<div class="rp-char-tabs${useScroll ? ' rp-char-tabs-scroll' : ''}" id="rp-char-tabs">`;
  characters.forEach((char, i) => {
    html += `<button class="rp-char-tab${i === 0 ? ' active' : ''}" data-char="${escapeHtmlAttr(char.key)}">${escapeHtml(char.name)}</button>`;
  });
  html += '</div>';

  // ---- 角色详情区 ----
  html += '<div id="rp-char-detail">';
  if (characters.length > 0) {
    html += renderCharDetail(characters[0]);
  }
  html += '</div>';

  rpStatusContent.innerHTML = html;

  // 绑定 Tab 点击
  document.querySelectorAll('.rp-char-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.rp-char-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const key = btn.dataset.char;
      const char = characters.find(c => c.key === key);
      if (char) {
        document.getElementById('rp-char-detail').innerHTML = renderCharDetail(char);
      }
    });
  });
}

/**
 * 数据驱动：渲染单个角色详情
 * 通过 Object.entries 遍历所有字段，根据字段类型自动选择渲染方式
 *
 * @param {{key: string, name: string, data: Object}} character
 * @returns {string} HTML
 */
function renderCharDetail(character) {
  const { key, name, data } = character;
  if (!data) return '<div style="color:#8899bb;">无数据</div>';

  // 提取核心展示字段
  const identity = extractFirstString(data, ['身份', 'identity', 'role']);
  const age = extractFirstValue(data, ['年龄', 'age']);

  let html = `<div class="rp-char-header">
    <div class="rp-char-name">${escapeHtml(name)}</div>
    <div class="rp-char-meta">${age || '?'}岁 · ${escapeHtml(identity || '')}</div>
  </div>`;

  // ---- 当前状态 ----
  const status = data['当前状态'];
  if (status && typeof status === 'object') {
    html += '<div class="rp-data-box" style="margin-bottom:8px;">';
    html += '<div class="box-title">当前状态</div>';
    for (const [k, v] of Object.entries(status)) {
      if (k === '当前着装' || k === '内心想法') continue; // 单独渲染
      const label = fieldLabel(k);
      html += `<div class="rp-data-row"><span class="rp-data-label">${label}</span><span class="rp-data-value">${escapeHtml(formatValue(v))}</span></div>`;
    }
    // 内心想法
    const thought = status['内心想法'];
    if (thought) {
      html += `<div class="rp-data-row"><span class="rp-data-label">💭 想法</span><span class="rp-data-value" style="font-style:italic;">"${escapeHtml(String(thought).substring(0, 60))}"</span></div>`;
    }
    html += '</div>';
  }

  // ---- 归属/情分进度条（如果存在） ----
  const belonging = data['归属值'];
  const affection = data['情分值'];
  if (belonging !== undefined || affection !== undefined) {
    html += '<div class="rp-data-grid">';
    if (belonging !== undefined) {
      const v = clamp(Number(belonging) || 0, 0, 100);
      html += `<div class="rp-data-box">
        <div class="box-title">归属值</div>
        <div style="text-align:right;">${v}</div>
        <div class="rp-bar-container"><div class="rp-bar-fill" style="width:${v}%;background:#90caf9;"></div></div>
      </div>`;
    }
    if (affection !== undefined) {
      const v = clamp(Number(affection) || 0, 0, 100);
      html += `<div class="rp-data-box">
        <div class="box-title">情分值</div>
        <div style="text-align:right;">${v}</div>
        <div class="rp-bar-container"><div class="rp-bar-fill" style="width:${v}%;background:#ff8a80;"></div></div>
      </div>`;
    }
    html += '</div>';
  }

  // ---- 生理状态（动态遍历） ----
  const phys = data['生理状态'];
  if (phys && typeof phys === 'object') {
    html += '<div class="rp-data-grid" style="margin-top:8px;">';
    html += '<div class="rp-data-box" style="background:#0d1b2a;">';
    html += '<div class="box-title">生理监测</div>';
    for (const [k, v] of Object.entries(phys)) {
      if (k === '堕胎次数or分娩次数' && !v) continue;
      const label = fieldLabel(k);
      const formatted = formatSpecialField(k, v);
      html += `<div class="rp-data-row"><span class="rp-data-label">${label}</span><span>${formatted}</span></div>`;
    }
    html += '</div>';
    html += '</div>';
  }

  // ---- 花开蒂落 ----
  const flower = data['花开蒂落'];
  if (flower && typeof flower === 'object') {
    html += '<div class="rp-data-grid" style="margin-top:8px;">';
    html += '<div class="rp-data-box" style="background:#0d1b2a;">';
    html += '<div class="box-title">花开蒂落</div>';
    for (const [k, v] of Object.entries(flower)) {
      const label = fieldLabel(k);
      const formatted = formatSpecialField(k, v);
      html += `<div class="rp-data-row"><span class="rp-data-label">${label}</span><span>${formatted}</span></div>`;
    }
    html += '</div>';
    html += '</div>';
  }

  // ---- 着装 ----
  const outfit = data['当前状态']?.['当前着装'];
  if (outfit) {
    const outfitText = typeof outfit === 'object'
      ? Object.entries(outfit).map(([k, v]) => `${k}: ${v}`).join(' / ')
      : String(outfit);
    html += `<div class="rp-data-box" style="margin-top:8px;">
      <div class="box-title">着装</div>
      <div class="rp-long-text">${escapeHtml(outfitText)}</div>
    </div>`;
  }

  // ---- 贞洁/性交次数 ----
  const virgin = data['贞洁状态'];
  const sexCount = data['性交次数'];
  if (virgin || sexCount) {
    html += '<div class="rp-data-box" style="margin-top:8px;">';
    html += '<div class="box-title">私密档案</div>';
    if (virgin) {
      const vText = typeof virgin === 'object'
        ? Object.entries(virgin).map(([k, v]) => `${k}: ${v}`).join(' / ')
        : String(virgin);
      html += `<div class="rp-data-row"><span class="rp-data-label">贞洁</span><span class="rp-data-value">${escapeHtml(vText)}</span></div>`;
    }
    if (sexCount) {
      const sText = typeof sexCount === 'object'
        ? (sexCount['总次数'] ?? Object.values(sexCount)[0] ?? 0)
        : sexCount;
      html += `<div class="rp-data-row"><span class="rp-data-label">性交次数</span><span class="rp-data-value">${sText}</span></div>`;
    }
    html += '</div>';
  }

  // ---- 特殊事件 ----
  const events = data['特殊事件'];
  if (events && typeof events === 'object') {
    html += '<div class="rp-data-box" style="margin-top:8px;">';
    html += '<div class="box-title">特殊事件</div>';
    for (const [k, v] of Object.entries(events)) {
      const active = isTruthyField(v);
      html += `<span class="rp-tag${active ? ' active' : ''}">${active ? '☑' : '☐'} ${escapeHtml(fieldLabel(k))}</span>`;
    }
    html += '</div>';
  }

  // ---- 其他未渲染的顶层字段（兜底：简单键值对） ----
  const renderedKeys = new Set([
    '基本信息', '公民芯片', '当前状态', '归属值', '情分值',
    '生理状态', '花开蒂落', '贞洁状态', '性交次数', '特殊事件',
    '身份', '年龄', '年龄',
  ]);
  const remaining = Object.entries(data).filter(([k]) => !renderedKeys.has(k) && typeof k === 'string');
  if (remaining.length > 0) {
    html += '<div class="rp-data-box" style="margin-top:8px;">';
    html += '<div class="box-title">其他信息</div>';
    for (const [k, v] of remaining) {
      const val = typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : String(v);
      html += `<div class="rp-data-row"><span class="rp-data-label">${escapeHtml(fieldLabel(k))}</span><span class="rp-data-value">${escapeHtml(val)}</span></div>`;
    }
    html += '</div>';
  }

  return html;
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 字段名转显示标签
 */
function fieldLabel(key) {
  const map = {
    '是否为生理期': '🩸 生理期',
    '安全期': '🛡 安全期',
    '生理期持续天数': '📅 持续天数',
    '怀孕状态': '🤰 怀孕',
    '怀孕天数': '📆 天数',
    '触发状态': '⚡ 状态',
    '触发对象': '🎯 对象',
    '触发形式': '💫 形式',
    '专属生理印证': '🔮 生理印证',
    '堕胎次数or分娩次数': '📋 堕胎/分娩',
    所在地点: '📍 地点',
    内心想法: '💭 想法',
    当前着装: '👗 着装',
  };
  return map[key] || key;
}

/**
 * 特殊字段值的格式化
 */
function formatSpecialField(key, value) {
  if (key === '是否为生理期') {
    return value ? '<span class="rp-tag active" style="color:#ff6b6b;">🔴 生理期</span>' : '<span class="rp-tag">🟢 安全期</span>';
  }
  if (key === '触发状态') {
    return value ? '✅ 已触发' : '⬜ 未触发';
  }
  return escapeHtml(formatValue(value));
}

/**
 * 通用值格式化
 */
function formatValue(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? '是' : '否';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 100);
  return String(v);
}

/**
 * 从对象中按优先级提取第一个存在的字符串值
 */
function extractFirstString(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

/**
 * 从对象中按优先级提取第一个存在的值
 */
function extractFirstValue(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

/**
 * 判断字段值是否为"真"（用于特殊事件标签激活状态）
 */
function isTruthyField(v) {
  if (v === true) return true;
  if (typeof v === 'object' && v !== null) {
    return v['触发状态'] === true || v['状态'] === true;
  }
  return false;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

// ============================================================
// UI 更新
// ============================================================

let isStreaming = false;

function updateUI() {
  if (isStreaming) {
    sendBtn.classList.add('hidden');
    abortBtn.classList.remove('hidden');
    statusText.textContent = 'Generating...';
    statusIndicator.style.background = '#ff9800';
  } else {
    sendBtn.classList.remove('hidden');
    abortBtn.classList.add('hidden');
    statusText.textContent = isConnected ? 'Ready' : 'Disconnected';
    statusIndicator.style.background = isConnected ? '#4caf50' : '#f44336';
  }
}

// ============================================================
// ⭐ APPEND_SYSTEM.md 自动附加
// 用户发送消息时，将 .pi/APPEND_SYSTEM.md 内容拼到消息末尾再发给 AI。
// 原理：AI 对消息末尾注意力最高，格式规范放这里能最大程度保证输出格式正确。
// 设计：
//   - 前端不可见：用户输入框只显示自己输入的内容
//   - 历史只记录 AI 输出，不记录用户输入（含拼接的规范内容也不存历史）
// ============================================================

let appendStyleEnabled = true;   // 默认开启（用户也可手动关闭）
let appendStyleContent = '';     // APPEND_SYSTEM.md 内容缓存
let appendStyleCounter = 0;      // 计数器，每 5 次用户输入拼接一次
let appendStyleSections = [];    // ⭐ 切分后的章节（防习惯化）

// ⭐ 关键词定义关键章节（这些优先/高频显示）
const APPEND_CRITICAL_KEYWORDS = ['强制要求', '风格规范', '输出格式'];

/**
 * 切分 APPEND_SYSTEM 内容为独立章节（按 ## 标题分割）
 */
function splitAppendSections(content) {
  const lines = content.split('\n');
  const sections = [];
  let current = '';
  for (const line of lines) {
    if (line.startsWith('## ') && current) {
      const trimmed = current.trim();
      if (trimmed.length > 40) sections.push(trimmed);
      current = line;
    } else {
      current += (current ? '\n' : '') + line;
    }
  }
  const trimmed = current.trim();
  if (trimmed.length > 40) sections.push(trimmed);
  return sections;
}

// ⭐ 常用轮换前缀，每次随机选一个，让消息开头不固定
const APPEND_PREFIXES = [
  '[格式确认]',
  '[规则提醒]',
  '[注意]',
  '[提示]',
  '[确认]',
];

/**
 * 构造 APPEND_SYSTEM 后缀文本（替换 {{user}}）
 * ⭐ 每次返回不同的章节片段，防止 AI 习惯化
 */
function buildAppendSuffix() {
  appendStyleCounter++;
  // 每 5 次用户输入才拼接一次，避免过度强调
  if (appendStyleCounter % 5 !== 0) return '';
  if (!appendStyleContent) return '';

  // 第一次调用时切分缓存
  if (appendStyleSections.length === 0) {
    appendStyleSections = splitAppendSections(appendStyleContent);
  }
  if (appendStyleSections.length === 0) return '';

  const userName = localStorage.getItem('rp_user_name') || '{{user}}';
  const currentCycle = Math.floor(appendStyleCounter / 5);

  // ⭐ 轮换策略：每 3 轮插入一次关键章节，其余轮换普通章节
  let section;
  if (currentCycle % 4 === 0) {
    // 每 4 次插入强制要求/输出格式等关键章节
    const criticalSections = appendStyleSections.filter(s =>
      APPEND_CRITICAL_KEYWORDS.some(kw => s.includes(kw))
    );
    if (criticalSections.length > 0) {
      section = criticalSections[(currentCycle / 4) % criticalSections.length];
    } else {
      section = appendStyleSections[currentCycle % appendStyleSections.length];
    }
  } else {
    // 普通轮换
    section = appendStyleSections[(currentCycle - 1) % appendStyleSections.length];
  }

  // ⭐ 随机选一个前缀，让开头不固定
  const prefix = APPEND_PREFIXES[currentCycle % APPEND_PREFIXES.length];

  return `${prefix}\n${section.replace(/\{\{user\}\}/g, userName).trim()}`;
}

/**
 * 恢复上次的开关状态
 */
const savedAppendStyle = localStorage.getItem('rp_append_style');
if (savedAppendStyle === '1') {
  appendStyleEnabled = true;
}

// ============================================================
// 事件绑定
// ============================================================

// RP 模式开关——默认开启
rpModeBtn.classList.add('active');
messageRenderer.setRPMode(true);
rpStatusBtn.classList.add('visible');
rpModeBtn.querySelector('span:last-child').textContent = 'RP ON';

rpModeBtn.addEventListener('click', () => {
  rpMode = !rpMode;
  rpModeBtn.classList.toggle('active');
  messageRenderer.setRPMode(rpMode);
  if (rpMode) {
    rpStatusBtn.classList.add('visible');
    rpModeBtn.querySelector('span:last-child').textContent = 'RP ON';
  } else {
    rpStatusBtn.classList.remove('visible');
    rpModeBtn.querySelector('span:last-child').textContent = 'RP';
  }
});

// ⭐ APPEND_SYSTEM 附加开关
const appendStyleBtn = document.getElementById('append-style-btn');
const appendStyleIndicator = document.getElementById('append-style-indicator');

// 恢复上次状态
if (appendStyleEnabled && appendStyleBtn) {
  appendStyleBtn.classList.add('active');
  if (appendStyleIndicator) appendStyleIndicator.style.display = 'inline';
}

if (appendStyleBtn) {
  appendStyleBtn.addEventListener('click', () => {
    appendStyleEnabled = !appendStyleEnabled;
    appendStyleBtn.classList.toggle('active');
    localStorage.setItem('rp_append_style', appendStyleEnabled ? '1' : '0');
    if (appendStyleIndicator) {
      appendStyleIndicator.style.display = appendStyleEnabled ? 'inline' : 'none';
    }
    console.log('[RP] APPEND_SYSTEM 附加:', appendStyleEnabled ? 'ON' : 'OFF');
  });
}

// 状态面板按钮
rpStatusBtn.addEventListener('click', () => {
  rpStatusOverlay.classList.add('open');
  sendCommand('get_rp_state');
});

// 关闭状态面板
rpStatusClose.addEventListener('click', () => {
  rpStatusOverlay.classList.remove('open');
});
rpStatusOverlay.addEventListener('click', (e) => {
  if (e.target === rpStatusOverlay) {
    rpStatusOverlay.classList.remove('open');
  }
});

// 设置面板按钮（动态创建）
function createSettingsButton() {
  const btn = document.getElementById('rp-settings-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      settingsPanel.ensureInit();
      settingsPanel.toggle();
    });
  }
}
createSettingsButton();

// 新会话按钮
sessionPickerNew.addEventListener('click', () => {
  hideSessionPicker();
  sendCommand('new_session');
});

// 会话历史按钮
const rpSessionsBtn = document.getElementById('rp-sessions-btn');
if (rpSessionsBtn) {
  rpSessionsBtn.addEventListener('click', showSessionPicker);
}

// 选项按钮点击处理（委托事件）
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.rp-choice-btn');
  if (!btn) return;
  const text = btn.textContent.trim();
  if (!text) return;
  messageInput.value = text;
  messageInput.focus();
  messageInput.dispatchEvent(new Event('input'));
});

// 发送消息
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  // 检测是否为斜杠命令
  if (text.startsWith('/')) {
    hideSlashHints();
    execCommand(text);
    messageInput.value = '';
    return;
  }

  messageInput.value = '';

  // ⭐ APPEND_SYSTEM 附加：拼到消息末尾再发送
  // AI 对消息末尾注意力最高，格式规范放这里效果最好
  // 历史只记录 AI 输出，不记录用户输入
  const suffix = buildAppendSuffix();
  const finalMessage = (appendStyleEnabled && suffix)
    ? text + '\n\n---\n[系统风格规范]\n' + suffix
    : text;

  sendCommand('prompt', { message: finalMessage });
});

// 中止
abortBtn.addEventListener('click', () => {
  sendCommand('abort');
});

// Enter 发送
messageInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // 如果有选中的 slash 提示，触发它
    const selected = document.querySelector('.slash-hint.selected');
    if (selected) {
      e.preventDefault();
      const cmd = selected.dataset.cmd;
      messageInput.value = cmd + ' ';
      messageInput.focus();
      hideSlashHints();
      return;
    }
    e.preventDefault();
    chatForm.dispatchEvent(new Event('submit'));
  }
});

// ============================================================
// Slash 命令自动补全
// ============================================================

const slashHints = document.getElementById('slash-hints');
let slashIndex = -1;

function showSlashHints() {
  slashHints.classList.remove('hidden');
  slashIndex = -1;
  document.querySelectorAll('.slash-hint').forEach(h => h.classList.remove('selected'));
}

function hideSlashHints() {
  slashHints.classList.add('hidden');
  slashIndex = -1;
}

function updateSlashSelection(dir) {
  const hints = document.querySelectorAll('.slash-hint');
  if (hints.length === 0) return;
  hints.forEach(h => h.classList.remove('selected'));
  slashIndex += dir;
  if (slashIndex < 0) slashIndex = hints.length - 1;
  if (slashIndex >= hints.length) slashIndex = 0;
  hints[slashIndex].classList.add('selected');
  hints[slashIndex].scrollIntoView({ block: 'nearest' });
}

messageInput.addEventListener('input', () => {
  const val = messageInput.value;
  if (val === '/') {
    showSlashHints();
  } else if (val.startsWith('/')) {
    // 过滤匹配的命令
    const query = val.slice(1).toLowerCase();
    let anyVisible = false;
    document.querySelectorAll('.slash-hint').forEach(h => {
      const cmd = h.dataset.cmd.toLowerCase();
      if (cmd.includes(query)) {
        h.style.display = '';
        anyVisible = true;
      } else {
        h.style.display = 'none';
      }
    });
    if (anyVisible) {
      showSlashHints();
      slashIndex = -1;
    } else {
      hideSlashHints();
    }
  } else {
    hideSlashHints();
  }
});

// 键盘导航
messageInput.addEventListener('keydown', (e) => {
  if (!slashHints.classList.contains('hidden')) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateSlashSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateSlashSelection(-1);
    } else if (e.key === 'Escape') {
      hideSlashHints();
      messageInput.value = '';
    }
  }
});

// 点击选择
document.querySelectorAll('.slash-hint').forEach(h => {
  h.addEventListener('click', () => {
    const cmd = h.dataset.cmd;
    messageInput.value = cmd + ' ';
    messageInput.focus();
    hideSlashHints();
  });
});

// 点击其他地方关闭
slashHints.addEventListener('mousedown', (e) => e.preventDefault());
document.addEventListener('click', (e) => {
  if (!slashHints.contains(e.target) && e.target !== messageInput) {
    hideSlashHints();
  }
});

// ============================================================
// 代码终端面板
// ============================================================

const rpTermBtn = document.getElementById('rp-term-btn');
const rpTermOverlay = document.getElementById('rp-term-overlay');
const rpTermClose = document.getElementById('rp-term-close');
const rpTermInput = document.getElementById('rp-term-input');
const rpTermSend = document.getElementById('rp-term-send');
const rpTermResult = document.getElementById('rp-term-result');

// 代码片段按钮
const rpSnippetBtn = document.getElementById('rp-snippet-btn');
if (rpSnippetBtn) {
  rpSnippetBtn.addEventListener('click', () => {
    renderSnippets();
    snippetOverlay.classList.toggle('open');
  });
}

if (rpTermBtn) {
  rpTermBtn.addEventListener('click', () => {
    rpTermOverlay.classList.toggle('open');
  });
}
if (rpTermClose) {
  rpTermClose.addEventListener('click', () => {
    rpTermOverlay.classList.remove('open');
  });
}
if (rpTermOverlay) {
  rpTermOverlay.addEventListener('click', (e) => {
    if (e.target === rpTermOverlay) rpTermOverlay.classList.remove('open');
  });
}

function execCommand(cmd) {
  if (!cmd.trim()) return;
  rpTermResult.textContent = '发送中...';

  const trimmed = cmd.trim();
  if (trimmed === '/compact') {
    sendCommand('compact', { hint: '保留角色关系、当前场景、最近对话细节。' });
    rpTermInput.value = '';
    return;
  } else if (trimmed.startsWith('/')) {
    sendCommand('exec', { code: trimmed });
    rpTermInput.value = '';
    return;
  }

  rpTermInput.value = '';
  sendCommand('exec', { code: trimmed });
}

if (rpTermSend) {
  rpTermSend.addEventListener('click', () => execCommand(rpTermInput.value));
}
if (rpTermInput) {
  rpTermInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      execCommand(rpTermInput.value);
    }
  });
}

document.querySelectorAll('.rp-term-cmd').forEach(btn => {
  btn.addEventListener('click', () => {
    const cmd = btn.dataset.cmd;
    execCommand(cmd);
  });
});

function handleExecResult(msg) {
  if (msg.success) {
    rpTermResult.textContent = '✅ ' + (msg.message || '已执行');
    rpTermOverlay.classList.remove('open');
  } else {
    rpTermResult.textContent = '❌ ' + (msg.error || '失败');
  }
}

// 在 handleMessage 里捕获 exec_result
const origHandleMessage = handleMessage;
handleMessage = function(msg) {
  if (msg.type === 'exec_result') {
    handleExecResult(msg);
    return;
  }
  if (msg.type === 'compact_result') {
    rpTermResult.textContent = msg.success ? '✅ 压缩完成' : ('❌ ' + (msg.error || '失败'));
    return;
  }
  origHandleMessage(msg);
};

// ============================================================
// 卡片 UI 动态加载
// ============================================================

/** 已加载过的卡片 UI（去重用） */
const _loadedCardUIs = new Set();

/**
 * 从服务端接收卡片 UI 文件列表，动态注入 CSS 和 JS。
 * @param {string} cardId 卡片标识
 * @param {Array<{name: string, content: string}>} files 文件名和内容
 */
function loadCardUI(cardId, files) {
  if (!files || files.length === 0) return;
  if (_loadedCardUIs.has(cardId)) return;
  _loadedCardUIs.add(cardId);

  for (const file of files) {
    if (file.name.endsWith('.css')) {
      const style = document.createElement('style');
      style.setAttribute('data-card-ui', cardId);
      style.textContent = file.content;
      document.head.appendChild(style);
    } else if (file.name.endsWith('.js')) {
      const script = document.createElement('script');
      script.setAttribute('data-card-ui', cardId);
      script.textContent = file.content;
      document.body.appendChild(script);
    }
  }

  console.log('[RP] 卡片 UI 已加载:', cardId, files.map(f => f.name).join(', '));
}

// ============================================================
// 启动
// ============================================================

connect();
