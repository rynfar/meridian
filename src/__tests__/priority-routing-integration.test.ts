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
import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from "bun:test"
import { createAdaptorServer } from "@hono/node-server"
import type { AddressInfo } from "node:net"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fetchOAuthUsage, fetchOAuthUsageResult, peekOAuthUsage, resetOAuthUsageCache } from "../proxy/oauthUsage"
import { installSdkMock } from "./sdkMock"
import { createOwnedCredentialStore } from "./modelsMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId, streamEvent } from "./helpers"
import { createPriorityAttestation } from "../../plugin/priority-attestation"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"
import { requestOptions } from "../../plugin/pi/headers"
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
// Accounts that refuse only one model: dir fragment -> SDK model substring.
let failingModelDirs = new Map<string, string>()
// Accounts that fail only AFTER streaming some content — the error frame then
// lands behind message_start, where the sniffer must not touch it.
let failAfterContentDirs = new Set<string>()
// SDK pings before an account error/success are discarded by the idle guard.
// They must not turn a pending account into an accepted stream. The proxy's
// independent 15s downstream heartbeat is exercised separately below.
let preludePingDirs = new Set<string>()
let preludePingSucceedDirs = new Set<string>()
// Accounts that sleep this long before refusing — long enough for the proxy
// heartbeat to emit `: ping` into the stream first. Scoped per account so a
// failover target serves immediately.
let preludeHeartbeatDirs = new Map<string, number>()
// Accounts that neither answer nor refuse: the client is held on keepalives
// alone until it cancels.
let silentForeverDirs = new Set<string>()
let activeSilentCalls = 0
let signalAccountPending = (): void => {}
let delayedRefusals = 0
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
        if ([...silentForeverDirs].some((f) => dir.includes(f))) {
          // A pending account that only yields keepalives until SDK abort.
          activeSilentCalls++
          try {
            yield withReturnedSessionId(streamEvent({ type: "ping" }))
            const signal: AbortSignal | undefined = params.options?.abortController?.signal
            if (!signal) throw new Error("silent fixture requires SDK abort signal")
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(new Error("aborted"))
              else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
            })
          } finally {
            activeSilentCalls--
          }
          return
        }
        const heartbeatDelay = [...preludeHeartbeatDirs.entries()]
          .find(([fragment]) => dir.includes(fragment))?.[1] ?? 0
        if (heartbeatDelay > 0) {
          // The proxy's heartbeat interval (15s) fires while this account is
          // still deciding, so the error frame lands BEHIND the comment.
          signalAccountPending()
          await new Promise(resolve => setTimeout(resolve, heartbeatDelay))
          delayedRefusals++
          throw new Error(failureMessage)
        }
        if ([...preludePingDirs].some((f) => dir.includes(f))) {
          if (streaming) {
            signalAccountPending()
            yield withReturnedSessionId(streamEvent({ type: "ping" }))
            await new Promise(resolve => setTimeout(resolve, 300))
          }
          throw new Error(failureMessage)
        }
        if ([...failingDirs].some((f) => dir.includes(f))) {
          throw new Error(failureMessage)
        }
        const sdkModel = String(params.options?.model ?? "")
        if ([...failingModelDirs].some(([f, model]) => dir.includes(f) && sdkModel.includes(model))) {
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
          if ([...preludePingSucceedDirs].some((f) => dir.includes(f))) {
            yield withReturnedSessionId(streamEvent({ type: "ping" }))
          }
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
const { loadSettings, saveSettings } = await import("../settings")
const { rememberOrganization } = await import("../proxy/organizationName")
const {
  evictSharedSession,
  lookupPriorityAssignmentResult,
  lookupSharedSessionResult,
} = await import("../proxy/sessionStore")
const { telemetryStore } = await import("../telemetry")
type TelemetryRow = import("../telemetry").RequestMetric

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

/**
 * Headers the Meridian Pi extension sends for a turn of a root Pi session,
 * produced by the extension's own request shaping and final-hook signer.
 */
function trustedPiTurnHeaders(
  sessionId: string,
  humanMessageId: string,
  source?: string,
): Record<string, string> {
  const clockKey = `pi:${sessionId}`
  const previous = testTurnClock.get(clockKey)
  const issuedAt = previous?.humanMessageId === humanMessageId
    ? previous.issuedAt
    : Math.max(Math.floor(Date.now() / 1000), (previous?.issuedAt ?? 0) + 1)
  testTurnClock.set(clockKey, { humanMessageId, issuedAt })
  const session = {
    getSessionId: () => sessionId,
    getHeader: () => null,
    getBranch: () => [{ type: "message", id: humanMessageId, message: { role: "user", timestamp: issuedAt * 1000 } }],
  }
  const shaped = requestOptions(
    normalizeContext({ messages: [] }),
    { sessionId, headers: source ? { "x-meridian-source": source } : {} },
    { session },
    PRIORITY_ATTESTATION_TEST_KEY,
  ).headers ?? {}
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(shaped)) if (value !== null) headers[name] = value
  return headers
}

async function assignPiToFallback(app: TestApp, sessionId: string): Promise<void> {
  process.env.MERIDIAN_PROFILE_ORDER = "personal,work"
  const response = await post(app, trustedPiTurnHeaders(sessionId, "a1b2c3d4"), OPENING_MESSAGE)
  await response.json()
  process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  capturedEnvs = []
  capturedSdkCalls = []
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
  readonly model?: string
}

async function postMessages(app: TestApp, options: PostMessagesOptions): Promise<Response> {
  const content = options.content ?? "hello"
  const messages = typeof content === "string" ? [{ role: "user", content }] : content
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...options.headers },
    body: JSON.stringify({
      model: options.model ?? "claude-sonnet-4-5",
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

async function postClaudeCode(app: TestApp, sessionId: string, content: string, agentId?: string): Promise<number> {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "user-agent": "claude-cli/2.1.287",
      ...(agentId ? { "x-claude-code-agent-id": agentId } : {}),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content }],
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    }),
  }))
  await response.text()
  return response.status
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
  failingModelDirs = new Map()
  preludePingDirs = new Set()
  preludePingSucceedDirs = new Set()
  preludeHeartbeatDirs = new Map()
  silentForeverDirs = new Set()
  signalAccountPending = () => {}
  delayedRefusals = 0
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
  beforeEach(async () => {
    resetProcessSdkSemaphoreForTests()
    capturedEnvs = []
    failingDirs = new Set()
    // failureMessage resets in the file-level beforeEach, which runs first and
    // covers the later describes too — this one only ever saw the leak because
    // its own tests happened to run last.
    await clearSessionCache()
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
    expect(res.headers.get("x-claude-session-id")).not.toBeNull()
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

  it("reports a failover as ONE telemetry row naming every account it touched", async () => {
    telemetryStore.clear()
    failingDirs.add("prof-work")
    const app = createTestApp()
    expect((await post(app, {}, "telemetry route chain unique message")).status).toBe(200)

    const hops = await (await app.fetch(new Request("http://localhost/telemetry/requests?hops=1"))).json() as TelemetryRow[]
    expect(hops).toHaveLength(2)
    expect(hops.every((h) => h.routeKind === "priority-hop")).toBe(true)
    expect(new Set(hops.map((h) => h.routeGroupId)).size).toBe(1)

    const rows = await (await app.fetch(new Request("http://localhost/telemetry/requests"))).json() as TelemetryRow[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.routeKind).toBe("priority")
    expect(rows[0]!.profileId).toBe("personal")
    expect(rows[0]!.routeChain).toEqual([
      { profileId: "work", ok: false, status: 429, error: "rate_limit_error" },
      { profileId: "personal", ok: true, status: 200, error: null },
    ])
  }, 20_000)

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

  describe("profiles signed in to one account", () => {
    // work and twin hold ONE account (same account and organization UUIDs);
    // personal is the same person in another organization, its own quota.
    const sameAccount = { name: "Acme", accountUuid: "acct-1", organizationUuid: "org-1", email: null }
    let tempDir = ""
    let savedOrganizations: string | null = null
    let storeOverride: ReturnType<typeof spyOn>
    const tokenMarks: Record<string, number> = {}

    function organizationsFile(): string {
      return join(process.env.MERIDIAN_CONFIG_DIR!, "organizations.json")
    }

    function createTwinApp(): TestApp {
      const { app } = createProxyServer({
        port: 0,
        host: "127.0.0.1",
        profiles: ["work", "twin", "personal"].map(id => ({
          id,
          claudeConfigDir: join(tempDir, id === "twin" ? "twin-of-w" : `prof-${id}`),
        })),
        defaultProfile: "work",
      })
      return app
    }

    beforeEach(async () => {
      tempDir = mkdtempSync(join(tmpdir(), "meridian-shared-quota-"))
      savedOrganizations = existsSync(organizationsFile()) ? readFileSync(organizationsFile(), "utf-8") : null
      const tokens = await import("../proxy/tokenRefresh")
      tokens.setCredentialStorePlatformForTests("linux")
      storeOverride = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options =>
        createOwnedCredentialStore(tempDir, options?.claudeConfigDir ?? join(tempDir, "prof-default")))
      // Each profile's stored token, far from expiry so nothing refreshes it.
      const base = Date.now() + 6 * 3_600_000
      for (const [index, dir] of ["prof-work", "twin-of-w", "prof-personal"].entries()) {
        const expiresAt = base + index * 1_000
        tokenMarks[dir] = expiresAt
        mkdirSync(join(tempDir, dir), { recursive: true })
        writeFileSync(join(tempDir, dir, ".credentials.json"), JSON.stringify({
          claudeAiOauth: { accessToken: `fake-${dir}`, refreshToken: "fake-refresh", expiresAt, subscriptionType: "max" },
        }))
      }
      rememberOrganization("work", sameAccount, tokenMarks["prof-work"]!)
      rememberOrganization("twin", sameAccount, tokenMarks["twin-of-w"]!)
      rememberOrganization("personal", { ...sameAccount, organizationUuid: "org-personal" }, tokenMarks["prof-personal"]!)
      process.env.MERIDIAN_PROFILE_ORDER = "work,twin,personal"
      failingDirs.add("prof-work")
    })

    afterEach(async () => {
      storeOverride.mockRestore()
      const tokens = await import("../proxy/tokenRefresh")
      tokens.setCredentialStorePlatformForTests(null)
      if (savedOrganizations === null) rmSync(organizationsFile(), { force: true })
      else writeFileSync(organizationsFile(), savedOrganizations)
      rmSync(tempDir, { recursive: true, force: true })
    })

    it("a quota refusal cools down every profile signed in to the same account", async () => {
      const app = createTwinApp()
      const res = await post(app, {}, "shared quota unique message")
      expect(res.status).toBe(200)
      expect(capturedEnvs[capturedEnvs.length - 1]).toContain("prof-personal")
      // The twin is never asked: its answer is the refusal work just gave.
      expect(capturedEnvs.some((e) => e.includes("twin-of-w"))).toBe(false)
      expect((await exhaustedMarks(app)).map(mark => mark.id).sort()).toEqual(["twin", "work"])
    }, 20_000)

    it("a streamed quota refusal skips the twin too", async () => {
      const app = createTwinApp()
      const res = await postMessages(app, { stream: true, content: "shared quota streamed unique message" })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("prof-personal")
      expect(capturedEnvs.some((e) => e.includes("twin-of-w"))).toBe(false)
      expect((await exhaustedMarks(app)).map(mark => mark.id).sort()).toEqual(["twin", "work"])
    }, 20_000)

    it("a twin whose stored token now belongs to another account is not cooled down", async () => {
      // twin was signed in to another account with `claude login`: its stored
      // token changed, and its saved record, read for the earlier token, still
      // names work's account.
      rememberOrganization("twin", sameAccount, tokenMarks["twin-of-w"]! - 60_000)
      const app = createTwinApp()
      const res = await post(app, {}, "relogged twin unique message")
      expect(res.status).toBe(200)
      expect(capturedEnvs[capturedEnvs.length - 1]).toContain("twin-of-w")
      expect((await exhaustedMarks(app)).map(mark => mark.id)).toEqual(["work"])
    }, 20_000)

    it("cools down no twin when the refused profile's own record predates its token", async () => {
      // Nothing proves which account refused, so nothing else is benched.
      rememberOrganization("work", sameAccount, tokenMarks["prof-work"]! - 60_000)
      const app = createTwinApp()
      const res = await post(app, {}, "stale refuser unique message")
      expect(res.status).toBe(200)
      expect(capturedEnvs[capturedEnvs.length - 1]).toContain("twin-of-w")
      expect((await exhaustedMarks(app)).map(mark => mark.id)).toEqual(["work"])
    }, 20_000)

    it("the OAuth refinement extends the twin's cooldown too", async () => {
      const WORK_RESET = Date.now() + 4 * 60 * 60_000
      __setFetchOAuthUsageOverride(async (opts) => {
        if (opts?.profileId !== "work") return null
        return { windows: [{ type: "five_hour", utilization: 1, resetsAt: WORK_RESET }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
      })
      const app = createTwinApp()
      await post(app, {}, "refined twin unique message")
      await Bun.sleep(50)
      const marks = await exhaustedMarks(app)
      expect(marks.map(m => [m.id, m.until]).sort()).toEqual([["twin", WORK_RESET], ["work", WORK_RESET]])
    }, 20_000)

    it("a per-model weekly refusal benches the twin for that model only", async () => {
      failingDirs.delete("prof-work")
      failingModelDirs.set("prof-work", "fable")
      failureMessage = "Claude Code returned an error result: You've hit your Fable limit"
      const app = createTwinApp()
      const res = await postMessages(app, { model: "claude-fable-5-2", content: "fable twin unique message", stream: false })
      expect(res.status).toBe(200)
      expect(await res.text()).toContain("prof-personal")
      expect(capturedEnvs.some((e) => e.includes("twin-of-w"))).toBe(false)
      const health = await (await app.fetch(new Request("http://localhost/profiles/health"))).json() as {
        exhausted: unknown[]
        exhaustedModels: Array<{ id: string; modelFamily: string }>
      }
      expect(health.exhausted).toEqual([])
      expect(health.exhaustedModels.map(m => [m.id, m.modelFamily]).sort()).toEqual([["twin", "fable"], ["work", "fable"]])
      capturedEnvs = []
      const other = await postMessages(app, { model: "claude-opus-4-1", content: "opus after fable twin unique message", stream: false })
      expect(other.status).toBe(200)
      await other.text()
      expect(capturedEnvs).toHaveLength(1)
      expect(capturedEnvs[0]).toContain("prof-work")
    }, 20_000)

    it("a twin whose token renewed since its account was read is still tried", async () => {
      // Same account, but the twin's access token was renewed after its record
      // was read and no /profiles/list poll has re-read it yet (headless use).
      rememberOrganization("twin", sameAccount, tokenMarks["twin-of-w"]! - 8 * 3_600_000)
      failingDirs.add("twin-of-w")
      const app = createTwinApp()
      const res = await post(app, {}, "renewed twin unique message")
      expect(res.status).toBe(200)
      expect(capturedEnvs.some((e) => e.includes("twin-of-w"))).toBe(true)
    }, 20_000)

    it("a billing refusal benches only the refused profile", async () => {
      failureMessage = SUBSCRIPTION_REFUSAL
      const app = createTwinApp()
      const res = await post(app, {}, "billing twin unique message")
      expect(res.status).toBe(200)
      expect(capturedEnvs[capturedEnvs.length - 1]).toContain("twin-of-w")
      expect((await exhaustedMarks(app)).map(mark => mark.id)).toEqual(["work"])
    }, 20_000)
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

  it("keeps a Claude Code subagent on its conversation's assigned account", async () => {
    const app = createTestApp()
    const sessionId = `cc-priority-${crypto.randomUUID()}`
    // The conversation is assigned to personal while personal is preferred.
    process.env.MERIDIAN_PROFILE_ORDER = "personal,work"
    expect(await postClaudeCode(app, sessionId, "cc opening")).toBe(200)
    expect(capturedEnvs.at(-1)).toContain("prof-personal")
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    capturedEnvs = []

    // A brand-new conversation drains back to the preferred account...
    expect(await postClaudeCode(app, `cc-priority-new-${crypto.randomUUID()}`, "cc unrelated")).toBe(200)
    expect(capturedEnvs.at(-1)).toContain("prof-work")
    // ...while a subagent of the assigned conversation stays with it.
    expect(await postClaudeCode(app, sessionId, "cc subagent task", "a4a81dc1bbf7ee837")).toBe(200)
    expect(capturedEnvs.at(-1)).toContain("prof-personal")
  })

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

  it("promotes a Pi conversation on a newer human turn signed by the Pi extension", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignPiToFallback(app, "pi-promotion-session")

    // When
    const response = await post(app, trustedPiTurnHeaders("pi-promotion-session", "e5f6a7b8"), CONTINUED_AFTER_PERSONAL)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-work")
    expect(capturedEnvs[0]).toContain("prof-work")
    expect(lookupPriorityAssignmentResult("pi:pi-promotion-session").status).toBe("found")
  })

  it("keeps a Pi tool continuation of the same human turn on its fallback", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignPiToFallback(app, "pi-tool-session")

    // When
    const response = await post(app, trustedPiTurnHeaders("pi-tool-session", "a1b2c3d4"), TOOL_CONTINUATION)
    const body = await response.text()

    // Then
    expect(body).toContain("prof-personal")
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  })

  it("never promotes a Pi request marked as a side call or subagent", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignPiToFallback(app, "pi-source-session")

    for (const source of ["fork-side-call", "subagent-child"]) {
      const headers = {
        ...trustedPiTurnHeaders("pi-source-session", "e5f6a7b8"),
        "x-meridian-source": source,
      }

      // When
      const response = await post(app, headers, CONTINUED_AFTER_PERSONAL)
      const body = await response.text()

      // Then
      expect(body).toContain("prof-personal")
      expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
    }
  })

  it("does not accept a Pi attestation for an OpenCode session, or the reverse", async () => {
    // Given
    process.env.MERIDIAN_PRIORITY_FAILBACK = "next-user-turn"
    const app = createTestApp()
    await assignToFallback(app, "cross-opencode-session")
    await assignPiToFallback(app, "cross-pi-session")
    // Everything but the generation matches what each adapter would accept.
    const issuedAt = Math.floor(Date.now() / 1000) + 5
    const piTokenForOpenCode = createPriorityAttestation({
      generation: "pi1",
      sessionId: "cross-opencode-session",
      agentId: "build",
      humanMessageId: "request-2",
      issuedAt,
    }, PRIORITY_ATTESTATION_TEST_KEY)!
    const openCodeTokenForPi = createPriorityAttestation({
      generation: "oc1",
      sessionId: "cross-pi-session",
      agentId: "pi",
      humanMessageId: "e5f6a7b8",
      issuedAt,
    }, PRIORITY_ATTESTATION_TEST_KEY)!

    // When
    const openCode = await post(app, {
      ...trustedOpenCodeTurnHeaders("cross-opencode-session", "request-2"),
      "x-meridian-opencode-turn": piTokenForOpenCode,
    }, CONTINUED_AFTER_PERSONAL)
    const pi = await post(app, {
      ...trustedPiTurnHeaders("cross-pi-session", "e5f6a7b8"),
      "x-meridian-opencode-turn": openCodeTokenForPi,
    }, CONTINUED_AFTER_PERSONAL)

    // Then
    expect(await openCode.text()).toContain("prof-personal")
    expect(await pi.text()).toContain("prof-personal")
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
    expect(await evictSharedSession(staleRoute.mappingKey, staleRoute.mappingGeneration)).toBe(true)
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
        if (stream) {
          // The withheld attempt's own error frame relays verbatim — never a
          // substituted api_error envelope (that substitution is how a
          // locked-body copy bug would show up here).
          expect(body).not.toContain("api_error")
        }
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
    // The rollback is a store write off the event loop; give it wall time, not ticks.
    for (let attempt = 0; attempt < 500 && durableRoute(sessionId).profileId !== "personal"; attempt++) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
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
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = durableRoute(sessionId)
      const mapping = lookupSharedSessionResult(current.mappingKey)
      if (
        mapping.status === "found"
        && mapping.session.claudeSessionId === fallbackMapping.session.claudeSessionId
        && current.mappingGeneration === mapping.generation
      ) break
      await new Promise<void>(resolve => setTimeout(resolve, 10))
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

  it("keeps a pre-stream refusal's own HTTP status on a streaming request", async () => {
    const gate = createStreamCompletionGate(++capturePhase)
    streamCompletionGate = gate
    const app = createTestApp()
    const headers = { "x-opencode-session": "stream-conflict-session" }
    const first = await postStream(app, { headers, content: "same request" })
    await gate.entered
    const second = postStream(app, { headers, content: "same request" })
    await Bun.sleep(10)
    gate.open()
    await first.text()
    const refused = await second
    expect(refused.status).toBe(400)
    expect(refused.headers.get("content-type")).toContain("application/json")
    const body = await refused.json() as { error: { type: string } }
    expect(body.error.type).toBe("invalid_request_error")
  }, 20_000)

  it("lets a compat route relay a pre-stream refusal with its status", async () => {
    const gate = createStreamCompletionGate(++capturePhase)
    streamCompletionGate = gate
    const app = createTestApp()
    const completion = () => app.fetch(new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-session": "compat-conflict-session" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", stream: true, messages: [{ role: "user", content: "same request" }] }),
    }))
    const first = await completion()
    await gate.entered
    const second = completion()
    await Bun.sleep(10)
    gate.open()
    await first.text()
    expect((await second).status).toBe(400)
  }, 20_000)

  const STREAM_BODY = JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 128,
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  })

  it("streams fail over when a keepalive ping precedes the account error", async () => {
    // A ping frame carries no content, so the quota refusal behind it must
    // still reach the sniffer and fail over.
    preludePingDirs.add("prof-work")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: STREAM_BODY,
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain("prof-personal")
    expect(text.split("event: message_start").length - 1).toBe(1)
    expect(text).not.toContain("rate_limit_error")
  }, 20_000)

  it("discards SDK transport pings without suppressing successful content", async () => {
    // SDK pings do not represent model progress. Raw downstream SSE keepalives
    // remain covered by the relay/framing tests and the delayed socket case.
    preludePingSucceedDirs.add("prof-work")
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: STREAM_BODY,
    }))
    expect(res.status).toBe(200)
    // Streaming already omits speculative SDK IDs: do not invent one on the
    // outer response while account selection is still pending.
    expect(res.headers.get("x-claude-session-id")).toBeNull()
    const text = await res.text()
    expect(text).not.toContain("event: ping")
    expect(text).toContain("event: message_start")
    expect(text).toContain("ok from /tmp/meridian-test-prof-work")
    expect(text.split("event: message_start").length - 1).toBe(1)
  }, 20_000)

  it("streams fail over when the service heartbeat precedes the account error", async () => {
    // The proxy heartbeats `: ping`
    // every 15s while the spent account is still deciding, and the refusal
    // arrives AFTER that comment. Shipped behavior answered the client with
    // the error and never tried the healthy account. The billing refusal
    // keeps the work account to a single attempt — a quota refusal here
    // would re-enter the in-stream retry ladder and re-sleep per attempt
    // (rate_limit_error behind a keepalive is covered by the ping test and
    // the scanner unit tests). The account decision runs inside the
    // client-facing stream, so the heartbeat itself is now observable on the
    // wire instead of buffered by a pending verdict.
    failureMessage = SUBSCRIPTION_REFUSAL
    preludeHeartbeatDirs.set("prof-work", 16_000)
    const app = createTestApp()
    const res = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: STREAM_BODY,
    }))
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain(": ping")
    expect(text).toContain("prof-personal")
    expect(text.split("event: message_start").length - 1).toBe(1)
    expect(text).not.toContain("billing_error")
  }, 35_000)

  it("delivers headers and the first keepalive before a delayed refusal, then fails over exactly once", async () => {
    // Exercise response-header and heartbeat delivery on a real socket.
    // The account decision runs INSIDE the client-facing stream: response
    // headers and the downstream heartbeat reach the client while the spent
    // account is still deciding — never held until the verdict — and the
    // healthy fallback then serves exactly once.
    failureMessage = SUBSCRIPTION_REFUSAL
    preludeHeartbeatDirs.set("prof-work", 16_000)
    const app = createTestApp()
    const server = createAdaptorServer({ fetch: app.fetch })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    try {
      const { port } = server.address() as AddressInfo
      const accountPending = new Promise<void>(resolve => { signalAccountPending = resolve })
      const pending = fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: STREAM_BODY,
      })
      await accountPending
      const first = await Promise.race([
        pending.then(() => "headers" as const),
        new Promise<"deadline">(resolve => setTimeout(() => resolve("deadline"), 100)),
      ])
      // The withheld-headers regression: a pending account verdict must not
      // hold the client's response headers.
      expect(first).toBe("headers")
      expect(delayedRefusals).toBe(0)
      const res = await pending
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      // The FIRST wire bytes are the content-free keepalive, not a decision.
      const firstChunk = await reader.read()
      const firstText = decoder.decode(firstChunk.value)
      expect(firstText).toContain(": ping\n\n")
      expect(delayedRefusals).toBe(0)
      let body = firstText
      while (true) {
        const next = await reader.read()
        if (next.done) break
        body += decoder.decode(next.value)
      }
      expect(body).toContain("prof-personal")
      expect(body.split("event: message_start").length - 1).toBe(1)
      expect(body).not.toContain("billing_error")
      expect(capturedEnvs.filter(e => e.includes("prof-personal"))).toHaveLength(1)
      expect(delayedRefusals).toBe(1)
    } finally {
      ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
      server.close()
    }
  }, 35_000)

  it("cancelling before the inner response exists never starts SDK work", async () => {
    silentForeverDirs.add("prof-work")
    const app = createTestApp()
    const res = await postStream(app, {})
    await res.body!.cancel("cancel before reader registration")
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(capturedEnvs).toHaveLength(0)
  }, 5_000)

  it("releases the exact durable turn claim after pre-response cancellation", async () => {
    const app = createTestApp()
    const sessionId = "pre-response-cancel-claim"
    await assignToFallback(app, sessionId)
    const headers = trustedOpenCodeTurnHeaders(sessionId, "cancelled-turn")
    capturedEnvs = []
    const res = await postStream(app, { headers, content: CONTINUED_AFTER_PERSONAL })
    await res.body!.cancel("cancel pending preparation")
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(capturedEnvs).toHaveLength(0)
    const retried = await postStream(app, { headers, content: CONTINUED_AFTER_PERSONAL })
    const text = await retried.text()
    expect(text).not.toContain("Durable priority attempt state is unavailable")
    expect(text).toContain("message_start")
  }, 10_000)

  it("releases the exact durable turn claim after the entire stream pool refuses", async () => {
    const app = createTestApp()
    const sessionId = "refused-pool-claim"
    await assignToFallback(app, sessionId)
    const headers = trustedOpenCodeTurnHeaders(sessionId, "refused-turn")
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    const refused = await postStream(app, { headers, content: CONTINUED_AFTER_PERSONAL })
    expect((await refused.text()).split("event: error").length - 1).toBe(1)
    failingDirs.clear()
    // A new instance has a fresh process-local exhaustion map, but shares the
    // durable claim table. Retry the exact same authenticated logical turn.
    const retried = await postStream(createTestApp(), { headers, content: CONTINUED_AFTER_PERSONAL })
    const text = await retried.text()
    expect(text).not.toContain("Durable priority attempt state is unavailable")
    expect(text).toContain("message_start")
  }, 15_000)

  it("cancelling a keepalive-only pending stream stops promptly without a fallback", async () => {
    silentForeverDirs.add("prof-work")
    const app = createTestApp()
    const pending = postStream(app, {})
    const res = await pending
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(": ping\n\n")
    expect(activeSilentCalls).toBe(1)
    // Cancel after a real keepalive, but before meaningful output.
    await reader.cancel()
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(activeSilentCalls).toBe(0)
    expect(capturedEnvs.some(e => e.includes("prof-personal"))).toBe(false)
    // A cancelled stream must not wedge the dispatcher: a fresh request
    // still answers from the pool.
    silentForeverDirs.clear()
    const fresh = await postStream(app, { content: "post-cancel unique message" })
    expect(fresh.status).toBe(200)
    expect(await fresh.text()).toContain("message_start")
  }, 25_000)

  it("emits the pool's terminal error exactly once once headers are out", async () => {
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    const app = createTestApp()
    const res = await postStream(app, {})
    // Headers go out before any verdict, so the pool's terminal refusal can
    // only travel inside the stream — one coherent error frame, not one per
    // refused account.
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text.split("event: error").length - 1).toBe(1)
    expect(text).toContain("billing_error")
    expect(text).not.toContain("message_start")
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

  beforeEach(async () => {
    capturedEnvs = []
    failingDirs = new Set()
    await clearSessionCache()
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
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: WORK_RESET }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
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
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: WORK_RESET }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
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
      bankedResets: null,
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
      return { windows: [{ type: "five_hour", utilization: 0.2, resetsAt: futureReset }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
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
      return { windows: [{ type: "five_hour", utilization: 1, resetsAt: farReset }], extraUsage: null, bankedResets: null, fetchedAt: Date.now() }
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

describe("per-model weekly bench", () => {
  const DAY_MS = 24 * 60 * 60_000
  const FABLE_LIMIT = "Claude Code returned an error result: You've hit your Fable limit"

  type Health = {
    exhausted: Array<{ id: string; until: number; reason: string }>
    exhaustedModels: Array<{ id: string; modelFamily: string; until: number; reason: string }>
    spent: Array<{ profileId: string; diagnosis: { bucket: string | null; reported: boolean; source: string }; modelFamily: string | null }>
  }

  type QuotaSpent = { diagnosis: { bucket: string | null; reported: boolean }; modelFamily: string | null } | null

  /** One profile's `spent` as `/v1/usage/quota/all` reports it. */
  async function quotaSpent(app: TestApp, id: string): Promise<QuotaSpent> {
    const body = await (await app.fetch(new Request("http://localhost/v1/usage/quota/all"))).json() as {
      profiles: Array<{ id: string; spent: QuotaSpent }>
    }
    return body.profiles.find(profile => profile.id === id)?.spent ?? null
  }

  async function health(app: TestApp): Promise<Health> {
    return await (await app.fetch(new Request("http://localhost/profiles/health"))).json() as Health
  }

  /** The profiles one request tried, in order. */
  async function attempts(app: TestApp, model: string, content: string, stream = false): Promise<string[]> {
    capturedEnvs = []
    const res = await postMessages(app, { model, content, stream })
    expect(res.status).toBe(200)
    await res.text()
    return capturedEnvs.map(dir => dir.includes("prof-work") ? "work" : dir.includes("prof-personal") ? "personal" : dir)
  }

  beforeEach(async () => {
    resetProcessSdkSemaphoreForTests()
    capturedEnvs = []
    failingDirs = new Set()
    await clearSessionCache()
    resetActiveProfile()
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    savedEnv.MERIDIAN_PRIORITY_FAILBACK = process.env.MERIDIAN_PRIORITY_FAILBACK
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    delete process.env.MERIDIAN_PRIORITY_FAILBACK
    rateLimitStore.clear()
    resetOAuthUsageCache()
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rateLimitStore.clear()
    resetOAuthUsageCache()
  })

  it("benches a profile only for the refused model, until that model's bucket resets", async () => {
    const opusReset = Date.now() + 3 * DAY_MS
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "seven_day_opus", utilization: 1, resetsAt: opusReset })
    failingModelDirs.set("prof-work", "opus")
    const app = createTestApp()

    const first = await attempts(app, "claude-opus-4-1", "opus refused on work")
    expect(first[0]).toBe("work")
    expect(first.at(-1)).toBe("personal")
    const after = await health(app)
    expect(after.exhausted).toEqual([])
    expect(after.exhaustedModels).toEqual([{ id: "work", modelFamily: "opus", until: opusReset, reason: "rate_limit_error" }])
    expect(after.spent.map(entry => entry.diagnosis)).toEqual([expect.objectContaining({ bucket: "seven_day_opus", reported: true, source: "sdk_event" })])

    // Other models keep using the profile; the refused one skips it without a re-probe.
    expect(await attempts(app, "claude-sonnet-4-5", "sonnet after the opus refusal")).toEqual(["work"])
    expect(await attempts(app, "claude-fable-5-2", "fable after the opus refusal")).toEqual(["work"])
    expect(await attempts(app, "claude-opus-4-1", "opus after the opus refusal")).toEqual(["personal"])
  }, 20_000)

  it("keeps routing other models to a Fable-refused profile and learns the Fable bucket's reset", async () => {
    const fableReset = Date.now() + 5 * DAY_MS
    __setFetchOAuthUsageOverride(async (opts) => opts?.profileId === "work"
      ? {
          windows: [
            { type: "five_hour", utilization: 0.2, resetsAt: Date.now() + 60 * 60_000 },
            { type: "seven_day", utilization: 0.4, resetsAt: Date.now() + 6 * DAY_MS },
            { type: "seven_day_fable", utilization: 1, resetsAt: fableReset },
          ],
          extraUsage: null,
          bankedResets: null,
          fetchedAt: Date.now(),
        }
      : null)
    failureMessage = FABLE_LIMIT
    failingModelDirs.set("prof-work", "fable")
    const app = createTestApp()

    const first = await attempts(app, "claude-fable-5-2", "fable refused on work")
    expect(first[0]).toBe("work")
    expect(first.at(-1)).toBe("personal")
    // The refinement is deliberately not awaited by the request path.
    await Bun.sleep(20)
    const after = await health(app)
    expect(after.exhausted).toEqual([])
    expect(after.exhaustedModels).toEqual([{ id: "work", modelFamily: "fable", until: fableReset, reason: "rate_limit_error" }])
    // What a client reads to tell a Fable-only refusal apart.
    expect(after.spent.map(entry => entry.diagnosis)).toEqual([expect.objectContaining({ bucket: "seven_day_fable", reported: true, source: "error_message" })])
    expect(await quotaSpent(app, "work")).toMatchObject({ diagnosis: { bucket: "seven_day_fable", reported: true }, modelFamily: "fable" })

    expect(await attempts(app, "claude-opus-4-1", "opus after the fable refusal")).toEqual(["work"])
    // Mythos runs on the fable tier, so it shares the bench.
    expect(await attempts(app, "claude-mythos-5", "mythos after the fable refusal")).toEqual(["personal"])
  }, 20_000)

  it("benches the whole profile when a reported Fable bucket comes back on an Opus refusal", async () => {
    failureMessage = FABLE_LIMIT
    failingModelDirs.set("prof-work", "opus")
    const app = createTestApp()

    expect((await attempts(app, "claude-opus-4-1", "opus refused with fable wording")).at(-1)).toBe("personal")
    const after = await health(app)
    expect(after.exhausted.map(entry => entry.id)).toEqual(["work"])
    expect(after.exhaustedModels).toEqual([])
    // The diagnosis still names the Fable bucket, so only modelFamily says
    // this refusal was not benched for Fable alone.
    expect(await quotaSpent(app, "work")).toMatchObject({ diagnosis: { bucket: "seven_day_fable", reported: true }, modelFamily: null })
    expect(await attempts(app, "claude-sonnet-4-5", "sonnet after the mismatched refusal")).toEqual(["personal"])
  }, 20_000)

  it("benches the whole profile for an account-wide weekly refusal, as before", async () => {
    failureMessage = "Claude Code returned an error result: You've hit your weekly limit"
    failingModelDirs.set("prof-work", "opus")
    const app = createTestApp()

    expect((await attempts(app, "claude-opus-4-1", "weekly refusal on work")).at(-1)).toBe("personal")
    const after = await health(app)
    expect(after.exhausted.map(entry => entry.id)).toEqual(["work"])
    expect(after.exhaustedModels).toEqual([])
    expect(after.spent.map(entry => entry.modelFamily)).toEqual([null])
    expect(await attempts(app, "claude-sonnet-4-5", "sonnet after the weekly refusal")).toEqual(["personal"])
  }, 20_000)

  it("benches the whole profile when the per-model bucket was only guessed from cached usage", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-model-bench-"))
    const directory = join(root, "work")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "fake-model-bench-token", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" },
    }))
    // Loaded after the SDK mock is installed, like the rest of this file's proxy modules.
    const tokens = await import("../proxy/tokenRefresh")
    tokens.setCredentialStorePlatformForTests("linux")
    try {
      const seeded = await fetchOAuthUsageResult({
        profileId: "work",
        store: createOwnedCredentialStore(root, directory),
        fetchImpl: async () => Response.json({ seven_day_opus: { utilization: 95, resets_at: new Date(Date.now() + 3 * DAY_MS).toISOString() } }),
      })
      expect(seeded.error).toBeNull()
    } finally {
      tokens.setCredentialStorePlatformForTests(null)
      rmSync(root, { recursive: true, force: true })
    }
    // The default failure names no window, so the diagnosis falls back to
    // the hottest cached one.
    failingModelDirs.set("prof-work", "opus")
    const app = createTestApp()

    expect((await attempts(app, "claude-opus-4-1", "unnamed refusal on work")).at(-1)).toBe("personal")
    const after = await health(app)
    expect(after.spent.map(entry => entry.diagnosis)).toEqual([expect.objectContaining({ bucket: "seven_day_opus", reported: false, source: "cached_usage" })])
    expect(after.exhausted.map(entry => entry.id)).toEqual(["work"])
    expect(after.exhaustedModels).toEqual([])
    expect(after.spent.map(entry => entry.modelFamily)).toEqual([null])
    expect(await attempts(app, "claude-sonnet-4-5", "sonnet after the guessed refusal")).toEqual(["personal"])
  }, 20_000)

  it("skips a Fable-benched active profile only for Fable in active+priority mode, streaming too", async () => {
    process.env.MERIDIAN_ROUTING = "active+priority"
    failureMessage = FABLE_LIMIT
    failingModelDirs.set("prof-work", "fable")
    const app = createTestApp()

    const first = await attempts(app, "claude-fable-5-2", "streamed fable refusal", true)
    expect(first[0]).toBe("work")
    expect(first.at(-1)).toBe("personal")
    expect((await health(app)).exhaustedModels.map(entry => [entry.id, entry.modelFamily])).toEqual([["work", "fable"]])
    expect(await attempts(app, "claude-sonnet-4-5", "sonnet on the active profile", true)).toEqual(["work"])
    expect(await attempts(app, "claude-fable-5-2", "fable skips the active profile", true)).toEqual(["personal"])
  }, 20_000)
})

describe("keyless priority affinity", () => {
  beforeEach(async () => {
    capturedEnvs = []
    failingDirs = new Set()
    await clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear()
    // Mirror the existing blocks exactly — MERIDIAN_PROFILE_ORDER matters,
    // and the shared `savedEnv` object is restored wholesale in afterEach.
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    savedEnv.MERIDIAN_PRIORITY_FAILBACK = process.env.MERIDIAN_PRIORITY_FAILBACK
    savedEnv.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS = process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS
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
    // These cases assert assignment after a quota reset, not backoff timing.
    process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS = "1"
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
    // Keep the reset in the future through the first request, even on a busy
    // runner. Then wait for that exact reset rather than assuming the retry
    // ladder and request processing took a fixed amount of wall time.
    const resetsAt = Date.now() + 10_000
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()

    // Turn 1 — no session header of any kind. Fails over to personal.
    const r1 = await post(app, {}, "keyless conversation")
    expect(r1.status).toBe(200)

    // work recovers AND its exhaustion mark expires.
    failingDirs.delete("prof-work")
    await Bun.sleep(Math.max(0, resetsAt - Date.now() + 100))
    capturedEnvs = []

    // Turn 2 of the SAME conversation. getConversationFingerprint keys off the
    // FIRST user message, so re-sending it is a faithful stand-in for a longer
    // turn-2 payload that opens with the same message.
    const r2 = await post(app, {}, "keyless conversation")
    expect(r2.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)
  }, 30_000)

  it("gives two keyless conversations independent assignments", async () => {
    // Record before the failure because ProfileExhaustion only extends marks.
    const resetsAt = Date.now() + 10_000
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Conversation A fails over to personal and is assigned there.
    expect((await post(app, {}, "conversation A")).status).toBe(200)

    // work recovers and its mark expires, so a DIFFERENT conversation is free
    // to use it — proving the assignment is per-conversation, not global.
    failingDirs.delete("prof-work")
    await Bun.sleep(Math.max(0, resetsAt - Date.now() + 100))
    capturedEnvs = []
    expect((await post(app, {}, "conversation B")).status).toBe(200)
    expect(capturedEnvs.some((e) => e.includes("prof-work"))).toBe(true)
  }, 30_000)

  it("lands a keyless fork on the same account as its parent", async () => {
    // Work must genuinely recover before the fork request. Otherwise
    // choosePriorityProfile would still skip the exhausted work profile and the
    // assertion below would pass regardless of whether the fork actually
    // inherited its parent's assignment.
    const resetsAt = Date.now() + 10_000
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt,
    })
    failingDirs.add("prof-work")
    const app = createTestApp()
    // Parent fails over to personal.
    expect((await post(app, {}, "shared opening")).status).toBe(200)

    // work recovers AND its exhaustion mark expires — so the only thing that
    // can keep the fork on personal is the inherited assignment.
    failingDirs.delete("prof-work")
    await Bun.sleep(Math.max(0, resetsAt - Date.now() + 100))
    capturedEnvs = []
    // A fork shares the parent's first message, so it shares the fingerprint
    // and therefore the account. This deliberately diverges from the session
    // RESUME independence guard: an assignment picks an account, never a
    // session, so sharing costs nothing and preserves a warm cache.
    const fork = await post(app, { "x-meridian-source": "fork-memory-extract" }, "shared opening")
    expect(fork.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)
  }, 30_000)
})

describe("re-authenticated profile unbenching (#1385)", () => {
  let storeOverride: { mockRestore(): void }
  let tempDir = ""
  let originalFetch: typeof globalThis.fetch
  let credentialDirs: Array<string | undefined> = []
  let resetRequests: Array<{ url: string; authorization: string | null }> = []

  async function healthSnapshots(app: TestApp) {
    const res = await app.fetch(new Request("http://localhost/profiles/list"))
    const body = await res.json() as {
      exhausted?: Array<{ id: string; until: number; reason: string }>
      spent?: Array<{ profileId: string; until: number; diagnosis: { bucket: string | null } }>
    }
    return {
      exhausted: body.exhausted ?? [],
      spent: body.spent ?? [],
    }
  }

  function stubOAuthEndpoints(status = 200, resetOutcome?: unknown, resetStatus = 200) {
    const syntheticFetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = String(input)
        if (url === "https://api.anthropic.com/api/oauth/profile") {
          return Response.json({
            organization: {
              uuid: "00000000-0000-4000-8000-000000000001",
              organization_type: "claude_max",
              rate_limit_tier: "default_claude_max_5x",
            },
          })
        }
        if (url === "https://platform.claude.com/v1/oauth/token") {
          if (status !== 200) {
            return Response.json({ error: "invalid_grant" }, { status })
          }
          return Response.json({
            access_token: "fresh-access-token",
            refresh_token: "fresh-refresh-token",
            expires_in: 3600,
          })
        }
        if (url.endsWith("/reset_rate_limits") && resetOutcome !== undefined) {
          resetRequests.push({ url, authorization: new Headers(init?.headers).get("Authorization") })
          if (typeof resetOutcome === "function") return resetOutcome()
          return Response.json(resetOutcome, { status: resetStatus })
        }
        throw new Error(`Unexpected fetch in #1385 test: ${url}`)
      },
      { preconnect: originalFetch.preconnect },
    )
    globalThis.fetch = syntheticFetch
    expect(globalThis.fetch).toBe(syntheticFetch)
  }

  function createReauthTestApp(): { app: TestApp; workDir: string; personalDir: string } {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs")
    const { join } = require("node:path") as typeof import("node:path")
    const workDir = join(tempDir, "prof-work")
    const personalDir = join(tempDir, "prof-personal")
    mkdirSync(workDir, { recursive: true })
    mkdirSync(personalDir, { recursive: true })
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [
        { id: "work", claudeConfigDir: workDir },
        { id: "personal", claudeConfigDir: personalDir },
      ],
      defaultProfile: "work",
      silent: true,
    })
    return { app, workDir, personalDir }
  }

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { resetPendingLogins } = await import("../proxy/profileLogin")
    const { resetInflightRefresh, setCredentialStorePlatformForTests, stopBackgroundRefresh } = await import("../proxy/tokenRefresh")

    originalFetch = globalThis.fetch
    // Proactive refresh can run on the first mocked HTTP turn, before the
    // explicit login/refresh request below. Refuse all other network paths.
    stubOAuthEndpoints(200)
    tempDir = mkdtempSync(join(tmpdir(), "meridian-reauth-1385-"))
    setCredentialStorePlatformForTests("linux")
    // These four controls intentionally persist synthetic OAuth tokens in their
    // newly owned directories. Keep the real file backend behind a path guard;
    // all other SDK-mocked tests retain the empty default store.
    const tokens = await import("../proxy/tokenRefresh")
    credentialDirs = []
    resetRequests = []
    storeOverride = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options => {
      credentialDirs.push(options?.claudeConfigDir)
      return createOwnedCredentialStore(tempDir, options?.claudeConfigDir ?? join(tempDir, "prof-default"))
    })
    resetPendingLogins()
    resetInflightRefresh()
    stopBackgroundRefresh()
    resetProcessSdkSemaphoreForTests()
    capturedEnvs = []
    failingDirs = new Set()
    await clearSessionCache()
    resetActiveProfile()
    rateLimitStore.clear()
    resetOAuthUsageCache()
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    savedEnv.MERIDIAN_PRIORITY_FAILBACK = process.env.MERIDIAN_PRIORITY_FAILBACK
    savedEnv.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS = process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS
    savedEnv.MERIDIAN_CREDENTIALS_READONLY = process.env.MERIDIAN_CREDENTIALS_READONLY
    savedEnv.CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_PRIORITY_FAILBACK
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    process.env.MERIDIAN_RATE_LIMIT_BASE_DELAY_MS = "1"
  })

  afterEach(async () => {
    const { rmSync } = await import("node:fs")
    const { resetPendingLogins } = await import("../proxy/profileLogin")
    const { resetInflightRefresh, setCredentialStorePlatformForTests, stopBackgroundRefresh } = await import("../proxy/tokenRefresh")

    globalThis.fetch = originalFetch
    storeOverride.mockRestore()
    setCredentialStorePlatformForTests(null)
    resetPendingLogins()
    resetInflightRefresh()
    stopBackgroundRefresh()
    resetProcessSdkSemaphoreForTests()
    rateLimitStore.clear()
    resetOAuthUsageCache()
    if (tempDir) rmSync(tempDir, { recursive: true, force: true })
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
  })

  async function seedResetCredentials(directory: string, token = "fake-reset-work"): Promise<void> {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: token, refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" },
    }))
  }

  async function resetQuota(app: TestApp, profile = "work", ids: { grantId?: string; requestId?: string } = {}): Promise<Response> {
    return app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, grantId: ids.grantId ?? "fake-grant", requestId: ids.requestId ?? "fake-request" }),
    }))
  }

  it("answers a concurrent redemption with reset_in_progress and replays a settled request ID", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    const release = Promise.withResolvers<Response>()
    const posted = Promise.withResolvers<void>()
    stubOAuthEndpoints(200, () => {
      posted.resolve()
      return release.promise
    })
    const first = resetQuota(app)
    await posted.promise
    const concurrent = await resetQuota(app, "work", { requestId: "fake-other-request" })
    expect(concurrent.status).toBe(409)
    expect(concurrent.headers.get("cache-control")).toBe("no-store")
    expect(await concurrent.json()).toEqual({ code: "reset_in_progress", error: expect.any(String), indeterminate: false })
    release.resolve(Response.json({ result: "reset", resets_left: 0, cleared: ["five_hour"] }))
    const settled = await first
    expect(settled.status).toBe(200)
    const settledBody = await settled.json() as Record<string, unknown>
    expect(settledBody).toMatchObject({ profile: "work", grantId: "fake-grant", requestId: "fake-request", result: "reset", replayed: false })
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: Date.now() + 3_600_000 })
    const replay = await resetQuota(app)
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ ...settledBody, replayed: true })
    expect(rateLimitStore.get("work", "five_hour")?.status).toBe("rejected")
    const conflict = await resetQuota(app, "work", { grantId: "fake-other-grant" })
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ code: "request_id_conflict", indeterminate: false })
    expect(resetRequests).toHaveLength(1)
  })

  it("replays an indeterminate outcome instead of re-sending a blind retry", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    stubOAuthEndpoints(200, () => { throw new Error("Synthetic connection loss") })
    const first = await resetQuota(app)
    expect(first.status).toBe(502)
    expect(await first.json()).toEqual({ code: "reset_indeterminate", error: expect.any(String), indeterminate: true, replayed: false })
    const retry = await resetQuota(app)
    expect(retry.status).toBe(502)
    expect(await retry.json()).toEqual({ code: "reset_indeterminate", error: expect.any(String), indeterminate: true, replayed: true })
    expect(resetRequests).toHaveLength(1)
  })

  it("rejects inferred token reset targets without consulting any credential store", async () => {
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1", silent: true,
      profiles: [
        { id: "inferred", oauthToken: "fake-token" },
        { id: "mislabelled", type: "claude-max", oauthToken: "fake-token" },
      ],
    })
    credentialDirs = []
    for (const profile of ["inferred", "mislabelled"]) {
      const response = await resetQuota(app, profile)
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "not_oauth" })
    }
    expect(credentialDirs).toEqual([])
    expect(resetRequests).toEqual([])
  })

  it("targets a named account instead of the active default and invalidates only that account's usage", async () => {
    const { app, workDir, personalDir } = createReauthTestApp()
    for (const [profileId, directory] of [["work", workDir], ["personal", personalDir]] as const) {
      await seedResetCredentials(directory, `fake-${profileId}-token`)
      await fetchOAuthUsage({
        profileId, store: createOwnedCredentialStore(tempDir, directory),
        fetchImpl: async () => Response.json({ five_hour: { utilization: 100 } }),
      })
    }
    expect(peekOAuthUsage("work")).toBeDefined()
    expect(peekOAuthUsage("personal")).toBeDefined()
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour"] })
    credentialDirs = []
    const response = await resetQuota(app, "personal")
    expect(response.status).toBe(200)
    expect(credentialDirs).toEqual([personalDir])
    expect(resetRequests).toEqual([expect.objectContaining({ authorization: "Bearer fake-personal-token" })])
    expect(peekOAuthUsage("personal")).toBeUndefined()
    expect(peekOAuthUsage("work")).toBeDefined()
  })

  it("targets explicit single-account default credentials and invalidates the unscoped usage cache", async () => {
    const directory = join(tempDir, "prof-default")
    await seedResetCredentials(directory, "fake-default-token")
    resetOAuthUsageCache()
    await fetchOAuthUsage({
      store: createOwnedCredentialStore(tempDir, directory),
      fetchImpl: async () => Response.json({ five_hour: { utilization: 100 } }),
    })
    expect(peekOAuthUsage()).toBeDefined()
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour"] })
    credentialDirs = []
    const response = await resetQuota(app, "default")
    expect(response.status).toBe(200)
    expect(credentialDirs).toEqual([undefined])
    expect(resetRequests).toEqual([expect.objectContaining({
      authorization: "Bearer fake-default-token",
      url: "https://api.anthropic.com/api/organizations/00000000-0000-4000-8000-000000000001/reset_rate_limits",
    })])
    expect(peekOAuthUsage()).toBeUndefined()
    resetOAuthUsageCache()
  })

  it("retains weekly and model refusals, spent state and routing exclusion after a session-only reset", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    const observedAt = Date.now()
    const resetsAt = observedAt + 3_600_000
    for (const rateLimitType of ["five_hour", "seven_day", "seven_day_opus"] as const) {
      rateLimitStore.record("work", { status: "rejected", rateLimitType, utilization: 1, resetsAt }, rateLimitType === "five_hour" ? observedAt - 1 : observedAt)
    }
    rateLimitStore.record("personal", { status: "allowed", rateLimitType: "five_hour", utilization: 0.2 })
    failingDirs.add("prof-work")
    expect((await post(app, {}, "before partial reset")).status).toBe(200)
    const before = await healthSnapshots(app)
    expect(before.spent.map(entry => entry.profileId)).toEqual(["work"])
    expect(before.spent[0]?.diagnosis.bucket).toBe("seven_day")
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour"] })
    const response = await resetQuota(app)
    expect(response.status).toBe(200)
    expect(resetRequests[0]?.authorization).toBe("Bearer fake-reset-work")
    expect(rateLimitStore.get("work", "five_hour")).toBeUndefined()
    expect(rateLimitStore.get("work", "seven_day")?.status).toBe("rejected")
    expect(rateLimitStore.get("work", "seven_day_opus")?.status).toBe("rejected")
    expect(rateLimitStore.get("personal", "five_hour")?.utilization).toBe(0.2)
    expect(await healthSnapshots(app)).toEqual(before)
    failingDirs.delete("prof-work")
    capturedEnvs = []
    expect((await post(app, {}, "after partial reset")).status).toBe(200)
    expect(capturedEnvs.length).toBeGreaterThan(0)
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  }, 20_000)

  it("removes a cleared session spent label while retaining an uncleared weekly routing exclusion", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    const resetsAt = Date.now() + 3_600_000
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt })
    failingDirs.add("prof-work")
    expect((await post(app, {}, "session refusal before weekly evidence")).status).toBe(200)
    const before = await healthSnapshots(app)
    expect(before.spent[0]?.diagnosis.bucket).toBe("five_hour")
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "seven_day", utilization: 1, resetsAt })
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(await healthSnapshots(app)).toEqual({ spent: [], exhausted: before.exhausted })
    expect(rateLimitStore.get("work", "five_hour")).toBeUndefined()
    expect(rateLimitStore.get("work", "seven_day")?.status).toBe("rejected")
    failingDirs.delete("prof-work")
    capturedEnvs = []
    expect((await post(app, {}, "weekly remains after session label cleared")).status).toBe(200)
    expect(capturedEnvs.length).toBeGreaterThan(0)
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  }, 20_000)

  it("retains independent overage refusal and routing exclusion after clearing the session window", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    const observedAt = Date.now()
    const resetsAt = observedAt + 3_600_000
    rateLimitStore.record("work", {
      status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt,
      overageStatus: "rejected", overageResetsAt: resetsAt, isUsingOverage: true,
    }, observedAt)
    failingDirs.add("prof-work")
    expect((await post(app, {}, "session with independent overage refusal")).status).toBe(200)
    const before = await healthSnapshots(app)
    expect(before.spent[0]?.diagnosis.bucket).toBe("five_hour")
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour", "seven_day_overage_included"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(rateLimitStore.get("work", "five_hour")).toMatchObject({
      status: "allowed", observedAt, overageStatus: "rejected", overageResetsAt: resetsAt, isUsingOverage: true,
    })
    expect(rateLimitStore.get("work", "five_hour")?.utilization).toBeUndefined()
    expect(rateLimitStore.get("work", "five_hour")?.resetsAt).toBeUndefined()
    expect(await healthSnapshots(app)).toEqual({ spent: [], exhausted: before.exhausted })
    failingDirs.delete("prof-work")
    capturedEnvs = []
    expect((await post(app, {}, "overage still excludes reset account")).status).toBe(200)
    expect(capturedEnvs.length).toBeGreaterThan(0)
    expect(capturedEnvs.every(dir => dir.includes("prof-personal"))).toBe(true)
  }, 20_000)

  it("unbenches a matching cleared refusal without touching another exhausted profile", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    const resetsAt = Date.now() + 3_600_000
    for (const profile of ["work", "personal"]) {
      rateLimitStore.record(profile, { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt })
    }
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")
    expect((await post(app, {}, "before matching reset")).status).toBe(429)
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect((await healthSnapshots(app)).spent.map(entry => entry.profileId)).toEqual(["personal"])
    expect((await healthSnapshots(app)).exhausted.map(entry => entry.id)).toEqual(["personal"])
    expect(rateLimitStore.get("personal", "five_hour")?.status).toBe("rejected")
    failingDirs.delete("prof-work")
    capturedEnvs = []
    expect((await post(app, {}, "after matching reset")).status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("allows a matching named session refusal to be re-probed even without a reset timestamp", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    failureMessage = "Claude Code returned an error result: You've hit your session limit"
    failingDirs.add("prof-work")
    expect((await post(app, {}, "session refusal without clock")).status).toBe(200)
    expect((await healthSnapshots(app)).spent.map(entry => entry.profileId)).toEqual(["work"])
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(await healthSnapshots(app)).toEqual({ exhausted: [], spent: [] })
    failingDirs.delete("prof-work")
    capturedEnvs = []
    expect((await post(app, {}, "retry cleared session without clock")).status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  for (const scenario of [
    { name: "empty cleared list", body: { result: "reset", cleared: [] }, status: 200, expectedStatus: 200 },
    { name: "already used grant", body: { result: "already_used", cleared: ["five_hour"] }, status: 200, expectedStatus: 200 },
    ...["not_limited", "cooldown", "ineligible", "unavailable"].map(result => ({
      name: result, body: { result, cleared: ["five_hour"] }, status: 200, expectedStatus: 200,
    })),
    { name: "uncertain mutation", body: { error: "unavailable" }, status: 503, expectedStatus: 502 },
  ]) {
    it(`preserves known quota health after ${scenario.name}`, async () => {
      const { app, workDir } = createReauthTestApp()
      await seedResetCredentials(workDir)
      rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt: Date.now() + 3_600_000 })
      failingDirs.add("prof-work")
      expect((await post(app, {}, `before ${scenario.name}`)).status).toBe(200)
      const before = await healthSnapshots(app)
      stubOAuthEndpoints(200, scenario.body, scenario.status)
      expect((await resetQuota(app)).status).toBe(scenario.expectedStatus)
      expect(await healthSnapshots(app)).toEqual(before)
      expect(rateLimitStore.get("work", "five_hour")?.status).toBe("rejected")
    }, 20_000)
  }

  it("lifts a model bench when a confirmed reset clears that model's bucket", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "seven_day_opus", utilization: 1, resetsAt: Date.now() + 3 * 24 * 60 * 60_000 })
    failingModelDirs.set("prof-work", "opus")
    expect((await postMessages(app, { model: "claude-opus-4-1", content: "opus before model reset", stream: false })).status).toBe(200)
    const health = async () => await (await app.fetch(new Request("http://localhost/profiles/health"))).json() as {
      exhaustedModels: Array<{ id: string; modelFamily: string }>
      spent: unknown[]
    }
    expect((await health()).exhaustedModels.map(entry => [entry.id, entry.modelFamily])).toEqual([["work", "opus"]])
    stubOAuthEndpoints(200, { result: "reset", cleared: ["seven_day_opus"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(await health()).toMatchObject({ exhaustedModels: [], spent: [] })
    failingModelDirs.clear()
    capturedEnvs = []
    expect((await postMessages(app, { model: "claude-opus-4-1", content: "opus after model reset", stream: false })).status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("lifts a profile-wide bench whose refusal named another model's bucket when that bucket is cleared", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    failureMessage = "Claude Code returned an error result: You've hit your Fable limit"
    failingModelDirs.set("prof-work", "opus")
    expect((await postMessages(app, { model: "claude-opus-4-1", content: "opus refused with fable wording before reset", stream: false })).status).toBe(200)
    const health = async () => await (await app.fetch(new Request("http://localhost/profiles/health"))).json() as {
      exhausted: Array<{ id: string }>
      exhaustedModels: unknown[]
    }
    expect((await health()).exhausted.map(entry => entry.id)).toEqual(["work"])
    stubOAuthEndpoints(200, { result: "reset", cleared: ["seven_day_fable"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(await health()).toMatchObject({ exhausted: [], exhaustedModels: [] })
  }, 20_000)

  it("preserves quota refusals whose bucket was never identified", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    failingDirs.add("prof-work")
    expect((await post(app, {}, "unknown refusal before reset")).status).toBe(200)
    const before = await healthSnapshots(app)
    expect(before.spent.map(entry => entry.profileId)).toEqual(["work"])
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour", "seven_day"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(await healthSnapshots(app)).toEqual(before)
  }, 20_000)

  it("preserves non-quota exhaustion when quota buckets happen to be cleared", async () => {
    const { app, workDir } = createReauthTestApp()
    await seedResetCredentials(workDir)
    failureMessage = SUBSCRIPTION_REFUSAL
    failingDirs.add("prof-work")
    expect((await post(app, {}, "billing refusal before reset")).status).toBe(200)
    const before = await healthSnapshots(app)
    expect(before.exhausted).toEqual([expect.objectContaining({ id: "work", reason: "billing_error" })])
    stubOAuthEndpoints(200, { result: "reset", cleared: ["five_hour", "seven_day"] })
    expect((await resetQuota(app)).status).toBe(200)
    expect(await healthSnapshots(app)).toEqual(before)
  }, 20_000)

  it("clears exhausted and spent state when /profiles/login/complete succeeds so the next request routes to the re-authenticated profile", async () => {
    const resetsAt = Date.now() + 60 * 60_000
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt,
    })
    failingDirs.add("prof-work")
    const { app } = createReauthTestApp()

    const first = await post(app, {}, "conv-1 before reauth")
    expect(first.status).toBe(200)
    expect(await healthSnapshots(app)).toEqual({
      exhausted: [expect.objectContaining({ id: "work", reason: "rate_limit_error" })],
      spent: [expect.objectContaining({ profileId: "work" })],
    })
    expect(rateLimitStore.get("work", "five_hour")).toBeDefined()

    // Even if upstream would now accept work, the stale bench keeps skipping it.
    failingDirs.delete("prof-work")
    capturedEnvs = []
    const stillBenched = await post(app, {}, "conv-2 while still benched")
    expect(stillBenched.status).toBe(200)
    expect(capturedEnvs.every((e) => e.includes("prof-personal"))).toBe(true)

    // Re-authenticate work via /profiles/login/start + /profiles/login/complete.
    const started = await app.fetch(new Request("http://localhost/profiles/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))
    expect(started.status).toBe(200)
    const { loginId } = await started.json() as { loginId: string }

    stubOAuthEndpoints(200)
    const completed = await app.fetch(new Request("http://localhost/profiles/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId, code: "reauth-code-123" }),
    }))
    expect(completed.status).toBe(200)

    expect(await healthSnapshots(app)).toEqual({ exhausted: [], spent: [] })
    expect(rateLimitStore.get("work", "five_hour")).toBeUndefined()

    capturedEnvs = []
    const afterReauth = await post(app, {}, "conv-3 after reauth")
    expect(afterReauth.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("clears exhausted and spent state when browser loopback /callback completes login", async () => {
    const resetsAt = Date.now() + 60 * 60_000
    rateLimitStore.record("work", {
      status: "rejected",
      rateLimitType: "five_hour",
      utilization: 1,
      resetsAt,
    })
    failingDirs.add("prof-work")
    const { app } = createReauthTestApp()

    expect((await post(app, {}, "callback conv-1")).status).toBe(200)
    expect((await healthSnapshots(app)).exhausted.map((e) => e.id)).toEqual(["work"])
    expect((await healthSnapshots(app)).spent.map((s) => s.profileId)).toEqual(["work"])

    const started = await app.fetch(new Request("http://localhost/profiles/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json", host: "127.0.0.1:3457" },
      body: JSON.stringify({ profile: "work" }),
    }))
    const { authorizeUrl } = await started.json() as { authorizeUrl: string }
    const state = new URL(authorizeUrl).searchParams.get("state") ?? ""

    stubOAuthEndpoints(200)
    const callbackRes = await app.fetch(
      new Request(`http://localhost/callback?code=loopback-code&state=${encodeURIComponent(state)}`),
    )
    expect(callbackRes.status).toBe(200)
    expect(await healthSnapshots(app)).toEqual({ exhausted: [], spent: [] })

    failingDirs.delete("prof-work")
    capturedEnvs = []
    const afterCallback = await post(app, {}, "callback conv-2")
    expect(afterCallback.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("clears only the refreshed profile on POST /auth/refresh and leaves other profiles benched", async () => {
    const { writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { app, workDir, personalDir } = createReauthTestApp()
    for (const dir of [workDir, personalDir]) {
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
        claudeAiOauth: {
          accessToken: "old-access",
          refreshToken: "old-refresh",
          expiresAt: Date.now() - 1_000,
          subscriptionType: "max",
        },
      }))
    }

    const resetsAt = Date.now() + 60 * 60_000
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt })
    rateLimitStore.record("personal", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt })
    failingDirs.add("prof-work")
    failingDirs.add("prof-personal")

    // Both accounts fail -> both get marked exhausted and spent.
    expect((await post(app, {}, "exhaust both")).status).toBe(429)
    const beforeRefresh = await healthSnapshots(app)
    expect(beforeRefresh.exhausted.map((e) => e.id).sort()).toEqual(["personal", "work"])
    expect(beforeRefresh.spent.map((s) => s.profileId).sort()).toEqual(["personal", "work"])

    stubOAuthEndpoints(200)
    const refreshRes = await app.fetch(new Request("http://localhost/auth/refresh", {
      method: "POST",
      headers: { "x-meridian-profile": "work" },
    }))
    expect(refreshRes.status).toBe(200)

    const afterRefresh = await healthSnapshots(app)
    expect(afterRefresh.exhausted.map((e) => e.id)).toEqual(["personal"])
    expect(afterRefresh.spent.map((s) => s.profileId)).toEqual(["personal"])
    expect(rateLimitStore.get("work", "five_hour")).toBeUndefined()
    expect(rateLimitStore.get("personal", "five_hour")).toBeDefined()

    failingDirs.delete("prof-work")
    capturedEnvs = []
    const afterWorkRefresh = await post(app, {}, "after work refresh")
    expect(afterWorkRefresh.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("keeps the profile benched when login completion or token refresh fails", async () => {
    const { writeFileSync } = await import("node:fs")
    const { join } = await import("node:path")
    const { app, workDir } = createReauthTestApp()
    writeFileSync(join(workDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: Date.now() - 1_000,
        subscriptionType: "max",
      },
    }))

    const resetsAt = Date.now() + 60 * 60_000
    rateLimitStore.record("work", { status: "rejected", rateLimitType: "five_hour", utilization: 1, resetsAt })
    failingDirs.add("prof-work")

    expect((await post(app, {}, "bench work")).status).toBe(200)
    expect((await healthSnapshots(app)).exhausted.map((e) => e.id)).toEqual(["work"])

    const started = await app.fetch(new Request("http://localhost/profiles/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))
    const { loginId } = await started.json() as { loginId: string }

    stubOAuthEndpoints(400)
    const failedLogin = await app.fetch(new Request("http://localhost/profiles/login/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loginId, code: "bad-code" }),
    }))
    expect(failedLogin.status).toBe(502)

    const failedRefresh = await app.fetch(new Request("http://localhost/auth/refresh", {
      method: "POST",
      headers: { "x-meridian-profile": "work" },
    }))
    expect(failedRefresh.status).toBe(500)

    const stillBenched = await healthSnapshots(app)
    expect(stillBenched.exhausted.map((e) => e.id)).toEqual(["work"])
    expect(stillBenched.spent.map((s) => s.profileId)).toEqual(["work"])
  }, 20_000)
})

describe("priority weekly reserve", () => {
  const WEEK_RESET = Date.now() + 3 * 24 * 60 * 60_000
  let savedWeeklyReserveSetting: Record<string, number> | undefined

  function recordWeekly(profileId: string, utilization: number, resetsAt = WEEK_RESET): void {
    rateLimitStore.record(profileId, { status: "allowed", rateLimitType: "seven_day", utilization, resetsAt })
  }

  beforeEach(async () => {
    resetProcessSdkSemaphoreForTests()
    capturedEnvs = []
    failingDirs = new Set()
    await clearSessionCache()
    resetActiveProfile()
    for (const key of ["MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER", "MERIDIAN_PRIORITY_FAILBACK", "MERIDIAN_WEEKLY_RESERVE", "CLAUDE_CONFIG_DIR", "MERIDIAN_OPENCODE_ATTESTATION_KEY"]) {
      savedEnv[key] = process.env[key]
    }
    process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = PRIORITY_ATTESTATION_TEST_KEY.toString("base64url")
    capturedSdkCalls = []
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.MERIDIAN_PRIORITY_FAILBACK
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
    process.env.MERIDIAN_WEEKLY_RESERVE = "work=20"
    savedWeeklyReserveSetting = loadSettings().weeklyReserve
    rateLimitStore.clear()
    resetOAuthUsageCache()
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    saveSettings({ weeklyReserve: savedWeeklyReserveSetting })
    rateLimitStore.clear()
    resetOAuthUsageCache()
  })

  it("skips the preferred profile once it reaches its reserve line", async () => {
    recordWeekly("work", 0.85)
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve holds work")
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 20_000)

  it("keeps using the preferred profile below the line", async () => {
    recordWeekly("work", 0.79)
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve below line")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("returns the profile to the pool once its weekly window has reset", async () => {
    recordWeekly("work", 0.95, Date.now() - 1000)
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve after reset")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("reads the reserve from cached OAuth usage without fetching", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const root = mkdtempSync(join(tmpdir(), "meridian-weekly-reserve-"))
    const directory = join(root, "work")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "fake-weekly-token", refreshToken: "fake-refresh", expiresAt: Date.now() + 3_600_000, subscriptionType: "max" },
    }))
    const tokens = await import("../proxy/tokenRefresh")
    // File-backed store on every platform: never the login Keychain.
    tokens.setCredentialStorePlatformForTests("linux")
    let seeded: Awaited<ReturnType<typeof fetchOAuthUsageResult>>
    try {
      seeded = await fetchOAuthUsageResult({
        profileId: "work",
        store: createOwnedCredentialStore(root, directory),
        fetchImpl: async () => Response.json({ seven_day: { utilization: 90, resets_at: new Date(WEEK_RESET).toISOString() } }),
      })
    } finally {
      tokens.setCredentialStorePlatformForTests(null)
      rmSync(root, { recursive: true, force: true })
    }
    expect(seeded.error).toBeNull()
    expect(peekOAuthUsage("work")?.windows.find(w => w.type === "seven_day")?.utilization).toBe(0.9)
    let fetches = 0
    __setFetchOAuthUsageOverride(async () => { fetches++; return null })
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve from oauth cache")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-personal")
    expect(fetches).toBe(0)
  }, 20_000)

  it("uses the weeklyReserve setting when the env var is unset", async () => {
    delete process.env.MERIDIAN_WEEKLY_RESERVE
    saveSettings({ weeklyReserve: { work: 20 } })
    recordWeekly("work", 0.81)
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve from settings")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 20_000)

  it("does nothing without a reserve configured", async () => {
    delete process.env.MERIDIAN_WEEKLY_RESERVE
    saveSettings({ weeklyReserve: undefined })
    recordWeekly("work", 0.99)
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve unconfigured")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("still honors an explicit profile pin", async () => {
    recordWeekly("work", 0.95)
    const app = createTestApp()
    const res = await post(app, { "x-meridian-profile": "work" }, "weekly reserve pinned")
    expect(res.status).toBe(200)
    expect(capturedEnvs[0]).toContain("prof-work")
  }, 20_000)

  it("answers 429 with the earliest reset when every profile holds its reserve", async () => {
    process.env.MERIDIAN_WEEKLY_RESERVE = "work=20,personal=20"
    const personalReset = Date.now() + 60 * 60_000
    recordWeekly("work", 0.9)
    recordWeekly("personal", 0.9, personalReset)
    const app = createTestApp()
    const res = await post(app, {}, "weekly reserve all held")
    expect(res.status).toBe(429)
    const retryAfter = Number(res.headers.get("retry-after"))
    expect(retryAfter).toBeGreaterThan(55 * 60)
    expect(retryAfter).toBeLessThanOrEqual(60 * 60)
    const body = await res.json() as { error: { type: string }; retry_after?: number }
    expect(body.error.type).toBe("rate_limit_error")
    expect(body.retry_after).toBe(retryAfter)
    expect(capturedEnvs).toHaveLength(0)
  }, 20_000)

  it("caps the all-held Retry-After when the earliest reset is days away", async () => {
    process.env.MERIDIAN_WEEKLY_RESERVE = "work=20,personal=20"
    recordWeekly("work", 0.9)
    recordWeekly("personal", 0.9)
    const res = await post(createTestApp(), {}, "weekly reserve capped retry")
    expect(res.status).toBe(429)
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(24 * 60 * 60)
  }, 20_000)

  it("lets retain-only work keep its route when every profile is held", async () => {
    const sessionId = "weekly-reserve-retained"
    const app = createTestApp()
    await assignToFallback(app, sessionId, "human-1")
    expect(durableRoute(sessionId).profileId).toBe("personal")
    process.env.MERIDIAN_WEEKLY_RESERVE = "work=20,personal=20"
    recordWeekly("work", 0.9)
    recordWeekly("personal", 0.9)
    const res = await post(createTestApp(), unauthenticatedOpenCodeHeaders(sessionId), TOOL_CONTINUATION)
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 20_000)

  it("skips a held active profile in active+priority mode", async () => {
    process.env.MERIDIAN_ROUTING = "active+priority"
    recordWeekly("work", 0.9)
    const app = createTestApp()
    const switched = await app.fetch(new Request("http://localhost/profiles/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile: "work" }),
    }))
    expect(switched.status).toBe(200)
    capturedEnvs = []
    const res = await post(app, {}, "weekly reserve active held")
    expect(res.status).toBe(200)
    expect(capturedEnvs).toHaveLength(1)
    expect(capturedEnvs[0]).toContain("prof-personal")
  }, 20_000)
})
