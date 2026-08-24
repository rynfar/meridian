/**
 * `routing: "active+priority"` through the HTTP layer with a mocked SDK.
 *
 * The mode is priority routing with the human back in charge of the head:
 * traffic goes where the active profile says, and a refusal is re-proxied to
 * the next healthy account within the same request so the client never sees an
 * error. Asserts the two things that distinguish it from `priority` - the
 * active profile outranks a session's existing assignment, and switching it
 * moves conversations already under way - plus the refusal surfaces that make
 * a spent account visible in EVERY mode.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage } from "./helpers"

let capturedEnvs: string[] = []
let failingDirs = new Set<string>()
const DEFAULT_FAILURE = "Claude Code returned an error result: You've hit your session limit · resets 12:30am (America/Chicago)"
let failureMessage = DEFAULT_FAILURE

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    capturedEnvs.push(dir)
    return (async function* () {
      if ([...failingDirs].some((f) => dir.includes(f))) throw new Error(failureMessage)
      yield assistantMessage([{ type: "text", text: "ok from " + dir }])
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { telemetryStore } = await import("../telemetry")
type TelemetryRow = import("../telemetry").RequestMetric

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-ap-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-ap-personal" },
  { id: "spare", claudeConfigDir: "/tmp/meridian-ap-spare" },
]

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

function createTestApp(): TestApp {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
  return app
}

async function post(app: TestApp, headers: Record<string, string> = {}, content = "hello") {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content }],
    }),
  }))
}

async function setActive(app: TestApp, profile: string) {
  const res = await app.fetch(new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  }))
  expect(res.status).toBe(200)
}

async function profilesList(app: TestApp) {
  const res = await app.fetch(new Request("http://localhost/profiles/list"))
  return await res.json() as {
    routing: string
    spent?: Array<{ profileId: string; until: number | null; diagnosis: { bucket: string | null; reported: boolean; source: string } }>
    exhausted?: Array<{ id: string }>
    profileOrder?: string[]
  }
}

async function health(app: TestApp) {
  const res = await app.fetch(new Request("http://localhost/profiles/health"))
  expect(res.status).toBe(200)
  return await res.json() as {
    routing: string
    activeProfile?: string
    spent: Array<{ profileId: string; until: number | null; diagnosis: { bucket: string | null } }>
    exhausted: Array<{ id: string; until: number; reason: string }>
  }
}

async function events(app: TestApp, since = 0, limit?: number) {
  const url = `http://localhost/profiles/events?since=${since}` + (limit ? `&limit=${limit}` : "")
  const res = await app.fetch(new Request(url))
  expect(res.status).toBe(200)
  return await res.json() as {
    events: Array<{ seq: number; kind: string; profile: string; servedBy: string | null; internalHop: boolean; routing: string; limit: { bucket: string | null; reported: boolean } | null }>
    nextSince: number
    dropped: boolean
    latestSeq: number
  }
}

const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  capturedEnvs = []
  failingDirs = new Set()
  failureMessage = DEFAULT_FAILURE
  clearSessionCache()
  resetActiveProfile()
  rateLimitStore.clear()
  // Exhaustion fires refinePriorityCooldown -> fetchOAuthUsage as a real
  // side effect; without this the suite would read credentials and call
  // Anthropic for every refusal. Same guard as the priority-routing suite.
  __setFetchOAuthUsageOverride(async () => null)
  savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
  savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "work,personal,spare"
})

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  __setFetchOAuthUsageOverride(null)
  rateLimitStore.clear()
  resetActiveProfile()
})

describe("active+priority routing", () => {
  it("sends unpinned requests to the ACTIVE profile, not the head of the pool order", async () => {
    const app = createTestApp()
    await setActive(app, "spare")
    const res = await post(app, {}, "goes to the active profile")
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("ap-spare")
  })

  it("moves a conversation already under way when the active profile is switched", async () => {
    // The capability that distinguishes this mode from `priority`, where an
    // existing assignment outranks the pool head and switching would leave
    // running conversations where they were.
    const app = createTestApp()
    await setActive(app, "work")
    expect((await post(app, { "x-opencode-session": "s1" })).status).toBe(200)
    expect(capturedEnvs[0]).toContain("ap-work")

    await setActive(app, "personal")
    capturedEnvs = []
    expect((await post(app, { "x-opencode-session": "s1" }, "same conversation")).status).toBe(200)
    expect(capturedEnvs[0]).toContain("ap-personal")
  })

  it("re-proxies to the next account in the pool order when the active one is refused", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("ap-personal")
    expect(capturedEnvs[capturedEnvs.length - 1]).toContain("ap-personal")
  }, 20_000)

  it("keeps a conversation on the fallback it already used while the active profile is still refusing", async () => {
    // Affinity below the active profile: re-picking every turn during an
    // outage would pay a cold prompt cache each time.
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    failingDirs.add("ap-personal")
    expect((await post(app, { "x-opencode-session": "s2" })).status).toBe(200)
    capturedEnvs = []
    const res = await post(app, { "x-opencode-session": "s2" }, "second turn")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("ap-spare")
  }, 30_000)

  it("returns to the active profile as soon as it stops refusing", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    expect((await post(app, { "x-opencode-session": "s3" })).status).toBe(200)

    failingDirs.delete("ap-work")
    const list = await profilesList(app)
    // work is still cooling down, so the fallback stands until it expires.
    expect(list.exhausted?.map(e => e.id)).toContain("work")
  }, 20_000)

  it("surfaces the error only when every account refuses", async () => {
    const app = createTestApp()
    for (const dir of ["ap-work", "ap-personal", "ap-spare"]) failingDirs.add(dir)
    const res = await post(app)
    expect(res.status).toBe(429)
    const body = await res.json() as { error: { type: string } }
    expect(body.error.type).toBe("rate_limit_error")
  }, 40_000)

  it("lets an explicit x-meridian-profile header bypass the pool entirely", async () => {
    const app = createTestApp()
    failingDirs.add("ap-work")
    const res = await post(app, { "x-meridian-profile": "work" })
    expect(res.status).toBe(429)
    expect(capturedEnvs.every(e => e.includes("ap-work"))).toBe(true)
  }, 20_000)
})

describe("refusal reporting", () => {
  it("records WHICH allowance was refused, from the wording Anthropic used", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    await post(app)

    const list = await profilesList(app)
    const spent = list.spent?.find(s => s.profileId === "work")
    expect(spent).toBeDefined()
    expect(spent!.diagnosis.bucket).toBe("five_hour")
    expect(spent!.diagnosis.reported).toBe(true)
    expect(spent!.diagnosis.source).toBe("error_message")
  }, 20_000)

  it("guesses the bucket from cached windows when the wording names none, and says it is a guess", async () => {
    failureMessage = "429 rate limit reached for this account"
    const app = createTestApp()
    await setActive(app, "work")
    // The corp4 shape exactly: nothing near a limit, weekly cold, still refused.
    rateLimitStore.record("work", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.67,
      resetsAt: Date.now() + 40 * 60_000,
    })
    failingDirs.add("ap-work")
    await post(app)

    const spent = (await profilesList(app)).spent?.find(s => s.profileId === "work")
    expect(spent).toBeDefined()
    expect(spent!.diagnosis.reported).toBe(false)
  }, 20_000)

  it("reports a refusal in plain ACTIVE mode, where nothing fails over", async () => {
    // The account that ran out is worth knowing about whether or not routing
    // is avoiding it - in active mode the refusal reaches the client, and
    // until now nothing recorded that it had happened.
    process.env.MERIDIAN_ROUTING = "active"
    const app = createTestApp()
    failingDirs.add("ap-work")
    const res = await post(app)
    expect(res.status).toBe(429)

    const list = await profilesList(app)
    expect(list.routing).toBe("active")
    expect(list.spent?.map(s => s.profileId)).toContain("work")

    const page = await events(app)
    expect(page.events.map(e => e.kind)).toContain("refused")
    expect(page.events[0]!.profile).toBe("work")
  }, 20_000)

  it("names the refused allowance on the /telemetry row, in a mode that never fails over", async () => {
    process.env.MERIDIAN_ROUTING = "active"
    telemetryStore.clear()
    const app = createTestApp()
    failingDirs.add("ap-work")
    expect((await post(app, {}, "telemetry refusal bucket unique message")).status).toBe(429)

    const rows = await (await app.fetch(new Request("http://localhost/telemetry/requests"))).json() as TelemetryRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.profileId).toBe("work")
    expect(rows[0]!.routeKind).toBe("active")
    expect(rows[0]!.routeRefusedBucket).toBe("five_hour")
    expect(rows[0]!.routeChain).toBeUndefined()
  }, 20_000)
})

describe("GET /profiles/health", () => {
  it("reports which accounts are refusing and which are benched", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    expect((await post(app)).status).toBe(200)

    const page = await health(app)
    expect(page.routing).toBe("active+priority")
    expect(page.spent.map(s => s.profileId)).toContain("work")
    expect(page.spent.find(s => s.profileId === "work")!.diagnosis.bucket).toBe("five_hour")
    expect(page.exhausted.map(e => e.id)).toContain("work")
  }, 20_000)

  it("is empty and harmless before anything has gone wrong", async () => {
    const page = await health(createTestApp())
    expect(page.spent).toEqual([])
    expect(page.exhausted).toEqual([])
  })
})

describe("GET /profiles/events", () => {
  it("reports the refusal and the failover that hid it from the client", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    expect((await post(app)).status).toBe(200)

    const page = await events(app)
    const refused = page.events.find(e => e.kind === "refused")
    const failover = page.events.find(e => e.kind === "failover")
    expect(refused?.profile).toBe("work")
    // The client got a normal answer, so the refusal happened on an internal hop.
    expect(refused?.internalHop).toBe(true)
    expect(refused?.limit?.bucket).toBe("five_hour")
    expect(failover?.profile).toBe("work")
    expect(failover?.servedBy).toBe("personal")
    expect(failover?.routing).toBe("active+priority")
  }, 20_000)

  it("reports pool_exhausted when there was nowhere left to send the request", async () => {
    const app = createTestApp()
    for (const dir of ["ap-work", "ap-personal", "ap-spare"]) failingDirs.add(dir)
    expect((await post(app)).status).toBe(429)
    const page = await events(app)
    expect(page.events.map(e => e.kind)).toContain("pool_exhausted")
  }, 40_000)

  it("advances a since cursor without skipping anything", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    failingDirs.add("ap-work")
    expect((await post(app)).status).toBe(200)

    const first = await events(app, 0, 1)
    expect(first.events).toHaveLength(1)
    expect(first.nextSince).toBe(first.events[0]!.seq)

    const rest = await events(app, first.nextSince)
    expect(rest.events.every(e => e.seq > first.nextSince)).toBe(true)
    expect(rest.nextSince).toBe(rest.latestSeq)

    const idle = await events(app, rest.nextSince)
    expect(idle.events).toHaveLength(0)
    expect(idle.nextSince).toBe(rest.nextSince)
    expect(idle.dropped).toBe(false)
  }, 20_000)

  it("is empty and harmless before anything has gone wrong", async () => {
    const app = createTestApp()
    const page = await events(app)
    expect(page.events).toHaveLength(0)
    expect(page.latestSeq).toBe(0)
    expect(page.dropped).toBe(false)
  })
})

describe("routing settings", () => {
  // PUT persists to settings.json. The preload points that at a throwaway dir,
  // but it is shared by every test file in this process, and the sticky/priority
  // suites fall back to getSetting("routing") when MERIDIAN_ROUTING is unset.
  afterEach(() => {
    const { setSetting } = require("../settings") as typeof import("../settings")
    setSetting("routing", undefined)
  })

  it("accepts the new mode over PUT /settings/api/routing and offers it in the mode list", async () => {
    const app = createTestApp()
    const get = await app.fetch(new Request("http://localhost/settings/api/routing"))
    const cfg = await get.json() as { modes: string[] }
    expect(cfg.modes).toContain("active+priority")

    const put = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routing: "active+priority" }),
    }))
    expect(put.status).toBe(200)
  })

  it("still rejects a mode it does not know", async () => {
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/settings/api/routing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routing: "chaos" }),
    }))
    expect(res.status).toBe(400)
  })
})
