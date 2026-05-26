/**
 * RP XML Processor - 基于 DOMParser 的 XML 标签解析器
 *
 * 替代原有的正则解析，正确处理嵌套标签，防止内容泄露。
 * UpdateVariable 块在服务端剥离，前端若收到则丢弃。
 */

/** 允许的标签白名单 */
const ALLOWED_TAGS = new Set([
  'content', 'choice',
  'perspective', 'toggle_title', 'content_html',
  'thinking', 'Analysis'
]);

/** 禁止传递到前端的标签（服务端应已剥离，前端做最后防线） */
const BLOCKED_TAGS = new Set([
  'UpdateVariable', 'update_state', 'read_state', 'load_worldbook', 'advance_time'
]);

/**
 * 解析 AI 输出的 RP 内容，返回结构化数据
 * @param {string} text - AI 原始输出
 * @param {boolean} rpMode - 是否 RP 模式
 * @returns {{ mainContent: string, perspectives: Array<{title: string, html: string}>, choices: string[], thinking: string }}
 */
export function parseRPContent(text, rpMode = true) {
  const result = {
    mainContent: '',
    perspectives: [],
    choices: [],
    thinking: ''
  };

  if (!text) return result;

  // Step 1: 剥离 blocked 标签（UpdateVariable 等绝对不应展示的内容）
  let cleaned = stripBlockedTags(text);

  // Step 2: 提取 thinking（非 RP 模式下也剥离，RP 模式下可折叠展示）
  cleaned = extractThinking(cleaned, result);

  // Step 3: 提取 perspective 块（使用 DOMParser 处理嵌套）
  cleaned = extractPerspectives(cleaned, result);

  // Step 4: 提取 content 块中的 choice
  const contentMatch = cleaned.match(/<content>([\s\S]*?)<\/content>/);
  let mainText = '';
  if (contentMatch) {
    mainText = contentMatch[1];
    // 提取 choice 标签
    mainText = extractChoices(mainText, result);
    // 移除可能的 perspective 残留
    mainText = mainText.replace(/<perspective>[\s\S]*?<\/perspective>/g, '');
    result.mainContent = mainText.trim();
    // 同时剥离 content 标签本身，剩下的是正文间隙
    cleaned = cleaned.replace(/<content>[\s\S]*?<\/content>/, '');
  } else {
    // 没有 content 标签，整个 cleaned 就是正文
    let text2 = extractChoices(cleaned, result);
    text2 = text2.replace(/<perspective>[\s\S]*?<\/perspective>/g, '');
    result.mainContent = text2.trim();
  }

  // 非 RP 模式：清除所有 XML 标签，只留纯文本
  if (!rpMode) {
    result.mainContent = stripAllTags(result.mainContent);
    result.perspectives = [];
    result.thinking = '';
  }

  return result;
}

/**
 * 剥离 blocked 标签（安全最后防线）
 * 导出供流式渲染使用
 */
export function stripBlockedTags(text) {
  let result = text;
  for (const tag of BLOCKED_TAGS) {
    const regex = new RegExp(`<${tag}[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    result = result.replace(regex, '');
  }
  return result;
}

/**
 * 提取 thinking 标签内容
 */
function extractThinking(text, result) {
  const regex = /<thinking>([\s\S]*?)<\/thinking>/gi;
  const parts = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    parts.push(match[1].trim());
  }
  result.thinking = parts.join('\n---\n');
  return text.replace(regex, '');
}

/**
 * 使用 DOMParser 提取 perspective 块
 * 能正确处理嵌套 HTML 标签（<p>, <strong> 等）
 */
function extractPerspectives(text, result) {
  const regex = /<perspective>([\s\S]*?)<\/perspective>/g;
  let cleaned = text;
  const matches = [];

  let match;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match[1]);
  }

  for (const raw of matches) {
    // 尝试用 DOMParser 解析
    const parsed = parsePerspectiveBlock(raw);
    if (parsed) {
      result.perspectives.push(parsed);
    }
  }

  return cleaned.replace(regex, '');
}

/**
 * 用 DOMParser 解析单个 perspective 块内部
 */
function parsePerspectiveBlock(innerXml) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<root>${innerXml}</root>`, 'text/xml');

    // 检查解析错误
    const parseError = doc.querySelector('parsererror');
    if (parseError) {
      // 回退到正则
      return parsePerspectiveFallback(innerXml);
    }

    const titleEl = doc.querySelector('toggle_title');
    const htmlEl = doc.querySelector('content_html');

    if (titleEl && htmlEl) {
      return {
        title: titleEl.textContent?.trim() || '',
        html: htmlEl.innerHTML?.trim() || htmlEl.textContent?.trim() || ''
      };
    }

    return parsePerspectiveFallback(innerXml);
  } catch {
    return parsePerspectiveFallback(innerXml);
  }
}

/**
 * 正则回退：解析 perspective 内部结构
 */
function parsePerspectiveFallback(innerXml) {
  const titleMatch = innerXml.match(/<toggle_title>([\s\S]*?)<\/toggle_title>/);
  const htmlMatch = innerXml.match(/<content_html>([\s\S]*?)<\/content_html>/);

  if (titleMatch || htmlMatch) {
    return {
      title: titleMatch ? titleMatch[1].trim() : '',
      html: htmlMatch ? htmlMatch[1].trim() : ''
    };
  }
  return null;
}

/**
 * 提取 choice 标签
 */
function extractChoices(text, result) {
  // 先尝试 DOMParser
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<root>${text}</root>`, 'text/xml');
    const parseError = doc.querySelector('parsererror');
    if (!parseError) {
      const choiceEls = doc.querySelectorAll('choice');
      for (const el of choiceEls) {
        const t = el.textContent?.trim();
        if (t) result.choices.push(t);
      }
      // 移除已解析的 choice 标签
      return text.replace(/<choice>[\s\S]*?<\/choice>/g, '');
    }
  } catch {}

  // 回退到正则
  const regex = /<choice>([\s\S]*?)<\/choice>/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const t = match[1].trim();
    if (t && !result.choices.includes(t)) {
      result.choices.push(t);
    }
  }
  return text.replace(regex, '');
}

/**
 * 剥离所有 XML 标签（非 RP 模式用）
 */
function stripAllTags(text) {
  return text
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * 验证标签名是否在白名单内
 */
export function isAllowedTag(tagName) {
  return ALLOWED_TAGS.has(tagName) || BLOCKED_TAGS.has(tagName);
}
