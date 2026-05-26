/**
 * setup.mjs — 角色扮演项目初始化脚本
 *
 * 功能：
 * 1. 复制并规范化世界书文件名
 * 2. 从 YAML 角色初始状态生成 state.json
 * 3. ⭐ 支持 SillyTavern 格式的 PNG/JSON 角色卡导入
 *    - PNG → 解析 tEXt chunk 提取 chara JSON
 *    - JSON → 直接 JSON.parse
 *    - 生成 .md 世界书文件（含 character_book entries）
 *    - 生成 state.json 角色条目
 *    - 生成 .rpconfig.json 默认配置
 *
 * 用法：
 *   node setup.mjs                                  # 标准初始化
 *   node setup.mjs --character <path-to-card.png>   # 导入角色卡
 *   node setup.mjs --character <path-to-card.json>  # 导入 JSON 角色卡
 *   node setup.mjs --scan                            # 扫描 ./characters/ 目录
 */

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync,
  existsSync, copyFileSync, statSync, unlinkSync, symlinkSync, renameSync,
  rmSync
} from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import extractChunks from 'png-chunks-extract';
import { decode as decodeTextChunk } from 'png-chunk-text';

// ============================================================
// 路径常量
// ============================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = __dirname;
const WORLD_BOOK_SRC = join(PROJECT_DIR, 'worldbook_clean');
const WORLD_BOOK_DST = join(PROJECT_DIR, '.pi', 'worldbook');
const STATE_PATH = join(PROJECT_DIR, '.pi', 'state.json');
const RP_CONFIG_PATH = join(PROJECT_DIR, '.rpconfig.json');
const CHARACTERS_DIR = join(PROJECT_DIR, 'characters');
const CARDS_DIR = join(PROJECT_DIR, '.pi', 'cards');
const REGISTRY_PATH = join(CARDS_DIR, 'registry.json');

// ============================================================
// 工具函数
// ============================================================

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function cleanName(name) {
  return name.replace(/ +/g, ' ').trim();
}

function getNested(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

function setNested(obj, path, value) {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!current[keys[i]]) current[keys[i]] = {};
    current = current[keys[i]];
  }
  current[keys[keys.length - 1]] = value;
}

// ============================================================
// 卡片注册表管理
// ============================================================

function loadRegistry() {
  if (!existsSync(REGISTRY_PATH)) return { cards: {}, active: null };
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8'));
  } catch {
    return { cards: {}, active: null };
  }
}

function saveRegistry(registry) {
  ensureDir(CARDS_DIR);
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

function registerCard(cardName, cardDir) {
  const registry = loadRegistry();
  registry.cards[cardName] = {
    dir: cardDir,
    imported_at: new Date().toISOString(),
  };
  if (!registry.active) {
    registry.active = cardName;
  }
  saveRegistry(registry);
  console.log(`📋 已注册卡片: ${cardName}`);
}

/**
 * 激活指定卡片（更新软链接）
 */
function activateCard(cardName) {
  const registry = loadRegistry();
  if (!registry.cards[cardName]) {
    console.error(`❌ 卡片 "${cardName}" 未注册`);
    return false;
  }
  const cardDir = registry.cards[cardName].dir;

  // 删除旧链接/文件
  for (const p of [WORLD_BOOK_DST, STATE_PATH, RP_CONFIG_PATH]) {
    try {
      const st = statSync(p);
      if (st.isSymbolicLink() || st.isDirectory() || st.isFile()) {
        if (st.isDirectory()) {
          // 如果是真实目录（非链接），重命名备份而非删除
          const backup = p + '.backup_' + Date.now();
          renameSync(p, backup);
          console.log(`   📦 已备份: ${backup}`);
        } else {
          unlinkSync(p);
        }
      }
    } catch {}
  }

  // 创建软链接
  ensureDir(dirname(WORLD_BOOK_DST));
  symlinkSync(join(cardDir, 'worldbook'), WORLD_BOOK_DST, 'dir');
  symlinkSync(join(cardDir, 'state.json'), STATE_PATH, 'file');
  symlinkSync(join(cardDir, 'config.json'), RP_CONFIG_PATH, 'file');

  registry.active = cardName;
  saveRegistry(registry);
  console.log(`✅ 已激活卡片: ${cardName}`);
  console.log(`   worldbook → ${WORLD_BOOK_DST}`);
  console.log(`   state.json → ${STATE_PATH}`);
  console.log(`   config.json → ${RP_CONFIG_PATH}`);
  return true;
}

// ============================================================
// 步骤 1：复制世界书（文件名规范化）
// ============================================================

function stepCopyWorldbook() {
  console.log('📂 步骤 1/3: 复制世界书...');

  function copyDir(src, dst) {
    if (!existsSync(src)) return;
    ensureDir(dst);
    for (const f of readdirSync(src)) {
      const clean = cleanName(f);
      const s = join(src, f);
      const d = join(dst, clean);
      if (statSync(s).isDirectory()) {
        copyDir(s, d);
      } else {
        copyFileSync(s, d);
        if (f !== clean) {
          console.log(`  清理文件名: ${f} → ${clean}`);
        }
      }
    }
  }

  copyDir(WORLD_BOOK_SRC, WORLD_BOOK_DST);
  console.log('✅ 世界书已复制到 .pi/worldbook/（文件名已规范化）\n');
}

// ============================================================
// YAML 解析器
// ============================================================

function parseYamlLike(text) {
  const lines = text.split('\n');
  const root = {};
  const stack = [{ obj: root, indent: -1 }];

  for (const raw of lines) {
    const trimmed = raw.trimEnd();
    if (!trimmed.trim() || trimmed.trim().startsWith('#')) continue;

    const indent = raw.length - raw.trimStart().length;
    const content = trimmed.trimStart();
    const match = content.match(/^([^:]+?):\s*(.*)$/);
    if (!match) continue;

    const key = match[1].trim().replace(/'/g, '');
    const value = match[2].trim().replace(/'/g, '');

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }

    if (value === '') {
      const newObj = {};
      stack[stack.length - 1].obj[key] = newObj;
      stack.push({ obj: newObj, indent });
    } else {
      let parsed = value;
      if (value === 'true') parsed = true;
      else if (value === 'false') parsed = false;
      else if (/^\d+$/.test(value)) parsed = parseInt(value);
      stack[stack.length - 1].obj[key] = parsed;
    }
  }
  return root;
}

// ============================================================
// Schema 校验
// ============================================================

function validateCharData(name, data) {
  const errors = [];
  const requiredFields = [
    { path: '基本信息.姓名', label: '基本信息.姓名' },
    { path: '归属值', label: '归属值' },
    { path: '情分值', label: '情分值' },
    { path: '身份', label: '身份' },
    { path: '年龄', label: '年龄' },
  ];

  for (const { path, label } of requiredFields) {
    const v = getNested(data, path);
    if (v === undefined || v === null || v === '') {
      errors.push(`缺少必填字段: ${label}`);
    }
  }

  if (data['归属值'] !== undefined && data['归属值'] !== null) {
    const n = Number(data['归属值']);
    if (isNaN(n) || n < 0 || n > 100) {
      errors.push(`归属值超出范围 [0,100]: ${data['归属值']}`);
    }
  }

  if (data['情分值'] !== undefined && data['情分值'] !== null) {
    const n = Number(data['情分值']);
    if (isNaN(n) || n < 0 || n > 100) {
      errors.push(`情分值超出范围 [0,100]: ${data['情分值']}`);
    }
  }

  return errors;
}

function validateWorldData(data) {
  const errors = [];
  const requiredFields = ['当前日期', '当前星期', '当前时间', '当前位置'];
  for (const f of requiredFields) {
    if (!data[f]) {
      errors.push(`世界数据缺少必填字段: ${f}`);
    }
  }
  return errors;
}

// ============================================================
// 步骤 2：生成 state.json（标准流程）
// ============================================================

function stepGenerateState() {
  console.log('📊 步骤 2/3: 生成 state.json...');

  const initDir = join(WORLD_BOOK_SRC, '角色初始状态');
  const state = {};

  for (const f of readdirSync(initDir)) {
    const content = readFileSync(join(initDir, f), 'utf-8');
    const yamlMatch = content.match(/```yaml\n([\s\S]*?)```/);
    if (!yamlMatch) continue;

    let name = f.replace('.md', '');
    const nameMatch = content.match(/^#\s*(.+?)\s*-\s*初始/);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/'/g, '');
    }

    const data = parseYamlLike(yamlMatch[1]);
    state[name] = data;
  }

  // 从角色初始状态目录动态读取所有角色名，替代旧版硬编码
  const charNames = Object.keys(state).filter(k => k !== '世界' && k !== '{{user}}');
  const finalState = {
    世界: state['世界'] || { 当前日期: '2333-09-10', 当前星期: '星期一', 当前时间: '07:30', 当前位置: '学校' },
    '{{user}}': state['{{user}}'] || {},
  };

  // Schema 校验
  let hasErrors = false;
  const worldErrors = validateWorldData(state['世界'] || {});
  if (worldErrors.length > 0) {
    console.error('❌ 世界数据校验失败:');
    worldErrors.forEach(e => console.error(`   ${e}`));
    hasErrors = true;
  }

  for (const name of charNames) {
    const data = state[name];
    if (!data) {
      console.error(`❌ 角色 "${name}" 在角色初始状态目录中未找到`);
      hasErrors = true;
      continue;
    }
    const errors = validateCharData(name, data);
    if (errors.length > 0) {
      console.error(`❌ 角色 "${name}" 校验失败:`);
      errors.forEach(e => console.error(`   ${e}`));
      hasErrors = true;
    }
  }

  if (hasErrors) {
    console.error('\n❌ Schema 校验失败，请修正上述错误后重试。');
    process.exit(1);
  }

  console.log('✅ Schema 校验通过');

  for (const name of charNames) {
    finalState[name] = state[name] || { 基本信息: { 姓名: name } };
  }

  finalState['_meta'] = {
    version: 2,
    lastUpdated: new Date().toISOString(),
    trackedCharacters: charNames,
    route: '',
    routeOptions: [],
    started: false,
  };

  writeFileSync(STATE_PATH, JSON.stringify(finalState, null, 2), 'utf-8');
  console.log(`✅ state.json 已生成 (${Object.keys(finalState).length} 个条目: 世界, user, ${charNames.length} 个角色)`);
  console.log(`📂 位置: ${STATE_PATH}\n`);
}

// ============================================================
// ⭐ 步骤 3：SillyTavern 角色卡导入
// ============================================================

// ============================================================
// PNG chunk 解析（使用 png-chunks-extract + png-chunk-text）
// ============================================================

/** 多编码候选列表（按优先级排序） */
const ENCODING_CANDIDATES = ['utf-8', 'gbk', 'gb18030', 'shift-jis', 'windows-1252'];

/** 将 Buffer 按指定编码解码为字符串 */
function decodeBuffer(buf, encoding) {
  return Buffer.from(buf).toString(encoding);
}

/** 尝试将字符串解析为角色卡 JSON：纯 JSON → base64 JSON → base64+zlib JSON */
function tryParseCardText(rawText) {
  const trimmed = rawText.trim();

  // 方式1: 纯 JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed);
  }

  // 方式2: Base64（含 URL-safe 变体）
  const b64Candidates = [trimmed];
  if (trimmed.includes('-') || trimmed.includes('_')) {
    b64Candidates.push(trimmed.replace(/-/g, '+').replace(/_/g, '/'));
  }

  for (const b64 of b64Candidates) {
    try {
      const decoded = Buffer.from(b64, 'base64');
      const utf8 = decoded.toString('utf-8');
      if (utf8.startsWith('{') || utf8.startsWith('[')) {
        return JSON.parse(utf8);
      }
      // 尝试 zlib 解压
      try {
        const decompressed = inflateSync(decoded);
        const decompUtf8 = decompressed.toString('utf-8');
        if (decompUtf8.startsWith('{') || decompUtf8.startsWith('[')) {
          return JSON.parse(decompUtf8);
        }
      } catch { /* 非 zlib 数据 */ }
    } catch { /* base64 解码失败 */ }
  }

  return null;
}

/**
 * 使用 png-chunks-extract 解析 PNG 角色卡
 *
 * 支持的 chunk 类型：tEXt、zTXt、iTXt
 * 支持的关键词：chara（V2）、ccv3（V3）
 * 自动尝试多种编码解码
 */
function parsePNGCharacterCard(filePath) {
  console.log(`🔍 解析 PNG 角色卡: ${filePath}`);

  const buffer = readFileSync(filePath);

  // 使用 png-chunks-extract 提取所有 chunk
  let chunks;
  try {
    chunks = extractChunks(buffer);
  } catch (e) {
    throw new Error(`文件不是有效的 PNG 格式，无法提取 chunk：${e.message}`);
  }

  // 收集 tEXt / zTXt / iTXt chunk 的原始数据
  const textChunkTypes = new Set(['tEXt', 'zTXt', 'iTXt']);
  const cardChunks = [];

  for (const chunk of chunks) {
    if (!textChunkTypes.has(chunk.name)) continue;

    let keyword, rawData;

    if (chunk.name === 'tEXt') {
      // png-chunk-text.decode 直接解析 tEXt 为 {keyword, text}
      try {
        const decoded = decodeTextChunk(chunk);
        keyword = decoded.keyword;
        rawData = Buffer.from(decoded.text, 'latin1'); // 保留原始字节
      } catch {
        continue; // 格式异常，跳过
      }
    } else if (chunk.name === 'zTXt') {
      // zTXt: keyword\0压缩方法\压缩数据
      const data = Buffer.from(chunk.data);
      const nullPos = data.indexOf(0);
      if (nullPos === -1) continue;
      keyword = data.slice(0, nullPos).toString('ascii');
      const cm = data[nullPos + 1];
      if (cm !== 0) continue; // 不支持的压缩方法
      try {
        rawData = inflateSync(data.slice(nullPos + 2));
      } catch {
        continue; // 解压失败
      }
    } else if (chunk.name === 'iTXt') {
      // iTXt: keyword\0压缩标志\0压缩方法\0语言\0翻译关键词\0数据
      const data = Buffer.from(chunk.data);
      let pos = 0;
      // keyword
      const kwEnd = data.indexOf(0, pos);
      if (kwEnd === -1) continue;
      keyword = data.slice(pos, kwEnd).toString('ascii');
      pos = kwEnd + 1;
      // 压缩标志
      const compFlag = data[pos];
      pos++;
      // 压缩方法
      const compMethod = data.indexOf(0, pos);
      if (compMethod === -1) continue;
      pos = compMethod + 1;
      // 语言标签
      const langEnd = data.indexOf(0, pos);
      if (langEnd === -1) continue;
      pos = langEnd + 1;
      // 翻译关键词
      const transKwEnd = data.indexOf(0, pos);
      if (transKwEnd === -1) continue;
      pos = transKwEnd + 1;
      // 文本数据
      const textBytes = data.slice(pos);
      if (compFlag === 1) {
        try {
          rawData = inflateSync(textBytes);
        } catch {
          continue;
        }
      } else {
        rawData = textBytes;
      }
    }

    if (keyword === 'chara' || keyword === 'ccv3') {
      cardChunks.push({ keyword, rawData, type: chunk.name });
    }
  }

  if (cardChunks.length === 0) {
    throw new Error(
      'PNG 文件中未找到角色卡数据。' +
      '请确认此 PNG 是由 SillyTavern 导出的角色卡（需包含 "chara" 或 "ccv3" 元数据）。'
    );
  }

  // 对每个 chunk 尝试多编码解析
  const candidates = [];
  for (const { keyword, rawData, type } of cardChunks) {
    // iTXt 规范要求 UTF-8；tEXt/zTXt 实际编码混乱，需多编码尝试
    const encodings = type === 'iTXt' ? ['utf-8'] : ENCODING_CANDIDATES;

    for (const enc of encodings) {
      try {
        const text = decodeBuffer(rawData, enc);
        const parsed = tryParseCardText(text);
        if (parsed) {
          // 评分：乱码字符越少越好
          const garbledCount = (text.match(/�/g) || []).length;
          candidates.push({ parsed, score: garbledCount, source: `${keyword}(${type})/${enc}` });
        }
      } catch { /* 此编码组合失败 */ }
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      '无法解析 PNG 中的角色卡数据。' +
      `已尝试 ${cardChunks.length} 个文本 chunk、多种编码组合，均无法提取有效 JSON。` +
      '请确认角色卡文件未损坏。'
    );
  }

  // 选评分最低的（0 = 无乱码）
  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  if (best.score > 0) {
    console.warn(`   ⚠️ 最佳解析结果仍有 ${best.score} 个乱码字符 (来源: ${best.source})`);
  } else {
    console.log(`   ✔ 解析成功 (来源: ${best.source})`);
  }

  return best.parsed;
}

/**
 * 解析 JSON 角色卡文件
 */
function parseJSONCharacterCard(filePath) {
  console.log(`🔍 解析 JSON 角色卡: ${filePath}`);
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * 解析任意角色卡文件（自动检测 PNG / JSON）
 */
function parseCharacterCard(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`角色卡文件不存在: ${filePath}`);
  }

  const ext = extname(filePath).toLowerCase();
  if (ext === '.png') {
    return parsePNGCharacterCard(filePath);
  } else if (ext === '.json') {
    return parseJSONCharacterCard(filePath);
  } else {
    throw new Error(`不支持的角色卡格式: ${ext}（仅支持 .png 和 .json）`);
  }
}

// ============================================================
// 角色卡字段提取
// ============================================================

/**
 * 从角色卡 JSON 的 data 字段提取关键信息
 *
 * SillyTavern 格式的 data 字段包含：
 *   name, description, personality, scenario,
 *   first_mes, mes_example, system_prompt, post_history_instructions,
 *   character_book (可选)
 *
 * 同时兼容直接放在根级的字段（部分导出格式）
 */
function extractCharacterData(card) {
  // 尝试 data 字段（标准 SillyTavern 格式），没有则用根级
  const source = card.data || card;

  const fields = [
    'name', 'description', 'personality', 'scenario',
    'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions',
    'creator_notes', 'character_version',
  ];

  const extracted = {};
  const missing = [];

  for (const f of fields) {
    if (source[f] !== undefined && source[f] !== null && source[f] !== '') {
      extracted[f] = source[f];
    } else {
      if (['name', 'description'].includes(f)) {
        missing.push(f);
      }
      extracted[f] = '';
    }
  }

  // 提取 character_book（世界书条目）
  extracted.character_book = source.character_book || card.character_book || null;

  // 提取 regex_scripts（正则脚本）
  const regexScripts = source.extensions?.regex_scripts
    || card.extensions?.regex_scripts
    || [];
  extracted.regex_scripts = regexScripts;

  // 提取 tavern_helper（酒馆助手脚本）
  let tavernHelper = source.extensions?.tavern_helper
    || card.extensions?.tavern_helper
    || source.extensions?.TavernHelper_scripts
    || card.extensions?.TavernHelper_scripts
    || [];
  // 如果是 [["scripts", [...]], ...] 格式，提取 scripts 数组
  if (Array.isArray(tavernHelper) && tavernHelper.length > 0 && Array.isArray(tavernHelper[0])) {
    const scriptsEntry = tavernHelper.find(e => Array.isArray(e) && e[0] === 'scripts');
    if (scriptsEntry) {
      tavernHelper = scriptsEntry[1] || [];
    }
  }
  extracted.tavern_helper = tavernHelper;

  // 提取额外元数据
  extracted.spec = card.spec || '';
  extracted.spec_version = card.spec_version || '';
  extracted.create_date = card.create_date || new Date().toISOString();

  return { extracted, missing };
}

// ============================================================
// 生成世界书 .md 文件（从 character_book.entries）
//
// 规则：全部导入，不丢弃任何条目。
//   - enabled !== false → 放入角色设定/ 目录
//   - enabled === false → 放入角色设定/disabled/ 子目录
//   原因：SillyTavern 中 disabled 条目通常对应不同路线或备用设定，
//         保留完整数据供后续路线切换使用。
// ============================================================
// 生成世界书 .md 文件（从 character_book.entries）
//
// 四目录结构（匹配引擎 worldbook.ts ACTIVE_DIRS）:
//   [常开]设定/     - enabled + constant === true
//   [触发]关键词/   - enabled + constant === false
//   [禁用]常开设定/  - disabled + constant === true
//   [禁用]触发词条/  - disabled + constant === false
//
// 文件名格式: {4位编号}-{安全标题}.md
// 编号来自 ST order 字段（1-based 显示），同号自动加 _1 _2 后缀去重
//
// 保留 SillyTavern 原始 metadata 到 YAML front matter：
//   keywords, priority(order), selective, secondary_keys(keysecondary),
//   constant, position, depth, enabled
// ============================================================ */

function generateWorldbookEntries(characterData, charName, worldbookDir) {
  const book = characterData.character_book;
  if (!book || !book.entries || book.entries.length === 0) {
    console.log(`   info 角色 "${charName}" 无 character_book，跳过世界书条目生成`);
    return 0;
  }

  // 清理旧角色设定/ 目录（兼容旧版导入）
  const oldDir = join(worldbookDir, '角色设定');
  if (existsSync(oldDir)) {
    rmSync(oldDir, { recursive: true, force: true });
  }

  // 四目录结构
  const dirs = {
    constant:        join(worldbookDir, '[常开]设定'),
    trigger:         join(worldbookDir, '[触发]关键词'),
    disabledConst:   join(worldbookDir, '[禁用]常开设定'),
    disabledTrigger: join(worldbookDir, '[禁用]触发词条'),
  };
  for (const d of Object.values(dirs)) {
    if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    ensureDir(d);
  }

  let count = 0;
  for (const entry of book.entries) {
    const enabled = entry.enabled !== false;
    const constant = entry.constant === true;

    // 4 位编号前缀（从 ST order 字段，1-based 显示）
    const orderNum = (entry.order ?? entry.insertion_order ?? count) + 1;
    const prefix = String(orderNum).padStart(4, '0');

    // 选择目录
    let targetDir;
    if (enabled) {
      targetDir = constant ? dirs.constant : dirs.trigger;
    } else {
      targetDir = constant ? dirs.disabledConst : dirs.disabledTrigger;
    }

    // 提取字段
    const keys = entry.keys || entry.key || [];
    const keywordList = Array.isArray(keys) ? keys : [keys];
    const entryContent = entry.content || '';
    const comment = entry.comment || entry.name || ('条目' + (count + 1));
    const priority = entry.priority ?? entry.insertion_order ?? entry.order ?? count;
    const selective = entry.selective ?? (entry.selectiveLogic !== undefined ? !!entry.selectiveLogic : undefined);
    const secondaryKeys = entry.secondary_keys || entry.keysecondary || [];
    const position = entry.position ?? (constant ? 1 : undefined);
    const depth = entry.depth ?? 4;

    // 文件名：{4位编号}-{安全标题}.md
    const safeName = comment.replace(/[<>:"\/\\|?*]/g, '_').slice(0, 60);
    let fileName = prefix + '-' + safeName + '.md';
    let filePath = join(targetDir, fileName);
    let suffix = 1;
    while (existsSync(filePath)) {
      filePath = join(targetDir, prefix + '-' + safeName + '_' + suffix + '.md');
      suffix++;
    }

    // YAML front matter
    const fmLines = [
      '---',
      'name: "' + comment.replace(/"/g, '\\"') + '"',
      'keywords: [' + keywordList.map(k => '"' + k.replace(/"/g, '\\"') + '"').join(', ') + ']',
      'priority: ' + priority,
      'selective: ' + (selective ?? true),
      'constant: ' + constant,
      'position: ' + (position ?? 1),
      'depth: ' + depth,
      'enabled: ' + enabled,
      'source: "character_card:' + charName + '"',
    ];
    if (secondaryKeys.length > 0) {
      fmLines.push('secondary_keys: [' + secondaryKeys.map(k => '"' + k.replace(/"/g, '\\"') + '"').join(', ') + ']');
    }
    if (!enabled) fmLines.push('disabled: true');
    fmLines.push('---');

    writeFileSync(filePath, fmLines.join('\n') + '\n\n# ' + comment + '\n\n' + entryContent + '\n', 'utf-8');
    count++;
  }

  // 统计各目录
  const fileCounts = {};
  for (const [key, dir] of Object.entries(dirs)) {
    try { fileCounts[key] = readdirSync(dir).filter(f => f.endsWith('.md')).length; } catch { fileCounts[key] = 0; }
  }
  console.log('   check 世界书条目: ' + count + ' 个 -> ' + worldbookDir + '/');
  console.log('      [常开]设定: ' + fileCounts.constant + ' 个');
  console.log('      [触发]关键词: ' + fileCounts.trigger + ' 个');
  if (fileCounts.disabledConst > 0) console.log('      [禁用]常开设定: ' + fileCounts.disabledConst + ' 个');
  if (fileCounts.disabledTrigger > 0) console.log('      [禁用]触发词条: ' + fileCounts.disabledTrigger + ' 个');

  return count;
}

function generateCharacterDescriptionFile(characterData, charName, worldbookDir) {
  const charBookDir = worldbookDir;
  ensureDir(charBookDir);

  const ext = characterData;
  const desc = ext.description || '';
  const personality = ext.personality || '';
  const scenario = ext.scenario || '';
  const firstMes = ext.first_mes || '';
  const mesExample = ext.mes_example || '';
  const systemPrompt = ext.system_prompt || '';

  const content = [
    '# ' + charName,
    '',
    '## 基本信息',
    `- 姓名: ${charName}`,
    ext.creator_notes ? `- 创作者备注: ${ext.creator_notes}` : '',
    ext.character_version ? `- 角色版本: ${ext.character_version}` : '',
    '',
    '## 描述',
    desc || '(无)',
    '',
    '## 性格',
    personality || '(无)',
    '',
    '## 场景',
    scenario || '(无)',
    '',
    '## 开场白',
    firstMes || '(无)',
    '',
    '## 示例对话',
    mesExample || '(无)',
    '',
    '## 系统提示',
    systemPrompt || '(无)',
  ].filter(l => l !== undefined).join('\n');

  const safeName = charName.replace(/[<>:"/\\|?*]/g, '_');
  const filePath = join(charBookDir, `${safeName}_角色描述.md`);
  writeFileSync(filePath, content, 'utf-8');
  console.log(`   ✅ 角色描述文件: ${filePath}`);
}

// ============================================================
// 生成 worldbook_entries.json（保留完整 SillyTavern 元数据）
// ============================================================

function generateWorldbookJson(characterData, charName, worldbookDir) {
  const book = characterData.character_book;
  if (!book || !book.entries || book.entries.length === 0) return 0;

  const entries = {};
  for (let i = 0; i < book.entries.length; i++) {
    const raw = book.entries[i];
    entries[i] = {
      ...raw,
      key: raw.key || raw.keys || [],
      keysecondary: raw.keysecondary || raw.secondary_keys || [],
      content: raw.content || '',
      comment: raw.comment || raw.name || ('条目' + (i + 1)),
      constant: raw.constant === true,
      disable: raw.disable !== undefined ? raw.disable : (raw.enabled === false),
      selective: raw.selective !== undefined ? raw.selective : (raw.selectiveLogic !== undefined ? !!raw.selectiveLogic : true),
      priority: raw.priority ?? raw.insertion_order ?? raw.order ?? i,
      position: raw.position ?? 1,
      depth: raw.depth ?? 4,
      probability: raw.probability ?? 100,
      useProbability: raw.useProbability !== undefined ? raw.useProbability : (raw.probability != null && raw.probability < 100),
      group: raw.group || '',
      groupWeight: raw.groupWeight ?? 100,
      scanDepth: raw.scanDepth ?? null,
      caseSensitive: raw.caseSensitive ?? null,
      matchWholeWords: raw.matchWholeWords ?? null,
      characterFilter: raw.characterFilter || { isExclude: false, names: [], tags: [] },
      triggers: raw.triggers || [],
      delay: raw.delay ?? 0,
      cooldown: raw.cooldown ?? 0,
      sticky: raw.sticky ?? 0,
      excludeRecursion: raw.excludeRecursion !== undefined ? raw.excludeRecursion : false,
      preventRecursion: raw.preventRecursion !== undefined ? raw.preventRecursion : false,
      delayUntilRecursion: raw.delayUntilRecursion !== undefined ? raw.delayUntilRecursion : false,
      vectorized: raw.vectorized !== undefined ? raw.vectorized : false,
      role: raw.role ?? 0,
      order: raw.order ?? i,
      uid: raw.uid ?? i,
      displayIndex: raw.displayIndex ?? i,
      automationId: raw.automationId || '',
      addMemo: raw.addMemo !== undefined ? raw.addMemo : true,
      groupOverride: raw.groupOverride !== undefined ? raw.groupOverride : false,
      useGroupScoring: raw.useGroupScoring !== undefined ? raw.useGroupScoring : false,
      matchPersonaDescription: raw.matchPersonaDescription !== undefined ? raw.matchPersonaDescription : false,
      matchCharacterDescription: raw.matchCharacterDescription !== undefined ? raw.matchCharacterDescription : false,
      matchCharacterPersonality: raw.matchCharacterPersonality !== undefined ? raw.matchCharacterPersonality : false,
      matchCharacterDepthPrompt: raw.matchCharacterDepthPrompt !== undefined ? raw.matchCharacterDepthPrompt : false,
      matchScenario: raw.matchScenario !== undefined ? raw.matchScenario : false,
      matchCreatorNotes: raw.matchCreatorNotes !== undefined ? raw.matchCreatorNotes : false,
      selectiveLogic: raw.selectiveLogic ?? 0,
    };
  }

  const jsonData = {
    source: 'character_card:' + charName,
    generatedAt: new Date().toISOString(),
    totalEntries: Object.keys(entries).length,
    entries,
  };

  const jsonPath = join(worldbookDir, 'worldbook_entries.json');
  writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2), 'utf-8');
  console.log('   worldbook_entries.json (' + Object.keys(entries).length + ' 条)');
  return Object.keys(entries).length;
}



// ============================================================
// 生成 state.json 角色条目
// ============================================================

/**
 * 通用角色属性模板（与世界观无关）
 *
 * 只包含所有角色卡通用的基础字段。
 * 卡片专属字段（如花开蒂落、公民芯片等）由该卡的世界书定义，
 * 其他卡片通过酒馆脚本的 variable_schema 注入专属变量。
 */
function createDefaultCharTemplate(charName, characterData) {
  const ext = characterData;
  return {
    归属值: 0,
    情分值: 100,
    基本信息: {
      姓名: charName,
      描述: ext.description || '',
    },
    当前状态: {
      所在地点: '未知',
      内心想法: '',
    },
    // SillyTavern 导入元数据（供引擎层参考）
    _import: {
      source: 'character_card',
      system_prompt: ext.system_prompt || '',
      post_history_instructions: ext.post_history_instructions || '',
      first_mes: ext.first_mes || '',
      scenario: ext.scenario || '',
    },
  };
}

function updateStateWithCharacter(charName, charTemplate) {
  let state = {};

  if (existsSync(STATE_PATH)) {
    try {
      state = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
    } catch {
      console.log('   ⚠️ state.json 已损坏，将覆盖重建');
    }
  }

  // 确保基础结构存在
  if (!state['世界']) {
    state['世界'] = {
      当前日期: '2333-09-10',
      当前星期: '星期一',
      当前时间: '07:30',
      当前位置: '学校',
    };
  }

  if (!state['{{user}}']) {
    state['{{user}}'] = { 基本信息: { 姓名: '{{user}}' } };
  }

  // 更新/添加角色
  state[charName] = charTemplate;

  // 更新 meta
  const existingTracked = state['_meta']?.trackedCharacters || [];
  if (!existingTracked.includes(charName)) {
    existingTracked.push(charName);
  }

  state['_meta'] = {
    ...(state['_meta'] || {}),
    version: 2,
    lastUpdated: new Date().toISOString(),
    trackedCharacters: existingTracked,
    route: state['_meta']?.route || '',
    routeOptions: [],
    started: state['_meta']?.started || false,
  };

  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  console.log(`   ✅ state.json 已更新（新增角色: ${charName}）`);
}

// ============================================================
// 生成 .rpconfig.json
// ============================================================

function generateRPConfig(charName, characterData) {
  const ext = characterData;
  const config = {
    character: {
      name: charName,
      imported_at: new Date().toISOString(),
    },
    system_prompt_override: ext.system_prompt || '',
    post_history_instructions: ext.post_history_instructions || '',
    scenario: ext.scenario || '',
    first_message: ext.first_mes || '',
    author_note: `[系统指令：请以 ${charName} 的身份，保持生动详细的描写，关注角色心理活动。回复长度应在800-1200字之间。]`,
  };

  writeFileSync(RP_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`   ✅ .rpconfig.json 已生成`);
}

// ============================================================
// 生成正则脚本文件（保留兼容）
// ============================================================

function generateRegexScriptsFile(regexScripts, charName) {
  if (!regexScripts || regexScripts.length === 0) return 0;
  // 新版已改为存入卡片目录，此函数保留兼容
  const regexDir = join(PROJECT_DIR, '.pi', 'regex_scripts');
  ensureDir(regexDir);
  const safeName = charName.replace(/[<>:"/\\|?*]/g, '_');
  const filePath = join(regexDir, `${safeName}.json`);
  writeFileSync(filePath, JSON.stringify(regexScripts, null, 2), 'utf-8');
  console.log(`   ✅ 正则脚本: .pi/regex_scripts/${safeName}.json (${regexScripts.length} 条)`);
  return regexScripts.length;
}

// ============================================================
// 生成酒馆助手脚本文件（保留兼容）
// ============================================================

function generateTavernHelperFile(tavernHelper, charName) {
  if (!tavernHelper || tavernHelper.length === 0) return 0;
  // 新版已改为存入卡片目录，此函数保留兼容
  const helperDir = join(PROJECT_DIR, '.pi', 'tavern_scripts');
  ensureDir(helperDir);
  const safeName = charName.replace(/[<>:"/\\|?*]/g, '_');
  const filePath = join(helperDir, `${safeName}.json`);
  writeFileSync(filePath, JSON.stringify(tavernHelper, null, 2), 'utf-8');
  console.log(`   ✅ 酒馆脚本: .pi/tavern_scripts/${safeName}.json (${tavernHelper.length} 条)`);
  return tavernHelper.length;
}

// ============================================================
// ⭐ 预处理：正则脚本 → 卡片前端渲染配置 (regex_hooks.json)
// ============================================================

/**
 * 将 SillyTavern 正则脚本预处理为 RP Web 前端可用的渲染钩子。
 *
 * 处理规则：
 *   - findRegex → 替换为 JavaScript 可用的正则（去掉 / 包裹，转换标志）
 *   - replaceString → 保留 HTML 模板
 *   - placement: [1,2] → 渲染阶段 "display"（在 Markdown 转 HTML 之后）
 *   - placement: [2] 仅 → 渲染阶段 "prompt"（发送给 AI 前）
 *   - promptOnly → 仅 prompt 阶段，不渲染
 *   - markdownOnly → 在 Markdown 渲染之后执行
 *   - disabled → 跳过不处理
 *   - scriptName 含 "对AI隐藏" 或 promptOnly → prompt 阶段剥离
 *   - scriptName 含 "状态栏"/"选项" → 跳过（依赖外部资源，无法在 Web 前端运行）
 */
function preprocessRegexScripts(regexScripts, cardDir) {
  if (!regexScripts || regexScripts.length === 0) return 0;

  const hooks = [];
  let skippedExternal = 0;
  let skippedDisabled = 0;

  for (const script of regexScripts) {
    // 跳过禁用的
    if (script.disabled) {
      skippedDisabled++;
      continue;
    }

    const name = script.scriptName || '';

    // 跳过依赖外部资源的（状态栏、选项等需要远程 HTML）
    if (name.includes('状态栏') || name.includes('[选项]') || name.includes('开场')) {
      skippedExternal++;
      continue;
    }

    // 跳过 promptOnly 的（由服务端处理）
    if (script.promptOnly) {
      // 保留给引擎层的 prompt 阶段剥离逻辑（不在 state.json 存储无用数据）
      continue;
    }

    // 提取 findRegex → 转为 JavaScript RegExp 字符串（兼容 new RegExp() 构造）
    let findRegex = script.findRegex || '';
    // SillyTavern 格式: /pattern/flags  →  提取 pattern 和 flags
    let pattern = '';
    let flags = 'g';
    const regexMatch = findRegex.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      pattern = regexMatch[1];
      flags = regexMatch[2] || 'g';
    } else {
      // 不是标准 /pattern/flags 格式，跳过
      continue;
    }

    // 跳过对 AI 隐藏类（在 _import 中保留，引擎层处理）
    if (name.includes('对AI隐藏')) {
      continue;
    }

    hooks.push({
      name,
      pattern,
      flags,
      replacement: script.replaceString || '',
      placement: script.placement || [1],
    });
  }

  // 写入卡片目录
  const hooksPath = join(cardDir, 'regex_hooks.json');
  writeFileSync(hooksPath, JSON.stringify(hooks, null, 2), 'utf-8');

  if (hooks.length > 0) {
    console.log(`   🔧 正则预处理: ${hooks.length} 条渲染钩子 → regex_hooks.json`);
  }
  if (skippedExternal > 0) {
    console.log(`   ⚠️ 跳过 ${skippedExternal} 条外部资源依赖脚本（状态栏/选项/开场页）`);
  }
  if (skippedDisabled > 0) {
    console.log(`   ⚠️ 跳过 ${skippedDisabled} 条已禁用脚本`);
  }

  return hooks.length;
}

// ============================================================
// ⭐ 预处理：酒馆脚本 → 角色变量定义 (variable_schema.json)
// ============================================================

/**
 * 从酒馆脚本中提取 Zod Schema，预处理为 RP Engine 可用的变量定义。
 *
 * 提取规则：
 *   - 从 "变量结构设计" 脚本中解析 z.object({...}) 结构
 *   - 提取角色名和对应字段 → 写入 variable_schema.json
 *   - 字段的默认值根据类型推断：
 *       z.number() → 0, z.boolean() → false, z.string() → ""
 *   - 排除 "世界" 键（由引擎全局管理）
 */
function preprocessTavernScripts(tavernHelper, cardDir, cardStatePath) {
  if (!tavernHelper || tavernHelper.length === 0) return 0;

  // 查找 "变量结构设计" 脚本
  const schemaScript = tavernHelper.find(
    s => s.name === '变量结构设计' || s.name?.includes('变量结构')
  );
  if (!schemaScript) {
    // 没有变量结构定义，不是所有卡片都需要
    return 0;
  }

  const content = schemaScript.content || '';

  // 提取 z.object({...}) 中的 key: z.xxx() 模式
  const charVariables = {};

  // 匹配: 角色名: z.object({...})
  const charRegex = /(\S+):\s*z\.object\(\{([^}]*)\}/g;
  let match;
  while ((match = charRegex.exec(content)) !== null) {
    const charName = match[1].trim();
    const fieldsBlock = match[2];

    if (charName === '世界') continue; // 世界数据由引擎管理

    const fields = {};
    // 匹配: 字段名: z.string/boolean/number
    const fieldRegex = /(\S+):\s*z\.(?:coerce\.)?(string|boolean|number)\(\)/g;
    let fm;
    while ((fm = fieldRegex.exec(fieldsBlock)) !== null) {
      const fieldName = fm[1].trim();
      const fieldType = fm[2];
      fields[fieldName] =
        fieldType === 'number' ? 0 :
        fieldType === 'boolean' ? false :
        ''; // string 默认空字符串
    }

    if (Object.keys(fields).length > 0) {
      charVariables[charName] = fields;
    }
  }

  // 提取顶级 "事件" 字段（如果存在）
  const eventMatch = content.match(/事件:\s*z\.object\(\{([^}]*)\}/);
  if (eventMatch) {
    const eventFields = {};
    const efRegex = /(\S+):\s*z\.boolean\(\)/g;
    let efm;
    while ((efm = efRegex.exec(eventMatch[1])) !== null) {
      eventFields[efm[1].trim()] = false;
    }
    if (Object.keys(eventFields).length > 0) {
      charVariables['事件'] = eventFields;
    }
  }

  if (Object.keys(charVariables).length === 0) return 0;

  // 写入卡片目录
  const schemaPath = join(cardDir, 'variable_schema.json');
  writeFileSync(schemaPath, JSON.stringify(charVariables, null, 2), 'utf-8');

  // 合并到卡片 state.json 中（为每个角色添加变量字段）
  if (existsSync(cardStatePath)) {
    try {
      const cardState = JSON.parse(readFileSync(cardStatePath, 'utf-8'));
      for (const [charName, fields] of Object.entries(charVariables)) {
        if (charName === '事件') {
          // 事件字段挂到卡片 meta 下
          cardState['事件'] = cardState['事件'] || fields;
        } else {
          // 如果角色已存在于 state 中，合并字段；否则创建
          if (cardState[charName]) {
            for (const [fname, fval] of Object.entries(fields)) {
              if (!(fname in cardState[charName])) {
                cardState[charName][fname] = fval;
              }
            }
          } else {
            cardState[charName] = {
              归属值: 0,
              情分值: 100,
              基本信息: { 姓名: charName },
              ...fields,
            };
          }
        }
      }
      // 更新 trackedCharacters
      if (cardState['_meta']) {
        const existing = cardState['_meta'].trackedCharacters || [];
        for (const name of Object.keys(charVariables)) {
          if (name !== '事件' && !existing.includes(name)) {
            existing.push(name);
          }
        }
      }
      writeFileSync(cardStatePath, JSON.stringify(cardState, null, 2), 'utf-8');
    } catch { /* state 写入失败不影响主流程 */ }
  }

  const charNames = Object.keys(charVariables).filter(k => k !== '事件');
  console.log(`   🍺 变量预处理: ${charNames.length} 个角色 (${charNames.join(', ')}) → variable_schema.json + state.json`);

  return charNames.length;
}

// ============================================================
// 角色卡导入主流程
// ============================================================

function importCharacterCard(filePath, targetDir) {
  console.log(`\n🎭 ===== 导入角色卡 =====`);
  console.log(`📄 文件: ${filePath}\n`);

  // 1. 解析角色卡
  let card;
  try {
    card = parseCharacterCard(filePath);
  } catch (e) {
    console.error(`❌ 解析失败: ${e.message}`);
    process.exit(1);
  }

  // 2. 提取数据
  const { extracted, missing } = extractCharacterData(card);

  // 3. 字段完整性检查
  if (missing.length > 0) {
    console.error('❌ 角色卡字段不完整，缺少以下关键字段:');
    for (const f of missing) {
      console.error(`   - ${f}${f === 'name' ? '（角色名，必须提供）' : '（角色描述，强烈建议提供）'}`);
    }
    if (missing.includes('name')) {
      console.error('\n❌ 缺少 name 字段，无法继续导入。');
      process.exit(1);
    }
    console.warn('⚠️ 部分字段缺失，将以默认值填充，继续导入...\n');
  }

  const charName = extracted.name;
  console.log(`👤 角色名: ${charName}`);

  if (extracted.description) {
    const descPreview = extracted.description.slice(0, 80).replace(/\n/g, ' ');
    console.log(`📝 描述: ${descPreview}...`);
  }
  if (extracted.personality) {
    const persPreview = extracted.personality.slice(0, 60).replace(/\n/g, ' ');
    console.log(`💭 性格: ${persPreview}...`);
  }
  if (extracted.character_book?.entries?.length) {
    console.log(`📚 世界书条目: ${extracted.character_book.entries.length} 条`);
  }
  if (extracted.regex_scripts?.length) {
    console.log(`🔧 正则脚本: ${extracted.regex_scripts.length} 条`);
  }
  if (extracted.tavern_helper?.length) {
    console.log(`🍺 酒馆脚本: ${extracted.tavern_helper.length} 条`);
  }
  console.log('');

  // 确定目标目录
  const cardDir = targetDir || join(CARDS_DIR, charName);
  const cardWorldbook = join(cardDir, 'worldbook');
  const cardStatePath = join(cardDir, 'state.json');
  const cardConfigPath = join(cardDir, 'config.json');
  const cardSystemPath = join(cardDir, 'APPEND_SYSTEM.md');

  // 4. 确保目录存在
  ensureDir(cardWorldbook);

  // 5. 生成角色描述 .md
  generateCharacterDescriptionFile(extracted, charName, cardWorldbook);

  // 6. 生成世界书条目 .md
  const entryCount = generateWorldbookEntries(extracted, charName, cardWorldbook);

  // 6a. 生成 worldbook_entries.json（保留完整 ST 元数据，供引擎直接读取）
  generateWorldbookJson(extracted, charName, cardWorldbook);

  // 7. 生成独立 state.json
  generateStandaloneState(charName, extracted, cardStatePath);

  // 8. 生成正则脚本（存入卡片目录下）
  const regexCount = generateRegexScriptsFileToDir(extracted.regex_scripts, charName, cardDir);

  // 9. 生成酒馆脚本
  const tavernCount = generateTavernHelperFileToDir(extracted.tavern_helper, charName, cardDir);

  // 10. ⭐ 预处理：正则脚本 → 前端渲染钩子
  const regexHooksCount = preprocessRegexScripts(extracted.regex_scripts, cardDir);

  // 11. ⭐ 预处理：酒馆脚本 → 角色变量定义 + 合并到 state.json
  const varSchemaCount = preprocessTavernScripts(extracted.tavern_helper, cardDir, cardStatePath);

  // 11a. ⭐ 扫描脚本中的远程 URL，记录到 remote_urls.json
  const remoteUrlCount = scanRemoteUrls(extracted.regex_scripts, extracted.tavern_helper, cardDir);

  // 11b. ⭐ 在卡片目录生成一条待办标记，提示 AI 完成本地化和向量检索
  generatePostImportTodo(charName, cardDir, remoteUrlCount, entryCount, regexCount, tavernCount);

  // 12. 生成 card config.json
  generateCardConfig(charName, extracted, cardConfigPath);

  // 13. 生成 APPEND_SYSTEM.md
  generateCardSystemPrompt(charName, extracted, cardSystemPath);

  // 14. 注册卡片
  registerCard(charName, cardDir);

  // 15. 总结
  console.log(`\n✅ 角色卡 "${charName}" 导入完成！`);
  console.log(`   📂 卡片目录: ${cardDir}`);
  console.log(`   - 角色描述: ${cardWorldbook}/${charName}_角色描述.md`);
  if (entryCount > 0) {
    console.log(`   - 世界书条目: ${cardWorldbook}/ （${entryCount} 个文件，分布在世界书 4 个子目录中）`);
  }
  if (regexHooksCount > 0) {
    console.log(`   - 渲染钩子: ${cardDir}/regex_hooks.json (${regexHooksCount} 条)`);
  }
  if (varSchemaCount > 0) {
    console.log(`   - 变量定义: ${cardDir}/variable_schema.json (${varSchemaCount} 个角色)`);
  }
  if (regexCount > 0) {
    console.log(`   - 正则脚本(原始): ${cardDir}/regex_scripts/ (${regexCount} 条)`);
  }
  if (tavernCount > 0) {
    console.log(`   - 酒馆脚本(原始): ${cardDir}/tavern_scripts/ (${tavernCount} 条)`);
  }
  console.log(`   - 状态文件: ${cardStatePath}`);
  console.log(`   - RP 配置: ${cardConfigPath}`);
  console.log(`   - 系统提示: ${cardSystemPath}`);
  console.log('');

  return cardDir;
}

// ============================================================
// 生成独立 state.json（新卡用，不污染全局 state）
// ============================================================

function generateStandaloneState(charName, characterData, statePath) {
  const charTemplate = createDefaultCharTemplate(charName, characterData);
  const state = {
    '{{user}}': {
      基本信息: { 姓名: '{{user}}' },
    },
    [charName]: charTemplate,
    _meta: {
      version: 3,
      lastUpdated: new Date().toISOString(),
      trackedCharacters: [charName],
      started: false,
    },
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  console.log(`   ✅ 独立 state.json → ${statePath}`);
}

// ============================================================
// 生成卡片专属 config.json
// ============================================================

function generateCardConfig(charName, characterData, configPath) {
  const ext = characterData;
  const config = {
    character: {
      name: charName,
      imported_at: new Date().toISOString(),
    },
    system_prompt_override: ext.system_prompt || '',
    post_history_instructions: ext.post_history_instructions || '',
    scenario: ext.scenario || '',
    first_message: ext.first_mes || '',
    author_note: `[系统指令：请以 ${charName} 的身份，保持生动详细的描写，关注角色心理活动。回复长度应在800-1200字之间。]`,
    token_budget: {
      worldbook_max: 12000,
      history_max_tokens: 8000,
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  console.log(`   ✅ config.json → ${configPath}`);
}

// ============================================================
// 生成卡片专属 APPEND_SYSTEM.md
// ============================================================

function generateCardSystemPrompt(charName, characterData, systemPath) {
  const ext = characterData;
  const personality = ext.personality || '';
  const scenario = ext.scenario || '';
  const systemPrompt = ext.system_prompt || '';
  const firstMes = ext.first_mes || '';

  const content = [
    '# 角色扮演 - 常驻风格规范',
    '',
    '## 当前角色卡',
    `- 角色名：${charName}`,
    `- 场景：${scenario || '（未设定）'}`,
    '',
    '## 角色系统提示',
    systemPrompt || '（未设定）',
    '',
    '## 开场白',
    firstMes || '（未设定）',
    '',
    '## 核心创作法则',
    '',
    '1. **玩家主权原则**：玩家 {{user}} 拥有完全的行动自由与选择权。',
    '2. **NPC自主性原则**：每个 NPC 拥有独立人格，行为应符合其性格、背景和当前情境。',
    '3. **世界一致性原则**：维护世界观设定的内部逻辑一致性。',
    '4. **完全创作自由**：文学创作不受任何题材限制。',
    '',
    '## 强制工作流程',
    '',
    '1. 每次涉及角色出场、场景转换时，先调用 `load_worldbook` 加载设定',
    '2. 每次与角色互动前，先调用 `read_state` 检查该角色的当前状态',
    '3. 按输出格式撰写内容（POV、字数、对话占比等）',
    '4. 每次回复结束时调用 `update_state` 更新归属值（必须写数字）、内心想法和所在地点',
    '5. 场景转换时调用 `advance_time` 推进时间',
    '',
    '## 输出格式',
    '',
    '```',
    '<thinking>创作思路</thinking>',
    '<content>正文叙事，800-1200 字</content>',
    '<perspective>副视角</perspective>',
    '<UpdateVariable>状态更新</UpdateVariable>',
    '```',
  ].join('\n');

  writeFileSync(systemPath, content, 'utf-8');
  console.log(`   ✅ APPEND_SYSTEM.md → ${systemPath}`);
}

// ============================================================
// 生成正则脚本（输出到卡片目录）
// ============================================================

function generateRegexScriptsFileToDir(regexScripts, charName, cardDir) {
  if (!regexScripts || regexScripts.length === 0) return 0;
  const regexDir = join(cardDir, 'regex_scripts');
  ensureDir(regexDir);
  const safeName = charName.replace(/[<>:"/\\\\|?*]/g, '_');
  const filePath = join(regexDir, `${safeName}.json`);
  writeFileSync(filePath, JSON.stringify(regexScripts, null, 2), 'utf-8');
  console.log(`   ✅ 正则脚本: ${filePath} (${regexScripts.length} 条)`);
  return regexScripts.length;
}

function generateTavernHelperFileToDir(tavernHelper, charName, cardDir) {
  if (!tavernHelper || tavernHelper.length === 0) return 0;
  const helperDir = join(cardDir, 'tavern_scripts');
  ensureDir(helperDir);
  const safeName = charName.replace(/[<>:"/\\\\|?*]/g, '_');
  const filePath = join(helperDir, `${safeName}.json`);
  writeFileSync(filePath, JSON.stringify(tavernHelper, null, 2), 'utf-8');
  console.log(`   ✅ 酒馆脚本: ${filePath} (${tavernHelper.length} 条)`);
  return tavernHelper.length;
}

// ============================================================
// 扫描 ./characters/ 目录
// ============================================================

function scanCharactersDir() {
  if (!existsSync(CHARACTERS_DIR)) {
    console.log(`ℹ️ 未找到 ${CHARACTERS_DIR} 目录，跳过扫描\n`);
    return;
  }

  const files = readdirSync(CHARACTERS_DIR)
    .filter(f => /\.(png|json)$/i.test(f))
    .sort();

  if (files.length === 0) {
    console.log(`ℹ️ ${CHARACTERS_DIR} 目录下没有角色卡文件\n`);
    return;
  }

  console.log(`🔍 发现 ${files.length} 个角色卡文件:\n`);
  for (const f of files) {
    const ext = extname(f).toLowerCase();
    const icon = ext === '.png' ? '🖼️' : '📋';
    console.log(`   ${icon} ${f}`);
  }
  console.log('');

  for (const f of files) {
    const filePath = join(CHARACTERS_DIR, f);
    importCharacterCard(filePath);
  }

  console.log(`✅ 已导入 ${files.length} 个角色卡\n`);
}

// ============================================================
// 步骤 3：完成提示
// ============================================================

function stepFinish() {
  console.log('🎉 ===== 初始化完成 =====');
  console.log('');
  console.log('下一步:');
  console.log('  1. 启动 pi: pi');
  console.log('  2. 选择路线: /route 路线名称');
  console.log('  3. 打开 RP Web: http://localhost:3002');
  console.log('  4. 开始角色扮演！');
}

// ============================================================
// 卡片管理命令
// ============================================================

function listCards() {
  const registry = loadRegistry();
  console.log('📋 已注册卡片:\n');
  for (const [name, info] of Object.entries(registry.cards)) {
    const marker = name === registry.active ? ' ★ 当前活跃' : '';
    console.log(`   ${marker ? '🟢' : '⚪'} ${name}${marker}`);
    console.log(`     目录: ${info.dir}`);
    console.log(`     导入时间: ${info.imported_at}`);
  }
  if (Object.keys(registry.cards).length === 0) {
    console.log('   （无）');
  }
  console.log('');
}

function registerLegacyCard() {
  // 注册旧版卡片（兼容旧项目结构迁移）
  if (!existsSync(WORLD_BOOK_DST)) return;

  const registry = loadRegistry();
  const CARD_NAME = '默认角色卡';
  if (registry.cards[CARD_NAME]) return;

  const cardDir = join(CARDS_DIR, CARD_NAME);

  if (!existsSync(cardDir)) {
    ensureDir(cardDir);

    if (existsSync(WORLD_BOOK_DST)) {
      copyDirSync(WORLD_BOOK_DST, join(cardDir, 'worldbook'));
    }
    if (existsSync(STATE_PATH)) {
      copyFileSync(STATE_PATH, join(cardDir, 'state.json'));
    }
    if (existsSync(RP_CONFIG_PATH)) {
      copyFileSync(RP_CONFIG_PATH, join(cardDir, 'config.json'));
    }
    const appendPath = join(PROJECT_DIR, '.pi', 'APPEND_SYSTEM.md');
    if (existsSync(appendPath)) {
      copyFileSync(appendPath, join(cardDir, 'APPEND_SYSTEM.md'));
    }
  }

  registerCard(CARD_NAME, cardDir);
}

function copyDirSync(src, dst) {
  ensureDir(dst);
  for (const f of readdirSync(src)) {
    const s = join(src, f);
    const d = join(dst, f);
    if (statSync(s).isDirectory()) {
      copyDirSync(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}

// ============================================================
// 主入口
// ============================================================

function main() {
  const args = process.argv.slice(2);

  // 解析命令行参数
  let mode = 'standard';      // standard | import | scan | register-legacy | list
  let characterPath = '';
  let targetDir = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--character' || args[i] === '-c' || args[i] === '--import' || args[i] === '-i') {
      mode = 'import';
      characterPath = args[i + 1] || '';
      i++;
    } else if (args[i] === '--target' || args[i] === '-t') {
      targetDir = args[i + 1] || '';
      i++;
    } else if (args[i] === '--scan' || args[i] === '-s') {
      mode = 'scan';
    } else if (args[i] === '--activate' || args[i] === '-a') {
      mode = 'activate';
      characterPath = args[i + 1] || '';
      i++;
    } else if (args[i] === '--list') {
      mode = 'list';
    } else if (args[i] === '--register-legacy') {
      mode = 'register-legacy';
    } else if (args[i] === '--help' || args[i] === '-h') {
      showHelp();
      return;
    }
  }

  console.log('🚀 角色扮演 · 卡片管理');
  console.log('========================\n');

  switch (mode) {
    case 'import':
      if (!characterPath) {
        console.error('❌ 请指定角色卡路径: node setup.mjs --import <path>');
        process.exit(1);
      }
      importCharacterCard(characterPath, targetDir || '');
      break;

    case 'activate':
      if (!characterPath) {
        console.error('❌ 请指定卡片名: node setup.mjs --activate <name>');
        process.exit(1);
      }
      activateCard(characterPath);
      break;

    case 'list':
      listCards();
      break;

    case 'register-legacy':
      registerLegacyCard();
      break;

    case 'scan':
      stepCopyWorldbook();
      stepGenerateState();
      scanCharactersDir();
      stepFinish();
      break;

    case 'standard':
    default:
      stepCopyWorldbook();
      stepGenerateState();
      registerLegacyCard();
      stepFinish();
      break;
  }
}

// ============================================================
// ⭐ 扫描脚本中的远程 URL
// ============================================================

function scanRemoteUrls(regexScripts, tavernHelper, cardDir) {
  const urls = [];
  const seen = new Set();

  function collect(text, source) {
    if (!text) return;
    const matches = text.matchAll(/https?:\/\/[^\s"'<>\]]+/g);
    for (const m of matches) {
      const url = m[0].replace(/[,;)}\\]+$/, '');
      if (!seen.has(url)) {
        seen.add(url);
        urls.push({ url, source, type: guessURLType(url) });
      }
    }
  }

  for (const s of (regexScripts || [])) {
    collect(s.replaceString, `regex: ${s.scriptName}`);
    collect(s.findRegex, `regex: ${s.scriptName}`);
  }
  for (const s of (tavernHelper || [])) {
    collect(s.content, `tavern: ${s.name}`);
  }

  if (urls.length > 0) {
    writeFileSync(join(cardDir, 'remote_urls.json'), JSON.stringify(urls, null, 2), 'utf-8');
    console.log(`   🔗 远程 URL: ${urls.length} 个 → remote_urls.json`);
  }
  return urls.length;
}

function guessURLType(url) {
  if (url.includes('jsdelivr') || url.includes('cdn')) return 'cdn_script';
  if (url.includes('gitgud.io') || url.includes('raw')) return 'image_base_url';
  if (url.includes('.js')) return 'javascript';
  if (url.includes('.html')) return 'html_page';
  return 'unknown';
}

// ============================================================
// ⭐ 生成导入后待办标记
// ============================================================

function generatePostImportTodo(charName, cardDir, remoteUrlCount, worldbookEntryCount, regexCount, tavernCount) {
  const todos = [];

  if (remoteUrlCount > 0) {
    todos.push(`### 1. 脚本与正则本地化

卡片包含 ${remoteUrlCount} 个远程 URL（见 remote_urls.json）。

在完成本地化后，产物放入卡片目录下的约定子目录：

#### 产物位置约定
| 远程资源类型 | 本地产物位置 | 引擎接口 |
|-------------|-------------|---------|
| 状态栏 HTML/JS | \`ui/status-bar.html\` + \`ui/status-bar.js\` | 引擎 session_start 时扫描卡片 \`ui/\` 目录，通过 WS 下发给前端加载 |
| 选项页 | 不需要（RP Web 的 \`<choice>\` 按钮已覆盖） | — |
| 开场页 | 不需要（AI 的开场白 + welcome 页面已覆盖） | — |
| MVU Zod bundle | \`scripts/mvu-parser.js\`（本地 json_patch 解析器） | \`regex-processor.ts\` 加载并注册为自定义钩子 |
| 图片 CDN | \`assets/\` 目录存放本地图片，更新 \`regex_hooks.json\` 中的路径 | 前端渲染钩子自动应用 |
| 世界书排序/设置脚本 | 不需要（引擎已自行管理） | — |

#### 具体步骤
- [ ] 读取 remote_urls.json 中的 URL 列表
- [ ] 下载每个 cdn_script 的源码，分析其功能
- [ ] 将远程 HTML 页面重建为本地 Vanilla JS 组件（不依赖 Vue/Pinia/jQuery）
- [ ] 组件数据源：WebSocket \`get_rp_state\` → \`state.cardStates["${charName}"].characters\`
- [ ] 生成的组件放入卡片 \`ui/\` 目录
- [ ] 将远程 JS bundle 改写为本地脚本，放入 \`scripts/\` 目录
- [ ] 更新 \`regex_hooks.json\` 移除 CDN 依赖，指向本地资源

正则脚本: ${regexCount} 条 | 酒馆脚本: ${tavernCount} 条`);
  }

  if (worldbookEntryCount > 100) {
    todos.push(`### 2. 世界书向量检索部署

卡片包含 ${worldbookEntryCount} 条世界书，超出关键词匹配的有效范围。

#### 产物位置约定
| 产物 | 位置 | 引擎接口 |
|------|------|---------|
| 向量索引 | \`vectors/\` 目录（ChromaDB 或 LanceDB 本地文件） | \`worldbook.ts\` 添加 \`searchWorldbookVector()\` 函数 |
| 索引元数据 | \`vectors/meta.json\`（条目→向量映射） | — |

#### 具体步骤
- [ ] 遍历 worldbook/[常开]设定/ 和 worldbook/[触发]关键词/ 下所有 .md 条目
- [ ] 对每个条目生成 text-embedding 向量
- [ ] 存储到卡片 \`vectors/\` 目录
- [ ] 在 \`worldbook.ts\` 添加向量搜索接口（优先语义搜索，回退关键词）
- [ ] 更新 \`load_worldbook\` 工具支持向量搜索

模型建议: text-embedding-3-small (OpenAI) 或 bge-small-zh (本地)`);
  }

  if (todos.length > 0) {
    const content = [
      `# 导入后待办 — ${charName}`,
      `> 导入时间: ${new Date().toISOString()}`,
      `> 本文件供 AI 在后续会话中逐项完成。完成后请勾选对应条目。`,
      '',
      `## 约定：卡片扩展目录结构`,
      '',
      'AI 本地化产物按以下目录结构放入卡片目录：',
      '',
      '```',
      `.pi/cards/<卡名>/`,
      `├── ui/                   # 前端 UI 组件（引擎自动扫描下发给前端）`,
      `│   ├── status-bar.html`,
      `│   └── status-bar.js`,
      `├── scripts/              # 本地化脚本（regex-processor 加载）`,
      `│   └── mvu-parser.js`,
      `├── assets/               # 本地化静态资源（图片等）`,
      `│   └── *.jpg`,
      `└── vectors/              # 向量索引（worldbook.ts 加载）`,
      `    ├── meta.json`,
      `    └── index.*`,
      '```',
      '',
      ...todos,
    ].join('\n');
    writeFileSync(join(cardDir, 'POST_IMPORT_TODO.md'), content, 'utf-8');
    console.log(`   📋 导入后待办: POST_IMPORT_TODO.md (${todos.length} 项)`);
  }
}

function showHelp() {
  console.log(`
角色扮演 · 卡片管理工具
================================

用法:
  node setup.mjs                                  标准初始化 + 注册旧版卡
  node setup.mjs --import <path>                   导入角色卡（.png 或 .json）
  node setup.mjs --import <path> --target <dir>    导入到指定目录
  node setup.mjs --activate <name>                 切换活跃卡片
  node setup.mjs --list                            列出所有卡片
  node setup.mjs --register-legacy                 注册当前 .pi/ 下的旧版卡
  node setup.mjs --scan                            扫描 ./characters/ 目录批量导入
  node setup.mjs --help                            显示此帮助

卡片管理:
  - 所有卡片存储在 .pi/cards/<卡名>/
  - 每张卡独立拥有 worldbook/、state.json、config.json
  - 激活卡片时自动创建软链接到 .pi/worldbook、.pi/state.json、.rpconfig.json
  - 旧版卡片可通过 --register-legacy 迁移到卡片系统

支持的角色卡格式:
  - PNG 图片（SillyTavern V2/V3，含 chara/ccv3 chunk）
  - JSON 文件（SillyTavern 导出格式）
`);
}

main();
