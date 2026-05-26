/**
 * RP Message Renderer - 基于 tau-mirror 的 MessageRenderer，增加 RP 副视角折叠功能
 * 
 * 使用 rp-web-xml.js 进行结构化 XML 解析，替代旧的正则链。
 */

import { renderMarkdown } from './rp-web-markdown.js';
import { parseRPContent, stripBlockedTags } from './rp-web-xml.js';

export class MessageRenderer {
  constructor(container) {
    this.container = container;
    this.isNearBottom = true;
    this.rpMode = false;
    /** @type {Array<{name: string, pattern: string, flags: string, replacement: string}>} */
    this.regexHooks = [];

    this.container.addEventListener('scroll', () => {
      const threshold = 100;
      this.isNearBottom =
        this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight < threshold;
    });
  }

  setRPMode(enabled) {
    this.rpMode = enabled;
  }

  /**
   * 接收服务端下发的正则渲染钩子
   * @param {Array<{name: string, pattern: string, flags: string, replacement: string}>} hooks
   */
  setRegexHooks(hooks) {
    this.regexHooks = hooks || [];
  }

  clear() {
    this.container.innerHTML = '';
  }

  renderWelcome() {
    this.container.innerHTML = `
      <div class="welcome">
        <div class="welcome-icon"><img src="tau-192.png" alt="τ" class="tau-icon-welcome"></div>
        <p>RP Web · 乐园回响</p>
        <p class="hint">开启 RP 模式后，副视角和状态面板自动可用</p>
      </div>
    `;
  }

  renderUserMessage(message, isHistory = false) {
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    // 提取文本内容，兼容 string 和 Array<contentBlock> 两种格式
    let text = '';
    if (typeof message.content === 'string') {
      text = message.content;
    } else if (Array.isArray(message.content)) {
      text = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }

    const div = document.createElement('div');
    div.className = `message user${isHistory ? ' history' : ''}`;
    div.innerHTML = `<div class="message-content">${this.escapeHtml(text)}</div>`;
    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
  }

  renderAssistantMessage(message, isStreaming = false, isHistory = false) {
    const welcome = this.container.querySelector('.welcome');
    if (welcome) welcome.remove();

    const div = document.createElement('div');
    div.className = `message assistant${isHistory ? ' history' : ''}`;
    div.dataset.messageId = message.id || 'streaming';

    let contentHtml = '';
    if (typeof message.content === 'string') {
      const processed = isStreaming ? this.escapeHtml(message.content) : this._processRPContent(message.content);
      contentHtml = processed;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'text') {
          const processed = isStreaming ? this.escapeHtml(block.text) : this._processRPContent(block.text);
          contentHtml += processed;
        } else if (block.type === 'thinking') {
          contentHtml += this.renderThinkingBlock(block.thinking);
        }
      }
    }

    const streamingClass = isStreaming ? ' streaming' : '';
    div.innerHTML = `<div class="message-content${streamingClass}">${contentHtml}</div>`;

    this.container.appendChild(div);
    if (!isHistory) this.scrollToBottom();
    return div;
  }

  /**
   * RP 内容处理核心函数
   * - 使用 parseRPContent 进行结构化 XML 解析
   * - RP 模式下渲染副视角折叠卡片 + 选项按钮
   * - 非 RP 模式下只输出纯文本 markdown
   */
  _processRPContent(text) {
    const parsed = parseRPContent(text, this.rpMode);

    // 渲染正文（保留现有 renderMarkdown 调用）
    let result = renderMarkdown(parsed.mainContent);

    // ⭐ 应用 display 阶段正则钩子（Markdown→HTML 之后）
    if (this.regexHooks.length > 0) {
      for (const hook of this.regexHooks) {
        try {
          const regex = new RegExp(hook.pattern, hook.flags);
          result = result.replace(regex, hook.replacement);
          // 同时处理 parsed 中可能被转义的内容
        } catch { /* 正则无效 */ }
      }
    }

    // RP 模式下渲染副视角折叠卡片和选项按钮
    if (this.rpMode) {
      // 渲染副视角折叠卡片
      for (const p of parsed.perspectives) {
        const id = 'rp-persp-' + Math.random().toString(36).slice(2, 8);
        result += `
<div class="rp-perspective">
  <button class="rp-perspective-toggle" onclick="
    var c=document.getElementById('${id}');
    c.classList.toggle('open');
    this.textContent = c.classList.contains('open') ? '▲ 收起 ${this.escapeHtml(p.title)}' : '${this.escapeHtml(p.title)}';
  ">${p.title}</button>
  <div class="rp-perspective-content" id="${id}">
    <div class="rp-perspective-inner">${p.html}</div>
  </div>
</div>`;
      }

      // 渲染选项按钮
      const choices = parsed.choices;
      if (choices.length > 0) {
        const uid = 'rp-choices-' + Math.random().toString(36).slice(2, 8);
        window._rpChoices = window._rpChoices || {};
        window._rpChoices[uid] = choices;
        result += '<div class="rp-choices">';
        for (let i = 0; i < choices.length; i++) {
          const escaped = this.escapeHtml(choices[i]);
          result += '<button class="rp-choice-btn" data-choices-id="' + uid + '" data-choice-index="' + i + '">' + escaped + '</button>';
        }
        result += '</div>';
      }
    }

    return result;
  }

  renderThinkingBlock(thinking) {
    const id = 'thinking-' + Math.random().toString(36).slice(2, 8);
    return `<div class="thinking-block">
<div class="thinking-toggle" onclick="var c=document.getElementById('${id}');c.classList.toggle('expanded');this.classList.toggle('expanded')">
<span class="chevron">▶</span>
<span class="thinking-label">💭 Thinking</span>
</div>
<div class="thinking-content" id="${id}">${this.escapeHtml(thinking)}</div>
</div>`;
  }

  updateStreamingThinking(messageElement, thinking) {
    let thinkingDiv = messageElement.querySelector('.streaming-thinking');
    if (!thinkingDiv) {
      const contentDiv = messageElement.querySelector('.message-content');
      if (!contentDiv) return;
      thinkingDiv = document.createElement('div');
      thinkingDiv.className = 'thinking-block streaming-thinking';
      thinkingDiv.innerHTML = `<div class="thinking-toggle expanded">
          <span class="chevron">▶</span>
          <span class="thinking-label">💭 Thinking</span>
        </div>
        <div class="thinking-content expanded"></div>`;
      contentDiv.prepend(thinkingDiv);
    }
    const contentEl = thinkingDiv.querySelector('.thinking-content');
    if (contentEl) {
      contentEl.textContent = thinking;
      this.scrollToBottom();
    }
  }

  updateStreamingMessage(messageElement, content) {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      let textNode = contentDiv.querySelector('.streaming-text');
      if (!textNode) {
        textNode = document.createElement('div');
        textNode.className = 'streaming-text';
        contentDiv.appendChild(textNode);
      }
      // 保存原始文本到 data 属性（供 finalize 使用）
      textNode.dataset.raw = content;
      // 流式输出：先剥离 blocked 标签（UpdateVariable 等绝不能泄露），再提取正文
      let cleanContent = stripBlockedTags(content);
      // 剥离 thinking（流式时不展示）
      cleanContent = cleanContent.replace(/<thinking>[\s\S]*<\/thinking>/gi, '');
      // 提取 <content> 块中的文本，或使用纯文本
      const contentMatch = cleanContent.match(/<content>([\s\S]*?)<\/content>/);
      if (contentMatch) {
        cleanContent = contentMatch[1];
      }
      // 去除剩余标签
      cleanContent = cleanContent.replace(/<[^>]+>/g, '').trim();
      textNode.innerHTML = this.escapeHtml(cleanContent || content.slice(-200));
      this.scrollToBottom();
    }
  }

  finalizeStreamingMessage(messageElement, usage = null, thinking = '') {
    const contentDiv = messageElement.querySelector('.message-content');
    if (contentDiv) {
      contentDiv.classList.remove('streaming');
      const streamingText = contentDiv.querySelector('.streaming-text');
      // 优先使用 dataset.raw（含完整 XML），回退到 textContent
      const rawText = streamingText ? (streamingText.dataset.raw || streamingText.textContent) : contentDiv.textContent;
      let html = '';
      if (thinking) {
        html += this.renderThinkingBlock(thinking);
      }
      html += this._processRPContent(rawText);
      contentDiv.innerHTML = html;
    }
  }

  renderSystemMessage(text) {
    const div = document.createElement('div');
    div.className = 'system-message';
    // ⭐ 先应用 display 正则钩子（在原始文本上），让钩子生成的 HTML 能正常传递
    let processed = text;
    if (this.regexHooks.length > 0) {
      for (const hook of this.regexHooks) {
        try {
          const regex = new RegExp(hook.pattern, hook.flags);
          processed = processed.replace(regex, hook.replacement);
        } catch { /* 正则无效 */ }
      }
    }
    // renderMarkdown 不转义 HTML，钩子产生的 HTML 标签能正常渲染
    div.innerHTML = `<div class="message-content">${renderMarkdown(processed)}</div>`;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  renderError(errorMessage) {
    const div = document.createElement('div');
    div.className = 'error-message';
    div.textContent = '⚠️ ' + errorMessage;
    this.container.appendChild(div);
    this.scrollToBottom();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  scrollToBottom() {
    if (this.isNearBottom) {
      requestAnimationFrame(() => {
        this.container.scrollTop = this.container.scrollHeight;
      });
    }
  }
}
