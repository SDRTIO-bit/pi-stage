// delete-card.mjs — 删除角色卡
import { existsSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const cardId = process.argv[2]
const registryPath = join(process.cwd(), ".pi", "cards", "registry.json")

if (!existsSync(registryPath)) {
  console.log("没有已导入的卡片")
  process.exit(0)
}

const registry = JSON.parse(readFileSync(registryPath, "utf-8"))

if (!cardId) {
  const entries = Object.entries(registry.cards)
  if (entries.length === 0) {
    console.log("没有已导入的卡片")
  } else {
    console.log("")
    console.log("已导入的卡片:")
    entries.forEach(([id, c]) => console.log(`  ${id}  @  ${c.dir}`))
    console.log("")
    console.log('用法: delete-card.bat "卡片ID"')
  }
  process.exit(0)
}

const card = registry.cards[cardId]
if (!card) {
  console.log(`[错误] 未找到卡片: ${cardId}`)
  process.exit(1)
}

const dir = card.dir
delete registry.cards[cardId]
registry.active = registry.active.filter(a => a !== cardId)
writeFileSync(registryPath, JSON.stringify(registry, null, 2))

if (existsSync(dir)) {
  rmSync(dir, { recursive: true, force: true })
  console.log(`已删除: ${dir}`)
} else {
  console.log(`已从注册表移除: ${cardId}`)
}
