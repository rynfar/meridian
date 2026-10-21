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
import { describe, it, expect, mock, setSystemTime, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, blockStop, messageDelta, messageStart, messageStop, resolveMockSdkSessionId, streamEvent, textBlockStart, textDelta } from "./helpers"

let capturedEnvs: string[] = []
let failingDirs = new Set<string>()
const DEFAULT_FAILURE = "Claude Code returned an error result: You've hit your session limit · resets 12:30am (America/Chicago)"
let failureMessage = DEFAULT_FAILURE
// Verbatim from the live proxy, 2026-10-05: what a Claude Max profile whose 7d
// Fable window is spent answers a Fable request with, while it goes on
// serving every other model.
const FABLE_LIMIT = "Claude Code returned an error result: You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas."
/** The same account once its usage credits are gone as well: no window is named. */
const OUT_OF_CREDITS = "Claude Code returned an error result: You're out of usage credits. Switch to another model, or manage usage credits at claude.ai/settings/usage?from=cc_cli_limit_message, to continue.\nSubprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas."
const SONNET_LIMIT = "Claude Code returned an error result: You've reached your Sonnet limit. Switch to another model to continue."
/** A throttled request: a 429 that names nothing. */
const THROTTLED = "API Error: 429 rate limited"
/** Config dirs whose account has no Fable allowance left. */
let fableSpentDirs = new Set<string>()
/** What such an account answers a Fable request with. */
let fableRefusal = FABLE_LIMIT
/** Config dirs whose account has no Sonnet allowance left. */
let sonnetSpentDirs = new Set<string>()
/** A rate-limit event the SDK emits with any request it is not out of allowance for, by config dir. */
let servedEvents = new Map<string, Record<string, unknown>>()
/**
 * The model the request in flight asked for. The mock goes by this and not by
 * the model option it is handed: other suites replace the model-mapping module
 * for the whole process, and under them every request reaches the SDK as
 * Sonnet.
 */
let requestedModel = ""
/** Config dirs whose Fable refusal arrives behind an SDK keepalive ping. */
let fablePingFirstDirs = new Set<string>()
/** The rate-limit event the SDK emits ahead of that refusal, by config dir. */
let fableLimitEvents = new Map<string, Record<string, unknown>>()
/**
 * Config dirs whose Fable refusal is recorded on a clock running behind the
 * attempt, by how far: what the attempt then finds on record is older than it.
 */
let fableRecordLagDirs = new Map<string, number>()
/** Puts the clock right again once a lagged refusal's request has returned. */
let restoreClock = (): void => {}
/** That event as the SDK gave it on 2026-10-05: seconds, and this type. */
const fableLimitEvent = (resetsAtMs: number): Record<string, unknown> => ({
  status: "rejected",
  rateLimitType: "seven_day_overage_included",
  resetsAt: Math.round(resetsAtMs / 1000),
  overageStatus: "rejected",
  overageDisabledReason: "org_level_disabled",
})

installSdkMock(() => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    capturedEnvs.push(dir)
    const sessionId = resolveMockSdkSessionId(params.options, "test-session")
    return (async function* () {
      const served = [...servedEvents].find(([f]) => dir.includes(f))?.[1]
      if (served) yield { type: "rate_limit_event", rate_limit_info: served, session_id: sessionId }
      if ([...failingDirs].some((f) => dir.includes(f))) throw new Error(failureMessage)
      // The tier the proxy runs a request as: Sonnet for a model it does not know.
      const tier = /fable|mythos/.test(requestedModel) ? "fable" : /opus|haiku/.test(requestedModel) ? "other" : "sonnet"
      if (tier === "fable" && [...fableSpentDirs].some((f) => dir.includes(f))) {
        if ([...fablePingFirstDirs].some((f) => dir.includes(f))) {
          yield { ...streamEvent({ type: "ping" }), session_id: sessionId }
        }
        const event = [...fableLimitEvents].find(([f]) => dir.includes(f))?.[1]
        if (event) yield { type: "rate_limit_event", rate_limit_info: event, session_id: sessionId }
        const lag = [...fableRecordLagDirs].find(([f]) => dir.includes(f))?.[1]
        if (lag !== undefined) {
          setSystemTime(new Date(Date.now() - lag))
          restoreClock = () => setSystemTime()
        }
        throw new Error(fableRefusal)
      }
      if (tier === "sonnet" && [...sonnetSpentDirs].some((f) => dir.includes(f))) throw new Error(SONNET_LIMIT)
      if (params.options?.includePartialMessages === true) {
        for (const event of [messageStart("msg-1"), textBlockStart(0), textDelta(0, "ok from " + dir), blockStop(0), messageDelta("end_turn"), messageStop()]) {
          yield { ...event, session_id: sessionId }
        }
      }
      yield { ...assistantMessage([{ type: "text", text: "ok from " + dir }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "active-priority-integration.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride, fetchOAuthUsage, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
type CredentialStore = import("../proxy/tokenRefresh").CredentialStore
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

async function post(app: TestApp, headers: Record<string, string> = {}, content = "hello", model = "claude-sonnet-4-5", stream = false) {
  requestedModel = model
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      max_tokens: 128,
      stream,
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
    exhaustedModels: Array<{ id: string; model: string; until: number; reason: string }>
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

beforeEach(async () => {
  capturedEnvs = []
  failingDirs = new Set()
  failureMessage = DEFAULT_FAILURE
  fableSpentDirs = new Set()
  fableRefusal = FABLE_LIMIT
  sonnetSpentDirs = new Set()
  servedEvents = new Map()
  fableLimitEvents = new Map()
  fablePingFirstDirs = new Set()
  fableRecordLagDirs = new Map()
  resetOAuthUsageCache()
  requestedModel = ""
  await clearSessionCache()
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
  restoreClock()
  restoreClock = () => {}
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

describe("an allowance spent for one model", () => {
  const FABLE = "claude-fable-5-1"
  const servedBy = async (res: Response) => (await res.json() as { content: Array<{ text: string }> }).content[0]?.text ?? ""

  it("serves a Fable request from the next account when the active one has no Fable allowance left", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    const res = await post(app, {}, "a subagent's first turn", FABLE)
    expect(res.status).toBe(200)
    expect(await servedBy(res)).toContain("ap-personal")
  }, 20_000)

  it("moves a streamed Fable request before the client has seen anything of the refusal", async () => {
    // How the Claude Code client asks, and the path where the refusal is a
    // frame in a stream rather than a status.
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    const res = await post(app, { "x-opencode-session": "sub" }, "a subagent's first turn", FABLE, true)
    expect(res.status).toBe(200)
    const stream = await res.text()
    expect(stream).toContain("ok from /tmp/meridian-ap-personal")
    expect(stream).not.toContain("event: error")
    expect(stream).not.toContain("ap-work")

    const state = await health(app)
    expect(state.exhausted).toEqual([])
    expect(state.exhaustedModels.map(e => [e.id, e.model])).toEqual([["work", "fable"]])
  }, 20_000)

  it("benches only Fable when the streamed refusal arrives behind a keepalive ping", async () => {
    // The stream's headers are already out when the refusal comes, so the
    // next account is tried inside the client's stream: the mark it leaves
    // must still be the model's own, and the account keep serving the rest.
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    fablePingFirstDirs.add("ap-work")
    fableLimitEvents.set("ap-work", fableLimitEvent(Date.now() + 2 * 24 * 60 * 60_000))
    const res = await post(app, { "x-opencode-session": "sub" }, "a subagent's first turn", FABLE, true)
    expect(res.status).toBe(200)
    const stream = await res.text()
    expect(stream).toContain("ok from /tmp/meridian-ap-personal")
    expect(stream).not.toContain("event: error")

    const state = await health(app)
    expect(state.exhausted).toEqual([])
    expect(state.exhaustedModels.map(e => [e.id, e.model])).toEqual([["work", "fable"]])
    expect(state.exhaustedModels[0]!.until).toBeGreaterThan(Date.now() + 24 * 60 * 60_000)

    capturedEnvs = []
    const other = await post(app, { "x-opencode-session": "main" }, "the main thread's next turn", "claude-sonnet-4-5", true)
    expect(await other.text()).toContain("ok from /tmp/meridian-ap-work")
    expect(capturedEnvs).toEqual(["/tmp/meridian-ap-work"])
  }, 20_000)

  it("keeps every other model on the account that refused Fable", async () => {
    // The account is not out: benching it whole would move each conversation
    // it holds to another account, and back when the bench ran out.
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    expect((await post(app, { "x-opencode-session": "sub" }, "a subagent's first turn", FABLE)).status).toBe(200)

    capturedEnvs = []
    const res = await post(app, { "x-opencode-session": "main" }, "the main thread's next turn")
    expect(res.status).toBe(200)
    expect(await servedBy(res)).toContain("ap-work")
    expect(capturedEnvs).toHaveLength(1)
  }, 20_000)

  it("sends the next Fable request straight to the fallback", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    expect((await post(app, { "x-opencode-session": "sub-1" }, "first", FABLE)).status).toBe(200)

    capturedEnvs = []
    const res = await post(app, { "x-opencode-session": "sub-2" }, "another subagent", FABLE)
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("ap-personal")
  }, 20_000)

  it("reports the account as serving, and names the model it is out for", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    await post(app, {}, "first", FABLE)

    const state = await health(app)
    expect(state.exhausted.map(e => e.id)).not.toContain("work")
    expect(state.exhaustedModels.map(e => [e.id, e.model])).toEqual([["work", "fable"]])
    expect(state.spent.find(s => s.profileId === "work")?.diagnosis.bucket).toBe("seven_day_fable")
    expect((await profilesList(app)).exhausted?.map(e => e.id) ?? []).not.toContain("work")
  }, 20_000)

  it("keeps Fable off the account until the reset the SDK reported for that allowance", async () => {
    const reset = Date.now() + 5 * 24 * 60 * 60_000
    fableLimitEvents.set("ap-work", fableLimitEvent(reset))
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    expect((await post(app, {}, "first", FABLE)).status).toBe(200)

    const [mark] = (await health(app)).exhaustedModels
    expect(mark?.id).toBe("work")
    expect(Math.abs((mark?.until ?? 0) - reset)).toBeLessThan(2_000)
  }, 20_000)

  it("looks again after ten minutes when nothing says when the allowance returns", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    const before = Date.now()
    await post(app, {}, "first", FABLE)

    const [mark] = (await health(app)).exhaustedModels
    expect(mark?.until).toBeGreaterThanOrEqual(before + 10 * 60_000)
    expect(mark?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  it("extends the bench to the window's own reset once a fresh usage read shows it spent", async () => {
    const reset = Date.now() + 3 * 24 * 60 * 60_000
    __setFetchOAuthUsageOverride(async () => ({
      windows: [
        { type: "five_hour", utilization: 0.08, resetsAt: Date.now() + 60 * 60_000 },
        { type: "seven_day", utilization: 0.85, resetsAt: reset },
        { type: "seven_day_fable", utilization: 1, resetsAt: reset },
      ],
      extraUsage: null,
      fetchedAt: Date.now(),
    }))
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    await post(app, {}, "first", FABLE)
    await Bun.sleep(20)

    const state = await health(app)
    expect(state.exhaustedModels.map(e => [e.id, e.model, e.until])).toEqual([["work", "fable", reset]])
    // The account-wide windows have room, so the account itself stays in.
    expect(state.exhausted).toEqual([])
  }, 20_000)

  it("leaves the ten-minute bench standing when the fresh read does not show that window spent", async () => {
    __setFetchOAuthUsageOverride(async () => ({
      windows: [{ type: "seven_day_fable", utilization: 0.4, resetsAt: Date.now() + 3 * 24 * 60 * 60_000 }],
      extraUsage: null,
      fetchedAt: Date.now(),
    }))
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    await post(app, {}, "first", FABLE)
    await Bun.sleep(20)

    const [mark] = (await health(app)).exhaustedModels
    expect(mark?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  /**
   * Put a usage snapshot in the cache the refusal's diagnosis reads, the way a
   * `/v1/usage/quota/all` poll does: the real reader, with its store and its
   * fetch supplied here.
   */
  async function warmUsage(profileId: string, fablePercent: number, resetsAt: number) {
    const store: CredentialStore = {
      read: async () => ({ claudeAiOauth: { accessToken: "token", refreshToken: "refresh", expiresAt: Date.now() + 60 * 60_000 } }),
      write: async () => true,
    }
    const reset = new Date(resetsAt).toISOString()
    const snapshot = await fetchOAuthUsage({
      profileId,
      store,
      fetchImpl: async () => new Response(JSON.stringify({
        five_hour: { utilization: 8, resets_at: new Date(Date.now() + 60 * 60_000).toISOString() },
        seven_day: { utilization: 30, resets_at: reset },
        limits: [{ kind: "weekly_scoped", group: "g", percent: fablePercent, resets_at: reset, severity: "ok", is_active: true, scope: { model: { id: null, display_name: "Fable" }, surface: null } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    })
    expect(snapshot?.windows.find(w => w.type === "seven_day_fable")?.utilization).toBe(fablePercent / 100)
  }

  it("does not take a reset from a usage snapshot in which that window is not spent", async () => {
    // The wording names the window and nothing reports its reset; the cached
    // snapshot has one for it, at 20% used. That is when the window turns
    // over, not when a refusal for some other reason ends.
    await warmUsage("work", 20, Date.now() + 6 * 24 * 60 * 60_000)
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    await post(app, {}, "first", FABLE)

    const [mark] = (await health(app)).exhaustedModels
    expect(mark?.id).toBe("work")
    expect(mark?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  it("takes it from a snapshot that shows the window spent", async () => {
    const reset = Date.now() + 6 * 24 * 60 * 60_000
    await warmUsage("work", 100, reset)
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    await post(app, {}, "first", FABLE)

    const [mark] = (await health(app)).exhaustedModels
    expect(Math.abs((mark?.until ?? 0) - reset)).toBeLessThan(2_000)
  }, 20_000)

  it("benches the account as before when the SDK's word on that allowance is from an earlier request", async () => {
    // A request held to the account is refused for Fable. That is outside the
    // pool, so nothing is benched, and the SDK's event stays on record: recent
    // enough for the next diagnosis to read, and not what the next request,
    // which is only throttled, was answered with.
    fableLimitEvents.set("ap-work", fableLimitEvent(Date.now() + 5 * 24 * 60 * 60_000))
    fableSpentDirs.add("ap-work")
    const app = createTestApp()
    await setActive(app, "work")
    expect((await post(app, { "x-meridian-profile": "work" }, "held to the account", FABLE)).status).toBe(429)
    expect((await health(app)).exhaustedModels).toEqual([])
    await Bun.sleep(5)

    failureMessage = THROTTLED
    failingDirs.add("ap-work")
    expect((await post(app, {}, "throttled", FABLE)).status).toBe(200)

    const state = await health(app)
    expect(state.exhaustedModels).toEqual([])
    expect(state.exhausted.map(e => e.id)).toEqual(["work"])
    expect(state.exhausted[0]?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  it("benches the account as before when the refusal on record is older than the attempt", async () => {
    // The wording names the Fable allowance and needs no SDK event, so only
    // the record's age says whether this attempt was the one refused for it.
    // A record that predates the attempt is some other request's word.
    fableRecordLagDirs.set("ap-work", 60_000)
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    const res = await post(app, {}, "first", FABLE)
    restoreClock()
    expect(await servedBy(res)).toContain("ap-personal")

    const state = await health(app)
    expect(state.spent.find(s => s.profileId === "work")?.diagnosis.bucket).toBe("seven_day_fable")
    expect(state.exhaustedModels).toEqual([])
    expect(state.exhausted.map(e => e.id)).toEqual(["work"])
  }, 20_000)

  it("does not keep Fable off an account that serves it on usage credits because one request was throttled", async () => {
    // What CLI 2.1.284 reports with a request it serves past the allowance,
    // here with the request that is then throttled.
    servedEvents.set("ap-work", { ...fableLimitEvent(Date.now() + 5 * 24 * 60 * 60_000), isUsingOverage: true, overageStatus: "allowed", overageDisabledReason: undefined })
    failureMessage = THROTTLED
    failingDirs.add("ap-work")
    const app = createTestApp()
    await setActive(app, "work")
    expect(await servedBy(await post(app, {}, "throttled", FABLE))).toContain("ap-personal")

    const state = await health(app)
    expect(state.exhaustedModels).toEqual([])
    expect(state.exhausted.map(e => e.id)).toEqual(["work"])
    expect(state.exhausted[0]?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  it("keeps only Fable off an account that is out of usage credits", async () => {
    fableRefusal = OUT_OF_CREDITS
    // The fresh usage read that follows a refusal shows the Fable window
    // spent as well, days from its reset.
    __setFetchOAuthUsageOverride(async () => ({
      windows: [{ type: "seven_day_fable", utilization: 1, resetsAt: Date.now() + 3 * 24 * 60 * 60_000 }],
      extraUsage: null,
      fetchedAt: Date.now(),
    }))
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    const res = await post(app, { "x-opencode-session": "sub" }, "a subagent's first turn", FABLE)
    expect(await servedBy(res)).toContain("ap-personal")
    await Bun.sleep(20)

    capturedEnvs = []
    expect(await servedBy(await post(app, { "x-opencode-session": "main" }, "the main thread's next turn"))).toContain("ap-work")
    expect(capturedEnvs).toHaveLength(1)
    const state = await health(app)
    expect(state.exhausted).toEqual([])
    expect(state.exhaustedModels.map(e => [e.id, e.model])).toEqual([["work", "fable"]])
    // Credits return when someone buys them: look again, do not wait a week.
    expect(state.exhaustedModels[0]?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  it("goes by the tier a request is run as when it names no model the proxy knows", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    sonnetSpentDirs.add("ap-work")
    expect(await servedBy(await post(app, { "x-opencode-session": "s1" }, "first"))).toContain("ap-personal")

    capturedEnvs = []
    const res = await post(app, { "x-opencode-session": "s2" }, "from a client with its own model names", "gpt-4o")
    expect(await servedBy(res)).toContain("ap-personal")
    expect(capturedEnvs).toHaveLength(1)
    expect((await health(app)).exhausted).toEqual([])
  }, 20_000)

  it("gives a streaming client the same wait, in the frame it gets instead of a header", async () => {
    const soon = Date.now() + 20 * 60_000
    fableLimitEvents.set("ap-work", fableLimitEvent(Date.now() + 5 * 24 * 60 * 60_000))
    fableLimitEvents.set("ap-personal", fableLimitEvent(soon))
    fableLimitEvents.set("ap-spare", fableLimitEvent(Date.now() + 3 * 24 * 60 * 60_000))
    const app = createTestApp()
    await setActive(app, "work")
    for (const dir of ["ap-work", "ap-personal", "ap-spare"]) fableSpentDirs.add(dir)
    const waits: number[] = []
    for (const content of ["first", "a retry"]) {
      const frame = await (await post(app, {}, content, FABLE, true)).text()
      expect(frame).toContain("event: error")
      const payload = JSON.parse(frame.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? "{}") as { error?: { type?: string; retry_after?: number } }
      expect(payload.error?.type).toBe("rate_limit_error")
      waits.push(payload.error?.retry_after ?? 0)
    }
    for (const wait of waits) {
      expect(wait).toBeGreaterThan(18 * 60)
      expect(wait).toBeLessThanOrEqual(20 * 60 + 2)
    }
  }, 40_000)

  it("steps around an account that is out altogether on the way to one with Fable left", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    failingDirs.add("ap-personal")
    const res = await post(app, {}, "first", FABLE)
    expect(res.status).toBe(200)
    expect(await servedBy(res)).toContain("ap-spare")

    const state = await health(app)
    expect(state.exhausted.map(e => e.id)).toEqual(["personal"])
    expect(state.exhaustedModels.map(e => e.id)).toEqual(["work"])
  }, 30_000)

  it("tells the client to wait for the first account that gets Fable back, not the one tried last", async () => {
    // With every account benched only the active one is tried again, and its
    // own allowance may be days from returning while another's is minutes.
    const soon = Date.now() + 20 * 60_000
    fableLimitEvents.set("ap-work", fableLimitEvent(Date.now() + 5 * 24 * 60 * 60_000))
    fableLimitEvents.set("ap-personal", fableLimitEvent(soon))
    fableLimitEvents.set("ap-spare", fableLimitEvent(Date.now() + 3 * 24 * 60 * 60_000))
    const app = createTestApp()
    await setActive(app, "work")
    for (const dir of ["ap-work", "ap-personal", "ap-spare"]) fableSpentDirs.add(dir)
    expect((await post(app, {}, "first", FABLE)).status).toBe(429)

    capturedEnvs = []
    const again = await post(app, {}, "a retry", FABLE)
    expect(again.status).toBe(429)
    expect(capturedEnvs).toHaveLength(1)
    const wait = Number(again.headers.get("retry-after"))
    expect(wait).toBeGreaterThan(18 * 60)
    expect(wait).toBeLessThanOrEqual(Math.ceil((soon - Date.now()) / 1000) + 2)
    // The body carries the same wait as the header, not the tried account's.
    expect((await again.json() as { error: { retry_after?: number } }).error.retry_after).toBe(wait)
  }, 40_000)

  for (const stream of [false, true]) {
    describe(`effective pool retry waits (${stream ? "SSE" : "JSON"})`, () => {
      async function waitFrom(res: Response): Promise<number> {
        if (!stream) {
          expect(res.status).toBe(429)
          const wait = Number(res.headers.get("retry-after"))
          const payload = await res.json() as { error: { type: string; retry_after: number } }
          expect(payload.error.type).toBe("rate_limit_error")
          expect(payload.error.retry_after).toBe(wait)
          return wait
        }
        expect(res.status).toBe(200)
        expect(res.headers.get("content-type")).toContain("text/event-stream")
        const frames = (await res.text()).split("\n\n").filter(frame => frame.startsWith("event: error\n"))
        expect(frames).toHaveLength(1)
        const payload = JSON.parse(frames[0]!.split("\n").find(line => line.startsWith("data: "))!.slice(6)) as {
          error: { type: string; retry_after: number }
        }
        expect(payload.error.type).toBe("rate_limit_error")
        return payload.error.retry_after
      }

      function expectWaitUntil(wait: number, reset: number): void {
        expect(wait).toBeGreaterThanOrEqual(Math.ceil((reset - Date.now()) / 1000) - 2)
        expect(wait).toBeLessThanOrEqual(Math.ceil((reset - Date.now()) / 1000) + 2)
      }

      async function benchFablePool(app: TestApp, resets: readonly number[]): Promise<void> {
        for (const [index, profile] of PROFILES.entries()) {
          const dir = `ap-${profile.id}`
          fableSpentDirs.add(dir)
          fableLimitEvents.set(dir, fableLimitEvent(resets[index]!))
          if (stream) fablePingFirstDirs.add(dir)
        }
        const res = await post(app, {}, "establish the model benches", FABLE)
        expect(res.status).toBe(429)
        await res.json()
        // The next refusal supplies no reset; it attempts a ten-minute mark.
        fableLimitEvents.clear()
        rateLimitStore.clear()
      }

      for (const [label, hours] of [
        ["the retried account", [3, 4, 5]],
        ["a skipped account", [5, 3, 4]],
      ] as const) {
        it(`keeps the longer model benches when a shorter repeat would hide ${label}'s opening`, async () => {
          const app = createTestApp()
          await setActive(app, "work")
          const resets = hours.map(hours => Date.now() + hours * 60 * 60_000)
          await benchFablePool(app, resets)

          capturedEnvs = []
          const wait = await waitFrom(await post(app, {}, "retry without a reset", FABLE, stream))
          expect(capturedEnvs).toEqual(["/tmp/meridian-ap-work"])
          expectWaitUntil(wait, Math.min(...resets))
          const state = await health(app)
          expect(state.exhausted).toEqual([])
          for (const [index, profile] of PROFILES.entries()) {
            expect(Math.abs((state.exhaustedModels.find(mark => mark.id === profile.id)?.until ?? 0) - resets[index]!)).toBeLessThan(1_000)
          }
          // A longer model bench must not move unrelated conversations.
          capturedEnvs = []
          expect(await servedBy(await post(app, {}, "another model"))).toContain("ap-work")
          expect(capturedEnvs).toEqual(["/tmp/meridian-ap-work"])
        }, 40_000)
      }

      it("waits for both account and model exclusions before comparing accounts", async () => {
        const app = createTestApp()
        await setActive(app, "work")
        const now = Date.now()
        const modelResets = [2, 4, 6].map(hours => now + hours * 60 * 60_000)
        await benchFablePool(app, modelResets)
        const accountResets = [3, 1, 1].map(hours => now + hours * 60 * 60_000)
        for (const [index, profile] of PROFILES.entries()) {
          rateLimitStore.record(profile.id, {
            status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: accountResets[index]!,
          })
          failingDirs.add(`ap-${profile.id}`)
        }
        failureMessage = THROTTLED
        const accountRefusal = await post(app, {}, "establish the account benches")
        expect(accountRefusal.status).toBe(429)
        await accountRefusal.json()
        failingDirs.clear()
        rateLimitStore.clear()

        capturedEnvs = []
        const wait = await waitFrom(await post(app, {}, "retry the overlapping benches", FABLE, stream))
        expect(capturedEnvs).toEqual(["/tmp/meridian-ap-work"])
        // Work needs its 3h account reset (not its 2h model reset);
        // personal needs its 4h model reset (not its 1h account reset).
        expectWaitUntil(wait, accountResets[0]!)
        const state = await health(app)
        for (const [index, profile] of PROFILES.entries()) {
          expect(Math.abs((state.exhausted.find(mark => mark.id === profile.id)?.until ?? 0) - accountResets[index]!)).toBeLessThan(1_000)
          expect(Math.abs((state.exhaustedModels.find(mark => mark.id === profile.id)?.until ?? 0) - modelResets[index]!)).toBeLessThan(1_000)
        }
      }, 40_000)

      it("uses a bench extended while later accounts are still being tried", async () => {
        const app = createTestApp()
        await setActive(app, "work")
        const reset = Date.now() + 3 * 60 * 60_000
        type Usage = NonNullable<Awaited<ReturnType<typeof fetchOAuthUsage>>>
        let refineWork: ((usage: Usage) => void) | undefined
        __setFetchOAuthUsageOverride(async options => {
          if (options?.profileId === "work") return new Promise<Usage>(resolve => { refineWork = resolve })
          if (options?.profileId === "personal") {
            expect(refineWork).toBeDefined()
            refineWork!({
              windows: [{ type: "seven_day_fable", utilization: 1, resetsAt: reset }],
              extraUsage: null, fetchedAt: Date.now(),
            })
          }
          return null
        })
        for (const profile of PROFILES) {
          fableSpentDirs.add(`ap-${profile.id}`)
          if (stream) fablePingFirstDirs.add(`ap-${profile.id}`)
        }
        fableLimitEvents.set("ap-personal", fableLimitEvent(Date.now() + 4 * 60 * 60_000))
        fableLimitEvents.set("ap-spare", fableLimitEvent(Date.now() + 5 * 60 * 60_000))
        // Work initially gets ten minutes, extended to three hours only
        // after personal refuses. Its earlier observed wait is now obsolete.
        const wait = await waitFrom(await post(app, {}, "refine during failover", FABLE, stream))
        expectWaitUntil(wait, reset)
        expect((await health(app)).exhaustedModels.find(mark => mark.id === "work")?.until).toBe(reset)
      }, 40_000)

      it("does not wait for another account once an eligible bench has expired", async () => {
        const app = createTestApp()
        await setActive(app, "work")
        const now = Date.now()
        __setFetchOAuthUsageOverride(async options => {
          if (options?.profileId === "personal") {
            setSystemTime(new Date(now + 2 * 60_000))
            restoreClock = () => setSystemTime()
          }
          return null
        })
        for (const [index, profile] of PROFILES.entries()) {
          const dir = `ap-${profile.id}`
          fableSpentDirs.add(dir)
          fableLimitEvents.set(dir, fableLimitEvent(now + [60_000, 3 * 60 * 60_000, 4 * 60 * 60_000][index]!))
          if (stream) fablePingFirstDirs.add(dir)
        }
        const wait = await waitFrom(await post(app, {}, "a bench expires during failover", FABLE, stream))
        // No effective exclusion remains on work: retain the ordinary
        // retry fallback instead of waiting hours for personal or spare.
        expect(wait).toBe(60)
        expect((await health(app)).exhaustedModels.map(mark => mark.id)).toEqual(["personal", "spare"])
      }, 40_000)

      it("keeps the ordinary ten-minute first-mark wait model-local", async () => {
        const app = createTestApp()
        await setActive(app, "work")
        for (const profile of PROFILES) {
          fableSpentDirs.add(`ap-${profile.id}`)
          if (stream) fablePingFirstDirs.add(`ap-${profile.id}`)
        }
        const before = Date.now()
        const wait = await waitFrom(await post(app, {}, "first refusal without resets", FABLE, stream))
        expectWaitUntil(wait, before + 10 * 60_000)
        expect(capturedEnvs).toEqual(PROFILES.map(profile => profile.claudeConfigDir))
        const state = await health(app)
        expect(state.exhausted).toEqual([])
        expect(state.exhaustedModels.map(mark => [mark.id, mark.model])).toEqual(PROFILES.map(profile => [profile.id, "fable"]))
        expect(await servedBy(await post(app, {}, "another model"))).toContain("ap-work")
      }, 40_000)
    })
  }

  it("counts the active account toward the wait once it is skipped as benched", async () => {
    // The order puts the active account last. It is tried first all the
    // same, and once benched is skipped, and may still be the first to get
    // Fable back.
    process.env.MERIDIAN_PROFILE_ORDER = "personal,spare"
    const soon = Date.now() + 20 * 60_000
    fableLimitEvents.set("ap-work", fableLimitEvent(soon))
    fableLimitEvents.set("ap-personal", fableLimitEvent(Date.now() + 5 * 24 * 60 * 60_000))
    fableLimitEvents.set("ap-spare", fableLimitEvent(Date.now() + 3 * 24 * 60 * 60_000))
    const app = createTestApp()
    await setActive(app, "work")
    fableSpentDirs.add("ap-work")
    fableSpentDirs.add("ap-personal")
    expect(await servedBy(await post(app, {}, "first", FABLE))).toContain("ap-spare")

    fableSpentDirs.add("ap-spare")
    capturedEnvs = []
    const refused = await post(app, {}, "the next Fable request", FABLE)
    expect(refused.status).toBe(429)
    expect(capturedEnvs).toEqual(["/tmp/meridian-ap-spare"])
    const wait = Number(refused.headers.get("retry-after"))
    expect(wait).toBeGreaterThan(18 * 60)
    expect(wait).toBeLessThanOrEqual(Math.ceil((soon - Date.now()) / 1000) + 2)
  }, 40_000)

  it("answers 429 when no account has Fable allowance left, and still serves the other models", async () => {
    const app = createTestApp()
    await setActive(app, "work")
    for (const dir of ["ap-work", "ap-personal", "ap-spare"]) fableSpentDirs.add(dir)
    const refused = await post(app, {}, "first", FABLE)
    expect(refused.status).toBe(429)
    expect((await refused.json() as { error: { type: string } }).error.type).toBe("rate_limit_error")

    const res = await post(app, {}, "the main thread's next turn")
    expect(res.status).toBe(200)
    expect(await servedBy(res)).toContain("ap-work")
  }, 40_000)

  it("holds in plain priority routing, where a conversation goes with its own request", async () => {
    // No active profile outranks an assignment there: the conversation whose
    // Fable request was moved stays on the account that served it, and the
    // ones that never asked for Fable stay where they were.
    process.env.MERIDIAN_ROUTING = "priority"
    const app = createTestApp()
    fableSpentDirs.add("ap-work")
    expect(await servedBy(await post(app, { "x-opencode-session": "main" }, "the main thread"))).toContain("ap-work")
    expect(await servedBy(await post(app, { "x-opencode-session": "sub" }, "a subagent's first turn", FABLE))).toContain("ap-personal")

    capturedEnvs = []
    expect(await servedBy(await post(app, { "x-opencode-session": "main" }, "the main thread's next turn"))).toContain("ap-work")
    expect(await servedBy(await post(app, { "x-opencode-session": "sub-2" }, "another subagent", FABLE))).toContain("ap-personal")
    expect(await servedBy(await post(app, { "x-opencode-session": "sub" }, "the first subagent, on another model"))).toContain("ap-personal")
    expect(capturedEnvs).toHaveLength(3)
    const state = await health(app)
    expect(state.exhausted).toEqual([])
    expect(state.exhaustedModels.map(e => [e.id, e.model])).toEqual([["work", "fable"]])
  }, 30_000)
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
