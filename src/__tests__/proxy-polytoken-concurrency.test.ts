import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, messageStart, resolveMockSdkSessionId, withMockSdkSessionId } from "./helpers"

type QueryInput = {
  options?: {
    sessionId?: string
    resume?: string
    env?: Record<string, string>
    [key: string]: unknown
  }
}

type AttemptControl = {
  release: () => void
  started: Promise<void>
}

let queryCalls = 0
let activeQueries = 0
let maxActiveQueries = 0
let controls: Array<AttemptControl & { wait: Promise<void>; markStarted: () => void }> = []
let capturedInputs: QueryInput[] = []
let pendingRequests = new Set<Promise<Response>>()

function deferredAttempt(): AttemptControl & { wait: Promise<void>; markStarted: () => void } {
  let release = () => {}
  let markStarted = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  return { release, started, wait, markStarted }
}

installSdkMock(() => ({
  query: (input: QueryInput) => {
    capturedInputs.push(input)
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const sessionId = resolveMockSdkSessionId(input.options, `polytoken-sdk-${queryCalls}`)
    const generator = (async function* () {
      activeQueries++
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      control.markStarted()
      try {
        yield withMockSdkSessionId(messageStart(`msg-${queryCalls}`), input.options)
        await control.wait
        yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "ok" }]), {
          ...input.options,
          sessionId,
        })
      } finally {
        activeQueries--
      }
    })()
    return Object.assign(generator, { close: () => {} })
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-polytoken-concurrency.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const { processSessionTurns } = await import("../proxy/session/turnCoordinator")

type TestApp = ReturnType<typeof createProxyServer>["app"]

function nativeRequest(
  sessionId: string,
  content: string,
  extraHeaders: Record<string, string> = {},
  messages: Array<{ role: string; content: unknown }> = [{ role: "user", content }],
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-polytoken-session": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 128,
      stream: false,
      messages,
    }),
  })
}

async function waitForControl(index: number, timeoutMs = 3_000): Promise<AttemptControl> {
  const deadline = Date.now() + timeoutMs
  while (!controls[index]) {
    if (Date.now() > deadline) throw new Error(`SDK attempt #${index} never started`)
    await Bun.sleep(1)
  }
  const control = controls[index]!
  await control.started
  return control
}

function observeNativeTurnArrival(sessionId: string, timeoutMs = 3_000) {
  let markArrived = () => {}
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const arrived = new Promise<void>((resolve, reject) => {
    markArrived = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      resolve()
    }
    timeoutHandle = setTimeout(() => reject(new Error(`native turn queue arrival timed out for ${sessionId}`)), timeoutMs)
  })
  const acquire = processSessionTurns.acquire.bind(processSessionTurns)
  const observer = spyOn(processSessionTurns, "acquire").mockImplementation((key, signal) => {
    const pending = acquire(key, signal)
    if (key === `session:${sessionId}`) markArrived()
    return pending
  })
  return {
    arrived,
    restore: () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      observer.mockRestore()
    },
  }
}

function fetchTracked(app: TestApp, request: Request): Promise<Response> {
  const pending = Promise.resolve(app.fetch(request))
  pendingRequests.add(pending)
  void pending.finally(() => pendingRequests.delete(pending))
  return pending
}

function continuationMessages(content: string, followUp: string) {
  return [
    { role: "user", content },
    { role: "assistant", content: "ok" },
    { role: "user", content: followUp },
  ]
}

describe("Polytoken native session concurrency", () => {
  let sessionDir: string
  const savedEnv = {
    max: process.env.MERIDIAN_MAX_CONCURRENT,
    hold: process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS,
    routing: process.env.MERIDIAN_ROUTING,
  }

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-polytoken-concurrency-"))
    setSessionStoreDir(sessionDir)
    process.env.MERIDIAN_MAX_CONCURRENT = "2"
    delete process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
    delete process.env.MERIDIAN_ROUTING
    queryCalls = 0
    activeQueries = 0
    maxActiveQueries = 0
    controls = []
    capturedInputs = []
    pendingRequests = new Set()
    clearSessionCache()
    resetProcessSdkSemaphoreForTests()
  })

  afterEach(async () => {
    for (const control of controls) control.release()
    await Promise.allSettled([...pendingRequests])
    resetProcessSdkSemaphoreForTests()
    clearSessionCache()
    setSessionStoreDir(null)
    rmSync(sessionDir, { recursive: true, force: true })
    if (savedEnv.max === undefined) delete process.env.MERIDIAN_MAX_CONCURRENT
    else process.env.MERIDIAN_MAX_CONCURRENT = savedEnv.max
    if (savedEnv.hold === undefined) delete process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
    else process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = savedEnv.hold
    if (savedEnv.routing === undefined) delete process.env.MERIDIAN_ROUTING
    else process.env.MERIDIAN_ROUTING = savedEnv.routing
  })

  it("polytoken_waiter_resumes_latest_state", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const sessionId = "pt-waiter"
    const first = fetchTracked(app, nativeRequest(sessionId, "opening turn"))
    const firstControl = await waitForControl(0)
    const arrival = observeNativeTurnArrival(sessionId)
    const second = fetchTracked(app, nativeRequest(
      sessionId,
      "opening turn",
      {},
      continuationMessages("opening turn", "continue after the latest state"),
    ))
    try {
      await arrival.arrived
    } finally {
      arrival.restore()
    }
    expect(queryCalls).toBe(1)
    expect(activeQueries).toBe(1)

    firstControl.release()
    expect((await first).status).toBe(200)
    const secondControl = await waitForControl(1)
    expect(capturedInputs[1]!.options?.resume).toBe(capturedInputs[0]!.options?.sessionId)
    secondControl.release()
    expect((await second).status).toBe(200)
    expect(maxActiveQueries).toBe(1)
  })

  it("polytoken_stale_branch_rejected", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const sessionId = "pt-stale"
    const first = fetchTracked(app, nativeRequest(sessionId, "same native body"))
    const firstControl = await waitForControl(0)
    const arrival = observeNativeTurnArrival(sessionId)
    const repeated = fetchTracked(app, nativeRequest(sessionId, "same native body"))
    try {
      await arrival.arrived
    } finally {
      arrival.restore()
    }
    expect(queryCalls).toBe(1)
    firstControl.release()
    expect((await first).status).toBe(200)
    const response = await repeated
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "This session advanced while the request was waiting. Retry with the latest conversation history or use a distinct session ID.",
      },
    })
    expect(queryCalls).toBe(1)
  })

  it("polytoken_distinct_key_parallelism", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const first = fetchTracked(app, nativeRequest("pt-parallel-a", "parallel body"))
    const firstControl = await waitForControl(0)
    const second = fetchTracked(app, nativeRequest("pt-parallel-b", "parallel body"))
    const secondControl = await waitForControl(1)
    expect(maxActiveQueries).toBe(2)
    expect(capturedInputs[0]!.options?.sessionId).not.toBe(capturedInputs[1]!.options?.sessionId)
    firstControl.release()
    secondControl.release()
    expect((await first).status).toBe(200)
    expect((await second).status).toBe(200)

    const continuation = async (sessionId: string, marker: string) => {
      const response = fetchTracked(app, nativeRequest(
        sessionId,
        "parallel body",
        {},
        continuationMessages("parallel body", marker),
      ))
      const control = await waitForControl(controls.length)
      const query = capturedInputs[capturedInputs.length - 1]!
      expect(query.options?.resume).toBe(
        sessionId === "pt-parallel-a" ? capturedInputs[0]!.options?.sessionId : capturedInputs[1]!.options?.sessionId,
      )
      control.release()
      expect((await response).status).toBe(200)
    }
    await continuation("pt-parallel-a", "continue A")
    await continuation("pt-parallel-b", "continue B")
  })

  it("polytoken_cross_profile_lineage_isolated", async () => {
    const app = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      silent: true,
      profiles: [
        { id: "work", claudeConfigDir: "/tmp/meridian-polytoken-work" },
        { id: "personal", claudeConfigDir: "/tmp/meridian-polytoken-personal" },
      ],
      defaultProfile: "work",
    }).app
    const sessionId = "pt-profiled"
    const first = fetchTracked(app, nativeRequest(sessionId, "profile body", { "x-meridian-profile": "work" }))
    const firstControl = await waitForControl(0)
    const arrival = observeNativeTurnArrival(sessionId)
    const second = fetchTracked(app, nativeRequest(sessionId, "profile body", { "x-meridian-profile": "personal" }))
    try {
      await arrival.arrived
    } finally {
      arrival.restore()
    }
    expect(queryCalls).toBe(1)
    firstControl.release()
    expect((await first).status).toBe(200)
    const secondControl = await waitForControl(1)
    expect(capturedInputs[0]!.options?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/meridian-polytoken-work")
    expect(capturedInputs[1]!.options?.env?.CLAUDE_CONFIG_DIR).toBe("/tmp/meridian-polytoken-personal")
    expect(capturedInputs[1]!.options?.resume).toBeUndefined()
    secondControl.release()
    expect((await second).status).toBe(200)
    expect(maxActiveQueries).toBe(1)
  })

  it("polytoken_legacy_header_isolation", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const clean = fetchTracked(app, nativeRequest("pt-clean", "header body"))
    const cleanControl = await waitForControl(0)
    cleanControl.release()
    expect((await clean).status).toBe(200)
    const cleanOptions = capturedInputs[0]!.options ?? {}

    const conflicting = fetchTracked(app, nativeRequest("pt-conflicting", "header body", {
      "x-opencode-agent-mode": "subagent",
      "x-opencode-effort": "high",
      "x-opencode-thinking": JSON.stringify({ type: "enabled", budget_tokens: 5000 }),
      "x-opencode-task-budget": "42",
      "x-session-affinity": "wrong-affinity",
      "x-opencode-session": "wrong-opencode-session",
      "x-meridian-source": "subagent-wrong",
      "x-meridian-attestation": "wrong-attestation",
    }))
    const conflictingControl = await waitForControl(1)
    conflictingControl.release()
    expect((await conflicting).status).toBe(200)
    const conflictingOptions = capturedInputs[1]!.options ?? {}
    expect({ maxTurns: conflictingOptions.maxTurns, thinking: conflictingOptions.thinking }).toEqual({
      maxTurns: cleanOptions.maxTurns,
      thinking: cleanOptions.thinking,
    })
    expect(conflictingOptions.sessionId).toBeTruthy()
    expect(conflictingOptions.resume).toBeUndefined()
    expect(conflictingOptions.sessionId).not.toBe(cleanOptions.sessionId)

    const continuation = fetchTracked(app, nativeRequest(
      "pt-conflicting",
      "header body",
      {
        "x-opencode-agent-mode": "primary",
        "x-opencode-effort": "low",
        "x-opencode-thinking": JSON.stringify({ type: "enabled", budget_tokens: 1 }),
        "x-session-affinity": "another-wrong-affinity",
      },
      continuationMessages("header body", "continue with native identity"),
    ))
    const continuationControl = await waitForControl(2)
    expect(capturedInputs[2]!.options?.resume).toBe(conflictingOptions.sessionId)
    continuationControl.release()
    expect((await continuation).status).toBe(200)
  })
})
