import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  resolveMockSdkSessionId,
  assistantMessage,
  messageStart,
  textBlockStart,
  textDelta,
  blockStop,
  messageDelta,
  messageStop,
} from "./helpers"

interface AttemptControl {
  release: () => void
  started: Promise<void>
}

let activeQueries = 0
let maxActiveQueries = 0
let queryCalls = 0
let controls: AttemptControl[] = []
type QueryParams = { prompt: string | AsyncIterable<unknown>; options?: { resume?: string; sessionId?: string } }
let capturedParams: QueryParams[] = []
let capturedPrompts: unknown[][] = []

function deferredAttempt(): AttemptControl & { wait: Promise<void>; markStarted: () => void } {
  let release = () => {}
  let markStarted = () => {}
  const wait = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { markStarted = resolve })
  return { release, started, wait, markStarted }
}

installSdkMock(() => ({
  query: (params: QueryParams) => {
    capturedParams.push(params)
    queryCalls++
    const control = deferredAttempt()
    controls.push(control)
    const index = queryCalls - 1
    const sessionId = resolveMockSdkSessionId(params.options, `sdk-downgrade-${queryCalls}`)
    const generator = (async function* () {
      const prompts: unknown[] = []
      if (typeof params.prompt === "string") prompts.push(params.prompt)
      else for await (const item of params.prompt) prompts.push(item)
      capturedPrompts[index] = prompts
      activeQueries++
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries)
      control.markStarted()
      if (index === 1) control.release()
      try {
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
}), "proxy-turn-conflict-downgrade.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetProcessSdkSemaphoreForTests } = await import("../proxy/concurrency")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const { processSessionTurns } = await import("../proxy/session/turnCoordinator")
const { telemetryStore } = await import("../telemetry")

function request(
  messages: Array<{ role: string; content: unknown }>,
  sessionId: string,
  stream = false,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-session": sessionId,
      ...extraHeaders,
    },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 128, stream, messages }),
  })
}

async function waitForControl(index: number, timeoutMs = 3000): Promise<AttemptControl> {
  const deadline = Date.now() + timeoutMs
  while (!controls[index]) {
    if (Date.now() > deadline) throw new Error(`SDK attempt #${index} never started`)
    await Bun.sleep(1)
  }
  const control = controls[index]!
  await control.started
  return control
}

describe("modified-history conflict downgrade", () => {
  let sessionDir: string
  const originalMax = process.env.MERIDIAN_MAX_CONCURRENT
  const originalHold = process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
  const originalPassthrough = process.env.MERIDIAN_PASSTHROUGH

  beforeEach(() => {
    sessionDir = mkdtempSync(join(tmpdir(), "meridian-modified-conflict-"))
    setSessionStoreDir(sessionDir)
    process.env.MERIDIAN_MAX_CONCURRENT = "1"
    process.env.MERIDIAN_PASSTHROUGH = "1"
    activeQueries = 0
    maxActiveQueries = 0
    queryCalls = 0
    controls = []
    capturedParams = []
    capturedPrompts = []
    clearSessionCache()
    resetProcessSdkSemaphoreForTests()
    telemetryStore.clear()
  })

  afterEach(() => {
    for (const control of controls) control.release()
    resetProcessSdkSemaphoreForTests()
    setSessionStoreDir(null)
    rmSync(sessionDir, { recursive: true, force: true })
    if (originalMax === undefined) delete process.env.MERIDIAN_MAX_CONCURRENT
    else process.env.MERIDIAN_MAX_CONCURRENT = originalMax
    if (originalHold === undefined) delete process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS
    else process.env.MERIDIAN_SESSION_TURN_MAX_HOLD_MS = originalHold
    if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
  })

  const opening = [
    { role: "user", content: "Read the fixture." },
    { role: "assistant", content: [{ type: "tool_use", id: "use1", name: "read", input: { path: "fixture.txt" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "old_fixture_value" }] },
  ]
  const superseding = [opening[0]!, opening[1]!,
    { role: "user", content: [{ type: "tool_result", tool_use_id: "use1", content: "REVISED" }] },
    { role: "assistant", content: "Decision identifier is unique_decision." },
    { role: "user", content: "Repeat the decision identifier." },
  ]

  async function race(messages: Array<{ role: string; content: unknown }>, stream: boolean) {
    const app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
    const key = crypto.randomUUID()
    const firstP = Promise.resolve(app.fetch(request(opening, key, stream))).then(async response => ({ status: response.status, raw: await response.text() }))
    const firstControl = await waitForControl(0)
    let markArrived = () => {}
    const arrived = new Promise<void>(resolve => { markArrived = resolve })
    const acquire = processSessionTurns.acquire.bind(processSessionTurns)
    const observer = spyOn(processSessionTurns, "acquire").mockImplementation((turnKey, signal) => {
      const pending = acquire(turnKey, signal)
      if (turnKey === `session:${key}`) markArrived()
      return pending
    })
    const secondP = Promise.resolve(app.fetch(request(messages, key, stream))).then(async response => ({ status: response.status, raw: await response.text() }))
    try { await arrived } finally { observer.mockRestore() }
    firstControl.release()
    expect((await firstP).status).toBe(200)
    return secondP
  }

  for (const stream of [false, true]) {
    it(`replays every revised message after waiting (stream=${stream})`, async () => {
      const second = await race(superseding, stream)
      expect(second.status).toBe(200)
      expect(second.raw).not.toContain('"type":"error"')
      expect(queryCalls).toBe(2)
      expect(maxActiveQueries).toBe(1)
      expect(capturedParams[1]?.options?.resume).toBeUndefined()
      expect(capturedParams[1]?.options?.sessionId).not.toBe(capturedParams[0]?.options?.sessionId)
      expect(capturedPrompts[1]).toHaveLength(1)
      const prompt = JSON.stringify(capturedPrompts[1])
      for (const value of ["REVISED", "unique_decision", "Repeat the decision identifier", "fixture.txt", "use1"]) expect(prompt).toContain(value)
      expect(prompt).not.toContain("old_fixture_value")
    })

    it(`refuses modified history without passthrough (stream=${stream})`, async () => {
      process.env.MERIDIAN_PASSTHROUGH = "0"
      const second = await race(superseding, stream)
      expect(second.status).toBe(400)
      expect(JSON.parse(second.raw).error.message).toContain("session advanced")
      expect(queryCalls).toBe(1)
    })

    it(`still refuses a stale undo (stream=${stream})`, async () => {
      const second = await race([opening[0]!, opening[1]!, { role: "user", content: "Replace the preceding tool-result turn." }], stream)
      expect(second.status).toBe(400)
      expect(JSON.parse(second.raw).error.message).toContain("session advanced")
      expect(queryCalls).toBe(1)
    })

    it(`still refuses unrelated history (stream=${stream})`, async () => {
      const second = await race([{ role: "user", content: "An entirely different conversation." }], stream)
      expect(second.status).toBe(400)
      expect(queryCalls).toBe(1)
    })
  }
})
