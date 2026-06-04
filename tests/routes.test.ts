// ============================================================
// routes.test.ts — HTTP 路由层单元测试
// ============================================================

import { describe, it, expect, beforeEach, afterAll } from "vitest"
import type * as http from "node:http"
import type { RouteContext } from "../src/presentation/http/routes/route-context.js"
import type { App } from "../src/composition-root.js"
import { StateStore } from "../src/state-store.js"
import { MemoryStorage } from "../src/infrastructure/storage-provider.js"
import { ContextPipeline } from "../src/context/pipeline.js"
import { RegexEngine, type RegexHook } from "../src/regex/hooks.js"
import { Worldbook } from "../src/worldbook/index.js"
import { CardManager } from "../src/card-manager.js"
import { LifecycleBus } from "../src/lifecycle/events.js"
import { AgentPipeline } from "../src/lifecycle/agent-pipeline.js"
import { SkillWriter } from "../src/skill-writer.js"
import { CardSessionStore } from "../src/cards/session-store.js"
import { register as registerSessionRoutes } from "../src/presentation/http/routes/session-routes.js"
import { register as registerTurnRoutes } from "../src/presentation/http/routes/turn-routes.js"
import { register as registerToolRoutes } from "../src/presentation/http/routes/tool-routes.js"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// ---- Stubs ----

interface StubRes extends http.ServerResponse {
  _code: number
  _data: unknown
}

function makeApp(tmpDir: string): App {
  const stateStore = new StateStore(new MemoryStorage())
  const regexEngine = new RegexEngine()
  regexEngine.load([
    { id: "rx-test", name: "test", pattern: "test", replacement: "ok", phase: "prompt", enabled: true } as RegexHook,
  ])

  return {
    stateStore,
    cardManager: new CardManager(tmpDir, stateStore),
    contextPipeline: new ContextPipeline(stateStore, regexEngine),
    worldbook: new Worldbook(),
    lifecycleBus: new LifecycleBus(),
    agentPipeline: new AgentPipeline(stateStore),
    regexEngine,
    skillWriter: new SkillWriter(tmpDir),
    cardSessionStore: new CardSessionStore(),
  }
}

function makeRouteCtx(app: App): RouteContext {
  return {
    app,
    readBody(req) {
      return Promise.resolve((req as any)._body ?? "")
    },
    json(res, code, data) {
      const r = res as unknown as StubRes
      r._code = code
      r._data = JSON.stringify(data)
    },
    parseJson(body) {
      try { return JSON.parse(body) as Record<string, unknown> } catch { return null }
    },
  }
}

function stubReq(url: string, method = "GET", body = ""): http.IncomingMessage {
  return { url, method, _body: body } as unknown as http.IncomingMessage
}

function stubRes(): StubRes {
  // @ts-expect-error partial stub only
  return { _code: 0, _data: "" }
}

function getData(res: StubRes): unknown {
  return JSON.parse(res._data as string)
}

let app: App
let ctx: RouteContext
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-route-test-"))
  app = makeApp(tmpDir)
  ctx = makeRouteCtx(app)
})

afterAll(() => {
  const parent = os.tmpdir()
  for (const entry of fs.readdirSync(parent)) {
    if (entry.startsWith("rp-route-test-")) {
      fs.rmSync(path.join(parent, entry), { recursive: true, force: true })
    }
  }
})

describe("session routes", () => {
  it("POST /session creates session", () => {
    // register card in file registry so POST /session can find it
    app.cardManager.saveRegistry({
      cards: { hero: { id: "hero", dir: tmpDir, imported_at: new Date().toISOString() } },
      active: [],
    })

    const res = stubRes()
    const r = registerSessionRoutes(
      ctx, stubReq("http://localhost/session", "POST", '{"cardId":"hero"}'),
      res as any, "/session", "POST", '{"cardId":"hero"}',
    )
    expect(r).toBe(true)
    expect(res._code).toBe(201)
    const data = getData(res) as any
    expect(data.ok).toBe(true)
    expect(data.sessionId).toBeDefined()
    expect(data.cardId).toBe("hero")
  })

  it("GET /session/:id returns session status", () => {
    const sid = "test-123"
    app.stateStore.createSession(sid)

    const res = stubRes()
    registerSessionRoutes(
      ctx, stubReq(`http://localhost/session/${sid}`),
      res as any, `/session/${sid}`, "GET", "",
    )
    expect(res._code).toBe(200)
    const data = getData(res) as any
    expect(data.sessionId).toBe(sid)
    expect(data.historyCount).toBe(0)
  })

  it("GET /session/:id 404 for unknown session", () => {
    const res = stubRes()
    registerSessionRoutes(
      ctx, stubReq("http://localhost/session/nope"),
      res as any, "/session/nope", "GET", "",
    )
    expect(res._code).toBe(404)
  })

  it("GET /sessions returns list", () => {
    app.stateStore.createSession("s1")
    app.stateStore.createSession("s2")
    // stateStore.listSessions reads from storage — persist first
    app.stateStore.persist("s1")
    app.stateStore.persist("s2")

    const res = stubRes()
    registerSessionRoutes(
      ctx, stubReq("http://localhost/sessions"),
      res as any, "/sessions", "GET", "",
    )
    expect(res._code).toBe(200)
    const data = getData(res) as string[]
    expect(data).toContain("s1")
    expect(data).toContain("s2")
  })

  it("returns false for non-matching path", () => {
    const res = stubRes()
    const r = registerSessionRoutes(
      ctx, stubReq("http://localhost/nope"),
      res as any, "/nope", "GET", "",
    )
    expect(r).toBe(false)
  })
})

describe("turn routes", () => {
  it("POST /session/:id/turn processes turn", async () => {
    const sid = "turn-test"
    app.stateStore.createSession(sid)

    const res = stubRes()
    await registerTurnRoutes(
      ctx, stubReq(`http://localhost/session/${sid}/turn`, "POST", '{"message":"hello"}'),
      res as any, `/session/${sid}/turn`, "POST", '{"message":"hello"}',
    )
    expect(res._code).toBe(200)
    const data = getData(res) as any
    expect(data.ok).toBe(true)
    expect(data.prompt).toBeDefined()
  })

  it("POST /session/:id/turn rejects empty body", async () => {
    const res = stubRes()
    await registerTurnRoutes(
      ctx, stubReq("http://localhost/session/s1/turn", "POST", ""),
      res as any, "/session/s1/turn", "POST", "",
    )
    expect(res._code).toBe(400)
  })

  it("POST /session/:id/turn rejects missing message", async () => {
    const res = stubRes()
    await registerTurnRoutes(
      ctx, stubReq("http://localhost/session/s1/turn", "POST", "{}"),
      res as any, "/session/s1/turn", "POST", "{}",
    )
    expect(res._code).toBe(400)
  })
})

describe("tool routes", () => {
  it("GET /tools returns tool list", async () => {
    const res = stubRes()
    await registerToolRoutes(
      ctx, stubReq("http://localhost/tools"), res as any, "/tools", "GET", "",
    )
    expect(res._code).toBe(200)
    const data = getData(res)
    expect(Array.isArray(data)).toBe(true)
  })

  it("POST with missing tool name returns 400", async () => {
    const res = stubRes()
    await registerToolRoutes(
      ctx, stubReq("http://localhost/session/s1/tool", "POST", "{}"),
      res as any, "/session/s1/tool", "POST", "{}",
    )
    expect(res._code).toBe(400)
  })

  it("POST with invalid JSON returns 400", async () => {
    const res = stubRes()
    await registerToolRoutes(
      ctx, stubReq("http://localhost/session/s1/tool", "POST", "not-json"),
      res as any, "/session/s1/tool", "POST", "not-json",
    )
    expect(res._code).toBe(400)
  })

  it("returns false for non-tool paths", async () => {
    const res = stubRes()
    const result = await registerToolRoutes(
      ctx, stubReq("http://localhost/other"), res as any, "/other", "GET", "",
    )
    expect(result).toBe(false)
  })
})
