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
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId } from "./helpers"
import { createPriorityAttestation } from "../../plugin/priority-attestation"
import type { PriorityFailbackPolicy } from "../proxy/routing"
import type { DurablePriorityAssignment } from "../proxy/sessionStore"

type CapturedSdkCall = {
  readonly dir: string
  readonly phase: number
  readonly resume: unknown
  readonly sessionId: unknown
}

type PromotionConcurrencyGate = {
  readonly phase: number
  calls: number
  active: number
  maxActive: number
  blocked: boolean
  readonly entered: Promise<void>
  readonly release: Promise<void>
  readonly signalEntered: () => void
  readonly open: () => void
}

type StreamCompletionGate = {
  readonly phase: number
  readonly entered: Promise<void>
  readonly release: Promise<void>
  readonly signalEntered: () => void
  readonly open: () => void
}

function createPromotionConcurrencyGate(phase: number): PromotionConcurrencyGate {
  let signalEntered = (): void => {}
  let open = (): void => {}
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const release = new Promise<void>(resolve => { open = resolve })
  return { phase, calls: 0, active: 0, maxActive: 0, blocked: false, entered, release, signalEntered, open }
}

function createStreamCompletionGate(phase: number): StreamCompletionGate {
  let signalEntered = (): void => {}
  let open = (): void => {}
  const entered = new Promise<void>(resolve => { signalEntered = resolve })
  const release = new Promise<void>(resolve => { open = resolve })
  return { phase, entered, release, signalEntered, open }
}

let capturedEnvs: string[] = []
let capturedSdkCalls: CapturedSdkCall[] = []
let capturePhase = 0
let failingDirs = new Set<string>()
// Accounts that fail only AFTER streaming some content — the error frame then
// lands behind message_start, where the sniffer must not touch it.
let failAfterContentDirs = new Set<string>()
type ExposureBeforeFailureKind = "tool" | "structured"
let exposureBeforeFailureDirs = new Map<string, ExposureBeforeFailureKind>()
let noncanonicalToolFailureDirs = new Set<string>()
let promotionConcurrencyGate: PromotionConcurrencyGate | null = null
let streamCompletionGate: StreamCompletionGate | null = null
let latePublicationRecoveryGate: StreamCompletionGate | null = null
let latePublicationRecoveryCalls = 0
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

installSdkMock(() => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    capturedEnvs.push(dir)
    const phase = capturePhase
    capturedSdkCalls.push({
      dir,
      phase,
      resume: params.options?.resume,
      sessionId: params.options?.sessionId,
    })
    const streaming = params.options?.includePartialMessages === true
    const returnedSessionId = resolveMockSdkSessionId(params.options)
    const withReturnedSessionId = (message: any) => returnedSessionId
      ? { ...message, session_id: returnedSessionId }
      : message
    return (async function* () {
      const gate = promotionConcurrencyGate
      const tracksPromotion = gate !== null && gate.phase === phase
      if (tracksPromotion) {
        gate.calls += 1
        gate.active += 1
        gate.maxActive = Math.max(gate.maxActive, gate.active)
        if (!gate.blocked) {
          gate.blocked = true
          gate.signalEntered()
          await gate.release
        }
      }
      try {
        const lateGate = latePublicationRecoveryGate
        if (lateGate !== null && lateGate.phase === phase && streaming) {
          latePublicationRecoveryCalls += 1
          if (latePublicationRecoveryCalls === 1) {
            // Produce a complete but silent first turn. Meridian publishes its
            // durable target, then starts silent-turn recovery. The second call
            // below is therefore an exact post-publication cancellation gate.
            yield withReturnedSessionId(messageStart("msg-silent"))
            yield withReturnedSessionId(textBlockStart(0))
            yield withReturnedSessionId(blockStop(0))
            yield withReturnedSessionId(messageDelta("end_turn"))
            yield withReturnedSessionId(messageStop())
            yield withReturnedSessionId(assistantMessage([]))
            return
          }
          lateGate.signalEntered()
          await lateGate.release
          yield withReturnedSessionId(assistantMessage([{ type: "text", text: "late recovery" }]))
          return
        }
        if ([...noncanonicalToolFailureDirs].some((fragment) => dir.includes(fragment))) {
          const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
          if (typeof hook !== "function") throw new Error("test expected a PreToolUse hook")
          void hook({
            tool_name: "read",
            tool_use_id: "noncanonical-tool",
            tool_input: {},
          })
          throw new Error("Reached maximum number of turns (3)")
        }
        const exposureFailure = [...exposureBeforeFailureDirs.entries()]
          .find(([fragment]) => dir.includes(fragment))?.[1]
        if (exposureFailure) {
          const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
          if (typeof hook !== "function") throw new Error("test expected a PreToolUse exposure hook")
          const hookPromise = hook({
            tool_name: exposureFailure === "structured" ? "StructuredOutput" : "read",
            tool_use_id: `exposed-${exposureFailure}`,
            tool_input: {},
          })
          if (exposureFailure === "structured") await hookPromise
          else void hookPromise
          // No stream frame preceded this account error. The priority sniffer
          // must return a replayable error body without trying another profile.
          throw new Error(failureMessage)
        }
        if ([...failingDirs].some((f) => dir.includes(f))) {
          throw new Error(failureMessage)
        }
        if ([...failAfterContentDirs].some((f) => dir.includes(f))) {
          if (streaming) {
            yield withReturnedSessionId(messageStart("msg-1"))
            yield withReturnedSessionId(textBlockStart(0))
            yield withReturnedSessionId(textDelta(0, "partial from " + dir))
          }
          throw new Error(failureMessage)
        }
        if (streaming) {
          yield withReturnedSessionId(messageStart("msg-1"))
          const completionGate = streamCompletionGate
          if (completionGate !== null && completionGate.phase === phase) {
            completionGate.signalEntered()
            await completionGate.release
          }
          yield withReturnedSessionId(textBlockStart(0))
          yield withReturnedSessionId(textDelta(0, "ok from " + dir))
          yield withReturnedSessionId(blockStop(0))
          yield withReturnedSessionId(messageDelta("end_turn"))
          yield withReturnedSessionId(messageStop())
        }
        yield withReturnedSessionId(assistantMessage([{ type: "text", text: "ok from " + dir }]))
      } finally {
        if (tracksPromotion) gate.active -= 1
      }

    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "priority-routing-integration.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { loadSettings, saveSettings } = await import("../proxy/settings")
const {
  evictSharedSession,
  lookupPriorityAssignmentResult,
  lookupSharedSessionResult,
} = await import("../proxy/sessionStore")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-test-prof-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-test-prof-personal" },
]

const PRIORITY_ATTESTATION_TEST_KEY = Buffer.alloc(32, 0x71)
const testTurnClock = new Map<string, { humanMessageId: string; issuedAt: number }>()

function trustedOpenCodeTurnHeaders(
  sessionId: string,
  humanMessageId: string,
  issuedAt?: number,
): Record<string, string> {
  const previous = testTurnClock.get(sessionId)
  const resolvedIssuedAt = issuedAt ?? (
    previous?.humanMessageId === humanMessageId
      ? previous.issuedAt
      : Math.max(Math.floor(Date.now() / 1000), (previous?.issuedAt ?? 0) + 1)
  )
  if (issuedAt === undefined) testTurnClock.set(sessionId, { humanMessageId, issuedAt: resolvedIssuedAt })
  const token = createPriorityAttestation({
    generation: "oc1",
    sessionId,
    agentId: "build",
    humanMessageId,
    issuedAt: resolvedIssuedAt,
  }, PRIORITY_ATTESTATION_TEST_KEY)
  if (!token) throw new Error("failed to create test priority attestation")
  return {
    "x-opencode-session": sessionId,
    "x-opencode-request": humanMessageId,
    "x-opencode-agent-name": "build",
    "x-opencode-agent-mode": "primary",
    "x-meridian-opencode-turn": token,
  }
}

function durableRoute(sessionId: string): DurablePriorityAssignment {
  const route = lookupPriorityAssignmentResult(`opencode:${sessionId}`)
  if (route.status !== "found") throw new Error(`durable route is ${route.status}`)
  return route.assignment
}

function unauthenticatedOpenCodeHeaders(
  sessionId: string,
  invalidAttestation = false,
): Record<string, string> {
  const headers = trustedOpenCodeTurnHeaders(sessionId, "untrusted-placeholder")
  if (invalidAttestation) {
    const token = headers["x-meridian-opencode-turn"]!
    const [prefix, payload, signature] = token.split(".")
    if (!prefix || !payload || !signature) throw new Error("test attestation has an invalid shape")
    headers["x-meridian-opencode-turn"] = `${prefix}.${payload}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`
  } else {
    delete headers["x-meridian-opencode-turn"]
  }
  return headers
}

type TestApp = {
  readonly fetch: (request: Request) => Response | Promise<Response>
}

function createTestApp(): TestApp {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
  return app
}

type TestMessage = {
  readonly role: "user" | "assistant"
  readonly content: string | readonly Record<string, unknown>[]
}

type PostMessagesOptions = {
  readonly headers?: Record<string, string>
  readonly content?: string | readonly TestMessage[]
  readonly stream: boolean
  readonly signal?: AbortSignal
  readonly tools?: readonly Record<string, unknown>[]
}

async function postMessages(app: TestApp, options: PostMessagesOptions): Promise<Response> {
  const content = options.content ?? "hello"
  const messages = typeof content === "string" ? [{ role: "user", content }] : content
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: options.stream,
      messages,
      ...(options.tools ? { tools: options.tools } : {}),
    }),
    ...(options.signal ? { signal: options.signal } : {}),
  }))
}

async function post(app: TestApp, headers: Record<string, string> = {}, content: string | readonly TestMessage[] = "hello"): Promise<Response> {
  return postMessages(app, { headers, content, stream: false })
}

async function postStream(app: TestApp, options: Omit<PostMessagesOptions, "stream">): Promise<Response> {
  return postMessages(app, { ...options, stream: true })
}

const OPENING_MESSAGE = "shared opening"
const CONTINUED_AFTER_PERSONAL: readonly TestMessage[] = [
  { role: "user", content: OPENING_MESSAGE },
  { role: "assistant", content: [{ type: "text", text: "ok from /tmp/meridian-test-prof-personal" }] },
  { role: "user", content: "next human turn" },
]
const TOOL_CONTINUATION: readonly TestMessage[] = [
  { role: "user", content: OPENING_MESSAGE },
  { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
]

async function assignToFallback(app: TestApp, sessionId: string, requestId = "request-1"): Promise<string> {
  process.env.MERIDIAN_PROFILE_ORDER = "personal,work"
  const response = await post(app, trustedOpenCodeTurnHeaders(sessionId, requestId), OPENING_MESSAGE)
  await response.json()
  const assigned = [...capturedSdkCalls].reverse().find(call => call.dir.includes("prof-personal"))?.sessionId
  if (typeof assigned !== "string") throw new Error("fallback assignment did not create a managed session")
  process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  capturedEnvs = []
  capturedSdkCalls = []
  return assigned
}

async function seedPreferredAndFallbackSessions(app: TestApp, sessionId: string): Promise<string> {
  const preferred = await post(app, {
    "x-meridian-profile": "work",
    "x-opencode-session": sessionId,
    "x-opencode-request": "stale-preferred-request",
    "x-opencode-request-kind": "human",
  }, OPENING_MESSAGE)
  await preferred.json()
  return assignToFallback(app, sessionId)
}

async function exhaustedMarks(app: { fetch: (r: Request) => Response | Promise<Response> }) {
  const res = await app.fetch(new Request("http://localhost/profiles/list"))
  const body = await res.json() as { exhausted?: Array<{ id: string; until: number; reason: string }> }
  return body.exhausted ?? []
}

const savedEnv: Record<string, string | undefined> = {}
let savedPriorityFailbackSetting: PriorityFailbackPolicy | undefined

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
  exposureBeforeFailureDirs = new Map()
  noncanonicalToolFailureDirs = new Set()
  promotionConcurrencyGate = null
  streamCompletionGate = null
  latePublicationRecoveryGate = null
  latePublicationRecoveryCalls = 0
  capturedSdkCalls = []
  capturePhase = 0
  testTurnClock.clear()
  savedPriorityFailbackSetting = loadSettings().priorityFailback
  saveSettings({ priorityFailback: undefined })
  __setFetchOAuthUsageOverride(async () => null)
})

afterEach(() => {
  saveSettings({ priorityFailback: savedPriorityFailbackSetting })
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
    savedEnv.MERIDIAN_PRIORITY_FAILBACK = process.env.MERIDIAN_PRIORITY_FAILBACK
    savedEnv.MERIDIAN_OPENCODE_ATTESTATION_KEY = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = PRIORITY_ATTESTATION_TEST_KEY.toString("base64url")
    // A profile with no claudeConfigDir of its own inherits the ambient
    // CLAUDE_CONFIG_DIR, so the SDK mock sees the developer's real config
    // directory instead of falling back to its "default" sentinel. A test that
    // fails such a profile by adding "default" to failingDirs then never fails
    // it at all. Green in CI, red on any machine that runs Claude Code with a
    // custom config dir — which is most of this project's users.
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    savedEnv.MERIDIAN_MAX_CONCURRENT = process.env.MERIDIAN_MAX_CONCURRENT
    savedEnv.PASSTHROUGH = process.env.PASSTHROUGH
    savedEnv.MERIDIAN_SILENT_TURN_RECOVERY = process.env.MERIDIAN_SILENT_TURN_RECOVERY
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    delete process.env.MERIDIAN_PRIORITY_FAILBACK
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

  it("fails over on the CLI's 'You're out of usage credits' wording", async () => {
    failureMessage = "Claude Code returned an error result: You're out of usage credits. /model to switch models."
    failingDirs.add("prof-work")
    const app = createTestApp()
    const res = await post(app)
    expect(res.status).toBe(200)
    const body = await res.json() as { content: Array<{ text: string }> }
    expect(body.content[0]?.text).toContain("prof-personal")
  }, 20_000)

  it("does not spend or exhaust the pool for incidental usage-credit prose", async () => {
    failureMessage = "Claude Code returned an error result: You're out of usage credits. This is only a documentation example, account healthy."
    failingDirs.add("prof-work")
    const app = createTestApp()

    const refused = await post(app, { "x-opencode-session": "incidental-usage-credit" })
    expect(refused.status).toBe(500)
    expect(capturedEnvs.length).toBeGreaterThan(0)
    expect(capturedEnvs.every(env => env.includes("prof-work"))).toBe(true)

    failingDirs.clear()
    capturedEnvs = []
    const recovered = await post(app, { "x-opencode-session": "incidental-usage-credit" }, "try again")
    expect(recovered.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-work")
  })

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

  it("defaults an unset priority failback policy to new-conversation affinity", async () => {
    // Given
    const app = createTestApp()
    await assignToFallback(app, "unset-policy-session")

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("unset-policy-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("defaults an invalid priority failback policy to new-conversation affinity", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "eventually"
    const app = createTestApp()
    await assignToFallback(app, "invalid-policy-session")

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("invalid-policy-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("accepts next-user-turn and promotes on a changed human request", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "human-promotion-session")

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("human-promotion-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-work")
    expect(capturedEnvs[0]).toContain("prof-work")
  })

  it("uses persisted priorityFailback when the environment is unset", async () => {
    // Given
    saveSettings({ priorityFailback: "next-user-turn" })
    const app = createTestApp()
    await assignToFallback(app, "persisted-policy-session")

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("persisted-policy-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-work")
  })

  it("lets MERIDIAN_PRIORITY_FAILBACK override persisted priorityFailback", async () => {
    // Given
    saveSettings({ priorityFailback: "next-user-turn" })
    process.env.MERIDIAN_PRIORITY_FAILBACK = "new-conversation"
    const app = createTestApp()
    await assignToFallback(app, "env-policy-session")

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("env-policy-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("does not promote a same-ID tool continuation even when kind remains human", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "tool-continuation-session")

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("tool-continuation-session", "request-1"), TOOL_CONTINUATION)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("does not promote a changed synthetic request", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "synthetic-request-session")

    // When
    const response = await post(app, {
      "x-opencode-session": "synthetic-request-session",
      "x-opencode-request": "request-2",
      "x-opencode-request-kind": "synthetic",
    }, CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("does not promote a changed request with an unknown kind", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "unknown-request-session")

    // When
    const response = await post(app, {
      "x-opencode-session": "unknown-request-session",
      "x-opencode-request": "request-2",
      "x-opencode-request-kind": "unknown",
    }, CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("ignores spoofed OpenCode turn headers on a non-OpenCode adapter", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    process.env.MERIDIAN_PROFILE_ORDER = "personal,work"
    const assigned = await post(app, { "x-meridian-agent": "pi" }, OPENING_MESSAGE)
    await assigned.text()
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    capturedEnvs = []

    // When
    const response = await post(app, {
      "x-meridian-agent": "pi",
      "x-opencode-session": "spoofed-session",
      "x-opencode-request": "request-2",
      "x-opencode-request-kind": "human",
    }, CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("starts a fresh preferred backing session when promoting", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await seedPreferredAndFallbackSessions(app, "fresh-promotion-session")
    const promotionPhase = ++capturePhase

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("fresh-promotion-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(capturedSdkCalls.filter(call => call.phase === promotionPhase && call.dir.includes("prof-work")).map(call => call.resume)).toEqual([undefined])
    expect(body).toContain("prof-work")
  })

  it("retains and resumes fallback after a pre-content preferred quota failure", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    const fallbackSessionId = await seedPreferredAndFallbackSessions(app, "failed-promotion-session")
    failingDirs.add("prof-work")
    const promotionPhase = ++capturePhase

    // When
    const response = await post(app, trustedOpenCodeTurnHeaders("failed-promotion-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    const promotionCalls = capturedSdkCalls.filter(call => call.phase === promotionPhase)
    const preferredCalls = promotionCalls.filter(call => call.dir.includes("prof-work"))
    expect(preferredCalls.length).toBeGreaterThan(0)
    expect(preferredCalls.every(call => call.resume === undefined)).toBe(true)
    expect(promotionCalls.filter(call => call.dir.includes("prof-personal")).map(call => call.resume)).toEqual([fallbackSessionId])
    expect(body).toContain("prof-personal")
  }, 20_000)

  it("serializes concurrent next-user-turn promotions for one logical session", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "concurrent-promotion-session")
    const promotionPhase = ++capturePhase
    const gate = createPromotionConcurrencyGate(promotionPhase)
    promotionConcurrencyGate = gate
    const first = post(app, trustedOpenCodeTurnHeaders("concurrent-promotion-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    await gate.entered

    // When
    const second = post(app, trustedOpenCodeTurnHeaders("concurrent-promotion-session", "request-3"), CONTINUED_AFTER_PERSONAL)
    await new Promise<void>(resolve => setImmediate(resolve))
    gate.open()
    const responses = await Promise.all([first, second])
    await Promise.all(responses.map(response => response.text()))

    // Then
    expect(gate.maxActive).toBe(1)
  })

  it("releases a queued turn when the promoted stream completes", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "completed-promotion-session")
    const promotionPhase = ++capturePhase
    const gate = createPromotionConcurrencyGate(promotionPhase)
    promotionConcurrencyGate = gate
    const first = postStream(app, {
      headers: trustedOpenCodeTurnHeaders("completed-promotion-session", "request-2"),
      content: CONTINUED_AFTER_PERSONAL,
    })
    await gate.entered
    const queued = post(app, trustedOpenCodeTurnHeaders("completed-promotion-session", "request-3"), CONTINUED_AFTER_PERSONAL)
    await new Promise<void>(resolve => setImmediate(resolve))
    gate.open()

    // When
    const firstResponse = await first
    const firstBody = await firstResponse.text()
    const queuedResponse = await queued
    const queuedBody = await queuedResponse.json()

    // Then
    expect(firstBody).toContain("prof-work")
    expect(gate.maxActive).toBe(1)
    expect(queuedResponse.status).toBe(400)
    expect(queuedBody).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.",
      },
    })
  })

  it("releases a queued promotion when the promoted stream is cancelled", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "cancelled-promotion-session")
    const promotionPhase = ++capturePhase
    const gate = createPromotionConcurrencyGate(promotionPhase)
    promotionConcurrencyGate = gate
    const first = postStream(app, {
      headers: trustedOpenCodeTurnHeaders("cancelled-promotion-session", "request-2"),
      content: CONTINUED_AFTER_PERSONAL,
    })
    await gate.entered
    const second = post(app, trustedOpenCodeTurnHeaders("cancelled-promotion-session", "request-3"), CONTINUED_AFTER_PERSONAL)
    await new Promise<void>(resolve => setImmediate(resolve))
    gate.open()
    const firstResponse = await first

    // When
    const firstBody = firstResponse.body
    expect(firstBody).not.toBeNull()
    if (firstBody === null) return
    await firstBody.cancel("test cancellation")
    const secondResponse = await second
    await secondResponse.text()

    // Then
    expect(gate.maxActive).toBe(1)
  })

  it("holds the turn lease until an aborted promoted stream completes", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "signal-cancelled-promotion-session")
    const promotionPhase = ++capturePhase
    const gate = createPromotionConcurrencyGate(promotionPhase)
    const completionGate = createStreamCompletionGate(promotionPhase)
    promotionConcurrencyGate = gate
    streamCompletionGate = completionGate
    const requestController = new AbortController()
    const first = postStream(app, {
      headers: trustedOpenCodeTurnHeaders("signal-cancelled-promotion-session", "request-2"),
      content: CONTINUED_AFTER_PERSONAL,
      signal: requestController.signal,
    })
    await gate.entered
    let queuedPromotionResolved = false
    const second = post(app, trustedOpenCodeTurnHeaders("signal-cancelled-promotion-session", "request-3"), CONTINUED_AFTER_PERSONAL).then(response => {
      queuedPromotionResolved = true
      return response
    })
    await new Promise<void>(resolve => setImmediate(resolve))
    gate.open()
    const firstResponse = await first
    await completionGate.entered

    // When
    requestController.abort("client timeout")
    await new Promise<void>(resolve => setImmediate(() => setImmediate(resolve)))
    const queuedPromotionResolvedBeforeCompletion = queuedPromotionResolved
    completionGate.open()
    const firstBody = firstResponse.body
    if (firstBody !== null) await firstBody.cancel("test cleanup")
    await second

    // Then
    expect(queuedPromotionResolvedBeforeCompletion).toBe(false)
    expect(queuedPromotionResolved).toBe(true)
    expect(gate.maxActive).toBe(1)
  })

  it("returns 499 for an aborted waiter and rejects a superseded following turn", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "aborted-waiter-session")
    const promotionPhase = ++capturePhase
    const gate = createPromotionConcurrencyGate(promotionPhase)
    promotionConcurrencyGate = gate
    const first = post(app, trustedOpenCodeTurnHeaders("aborted-waiter-session", "request-2"), CONTINUED_AFTER_PERSONAL)
    await gate.entered
    const requestController = new AbortController()
    const cancelled = postMessages(app, {
      headers: trustedOpenCodeTurnHeaders("aborted-waiter-session", "request-3"),
      content: CONTINUED_AFTER_PERSONAL,
      stream: false,
      signal: requestController.signal,
    })
    const third = post(app, trustedOpenCodeTurnHeaders("aborted-waiter-session", "request-4"), CONTINUED_AFTER_PERSONAL)
    await new Promise<void>(resolve => setImmediate(resolve))

    // When
    requestController.abort("client timeout")
    const cancelledResponse = await cancelled
    const cancelledBody = await cancelledResponse.json()
    gate.open()
    const [firstResponse, thirdResponse] = await Promise.all([first, third])
    await firstResponse.text()
    const thirdBody = await thirdResponse.json()

    // Then
    expect(cancelledResponse.status).toBe(499)
    expect(cancelledBody).toEqual({
      type: "error",
      error: { type: "request_cancelled", message: "The request was cancelled" },
    })
    expect(thirdResponse.status).toBe(400)
    expect(thirdBody).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.",
      },
    })
  })

  it("does not replay a promoted stream on fallback after content starts", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "contentful-promotion-session")
    failAfterContentDirs.add("prof-work")

    // When
    const response = await postStream(app, {
      headers: trustedOpenCodeTurnHeaders("contentful-promotion-session", "request-2"),
      content: CONTINUED_AFTER_PERSONAL,
    })
    const body = await response.text()

    // Then
    expect(body).toContain("partial from /tmp/meridian-test-prof-work")
    expect(body).toContain("rate_limit_error")
    expect(capturedEnvs.every(dir => dir.includes("prof-work"))).toBe(true)
  }, 20_000)

  it("withholds replayed older or equal changed attestations and retains the current route", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"

    for (const [label, issuedAtOffset] of [["equal", 0], ["older", -1]] as const) {
      const sessionId = `replayed-${label}-attestation-session`
      const app = createTestApp()
      await assignToFallback(app, sessionId, "human-1")
      const before = durableRoute(sessionId)
      capturedEnvs = []
      capturedSdkCalls = []

      const response = await post(
        app,
        trustedOpenCodeTurnHeaders(
          sessionId,
          `changed-${label}-human`,
          before.lastHumanTurnIssuedAt + issuedAtOffset,
        ),
        CONTINUED_AFTER_PERSONAL,
      )
      const body = await response.text()
      const after = durableRoute(sessionId)

      expect(response.status).toBe(200)
      expect(body).toContain("prof-personal")
      expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
      expect(after.profileId).toBe("personal")
      expect(after.lastHumanTurnDigest).toBe(before.lastHumanTurnDigest)
      expect(after.lastHumanTurnIssuedAt).toBe(before.lastHumanTurnIssuedAt)
    }
  })

  it("retains a durable fallback route without a valid attestation, including after app restart", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"

    for (const invalidAttestation of [false, true]) {
      const sessionId = invalidAttestation
        ? "invalid-attestation-restart-session"
        : "missing-attestation-restart-session"
      const firstApp = createTestApp()
      await assignToFallback(firstApp, sessionId, "human-1")
      const before = durableRoute(sessionId)
      capturedEnvs = []
      capturedSdkCalls = []

      // A new server instance has an empty process-local assignment LRU. Only
      // the durable route can retain the fallback profile here.
      const restartedApp = createTestApp()
      const response = await post(
        restartedApp,
        unauthenticatedOpenCodeHeaders(sessionId, invalidAttestation),
        CONTINUED_AFTER_PERSONAL,
      )
      const body = await response.text()
      const after = durableRoute(sessionId)

      expect(response.status).toBe(200)
      expect(body).toContain("prof-personal")
      expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
      expect(after.profileId).toBe("personal")
      expect(after.lastHumanTurnDigest).toBe(before.lastHumanTurnDigest)
      const afterMapping = lookupSharedSessionResult(after.mappingKey)
      expect(afterMapping.status).toBe("found")
      if (afterMapping.status !== "found" || !afterMapping.generation) {
        throw new Error("unsigned retained mapping is missing")
      }
      expect(after.mappingGeneration).toBe(afterMapping.generation)

      capturedEnvs = []
      capturedSdkCalls = []
      const secondMessages: readonly TestMessage[] = [
        ...CONTINUED_AFTER_PERSONAL,
        { role: "assistant", content: [{ type: "text", text: "ok from /tmp/meridian-test-prof-personal" }] },
        { role: "user", content: "second unsigned continuation" },
      ]
      const secondResponse = await post(
        createTestApp(),
        unauthenticatedOpenCodeHeaders(sessionId, invalidAttestation),
        secondMessages,
      )
      expect(secondResponse.status).toBe(200)
      expect(await secondResponse.text()).toContain("prof-personal")
      expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
      const twiceRetained = durableRoute(sessionId)
      const twiceMapping = lookupSharedSessionResult(twiceRetained.mappingKey)
      expect(twiceMapping.status).toBe("found")
      if (twiceMapping.status !== "found" || !twiceMapping.generation) {
        throw new Error("second unsigned retained mapping is missing")
      }
      expect(twiceRetained.mappingGeneration).toBe(twiceMapping.generation)
      expect(twiceRetained.lastHumanTurnDigest).toBe(before.lastHumanTurnDigest)
    }
  })

  it("never creates an unauthenticated cross-profile transcript when the retained account refuses", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.PASSTHROUGH = "1"
    const sessionId = "unsigned-retained-account-refusal"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    const fallback = durableRoute(sessionId)
    failureMessage = SUBSCRIPTION_REFUSAL
    exposureBeforeFailureDirs = new Map([["prof-personal", "tool"]])
    capturedEnvs = []
    capturedSdkCalls = []

    const response = await postStream(createTestApp(), {
      headers: unauthenticatedOpenCodeHeaders(sessionId),
      content: TOOL_CONTINUATION,
      tools: [{
        name: "read",
        description: "read a file",
        input_schema: { type: "object", properties: {} },
      }],
    })
    const body = await response.text()
    expect(body).toContain("billing_error")
    expect(capturedSdkCalls).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
    expect(capturedEnvs.some(dir => dir.includes("prof-work"))).toBe(false)

    const retained = durableRoute(sessionId)
    const mapping = lookupSharedSessionResult(retained.mappingKey)
    expect(retained.profileId).toBe("personal")
    expect(retained.lastHumanTurnDigest).toBe(fallback.lastHumanTurnDigest)
    expect(mapping.status).toBe("found")
    if (mapping.status !== "found" || !mapping.generation) throw new Error("retained mapping is missing")
    expect(retained.mappingGeneration).toBe(mapping.generation)
  }, 20_000)

  it("atomically refreshes a same-human tool continuation before the next human promotes", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const sessionId = "same-human-atomic-refresh-session"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    const before = durableRoute(sessionId)
    capturedEnvs = []
    capturedSdkCalls = []

    const continuation = await post(
      app,
      trustedOpenCodeTurnHeaders(sessionId, "human-1", before.lastHumanTurnIssuedAt + 1),
      TOOL_CONTINUATION,
    )
    expect(continuation.status).toBe(200)
    expect(await continuation.text()).toContain("prof-personal")
    const refreshed = durableRoute(sessionId)
    const refreshedMapping = lookupSharedSessionResult(refreshed.mappingKey)
    expect(refreshed.profileId).toBe("personal")
    expect(refreshed.lastHumanTurnDigest).toBe(before.lastHumanTurnDigest)
    expect(refreshedMapping.status).toBe("found")
    if (refreshedMapping.status !== "found" || !refreshedMapping.generation) {
      throw new Error("refreshed route mapping is missing")
    }
    expect(refreshed.mappingGeneration).toBe(refreshedMapping.generation)
    expect(refreshed.mappingGeneration).not.toBe(before.mappingGeneration)

    capturedEnvs = []
    capturedSdkCalls = []
    const afterToolContinuation: readonly TestMessage[] = [
      ...TOOL_CONTINUATION,
      { role: "assistant", content: [{ type: "text", text: "ok from /tmp/meridian-test-prof-personal" }] },
      { role: "user", content: "genuine next human" },
    ]
    const promoted = await post(
      app,
      trustedOpenCodeTurnHeaders(sessionId, "human-2", refreshed.lastHumanTurnIssuedAt + 1),
      afterToolContinuation,
    )
    expect(promoted.status).toBe(200)
    expect(await promoted.text()).toContain("prof-work")
    expect(capturedSdkCalls.some(call => call.dir.includes("prof-work") && call.resume === undefined)).toBe(true)
    expect(durableRoute(sessionId).profileId).toBe("work")
  })

  it("fresh-replays instead of resuming when the durable route mapping is stale", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const sessionId = "stale-durable-route-session"
    const firstApp = createTestApp()
    await assignToFallback(firstApp, sessionId, "human-1")
    const staleRoute = durableRoute(sessionId)
    expect(evictSharedSession(staleRoute.mappingKey, staleRoute.mappingGeneration)).toBe(true)
    expect(lookupSharedSessionResult(staleRoute.mappingKey).status).toBe("missing")
    capturedEnvs = []
    capturedSdkCalls = []

    const unauthenticatedCases = [
      unauthenticatedOpenCodeHeaders(sessionId),
      unauthenticatedOpenCodeHeaders(sessionId, true),
      trustedOpenCodeTurnHeaders(sessionId, "changed-equal", staleRoute.lastHumanTurnIssuedAt),
      trustedOpenCodeTurnHeaders(sessionId, "changed-older", staleRoute.lastHumanTurnIssuedAt - 1),
    ]
    for (const headers of unauthenticatedCases) {
      const withheld = await post(createTestApp(), headers, CONTINUED_AFTER_PERSONAL)
      expect(withheld.status).toBe(503)
      expect(await withheld.text()).toContain("Durable priority session state is unavailable")
    }
    expect(capturedSdkCalls).toHaveLength(0)
    expect(durableRoute(sessionId)).toEqual(staleRoute)

    const restartedApp = createTestApp()
    const replayed = await post(
      restartedApp,
      trustedOpenCodeTurnHeaders(sessionId, "human-1", staleRoute.lastHumanTurnIssuedAt + 1),
      CONTINUED_AFTER_PERSONAL,
    )
    expect(replayed.status).toBe(200)
    expect(await replayed.text()).toContain("prof-personal")
    const attempt = capturedSdkCalls.find(call => call.dir.includes("prof-personal"))
    expect(attempt?.resume).toBeUndefined()
    expect(typeof attempt?.sessionId).toBe("string")

    const repaired = durableRoute(sessionId)
    const repairedMapping = lookupSharedSessionResult(repaired.mappingKey)
    expect(repaired.profileId).toBe("personal")
    expect(repairedMapping.status).toBe("found")
    if (repairedMapping.status !== "found" || !repairedMapping.generation) {
      throw new Error("repaired route mapping is missing")
    }
    expect(repaired.mappingGeneration).toBe(repairedMapping.generation)
  })

  it("returns a usable first-frame account error after tool or structured exposure without failover", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.PASSTHROUGH = "1"
    failureMessage = SUBSCRIPTION_REFUSAL

    for (const kind of ["tool", "structured"] as const) {
      for (const stream of [false, true]) {
        exposureBeforeFailureDirs = new Map([["prof-work", kind]])
        capturedEnvs = []
        capturedSdkCalls = []
        const sessionId = `${kind}-${stream ? "stream" : "nonstream"}-exposure-account-error-session`
        const issuedAt = Math.floor(Date.now() / 1000)
        const originalHeaders = trustedOpenCodeTurnHeaders(sessionId, "human-1", issuedAt)
        const app = createTestApp()
        const response = await postMessages(app, {
          stream,
          headers: originalHeaders,
          content: "exposure must fence every retry",
          tools: [{
            name: "read",
            description: "read a file",
            input_schema: { type: "object", properties: {} },
          }],
        })
        const body = await response.text()

        expect(response.status).toBe(stream ? 200 : 402)
        expect(body).toContain("billing_error")
        expect(body).toContain("subscription")
        expect(capturedEnvs).toHaveLength(1)
        expect(capturedSdkCalls).toHaveLength(1)
        expect(capturedEnvs[0]).toContain("prof-work")

        const replay = await postMessages(createTestApp(), {
          stream,
          headers: originalHeaders,
          content: "exposure must fence every retry",
          tools: [{
            name: "read",
            description: "read a file",
            input_schema: { type: "object", properties: {} },
          }],
        })
        expect(replay.status).toBe(503)
        expect(await replay.text()).toContain("Durable priority attempt state is unavailable")
        expect(capturedSdkCalls).toHaveLength(1)

        const unsignedReplay = await postMessages(createTestApp(), {
          stream,
          headers: unauthenticatedOpenCodeHeaders(sessionId),
          content: "exposure must fence every retry",
        })
        expect(unsignedReplay.status).toBe(503)
        expect(capturedSdkCalls).toHaveLength(1)

        const invalidReplay = await postMessages(createTestApp(), {
          stream,
          headers: unauthenticatedOpenCodeHeaders(sessionId, true),
          content: "exposure must fence every retry",
        })
        expect(invalidReplay.status).toBe(503)
        expect(capturedSdkCalls).toHaveLength(1)

        exposureBeforeFailureDirs = new Map()
        const newer = await postMessages(createTestApp(), {
          stream,
          headers: trustedOpenCodeTurnHeaders(sessionId, "human-2", issuedAt + 1),
          content: "a newer human turn may recover",
        })
        expect(newer.status).toBe(200)
        expect(await newer.text()).not.toContain("Durable priority attempt state is unavailable")
        expect(capturedSdkCalls).toHaveLength(2)
      }
    }
  })

  it("durably blocks retry after an internal server-side tool is exposed", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.PASSTHROUGH = "0"
    failureMessage = SUBSCRIPTION_REFUSAL
    exposureBeforeFailureDirs = new Map([["prof-work", "tool"]])
    const sessionId = "internal-tool-exposure-account-error-session"
    const issuedAt = Math.floor(Date.now() / 1000)
    const headers = trustedOpenCodeTurnHeaders(sessionId, "human-1", issuedAt)
    const first = await postMessages(createTestApp(), {
      stream: false,
      headers,
      content: "internal tool exposure must be single-attempt",
      tools: [{
        name: "read",
        description: "read a file",
        input_schema: { type: "object", properties: {} },
      }],
    })
    expect(first.status).toBe(402)
    expect(await first.text()).toContain("billing_error")
    expect(capturedSdkCalls).toHaveLength(1)

    const replay = await postMessages(createTestApp(), {
      stream: false,
      headers,
      content: "internal tool exposure must be single-attempt",
    })
    expect(replay.status).toBe(503)
    expect(await replay.text()).toContain("Durable priority attempt state is unavailable")
    expect(capturedSdkCalls).toHaveLength(1)
  })

  it("withholds promoted tool terminals until atomic route and mapping publication", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.PASSTHROUGH = "1"

    for (const stream of [false, true]) {
      const sessionId = `noncanonical-promoted-tool-${stream ? "stream" : "nonstream"}`
      const app = createTestApp()
      await assignToFallback(app, sessionId, "human-1")
      const fallback = durableRoute(sessionId)
      noncanonicalToolFailureDirs = new Set(["prof-work"])
      capturedEnvs = []
      capturedSdkCalls = []

      const response = await postMessages(app, {
        stream,
        headers: trustedOpenCodeTurnHeaders(sessionId, "human-2", fallback.lastHumanTurnIssuedAt + 1),
        content: CONTINUED_AFTER_PERSONAL,
        tools: [{
          name: "read",
          description: "read a file",
          input_schema: { type: "object", properties: {} },
        }],
      })
      const body = await response.text()
      const retained = durableRoute(sessionId)
      const retainedMapping = lookupSharedSessionResult(retained.mappingKey)

      expect(body).toContain("error")
      expect(body).not.toContain('"stop_reason":"tool_use"')
      expect(capturedSdkCalls).toHaveLength(1)
      expect(capturedEnvs[0]).toContain("prof-work")
      expect(retained.profileId).toBe("personal")
      expect(retained.mappingGeneration).toBe(fallback.mappingGeneration)
      expect(retainedMapping.status).toBe("found")
      if (retainedMapping.status !== "found" || !retainedMapping.generation) {
        throw new Error("fallback mapping was lost after withheld tool terminal")
      }
      expect(retained.mappingGeneration).toBe(retainedMapping.generation)
      noncanonicalToolFailureDirs = new Set()
    }
  }, 20_000)

  it("withholds same-profile durable tool terminals without atomic publication", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.PASSTHROUGH = "1"

    for (const stream of [false, true]) {
      const sessionId = `noncanonical-same-profile-tool-${stream ? "stream" : "nonstream"}`
      const app = createTestApp()
      await assignToFallback(app, sessionId, "human-1")
      const fallback = durableRoute(sessionId)
      noncanonicalToolFailureDirs = new Set(["prof-personal"])
      capturedEnvs = []
      capturedSdkCalls = []

      const response = await postMessages(app, {
        stream,
        headers: trustedOpenCodeTurnHeaders(sessionId, "human-1", fallback.lastHumanTurnIssuedAt),
        content: TOOL_CONTINUATION,
        tools: [{
          name: "read",
          description: "read a file",
          input_schema: { type: "object", properties: {} },
        }],
      })
      const body = await response.text()
      expect(body).toContain("error")
      expect(body).not.toContain('"stop_reason":"tool_use"')
      expect(capturedSdkCalls).toHaveLength(1)
      expect(capturedEnvs[0]).toContain("prof-personal")
      expect(capturedEnvs.some(dir => dir.includes("prof-work"))).toBe(false)
      expect(durableRoute(sessionId).profileId).toBe("personal")
      noncanonicalToolFailureDirs = new Set()
    }
  }, 20_000)

  it("withholds unsigned retain-only tool terminals and preserves exact fallback authority", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.PASSTHROUGH = "1"

    for (const stream of [false, true]) {
      const sessionId = `noncanonical-unsigned-tool-${stream ? "stream" : "nonstream"}`
      const app = createTestApp()
      await assignToFallback(app, sessionId, "human-1")
      const fallback = durableRoute(sessionId)
      noncanonicalToolFailureDirs = new Set(["prof-personal"])
      capturedEnvs = []
      capturedSdkCalls = []

      const response = await postMessages(createTestApp(), {
        stream,
        headers: unauthenticatedOpenCodeHeaders(sessionId),
        content: TOOL_CONTINUATION,
        tools: [{
          name: "read",
          description: "read a file",
          input_schema: { type: "object", properties: {} },
        }],
      })
      const body = await response.text()
      expect(body).toContain("error")
      expect(body).not.toContain('"stop_reason":"tool_use"')
      expect(capturedSdkCalls).toHaveLength(1)
      expect(capturedEnvs[0]).toContain("prof-personal")
      const retained = durableRoute(sessionId)
      const mapping = lookupSharedSessionResult(retained.mappingKey)
      expect(retained.mappingGeneration).toBe(fallback.mappingGeneration)
      expect(mapping.status).toBe("found")
      if (mapping.status !== "found" || !mapping.generation) throw new Error("retained mapping is missing")
      expect(retained.mappingGeneration).toBe(mapping.generation)
      noncanonicalToolFailureDirs = new Set()
    }
  }, 20_000)

  it("rolls a late published promotion back to fallback when the client cancels", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.MERIDIAN_SILENT_TURN_RECOVERY = "1"
    const sessionId = "late-publication-cancel-session"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    const fallback = durableRoute(sessionId)
    const phase = ++capturePhase
    const recoveryGate = createStreamCompletionGate(phase)
    latePublicationRecoveryGate = recoveryGate

    const response = await postStream(app, {
      headers: trustedOpenCodeTurnHeaders(sessionId, "human-2", fallback.lastHumanTurnIssuedAt + 1),
      content: CONTINUED_AFTER_PERSONAL,
    })
    await recoveryGate.entered
    expect(durableRoute(sessionId).profileId).toBe("work")
    const body = response.body
    expect(body).not.toBeNull()
    if (!body) {
      recoveryGate.open()
      return
    }

    await body.cancel("cancel after atomic publication")
    recoveryGate.open()
    for (let attempt = 0; attempt < 50 && durableRoute(sessionId).profileId !== "personal"; attempt++) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }

    const restored = durableRoute(sessionId)
    const restoredMapping = lookupSharedSessionResult(restored.mappingKey)
    expect(restored.profileId).toBe("personal")
    expect(restored.lastHumanTurnDigest).toBe(fallback.lastHumanTurnDigest)
    expect(restoredMapping.status).toBe("found")
    if (restoredMapping.status !== "found" || !restoredMapping.generation) {
      throw new Error("restored fallback mapping is missing")
    }
    expect(restored.mappingGeneration).toBe(restoredMapping.generation)
    expect(capturedEnvs.every(dir => dir.includes("prof-work"))).toBe(true)
  }, 20_000)

  it("rolls an unsigned retain-only publication back on pre-terminal cancellation", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    process.env.MERIDIAN_SILENT_TURN_RECOVERY = "1"
    const sessionId = "unsigned-preterminal-cancel-session"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    const fallback = durableRoute(sessionId)
    const fallbackMapping = lookupSharedSessionResult(fallback.mappingKey)
    if (fallbackMapping.status !== "found") throw new Error("fallback mapping is missing")
    const phase = ++capturePhase
    const recoveryGate = createStreamCompletionGate(phase)
    latePublicationRecoveryGate = recoveryGate

    const response = await postStream(createTestApp(), {
      headers: unauthenticatedOpenCodeHeaders(sessionId),
      content: TOOL_CONTINUATION,
    })
    await recoveryGate.entered
    const provisional = durableRoute(sessionId)
    expect(provisional.mappingGeneration).not.toBe(fallback.mappingGeneration)
    const body = response.body
    if (!body) {
      recoveryGate.open()
      throw new Error("stream body is missing")
    }
    await body.cancel("cancel unsigned publication before terminal")
    latePublicationRecoveryGate = null
    recoveryGate.open()
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = durableRoute(sessionId)
      const mapping = lookupSharedSessionResult(current.mappingKey)
      if (
        mapping.status === "found"
        && mapping.session.claudeSessionId === fallbackMapping.session.claudeSessionId
        && current.mappingGeneration === mapping.generation
      ) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const restored = durableRoute(sessionId)
    const restoredMapping = lookupSharedSessionResult(restored.mappingKey)
    expect(restored.profileId).toBe("personal")
    expect(restored.lastHumanTurnDigest).toBe(fallback.lastHumanTurnDigest)
    expect(restoredMapping.status).toBe("found")
    if (restoredMapping.status !== "found" || !restoredMapping.generation) {
      throw new Error("unsigned rollback mapping is missing")
    }
    expect(restoredMapping.session.claudeSessionId).toBe(fallbackMapping.session.claudeSessionId)
    expect(restored.mappingGeneration).toBe(restoredMapping.generation)
  }, 20_000)

  it("keeps unsigned retain-only authority after queued terminal cancellation", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const sessionId = "unsigned-postterminal-cancel-session"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    const before = durableRoute(sessionId)

    const response = await postStream(createTestApp(), {
      headers: unauthenticatedOpenCodeHeaders(sessionId),
      content: TOOL_CONTINUATION,
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (durableRoute(sessionId).mappingGeneration !== before.mappingGeneration) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    await new Promise<void>(resolve => setImmediate(resolve))
    await response.body?.cancel("discard unsigned queued terminal")

    const retained = durableRoute(sessionId)
    const mapping = lookupSharedSessionResult(retained.mappingKey)
    expect(retained.profileId).toBe("personal")
    expect(retained.lastHumanTurnDigest).toBe(before.lastHumanTurnDigest)
    expect(mapping.status).toBe("found")
    if (mapping.status !== "found" || !mapping.generation) throw new Error("unsigned terminal mapping is missing")
    expect(retained.mappingGeneration).toBe(mapping.generation)
  }, 20_000)

  it("keeps finalized same-profile authority when a queued terminal body is cancelled", async () => {
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const sessionId = "post-terminal-cancel-session"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    const fallback = durableRoute(sessionId)
    const beforeRoute = lookupPriorityAssignmentResult(`opencode:${sessionId}`)
    if (beforeRoute.status !== "found") throw new Error("fallback route is missing")

    const response = await postStream(app, {
      headers: trustedOpenCodeTurnHeaders(sessionId, "human-1", fallback.lastHumanTurnIssuedAt),
      content: TOOL_CONTINUATION,
    })
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = lookupPriorityAssignmentResult(`opencode:${sessionId}`)
      if (current.status === "found" && current.generation !== beforeRoute.generation) break
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    // Publication and terminal finalization run synchronously once the mapping
    // changes. Leave the terminal bytes queued, then cancel the unread body.
    await new Promise<void>(resolve => setImmediate(resolve))
    await response.body?.cancel("discard queued finalized terminal")

    const retained = durableRoute(sessionId)
    const retainedMapping = lookupSharedSessionResult(retained.mappingKey)
    expect(retained.profileId).toBe("personal")
    expect(retainedMapping.status).toBe("found")
    if (retainedMapping.status !== "found" || !retainedMapping.generation) {
      throw new Error("finalized mapping was deleted by body cancellation")
    }
    expect(retained.mappingGeneration).toBe(retainedMapping.generation)
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
    savedEnv.MERIDIAN_PRIORITY_FAILBACK = process.env.MERIDIAN_PRIORITY_FAILBACK
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
    delete process.env.MERIDIAN_PRIORITY_FAILBACK
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
    savedEnv.MERIDIAN_PRIORITY_FAILBACK = process.env.MERIDIAN_PRIORITY_FAILBACK
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
    delete process.env.MERIDIAN_PRIORITY_FAILBACK
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
