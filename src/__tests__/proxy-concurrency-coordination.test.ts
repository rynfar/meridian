import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
  resolveMockSdkSessionId,
} from "./helpers"

interface AttemptControl {
  release: () => void
  started: Promise<void>
}

let activeQueries = 0
let maxActiveQueries = 0
let queryCalls = 0
let controls: AttemptControl[] = []
let capturedParams: Array<{ options?: { resume?: string; resumeSessionAt?: string; sessionId?: string; env?: Record<string, string> } }> = []
let rateLimitWorkQueries = false

function deferredAttempt(): AttemptControl & { wait: Promise<void>; markStarted: () => void } {
  let release = () => {}
  let markStarted = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  return { release, started, wait, markStarted }
}

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: { options?: { resume?: string; sessionId?: string; env?: Record<string, string> } }) => {
    capturedParams.push(params)
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const sessionId = resolveMockSdkSessionId(params.options, `sdk-concurrency-${queryCalls}`)
    const generator = (async function* () {
      activeQueries++
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      control.markStarted()
      try {
        if (rateLimitWorkQueries && params.options?.env?.CLAUDE_CONFIG_DIR?.includes("hot-work")) {
          throw new Error("429 rate limit reached for this account")
        }
        yield { ...messageStart(), session_id: sessionId }
        await control.wait
        yield { ...textBlockStart(0), session_id: sessionId }
        yield { ...textDelta(0, "ok"), session_id: sessionId }
        yield { ...blockStop(0), session_id: sessionId }
        yield { ...messageDelta("end_turn"), session_id: sessionId }
        yield { ...messageStop(), session_id: sessionId }
        yield { ...assistantMessage([{ type: "text", text: "ok" }]), session_id: sessionId }
      } finally {
        activeQueries--
      }
    })()
    return Object.assign(generator, { close: () => {} })
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
const { telemetryStore } = await import("../telemetry")
const { setSessionStoreDir, storeSharedSession, readSessionStoreSnapshot } = await import("../proxy/sessionStore")
const { processSessionTurns } = await import("../proxy/session/turnCoordinator")
const { computeLineageHash, computeMessageHashes } = await import("../proxy/session/lineage")

function request(
  messages: Array<{ role: string; content: unknown }>,
  sessionId: string,
  stream = false,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
    signal,
  })
}

/**
 * Oh My Pi has no per-flow header: every caller in one conversation, main turn
 * and side calls alike, stamps the same id in `metadata.user_id`.
 */
function piRequest(
  messages: Array<{ role: string; content: unknown }>,
  sessionId: string,
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-meridian-agent": "pi",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream: false,
      messages,
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) },
    }),
  })
}

async function waitForControl(index: number, timeoutMs = 3000): Promise<AttemptControl> {
  const deadline = Date.now() + timeoutMs
  while (!controls[index]) {
    // A refused request never reaches the SDK, so without this the assertion
    // "it was admitted" would surface as an opaque test-runner timeout.
    if (Date.now() > deadline) throw new Error(`SDK attempt #${index} never started`)
    await Bun.sleep(1)
  }
  const control = controls[index]!
  await control.started
  return control
}

describe("SDK and Session concurrency coordination", () => {
  let testSessionDir: string
  const originalMax = process.env.MERIDIAN_MAX_CONCURRENT
  const originalHold = process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
  const originalRouting = process.env.MERIDIAN_ROUTING

  beforeEach(() => {
    testSessionDir = mkdtempSync(join(tmpdir(), "meridian-concurrency-"))
    setSessionStoreDir(testSessionDir)
    process.env.MERIDIAN_MAX_CONCURRENT = "1"
    activeQueries = 0
    maxActiveQueries = 0
    queryCalls = 0
    controls = []
    capturedParams = []
    rateLimitWorkQueries = false
    clearSessionCache()
    resetProcessSdkSemaphoreForTests()
    telemetryStore.clear()
  })

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    setSessionStoreDir(null)
    rmSync(testSessionDir, { recursive: true, force: true })
    if (originalMax === undefined) delete process.env.MERIDIAN_MAX_CONCURRENT
    else process.env.MERIDIAN_MAX_CONCURRENT = originalMax
    if (originalHold === undefined) delete process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
    else process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = originalHold
    if (originalRouting === undefined) delete process.env.MERIDIAN_ROUTING
    else process.env.MERIDIAN_ROUTING = originalRouting
  })

  it("holds the SDK permit for the complete streaming lifecycle", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const first = await app.fetch(request([{ role: "user", content: "one" }], "stream-one", true))
    const firstControl = await waitForControl(0)
    const second = await app.fetch(request([{ role: "user", content: "two" }], "stream-two", true))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    expect(activeQueries).toBe(1)

    firstControl.release()
    await first.text()
    const secondControl = await waitForControl(1)
    expect(maxActiveQueries).toBe(1)
    secondControl.release()
    await second.text()
    expect(activeQueries).toBe(0)
  })

  it("shares the SDK permit across ProxyServer instances", async () => {
    const firstApp = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const secondApp = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    const first = await firstApp.fetch(request([{ role: "user", content: "one" }], "process-one", true))
    const firstControl = await waitForControl(0)
    const second = await secondApp.fetch(request([{ role: "user", content: "two" }], "process-two", true))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    expect(activeQueries).toBe(1)

    firstControl.release()
    await first.text()
    const secondControl = await waitForControl(1)
    expect(maxActiveQueries).toBe(1)
    secondControl.release()
    await second.text()
  })

  it("uses the latest resume state for a continuation that waited", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const opening = [{ role: "user", content: "hello" }]
    const continuation = [
      ...opening,
      { role: "assistant", content: "ok" },
      { role: "user", content: "continue" },
    ]
    const firstP = app.fetch(request(opening, "shared"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(continuation, "shared"))

    await Bun.sleep(10)
    expect(queryCalls).toBe(1)
    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    expect(capturedParams[0]?.options?.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    expect(capturedParams[1]?.options?.resume).toBe(capturedParams[0]?.options?.sessionId)
    secondControl.release()
    expect((await secondP).status).toBe(200)
  })

  it("returns an Anthropic-compatible invalid request for a stale repeated branch", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "conflict"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(messages, "conflict"))

    firstControl.release()
    expect((await firstP).status).toBe(200)
    const second = await secondP
    expect(second.status).toBe(400)
    expect(second.headers.get("x-meridian-conflict")).toBeNull()
    expect(await second.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.",
      },
    })
    expect(queryCalls).toBe(1)

    // A refusal that never reaches telemetry is a refusal operators can't
    // count, so the rate of concurrency conflicts stays invisible.
    const conflicts = telemetryStore.getRecent().filter(m => m.error === "session_turn_conflict")
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]!.status).toBe(400)
    expect(conflicts[0]!.upstreamDurationMs).toBe(0)
  })

  it("answers, instead of refusing, the loser of a race an adapter declares (#870)", async () => {
    // Reproduces the omp report: a side question asked mid-turn and the main
    // tool loop reach the proxy under one session id, holding branches that
    // share a prefix and differ at the last message. Serializing them is
    // right; refusing the loser is not, because the 400 is a hard error that
    // pushes the client onto a fallback model for a turn it could have run.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const shared = [
      { role: "user", content: "start the task" },
      { role: "assistant", content: "ok" },
    ]
    const sideQuestion = [...shared, { role: "user", content: "by the way, which branch is this?" }]
    const mainLoop = [...shared, { role: "user", content: "tool result for step 12" }]

    const sideP = app.fetch(piRequest(sideQuestion, "omp-session"))
    const sideControl = await waitForControl(0)
    const mainP = app.fetch(piRequest(mainLoop, "omp-session"))

    sideControl.release()
    expect((await sideP).status).toBe(200)
    const mainControl = await waitForControl(1)
    mainControl.release()
    expect((await mainP).status).toBe(200)
    // One session id still means one turn at a time: the second SDK query only
    // started once the first had finished.
    expect(maxActiveQueries).toBe(1)
    expect(queryCalls).toBe(2)

    // The loser carries a branch the winner never had, so it runs fresh rather
    // than resuming the winner's session and merging two histories.
    expect(capturedParams[1]?.options?.resume).toBeUndefined()
    expect(telemetryStore.getRecent().filter(m => m.error === "session_turn_conflict")).toHaveLength(0)

    // The mapping follows the turn that ran last, so the next main-loop request
    // resumes instead of paying a second fresh replay.
    const loserSessionId = capturedParams[1]?.options?.sessionId
    expect(loserSessionId).toMatch(/^[0-9a-f-]{36}$/)
    const stored = Object.values(readSessionStoreSnapshot()).map(s => s.claudeSessionId)
    expect(stored).toContain(loserSessionId!)
  })

  it("replays a declared-flow loser instead of rewinding the turn it lost to (#870)", async () => {
    // A side call carries a prefix of the main history, so once the main turn
    // commits the loser reads as an undo against it. Honouring that would roll
    // the winner's SDK session back to serve a turn that merely arrived late,
    // so a declared flow is admitted on its own body, never on that lineage.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const sessionId = `omp-undo-${crypto.randomUUID()}`
    const committed = [
      { role: "user", content: "start the task" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "tool result for step 12" },
    ]
    const lease = await processSessionTurns.acquire(`session:${sessionId}`)
    const sideP = app.fetch(piRequest(committed.slice(0, 2), sessionId))

    // Let handleWithQueue take its coherent arrival snapshot, then commit the
    // winning turn, UUIDs and all, before the queued side call is granted.
    await Bun.sleep(20)
    storeSharedSession(
      sessionId,
      "winner-sdk",
      committed.length,
      computeLineageHash(committed),
      computeMessageHashes(committed),
      ["winner-uuid-1", "winner-uuid-2", "winner-uuid-3"],
    )
    lease.markCommitted(sessionId)
    lease.release()

    const sideControl = await waitForControl(0)
    sideControl.release()
    expect((await sideP).status).toBe(200)
    // Neither resumed nor rolled back: the committed session is left alone.
    expect(capturedParams[0]?.options?.resume).toBeUndefined()
    expect(capturedParams[0]?.options?.resumeSessionAt).toBeUndefined()
  })

  it("does not refuse a turn because a DIFFERENT profile advanced the same session id", async () => {
    // One client session id backs an independent conversation per profile, each
    // with its own cache scope. A commit under "work" says nothing about the
    // lineage a queued "personal" request carries, so it must not refuse it.
    const app = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [
        { id: "work", claudeConfigDir: "/tmp/meridian-test-turn-work" },
        { id: "personal", claudeConfigDir: "/tmp/meridian-test-turn-personal" },
      ],
      defaultProfile: "work",
    }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "cross-profile", false, { "x-meridian-profile": "work" }))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(request(messages, "cross-profile", false, { "x-meridian-profile": "personal" }))

    // Still serialized — they share one client session id.
    await Bun.sleep(10)
    expect(queryCalls).toBe(1)

    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    secondControl.release()
    expect((await secondP).status).toBe(200)
    expect(queryCalls).toBe(2)
  })

  it("rejects a stale turn when a hot priority profile appears after the arrival snapshot", async () => {
    process.env.MERIDIAN_ROUTING = "priority"
    const profiles = [
      { id: "work", claudeConfigDir: "/tmp/meridian-test-hot-work" },
    ]
    const app = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles,
      defaultProfile: "work",
    }).app
    const sessionId = `hot-profile-${crypto.randomUUID()}`
    const lease = await processSessionTurns.acquire(`session:${sessionId}`)
    const pending = app.fetch(request([{ role: "user", content: "stale body" }], sessionId))

    // Let handleWithQueue take its coherent arrival snapshot, then make a new
    // profile and its durable mapping visible before the queued turn is granted.
    await Bun.sleep(20)
    profiles.push({ id: "hot", claudeConfigDir: "/tmp/meridian-test-hot-new" })
    storeSharedSession(`hot:${sessionId}`, "hot-existing-sdk", 2, "hot-lineage", ["old-a", "old-b"])
    rateLimitWorkQueries = true
    lease.release()

    const response = await pending
    expect(response.status).toBe(400)
    expect((await response.json() as { error?: { message?: string } }).error?.message)
      .toContain("advanced while the request was waiting")
    expect(capturedParams.length).toBeGreaterThan(0)
    expect(capturedParams.every((params) =>
      params.options?.env?.CLAUDE_CONFIG_DIR?.includes("hot-work") === true
    )).toBe(true)
  }, 10_000)

  it("lets a declared concurrent flow replay instead of refusing it", async () => {
    // fork-/subagent- sources knowingly run parallel turns under one session
    // key; a reclassification is their normal cost. Refusing them would break
    // flows that worked before turn coordination existed.
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "declared-flow"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(
      request(messages, "declared-flow", false, { "x-meridian-source": "subagent-scout" }),
    )

    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    secondControl.release()
    expect((await secondP).status).toBe(200)
    expect(queryCalls).toBe(2)
  })

  it("lets an OpenCode subagent mode replay instead of refusing it", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const messages = [{ role: "user", content: "same request" }]
    const firstP = app.fetch(request(messages, "declared-mode"))
    const firstControl = await waitForControl(0)
    const secondP = app.fetch(
      request(messages, "declared-mode", false, { "x-opencode-agent-mode": "subagent" }),
    )

    firstControl.release()
    expect((await firstP).status).toBe(200)

    const secondControl = await waitForControl(1)
    secondControl.release()
    expect((await secondP).status).toBe(200)
    expect(queryCalls).toBe(2)
  })

  it("aborts a wedged turn without releasing its fencing lease early", async () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "2"
    process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = "2000"
    resetProcessSdkSemaphoreForTests()
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app

    // This mock intentionally ignores AbortSignal while blocked. The watchdog
    // may request cancellation, but must retain the lease until the SDK attempt
    // actually settles or an older request could overwrite its successor.
    const wedged = await app.fetch(request([{ role: "user", content: "one" }], "wedged", true))
    const wedgedControl = await waitForControl(0)
    const waiterAbort = new AbortController()
    const secondP = app.fetch(request(
      [{ role: "user", content: "two" }],
      "wedged",
      true,
      {},
      waiterAbort.signal,
    ))
    await new Promise((resolve) => setTimeout(resolve, 2100))
    expect(queryCalls).toBe(1)

    // A waiter can still cancel cleanly; it never enters the SDK while the old
    // attempt is unfenced. Settle the mock before cancelling the response body
    // so the test does not intentionally leave background work behind.
    waiterAbort.abort()
    expect((await secondP).status).toBe(499)
    wedgedControl.release()
    await wedged.body?.cancel()
  }, 10_000)
})
