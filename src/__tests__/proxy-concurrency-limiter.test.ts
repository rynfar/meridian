/**
 * The SDK concurrency limiter under priority routing.
 *
 * Priority routing dispatches by re-entering this same app over `app.fetch`
 * (dispatchPriority), so one external request produces two passes through the
 * queued route. The limiter counts passes, not external requests, so the outer
 * pass holds a slot while waiting for an inner pass that needs one of its own.
 * At N concurrent external requests every slot is held by a waiter and nothing
 * can be admitted — a permanent deadlock, not a slowdown: on staging the
 * counter reached 10/10 and every subsequent request timed out until the
 * process was restarted, while /health kept answering.
 *
 * These tests fix the invariant the limiter is meant to express: one external
 * request occupies exactly one slot, and the limit still bounds how many SDK
 * subprocesses run at once.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

let sdkActive = 0
let sdkPeak = 0
/** Held open while a test needs SDK calls to overlap observably. */
let sdkGate: Promise<void> = Promise.resolve()
let openGate: () => void = () => {}

function gateClosed() {
  sdkGate = new Promise<void>((resolve) => { openGate = resolve })
}

installSdkMock(() => ({
  query: (params: any) => (async function* () {
    sdkActive++
    sdkPeak = Math.max(sdkPeak, sdkActive)
    try {
      await sdkGate
      const message = assistantMessage([{ type: "text", text: "ok" }])
      yield withMockSdkSessionId(message, params.options)
    } finally {
      sdkActive--
    }
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-concurrency-limiter.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride } = await import("../proxy/oauthUsage")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-test-conc-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-test-conc-personal" },
]

/** MAX_CONCURRENT is read when the app is built, so set the env first. */
function createTestApp(maxConcurrent: string) {
  process.env.MERIDIAN_MAX_CONCURRENT = maxConcurrent
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: PROFILES, defaultProfile: "work" })
  return app
}

async function post(app: any, content: string) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 128,
      stream: false,
      messages: [{ role: "user", content }],
    }),
  }))
}

/**
 * A deadlocked request never settles, so every assertion here needs a deadline
 * — without one the failure is an expired test timeout that says nothing about
 * which invariant broke.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms (queue deadlock)`)), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Waits for the SDK to have `n` calls in flight at once. */
async function waitForSdkActive(n: number, ms: number) {
  const until = Date.now() + ms
  while (sdkActive < n) {
    if (Date.now() > until) throw new Error(`only ${sdkActive}/${n} SDK calls in flight after ${ms}ms`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const savedEnv: Record<string, string | undefined> = {}

describe("SDK concurrency limiter", () => {
  beforeEach(() => {
    // The SDK semaphore is a process-wide singleton cached on first use, so
    // these bounds only mean anything if this file gets a fresh one. Without
    // the reset the assertions quietly measure whichever limit some earlier
    // test file happened to install first.
    resetProcessSdkSemaphoreForTests()
    sdkActive = 0
    sdkPeak = 0
    sdkGate = Promise.resolve()
    clearSessionCache()
    resetActiveProfile()
    __setFetchOAuthUsageOverride(async () => null)
    savedEnv.MERIDIAN_ROUTING = process.env.MERIDIAN_ROUTING
    savedEnv.MERIDIAN_PROFILE_ORDER = process.env.MERIDIAN_PROFILE_ORDER
    savedEnv.MERIDIAN_MAX_CONCURRENT = process.env.MERIDIAN_MAX_CONCURRENT
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "work,personal"
  })

  afterEach(() => {
    openGate()
    resetProcessSdkSemaphoreForTests()
    __setFetchOAuthUsageOverride(null)
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  // The whole defect in its smallest form: with a single slot, one request
  // needs two and waits on itself forever.
  it("serves a priority-routed request when only one slot exists", async () => {
    const app = createTestApp("1")
    const res = await withDeadline(post(app, "single slot"), 5_000, "one priority request")
    expect(res.status).toBe(200)
  }, 15_000)

  // The invariant stated positively: the limit is a budget of external
  // requests. With two slots, two requests must both reach the SDK — under the
  // double-count only one gets through (the other's outer pass is queued), or
  // neither does.
  it("admits as many concurrent requests as it has slots", async () => {
    gateClosed()
    const app = createTestApp("2")
    const inFlight = Promise.all([post(app, "slot a"), post(app, "slot b")])
    await withDeadline(waitForSdkActive(2, 5_000), 6_000, "two concurrent SDK calls")
    openGate()
    const [a, b] = await withDeadline(inFlight, 5_000, "both priority requests")
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
  }, 15_000)

  // Guard on the other side: not re-entering the queue must not become "no
  // queue at all". Six requests against two slots still run at most two SDK
  // subprocesses at a time.
  it("still bounds how many SDK calls run at once", async () => {
    const app = createTestApp("2")
    const results = await withDeadline(
      Promise.all(Array.from({ length: 6 }, (_, i) => post(app, `burst ${i}`))),
      15_000,
      "a burst of six priority requests",
    )
    expect(results.map((r: Response) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
    expect(sdkPeak).toBeLessThanOrEqual(2)
    expect(sdkPeak).toBeGreaterThan(0)
  }, 30_000)
})
