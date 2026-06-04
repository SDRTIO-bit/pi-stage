# Skill/Knowledge 拆分 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将世界书常开条目拆分为"执行规则（Skill 常驻）"和"世界知识（TF-IDF 按需检索）"，使 Skill 文件从 380KB 降至 60-80KB，消灭 pipeline summarize/drop。

**Architecture:** 在 `skill-generator.ts` 增加知识条目识别函数，在 `cards/skill-writer.ts` 的 `generateCardSkills()` 中执行拆分——执行规则走原有 Skill 编译管线，知识条目改 `constant: false` 回归世界书触发检索。世界书增加 `addEntries()` 支持增量追加。管线 budget 同步调整。

**Tech Stack:** TypeScript, Node.js (现有栈，无新增依赖)

---

### Task 1: Worldbook 增加 `addEntries()` 增量方法

**Files:**
- Modify: `src/worldbook/index.ts:80-84`

- [ ] **Step 1: 在 Worldbook 类中增加 `addEntries()` 方法**

在 `load()` 方法后面新增：

```typescript
/** 增量追加条目（不替换已有条目） */
addEntries(entries: WorldbookEntry[]): void {
  this.entries.push(...entries)
  this.rebuildIndex()
}
```

- [ ] **Step 2: 验证编译通过**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/worldbook/index.ts
git commit -m "feat: add Worldbook.addEntries() for incremental entry loading"
```

---

### Task 2: skill-generator 增加知识条目识别 + 过滤

**Files:**
- Modify: `src/skill-generator.ts`

- [ ] **Step 1: 增加 `isKnowledgeEntry()` 函数**

在 `categorizeEntry()` 函数后面新增：

```typescript
/** 判断条目是否为"世界知识"（应从 Skill 排除，走 worldbook 触发检索） */
export function isKnowledgeEntry(entry: WorldbookEntry): boolean {
  const name = entry.name
  const content = entry.content.slice(0, 500)

  // 【世界】前缀 → 知识（地理位置、物价、年表、神之途径、神秘学、海洋、维多利亚风、物品、资本、突发事件）
  if (/^【世界】/.test(name)) return true

  // 原著时间线
  if (/原著时间线/.test(name)) return true

  // 分隔符标记（世界观/数值参考/合理性审查/系统结构/判定区域 的开始和结束）
  if (/——(世界观|数值参考|合理性审查|系统结构|判定区域)(开始|结束)/.test(name)) return true

  // 内容特征：纯描述性，无规则/指令/格式关键词
  // 如果内容前 500 字符不包含任何执行规则关键词 → 知识
  const ruleKeywords =
    /规则|必须|不得|禁止|格式|输出|更新|判定|骰子|DC|难度|roll|dice|check|替换|replace|JSON\s*Patch|UpdateVariable|Analysis|审查|OOC|叙事节奏|沉浸感|自动化|战斗|变量|数值|上限|基准|模板|\{\{/
  if (!ruleKeywords.test(content)) return true

  return false
}
```

- [ ] **Step 2: 修改 `generateSkills()` 接受可选的过滤函数**

修改函数签名：

```typescript
export function generateSkills(
  constantEntries: WorldbookEntry[],
  opts?: { excludeKnowledge?: boolean },
): GeneratedSkill[] {
  const entries = opts?.excludeKnowledge
    ? constantEntries.filter((e) => !isKnowledgeEntry(e))
    : constantEntries
  // ... 其余逻辑保持不变，将 constantEntries 替换为 entries
}
```

同时修改函数体第一行，将 `constantEntries` 替换为 `entries`。

- [ ] **Step 3: 导出 `isKnowledgeEntry` 并验证编译**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/skill-generator.ts
git commit -m "feat: add isKnowledgeEntry() classifier and excludeKnowledge option"
```

---

### Task 3: cards/skill-writer 执行拆分逻辑

**Files:**
- Modify: `src/cards/skill-writer.ts`

- [ ] **Step 1: 修改 `generateCardSkills()` 拆分常开条目**

将 Phase 1 部分改为：

```typescript
export function generateCardSkills(cardDir: string, worldbookDir: string): GeneratedSkill[] {
  const wb = new Worldbook()
  wb.loadFromFiles([worldbookDir])

  // ---- Phase 1: 常开设定 → 拆分执行规则 / 世界知识 ----
  const constantEntries = wb.getConstantEntries()

  // 检出知识条目（从 Skill 中排除，回归 worldbook 触发检索）
  const knowledgeEntries = constantEntries.filter((e) => isKnowledgeEntry(e))
  if (knowledgeEntries.length > 0) {
    const reclassified = knowledgeEntries.map((e) => ({
      ...e,
      constant: false,
      category: "触发词条" as const,
    }))
    wb.addEntries(reclassified)
  }

  // 仅用执行规则条目生成 Skill 文件
  const skills = generateSkills(constantEntries, { excludeKnowledge: true })
  const skillsDir = getCardSkillsDir(cardDir)
  mkdirSync(skillsDir, { recursive: true })

  for (const skill of skills) {
    writeFileSync(join(skillsDir, skill.filename), skill.content, "utf-8")
  }

  // ---- Phase 2: 不变（扫描触发目录，提升高置信度元规则） ----
  // ... 保持不变
```

同时在文件顶部 import 中增加 `isKnowledgeEntry`：

```typescript
import { generateSkills, categorizeEntry, isKnowledgeEntry, type GeneratedSkill, type SkillCategory } from "../skill-generator.js"
```

- [ ] **Step 2: 同时移除 `world-context.md` 相关逻辑**

在 `generateCardSkills()` Phase 2 中，`uncategorized` 条目不追加到 `world-context.md`（因为知识条目已经从常开设定中排除，`world-context.md` 不再生成）：

```typescript
const filenameMap: Record<string, string> = {
  "core-rules": "00-core-rules.md",
  "style-protocol": "style-protocol.md",
  "judgment-system": "judgment-system.md",
  "variable-protocol": "variable-protocol.md",
  // uncategorized 不再映射到 world-context.md（知识条目走触发检索）
}
```

Phase 2 中已有 `if (cat === "uncategorized") continue` 守卫，保持一致。

- [ ] **Step 3: 验证编译**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add src/cards/skill-writer.ts
git commit -m "feat: split knowledge entries from skill generation into trigger retrieval"
```

---

### Task 4: 调整管线 budget 默认值

**Files:**
- Modify: `src/composition-root.ts:165`

- [ ] **Step 1: 更新 budget 默认值**

Skill 从 380KB → ~60-80KB 后，budget 可以收窄但仍然能完整容纳：

```typescript
const budget = config.budget ?? { target: 24576, hard: 40960 }
//                                    ~12K tokens      ~20K tokens
```

原值是 `{ target: 8192, hard: 12288 }`（4K/6K tokens），过小导致即使拆分后也可能截断。新值确保 ~60KB 的执行规则 Skill 文件完整进入 prompt。

> **注：** 这是默认值，调用方仍可通过 `config.budget` 覆盖。

- [ ] **Step 2: 验证编译**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/composition-root.ts
git commit -m "feat: widen pipeline budget to fit execution-rule skills"
```

---

### Task 5: 端到端验证

**Files:**
- 无新建文件（运行现有测试 + 手动验证）

- [ ] **Step 1: 运行现有测试套件**

```bash
npx vitest run
```

确认所有现有测试通过。

- [ ] **Step 2: 验证分类器对「诡秘剧场」数据的拆分效果**

在项目目录下运行临时验证脚本：

```bash
node -e "
const { Worldbook } = require('./dist/worldbook/index.js');
const { isKnowledgeEntry, generateSkills } = require('./dist/skill-generator.js');
const wb = new Worldbook();
wb.loadFromFiles(['./.pi/cards/诡秘剧场/worldbook']);
const constant = wb.getConstantEntries();
const knowledge = constant.filter(e => isKnowledgeEntry(e));
const execution = constant.filter(e => !isKnowledgeEntry(e));
console.log('常开总计:', constant.length);
console.log('知识条目:', knowledge.length, knowledge.map(e => e.name));
console.log('执行规则:', execution.length, execution.map(e => e.name));
const skills = generateSkills(constant, { excludeKnowledge: true });
const totalBytes = skills.reduce((s, sk) => s + Buffer.byteLength(sk.content, 'utf8'), 0);
console.log('Skill 总大小:', (totalBytes / 1024).toFixed(1), 'KB');
"
```

预期输出：
- 常开总计: 51
- 知识条目: ~25（地理位置、物价、年表、神之途径等）
- 执行规则: ~26（判定、格式、COT、变量、数值等）
- Skill 总大小: 60-80 KB

- [ ] **Step 3: Commit（如有快照数据调整）**

---

## 设计决策记录

1. **为什么不移动文件？** — 文件不动。分类在内存中通过 `isKnowledgeEntry()` 完成，`constant: false` 在运行时重标记。卡片作者的世界书目录结构保持不变，不影响酒馆 v3 卡片导入流程。

2. **知识条目如何被检索？** — 重标记为 `constant: false` + `category: "触发词条"` 后，`searchBySimilarity()` 的 `getTriggerEntries()` 会包含它们。TF-IDF 按 bigram 分词检索，命中率已有验证。

3. **`world-context.md` Skill 文件还生成吗？** — 不再生成。所有知识条目从 Skill 排除后，`uncategorized` 分类不再产生输出。

4. **输出格式 Skill 怎么处理？** — `0085-[mvu_update]变量输出格式.md` 被 `isKnowledgeEntry()` 识别为执行规则（内容包含 `JSON Patch`、`UpdateVariable` 等关键词），留在 `variable-protocol.md` 中。
