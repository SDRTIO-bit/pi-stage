// test-rp.mjs — 10 轮 RP 对话测试
const BASE = "http://localhost:3001"
const CARD_ID = "桃花村的公媳"

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return res.json()
}

// 10 轮对话
const turns = [
  "（清晨起床，伸了个懒腰）公公，早上好。今天有什么要做的吗？",
  "好，我去准备早饭。你想吃点什么？",
  "（在厨房忙碌）粥已经煮上了，我再炒两个小菜。",
  "（端着饭菜过来）公公，趁热吃吧。昨天你腰不舒服，今天好些了吗？",
  "那你先吃着，我去把院子扫了。",
  "（扫完院子回来）外面阳光真好，要不一会儿我们出去走走？",
  "村口那条小溪边，听说最近鱼多了，要不要去看看？",
  "（收拾好碗筷）走吧，带上点东西，说不定能钓上几条。",
  "（走在路上）空气真好，好久没这么悠闲了。",
  "公公你看，溪边真的有人钓鱼！我们也找个地方坐下吧。",
]

async function main() {
  console.log("=".repeat(60))
  console.log("PI RP Engine — 10 轮 RP 对话测试")
  console.log(`卡片: ${CARD_ID}`)
  console.log("=".repeat(60))

  // 1. 创建 session
  console.log("\n[1] 创建 session...")
  const sessionRes = await post("/session", { cardId: CARD_ID })
  console.log(`  sessionId: ${sessionRes.sessionId}`)
  console.log(`  cardName: ${sessionRes.cardName}`)
  const sid = sessionRes.sessionId

  // 2. 跑 10 轮
  let totalNodes = 0
  let totalDegraded = 0
  let totalWbTriggered = 0

  for (let i = 0; i < turns.length; i++) {
    const msg = turns[i]
    console.log(`\n[2.${i + 1}] Turn ${i + 1}: ${msg.slice(0, 30)}...`)

    const turnRes = await post(`/session/${sid}/turn`, { message: msg })
    console.log(`  prompt 长度: ${turnRes.prompt?.length || 0} 字符`)
    console.log(`  nodeCount: ${turnRes.nodeCount}`)
    console.log(`  degraded: ${turnRes.degraded}`)
    console.log(`  worldbookTriggered: ${turnRes.worldbookTriggered?.length || 0} 条`)
    if (turnRes.worldbookTriggered?.length > 0) {
      turnRes.worldbookTriggered.slice(0, 3).forEach((w) => console.log(`    - ${w.name}`))
      if (turnRes.worldbookTriggered.length > 3) console.log(`    ... 等 ${turnRes.worldbookTriggered.length} 条`)
    }
    if (turnRes.trace?.length > 0) {
      const degraded = turnRes.trace.filter((t) => t.action !== "scheduled" && t.action !== "collected")
      if (degraded.length > 0) {
        console.log(`  ⚠ 降级: ${degraded.map((d) => `${d.action}(${d.reason?.slice(0, 40)})`).join(", ")}`)
      }
    }
    totalNodes += turnRes.nodeCount || 0
    totalDegraded += turnRes.degraded || 0
    totalWbTriggered += turnRes.worldbookTriggered?.length || 0
  }

  // 3. 统计
  console.log("\n" + "=".repeat(60))
  console.log("汇总:")
  console.log(`  总轮次: ${turns.length}`)
  console.log(`  平均 nodeCount: ${(totalNodes / turns.length).toFixed(1)}`)
  console.log(`  总降级次数: ${totalDegraded}`)
  console.log(`  总世界书触发: ${totalWbTriggered}`)
  console.log("=".repeat(60))
}

main().catch((e) => {
  console.error("测试失败:", e.message)
  process.exit(1)
})
