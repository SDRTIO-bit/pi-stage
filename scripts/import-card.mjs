// import-card.mjs — 导入角色卡（含 Skill 自动生成）
import { importCardFromFile } from "../dist/cards/importer.js"
import { generateCardSkills } from "../dist/cards/skill-writer.js"

const filePath = process.argv[2]
if (!filePath) {
  console.log("用法: node scripts/import-card.mjs <角色卡文件路径>")
  console.log("支持: PNG / WEBP / JPEG / JSON")
  process.exit(1)
}

console.log("导入角色卡...")
const result = importCardFromFile(filePath)

console.log(JSON.stringify({
  name: result.meta.name,
  id: result.meta.id,
  worldbook: result.worldbookEntryCount,
  regex: result.regexHooksCount,
  variables: result.variableSchemaCount,
  dir: result.cardDir,
}, null, 2))

// 自动生成 Skill 文件（执行规则 / 知识拆分）
if (result.worldbookDir) {
  console.log("")
  console.log("生成 Skill 文件（执行规则 / 知识拆分）...")
  const skills = generateCardSkills(result.cardDir, result.worldbookDir)
  const totalBytes = skills.reduce((s, sk) => s + Buffer.byteLength(sk.content, "utf8"), 0)
  console.log(`Skill 总大小: ${(totalBytes / 1024).toFixed(1)} KB`)
  skills.forEach(s => console.log(`  ${s.filename}: ${(Buffer.byteLength(s.content, "utf8") / 1024).toFixed(1)} KB`))
}

console.log("")
console.log("导入完成! 启动服务后创建 Session:")
console.log(`  curl -X POST http://localhost:3000/session -H "Content-Type: application/json" -d "{\\"cardId\\":\\"${result.meta.id}\\"}"`)
