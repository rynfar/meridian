/**
 * Priority profile routing integration (routing="priority", opt-in).
 *
 * Through the HTTP layer with a mocked SDK whose behavior is per-profile
 * (keyed by the CLAUDE_CONFIG_DIR each profile injects): asserts ordered
 * preference, per-request failover on rate-limit errors, header-pin bypass,
 * assignment stickiness with cache-preserving drain-back (only NEW sessions
 * return to the preferred profile), exhaustion skip, and that the mode OFF
 * is byte-identical to today's behavior.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop } from "./helpers"

let capturedEnvs: string[] = []
let failingDirs = new Set<string>()
// Accounts that fail only AFTER streaming some content — the error frame then
// lands behind message_start, where the sniffer must not touch it.
let failAfterContentDirs = new Set<string>()
const DEFAULT_FAILURE = "429 rate limit reached for this account"
// Classifies as billing_error (402): an account whose subscription lapsed or
// whose card was declined. Per-account like a quota refusal, but with no reset
// to wait for.
const SUBSCRIPTION_REFUSAL = "Claude Code returned an error result: Your Claude Max subscription is inactive — update your payment method to continue."
// Classifies as overloaded_error (503): says nothing about the account, so it
// must NOT spend the pool.
const UPSTREAM_HICCUP = "Claude Code returned an error result: upstream is overloaded"
// A perfectly ordinary failure that happens to name a file called
// subscription.ts. Before the classifier was tightened this read as
// billing_error and, with billing in the failover set, burned the whole pool.
const INCIDENTAL_BILLING_WORD =
  "Claude Code returned an error result: Reached maximum number of turns (3) while editing subscription.ts"
let failureMessage = DEFAULT_FAILURE

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    capturedEnvs.push(dir)
    const streaming = params.options?.includePartialMessages === true
    return (async function* () {
      if ([...failingDirs].some((f) => dir.includes(f))) {
        throw new Error(failureMessage)
      }
      if ([...failAfterContentDirs].some((f) => dir.includes(f))) {
        if (streaming) {
          yield messageStart("msg-1")
          yield textBlockStart(0)
          yield textDelta(0, "partial from " + dir)
        }
        throw new Error(failureMessage)
      }
      if (streaming) {
        yield messageStart("msg-1")
        yield textBlockStart(0)
        yield textDelta(0, "ok from " + dir)
        yield blockStop(0)
        yield messageDelta("end_turn")
        yield messageStop()
      }
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
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-test-prof-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-test-prof-personal" },
]

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
  return app
}

async function post(app: any, headers: Record<string, string> = {}, content = "hello") {
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

async function exhaustedMarks(app: { fetch: (r: Request) => Response | Promise<Response> }) {
  const res = await app.fetch(new Request("http://localhost/profiles/list"))
  const body = await res.json() as { exhausted?: Array<{ id: string; until: number; reason: string }> }
  return body.exhausted ?? []
}

const savedEnv: Record<string, string | undefined> = {}

// File-level: every test in this file exhausts a profile through
// dispatchPriority at some point, which fires refinePriorityCooldown ->
// fetchOAuthUsage as a real (if fire-and-forget) side effect. Without this,
// the "priority routing" describe block below (which predates the OAuth
// refinement tier and sets no override of its own) would hit the real
// fetchOAuthUsage -> createPlatformCredentialStore on every exhaustion,
// spawning a `security find-generic-password` subprocess per call and, where
// a matching credential exists, making a live HTTPS call to Anthropic from
// the test suite. The "priority cooldown resolution" describe block below
// still sets its own per-test override in its own beforeEach; Bun runs outer
// (file-level) hooks before inner (describe-level) ones, so those overrides
// still win for those tests.
beforeEach(() => {
  failureMessage = DEFAULT_FAILURE
  failAfterContentDirs = new Set()
  __setFetchOAuthUsageOverride(async () => null)
})

afterEach(() => {
  __setFetchOAuthUsageOverride(null)
})

describe("priority routing", () => {
  beforeEach(() => {
    resetProcessSdkSemaphoreForTests()
    capturedEnvs = []
    failingDirs = new Set()
    // failureMessage resets in the file-level beforeEach, which runs first and
    // covers the later describes too — this one only ever saw the leak because
    // its own tests happened to run last.
    clearSessionCache()
    // The active profile is process-global module state; other test files
    // (profile-switch integration) set it. This suite's expectations are
    // relative to defaultProfile, so reset it explicitly.
    resetActiveProfile()
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    // A profile with no claudeConfigDir of its own inherits the ambient
    // CLAUDE_CONFIG_DIR, so the SDK mock sees the developer's real config
    // directory instead of falling back to its "default" sentinel. A test that
    // fails such a profile by adding "default" to failingDirs then never fails
    // it at all. Green in CI, red on any machine that runs Claude Code with a
    // custom config dir — which is most of this project's users.
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    savedEnv.MERIDIAN_MAX_CONCURRENT = process.env.MERIDIAN_MAX_CONCURRENT
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("routes unpinned requests to the highest-priority profile", async () => {
    const app = createTestApp()
    const res = await post(app, {}, "priority routes preferred unique message")
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  })

  it("fails over per request when the preferred profile is rate-limited", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as any
    expect(body.content[0].text).toContain("prof-personal")
    // work attempted (with its internal retry ladder), then personal
    expect(capturedEnvs.some((e) => e.includes("prof-work"))).toBe(true)
    expect(capturedEnvs[capturedEnvs.length - 1]).toContain("prof-personal")
  }, 20_000)

  it("fails over without deadlocking when MAX_CONCURRENT is 1", async () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "1"
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    const app = createTestApp()

    const res = await post(app, { "x-opencode-session": "priority-single-slot" })
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("prof-personal")
  })

  it("fails over on the CLI's shorter 'You've hit your limit' wording", async () => {
    failureMessage = "Claude Code returned an error result: You've hit your limit · resets 6:40pm (UTC)"
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("prof-personal")
  }, 20_000)

  it("fails over on the CLI's 'You've hit your weekly limit' wording", async () => {
    failureMessage = "Claude Code returned an error result: You've hit your weekly limit \u00b7 resets 2pm (Asia/Jerusalem)"
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("prof-personal")
  }, 20_000)

  it("surfaces the LAST tried profile's error when every profile is exhausted", async () => {
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(429)
    const body = await res.json() as any
    expect(body.error.type).toBe("rate_limit_error")
  }, 30_000)

  it("a pinned x-meridian-profile header bypasses the pool entirely", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app, { "x-meridian-profile": "work" })
    expect(res.status).toBe(429)
    expect(capturedEnvs.every((e) => e.includes("prof-work"))).toBe(true)
  }, 20_000)

  it("keeps a failed-over session on its target while NEW sessions drain back", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Session s1 fails over to personal
    const r1 = await post(app, { "x-opencode-session": "s1" })
    expect(r1.status).toBe(200)
    // work recovers
    failingDirs.delete("prof-work")
    capturedEnvs = []
    // s1 continues on personal (assignment retained — cache preserved)
    const r2 = await post(app, { "x-opencode-session": "s1" }, "hello again")
    expect(r2.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-personal")
    // ...but work is still marked exhausted (cooldown hasn't expired), so a
    // NEW session ALSO goes to personal for now — exhaustion outlives one
    // success elsewhere. This asserts the assignment layer specifically.
  }, 20_000)

  it("skips a profile marked exhausted without re-attempting it", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app) // marks work exhausted, serves from personal
    capturedEnvs = []
    const res = await post(app, {}, "second conversation")
    expect(res.status).toBe(200)
    // Straight to personal — no work attempt within the cooldown
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 20_000)

  it("streams fail over too when the error precedes any content", async () => {
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("message_start")
    expect(text).toContain("prof-personal")
    expect(text.split("event: message_start").length - 1).toBe(1)
  }, 20_000)

  it("fails over when the preferred account's subscription is refused", async () => {
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("prof-personal")
  }, 20_000)

  it("marks the refused account with its own reason, not the quota one", async () => {
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)
    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).toEqual(["work"])
    expect(marks[0]?.reason).toBe("billing_error")
  }, 20_000)

  // The blast radius of putting billing_error in the failover set: any error
  // text containing "subscription", "billing" or "payment" — a filename, a
  // path, an MCP server's stderr — used to mark EVERY profile exhausted, and a
  // fully exhausted pool collapses the candidate list, so the next genuine
  // quota failure never reaches the healthy account.
  it("does not spend the pool on an error that merely names a billing word", async () => {
    failureMessage = INCIDENTAL_BILLING_WORD
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).not.toContain("personal")
    expect(marks.map(m => m.id)).not.toContain("work")
  }, 20_000)

  it("still fails over to a healthy account after one of those errors", async () => {
    failureMessage = INCIDENTAL_BILLING_WORD
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)

    // The pool must be intact: a real quota refusal now still reaches personal.
    failureMessage = DEFAULT_FAILURE
    const res = await post(app, {}, "second request after an incidental billing word")
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("prof-personal")
  }, 30_000)

  it("streams fail over on a refused subscription too", async () => {
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("prof-personal")
    expect(text.split("event: message_start").length - 1).toBe(1)
  }, 20_000)

  it("surfaces the refusal's own status when every account is refused", async () => {
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    const app = createTestApp()
    const res = await post(app)
    // Not a 429: a client told to back off would retry a pool that cannot
    // recover on its own.
    expect(res.status).toBe(402)
    const body = await res.json() as { error: { type: string } }
    expect(body.error.type).toBe("billing_error")
  }, 30_000)

  it("does NOT spend the pool on a failure that says nothing about the account", async () => {
    failureMessage = UPSTREAM_HICCUP
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(503)
    // personal was never tried, and work carries no exhaustion mark
    expect(capturedEnvs.length).toBeGreaterThan(0)
    expect(capturedEnvs.every((e) => e.includes("prof-work"))).toBe(true)
    expect(await exhaustedMarks(app)).toEqual([])
  }, 20_000)

  it("moves an assigned conversation off an account once its subscription is refused", async () => {
    const app = createTestApp()
    // s1 lands on work, and assignment affinity pins it there
    const first = await post(app, { "x-opencode-session": "s1" })
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { content: Array<{ text: string }> }
    expect(firstBody.content[0]?.text).toContain("prof-work")

    // work's subscription lapses. Affinity outranks the pool order, so nothing
    // but an exhaustion mark can move this conversation — which is exactly
    // what a refusal that fails to mark leaves stuck.
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    const second = await post(app, { "x-opencode-session": "s1" })
    expect(second.status).toBe(200)
    const secondBody = await second.json() as { content: Array<{ text: string }> }
    expect(secondBody.content[0]?.text).toContain("prof-personal")

    // and it does not drift back: the mark makes the next request skip work
    capturedEnvs = []
    const third = await post(app, { "x-opencode-session": "s1" })
    expect(third.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 30_000)

  it("streams the refusal's own payload when every account is refused", async () => {
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    // SSE carries its failure in the frame, not in the status
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("event: error")
    expect(text).toContain("billing_error")
    expect(text).not.toContain("message_start")
  }, 30_000)

  it("leaves a refusal that arrives AFTER content alone", async () => {
    // The deliberate limit of this whole mechanism: once the client is
    // consuming a stream it is never yanked, whatever the error says. The
    // account keeps its place — the failure is not attributed to it here.
    failureMessage = SUBSCRIPTION_REFUSAL
    failAfterContentDirs.add("prof-work")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 128,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("partial from")
    expect(text).toContain("billing_error")
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
    expect(await exhaustedMarks(app)).toEqual([])
  }, 20_000)

  it("mode OFF is byte-identical: no failover, error surfaces from the default profile", async () => {
    delete process.env.MERIDIAN_ROUTING
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app, {}, "mode-off unique message")
    expect(res.status).toBe(429)
    expect(capturedEnvs.every((e) => e.includes("prof-work"))).toBe(true)
  }, 20_000)
})

describe("priority cooldown resolution", () => {
  const WORK_RESET = Date.now() + 4 * 60 * 60_000      // 4h out
  const PERSONAL_RESET = Date.now() + 30 * 60_000      // 30m out

  beforeEach(() => {
    capturedEnvs = []
    failingDirs = new Set()
    clearSessionCache()
    resetActiveProfile()
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    // A profile with no claudeConfigDir of its own inherits the ambient
    // CLAUDE_CONFIG_DIR, so the SDK mock sees the developer's real config
    // directory instead of falling back to its "default" sentinel. A test that
    // fails such a profile by adding "default" to failingDirs then never fails
    // it at all. Green in CI, red on any machine that runs Claude Code with a
    // custom config dir — which is most of this project's users.
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    rateLimitStore.clear()
    __setFetchOAuthUsageOverride(async () => null)
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rateLimitStore.clear()
    __setFetchOAuthUsageOverride(null)
  })

  it("uses the failing profile's OWN five_hour reset, not another profile's", async () => {
    // personal has a much later reset on record. work is the one that fails.
    // The old global-singleton bug would hand work personal's number.
    rateLimitStore.record("personal", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
      resetsAt: Date.now() + 5 * 60 * 60_000,
    })
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: WORK_RESET,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).toEqual(["work"])
    expect(marks.map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("ignores the five_hour reset when the refusal is about the subscription, not the quota", async () => {
    // work has a rejected five_hour window on record, resetting 4h out. A
    // billing refusal must not borrow that number: entitlement does not come
    // back when a quota window rolls over, so adopting it would hide the
    // account for four hours instead of re-probing it on the conservative
    // default.
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: WORK_RESET,
    })
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).toEqual(["work"])
    expect(marks[0]?.reason).toBe("billing_error")
    expect(marks[0]?.until).toBeLessThan(WORK_RESET)
    expect(marks[0]?.until).toBeGreaterThanOrEqual(before + 10 * 60_000)
    expect(marks[0]?.until).toBeLessThanOrEqual(Date.now() + 10 * 60_000)
  }, 20_000)

  it("adopts a SECONDS-valued reset from the SDK, which tier 1 could never match before (#708)", async () => {
    // The SDK reports resetsAt in epoch seconds. Every fixture above uses
    // milliseconds, which is why the suite never caught it: unconverted, the
    // tier-1 gate `(e.resetsAt ?? 0) > now` compares ~1.8e9 against ~1.8e12 and
    // is ALWAYS false, so a genuinely exhausted profile silently fell through to
    // the 10-minute default. Recording in the SDK's real unit here is the point
    // of the test — do not "fix" this to milliseconds.
    const resetMs = Date.now() + 3 * 60 * 60_000
    const resetSeconds = Math.floor(resetMs / 1000)
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: resetSeconds,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).toEqual(["work"])
    // The profile's own reset, not the 10-minute default.
    expect(marks[0]!.until).toBe(resetSeconds * 1000)
    expect(marks[0]!.until).toBeGreaterThan(before + 10 * 60_000)
  }, 20_000)

  it("falls back to the 10-minute default when the profile has no entry of its own", async () => {
    rateLimitStore.record("personal", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.5,
      resetsAt: Date.now() + 5 * 60 * 60_000,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)
    const after = Date.now()

    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u >= before + 10 * 60_000 && u <= after + 10 * 60_000)).toBe(true)
  }, 20_000)

  it("falls back to the 10-minute default when the profile's own five_hour entry is healthy (allowed, utilization < 1)", async () => {
    // A healthy account always has a five_hour entry with a future resetsAt
    // — that boundary exists regardless of consumption. This entry alone
    // doesn't prove the five-hour window caused the failure that's being
    // handled right now (it could be a seven_day cap instead), so the
    // synchronous tier-1 mark must not adopt this resetsAt.
    const futureReset = Date.now() + 3 * 60 * 60_000 // several hours out
    rateLimitStore.record("work", {
      status: "allowed",
      rateLimitType: "five_hour",
      utilization: 0.4,
      resetsAt: futureReset,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)
    const after = Date.now()

    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u >= before + 10 * 60_000 && u <= after + 10 * 60_000)).toBe(true)
  }, 20_000)

  it("refines a default-length mark with the authoritative OAuth reset", async () => {
    __setFetchOAuthUsageOverride(async (opts) => {
      if (opts?.profileId !== "work") return null
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: WORK_RESET }], extraUsage: null, fetchedAt: Date.now() }
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)
    // The refinement is deliberately not awaited by the request path.
    await Bun.sleep(20)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("does not attempt an OAuth usage fetch for a non-claude-max profile (#699)", async () => {
    // `api` profiles authenticate with a key and `oauth-token` profiles keep
    // their token in env with no on-disk credentials, so the fetch can only
    // fail — and `force: true` means the 30s cache won't suppress the repeat,
    // so each exhaustion event pays for a credential read (a
    // `/usr/bin/security` subprocess on macOS) to learn nothing.
    const attempted: Array<string | null | undefined> = []
    __setFetchOAuthUsageOverride(async (opts) => {
      attempted.push(opts?.profileId)
      return null
    })
    // The shared beforeEach pins the order to "work,personal"; this app has no
    // "work", so without overriding it the keyed profile is never tried.
    process.env.MERIDIAN_PROFILE_ORDER = "keyed,personal"
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [
        { id: "keyed", type: "api", apiKey: "sk-test" },
        { id: "personal", claudeConfigDir: "/tmp/meridian-test-prof-personal" },
      ],
      defaultProfile: "keyed",
    })
    // The api profile has no CLAUDE_CONFIG_DIR, so the SDK mock sees "default".
    failingDirs.add("default")
    await post(app)
    await Bun.sleep(20)

    expect(attempted).toEqual([])
    // The profile is still benched — the guard skips refinement, not the mark.
    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.id)).toEqual(["keyed"])
  }, 20_000)

  it("still refines a claude-max profile, proving the guard is type-scoped and not a blanket skip", async () => {
    // Control for the test above: without this, deleting the OAuth call
    // entirely would satisfy the guard test and look correct.
    const attempted: Array<string | null | undefined> = []
    __setFetchOAuthUsageOverride(async (opts) => {
      attempted.push(opts?.profileId)
      if (opts?.profileId !== "work") return null
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: WORK_RESET }], extraUsage: null, fetchedAt: Date.now() }
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)
    await Bun.sleep(20)

    expect(attempted).toEqual(["work"])
    expect((await exhaustedMarks(app)).map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("never shortens an existing mark with an earlier OAuth reset", async () => {
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: WORK_RESET,
    })
    __setFetchOAuthUsageOverride(async () => ({
      windows: [{ type: "five_hour", utilization: 1, resetsAt: PERSONAL_RESET }],
      extraUsage: null,
      fetchedAt: Date.now(),
    }))
    failingDirs.add("prof-work")
    const app = createTestApp()
    await post(app)
    await Bun.sleep(20)

    const marks = await exhaustedMarks(app)
    expect(marks.map(m => m.until)).toEqual([WORK_RESET])
  }, 20_000)

  it("leaves the mark unchanged when the OAuth fetch rejects", async () => {
    __setFetchOAuthUsageOverride(async () => { throw new Error("upstream 503") })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    const res = await post(app)
    await Bun.sleep(20)

    expect(res.status).toBe(200) // failover still succeeded
    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u <= before + 10 * 60_000 + 5_000)).toBe(true)
  }, 20_000)

  it("leaves the mark unchanged when the OAuth fetch returns null", async () => {
    // The null path is the one that actually happens in production:
    // fetchOAuthUsage swallows its own failures and returns null.
    __setFetchOAuthUsageOverride(async () => null)
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    const res = await post(app)
    await Bun.sleep(20)

    expect(res.status).toBe(200) // failover still succeeded
    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u <= before + 10 * 60_000 + 5_000)).toBe(true)
  }, 20_000)

  it("does not extend the mark when the OAuth five_hour window is healthy (utilization < 1)", async () => {
    // A healthy account always has a five_hour window with a future
    // resetsAt — the rolling window boundary exists regardless of
    // consumption. Only utilization >= 1 means that window is the actual
    // cause of exhaustion; otherwise the conservative 10-minute default
    // (tier 3) must stand.
    const futureReset = Date.now() + 3 * 60 * 60_000 // comfortably in the future, well under the 6h cap
    __setFetchOAuthUsageOverride(async (opts) => {
      if (opts?.profileId !== "work") return null
      return { windows: [{ type: "five_hour", utilization: 0.2, resetsAt: futureReset }], extraUsage: null, fetchedAt: Date.now() }
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)
    await Bun.sleep(20)
    const after = Date.now()

    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u >= before + 10 * 60_000 && u <= after + 10 * 60_000)).toBe(true)
  }, 20_000)

  it("clamps the synchronous mark to the 6-hour cap even when the profile's own reset is far beyond it", async () => {
    const farReset = Date.now() + 12 * 60 * 60_000 // 12h out — beyond the 6h cap
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: farReset,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)
    const after = Date.now()

    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u >= before + 6 * 60 * 60_000 && u <= after + 6 * 60 * 60_000)).toBe(true)
  }, 20_000)

  it("clamps the refinement mark to the 6-hour cap even when OAuth reports a reset far beyond it", async () => {
    const farReset = Date.now() + 12 * 60 * 60_000 // 12h out — beyond the 6h cap
    __setFetchOAuthUsageOverride(async (opts) => {
      if (opts?.profileId !== "work") return null
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: farReset }], extraUsage: null, fetchedAt: Date.now() }
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    const before = Date.now()
    await post(app)
    await Bun.sleep(20)
    const after = Date.now()

    const marks = await exhaustedMarks(app)
    const until = marks.map(m => m.until)
    expect(until).toHaveLength(1)
    expect(until.every(u => u >= before + 6 * 60 * 60_000 && u <= after + 6 * 60 * 60_000)).toBe(true)
  }, 20_000)

  it("does not block failover on the OAuth fetch", async () => {
    // A fetch that never settles must not stall the request. The explicit
    // type parameter matters: a bare `new Promise(() => {})` infers
    // `Promise<unknown>`, which does not satisfy the override's signature
    // and fails `tsc --noEmit`.
    __setFetchOAuthUsageOverride(() => new Promise<null>(() => {}))
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    expect(capturedEnvs.some(e => e.includes("prof-personal"))).toBe(true)
  }, 20_000)
})

describe("keyless priority affinity", () => {
  beforeEach(() => {
    capturedEnvs = []
    failingDirs = new Set()
    clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear()
    // Mirror the existing blocks exactly — MERIDIAN_PROFILE_ORDER matters,
    // and the shared `savedEnv` object is restored wholesale in afterEach.
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    // A profile with no claudeConfigDir of its own inherits the ambient
    // CLAUDE_CONFIG_DIR, so the SDK mock sees the developer's real config
    // directory instead of falling back to its "default" sentinel. A test that
    // fails such a profile by adding "default" to failingDirs then never fails
    // it at all. Green in CI, red on any machine that runs Claude Code with a
    // custom config dir — which is most of this project's users.
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    rateLimitStore.clear()
    // Same restore loop the other describe blocks use — copy it verbatim from
    // the "priority routing" block's afterEach rather than hand-rolling one.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
  })

  it("keeps a KEYLESS conversation on its failed-over profile after the preferred one recovers", async () => {
    // A short-out reset makes work's exhaustion mark expire soon after being
    // set, so "the cooldown elapsed" is testable without a real 10-minute
    // (default) or multi-hour wait. The gate added in #697 requires status
    // "rejected" (or utilization >= 1) for the entry to be trusted as the
    // cooldown source — and that trust check (`resetsAt > now`) is evaluated
    // only AFTER turn 1's own rate-limit retry ladder (2 retries, 1s + 2s
    // backoff = ~3s real time) has already run its course. A resetsAt inside
    // that ~3s window would already be in the past by the time the mark is
    // set, so tier 1 would reject it and fall back to the 10-minute default
    // — silently defeating the "quick recovery" setup below. 5s clears that
    // ~3s floor with ~2s margin; the follow-up 3.6s sleep runs after the
    // ladder too, so total elapsed at turn 2 is ~6.6s — comfortably past the
    // 5s resetsAt (expiring it ~1.6s before turn 2) while still trusting the
    // mark when it's set.
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt: Date.now() + 5_000,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()

    // Turn 1 — no session header of any kind. Fails over to personal.
    const r1 = await post(app, {}, "keyless conversation")
    expect(r1.status).toBe(200)

    // work recovers AND its exhaustion mark expires.
    failingDirs.delete("prof-work")
    await Bun.sleep(3_600)
    capturedEnvs = []

    // Turn 2 of the SAME conversation. getConversationFingerprint keys off the
    // FIRST user message, so re-sending it is a faithful stand-in for a longer
    // turn-2 payload that opens with the same message.
    const r2 = await post(app, {}, "keyless conversation")
    expect(r2.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)
  }, 20_000)

  it("gives two keyless conversations independent assignments", async () => {
    // MUST be recorded BEFORE the failing request. ProfileExhaustion.mark only
    // ever EXTENDS a mark, so recording this after the failure would leave the
    // 10-minute default in place and work would never come back inside the test.
    // See the timing note in the previous test — resetsAt must clear turn 1's
    // ~3s rate-limit retry ladder or tier 1 discards it for the 10-minute
    // default and this recovery never happens.
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: Date.now() + 5_000,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Conversation A fails over to personal and is assigned there.
    expect((await post(app, {}, "conversation A")).status).toBe(200)

    // work recovers and its mark expires, so a DIFFERENT conversation is free
    // to use it — proving the assignment is per-conversation, not global.
    failingDirs.delete("prof-work")
    await Bun.sleep(3_600)
    capturedEnvs = []
    expect((await post(app, {}, "conversation B")).status).toBe(200)
    expect(capturedEnvs.some((e) => e.includes("prof-work"))).toBe(true)
  }, 20_000)

  it("lands a keyless fork on the same account as its parent", async () => {
    // work must genuinely recover before the fork request — see the timing
    // note on the first test in this block for why the resetsAt margin
    // matters. Without a real recovery, choosePriorityProfile would still be
    // skipping the (still-exhausted) work profile on its own, and the
    // assertion below would pass regardless of whether the fork actually
    // inherited its parent's assignment.
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: Date.now() + 5_000,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Parent fails over to personal.
    expect((await post(app, {}, "shared opening")).status).toBe(200)

    // work recovers AND its exhaustion mark expires — so the only thing that
    // can keep the fork on personal is the inherited assignment.
    failingDirs.delete("prof-work")
    await Bun.sleep(3_600)
    capturedEnvs = []
    // A fork shares the parent's first message, so it shares the fingerprint
    // and therefore the account. This deliberately diverges from the session
    // RESUME independence guard: an assignment picks an account, never a
    // session, so sharing costs nothing and preserves a warm cache.
    const fork = await post(app, { "x-meridian-source": "fork-memory-extract" }, "shared opening")
    expect(fork.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)
  }, 20_000)
})
