/** HTTP preservation controls for Claude Code side calls. No private cache is seeded. */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { z } from "zod"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import {
  assistantMessage, blockStop, inputJsonDelta, messageDelta, messageStart,
  messageStop, parseSSE, resolveMockSdkSessionId, textBlockStart, textDelta,
  toolUseBlockStart,
} from "./helpers"
import { UpstreamIdleError } from "../proxy/streamIdleGuard"

type Script = "recover" | "success" | "failure" | "idle" | "cancel"
interface RegisteredTool { name: string; inputSchema: Record<string, z.ZodTypeAny> }
interface QueryInput {
  options: {
    abortController?: AbortController
    allowedTools?: string[]
    includePartialMessages?: boolean
    mcpServers?: Record<string, { tools: RegisteredTool[] }>
    resume?: string
    sessionId?: string
  }
}
interface CapturedQuery {
  options: QueryInput["options"]
  script: Script
  started: boolean
  stopped: boolean
  release: () => void
}

let scripts: Script[] = []
let captured: CapturedQuery[] = []

installSdkMock(() => ({
  query: (input: QueryInput) => {
    const script = scripts.shift()
    if (!script) throw new Error("Unexpected SDK query: the HTTP fixture did not schedule an attempt")
    let release = () => {}
    const wait = new Promise<void>(resolve => { release = resolve })
    const observation: CapturedQuery = { options: input.options, script, started: false, stopped: false, release }
    captured.push(observation)
    const sdkSessionId = resolveMockSdkSessionId(input.options, crypto.randomUUID())
    const controller = input.options.abortController
    const generator = (async function* () {
      observation.started = true
      try {
        if (script === "idle") throw new UpstreamIdleError(90_000, 90_001)
        if (script === "failure") throw new Error("Fixture query failed without completing a turn")
        if (script === "cancel") {
          yield { ...messageStart(), session_id: sdkSessionId }
          controller?.signal.addEventListener("abort", release, { once: true })
          if (controller?.signal.aborted) release()
          await wait
          throw new DOMException("Fixture request canceled", "AbortError")
        }
        if (script === "recover") {
          // The CLI streamed a complete, declared call but could not dispatch it.
          // No PreToolUse hook runs: this is the real uncaptured recovery path.
          for (const message of [
            messageStart("msg_aux_recovery"),
            toolUseBlockStart(0, "read", "toolu_aux_recovery"),
            inputJsonDelta(0, '{"file_path":"fixture.txt"}'),
            blockStop(0), messageDelta("tool_use"), messageStop(),
            assistantMessage([{ type: "tool_use", id: "toolu_aux_recovery", name: "read", input: { file_path: "fixture.txt" } }]),
            {
              type: "user", parent_tool_use_id: null, uuid: crypto.randomUUID(),
              message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_aux_recovery",
                is_error: true, content: "<tool_use_error>Error: No such tool available: read</tool_use_error>" }] },
            },
            { type: "result", subtype: "error_max_turns", is_error: true },
          ]) yield { ...message, session_id: sdkSessionId }
          throw new Error("Claude Code returned an error result: Reached maximum number of turns (1)")
        }
        if (input.options.includePartialMessages) {
          for (const message of [messageStart(), textBlockStart(0), textDelta(0, "COMPLETED"),
            blockStop(0), messageDelta(), messageStop()]) yield { ...message, session_id: sdkSessionId }
        }
        yield { ...assistantMessage([{ type: "text", text: "COMPLETED" }]), session_id: sdkSessionId }
        yield { type: "result", subtype: "success", is_error: false, session_id: sdkSessionId }
      } finally {
        controller?.signal.removeEventListener("abort", release)
        observation.stopped = true
      }
    })()
    return Object.assign(generator, { close: release })
  },
  createSdkMcpServer: (input: { name: string; tools: RegisteredTool[] }) => ({ type: "sdk", name: input.name,
    tools: input.tools, instance: {} }),
  tool: (name: string, _description: string, inputSchema: Record<string, z.ZodTypeAny>) => ({ name, inputSchema }),
}), "proxy-claude-auxiliary-recovery.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
type App = ReturnType<typeof createProxyServer>["app"]
interface WireResult { status: number; raw: string; errorType?: string }

const READ = { name: "read", description: "Read a fixture", input_schema: {
  type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"],
} }
const WRITE = { name: "write", description: "Write a fixture", input_schema: {
  type: "object", properties: { content: { type: "string" } }, required: ["content"],
} }
const OPENING = [{ role: "user", content: "Read the fixture file" }]
const CONTINUATION = [
  ...OPENING,
  { role: "assistant", content: [{ type: "tool_use", id: "toolu_aux_recovery", name: "read", input: { file_path: "fixture.txt" } }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_aux_recovery", content: "fixture contents" }] },
]
const managedEnv = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_SESSION_DIR", "MERIDIAN_ROUTING", "MERIDIAN_PASSTHROUGH",
  "MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY", "MERIDIAN_TELEMETRY_PERSIST", "MERIDIAN_NO_UPDATE_CHECK"]
let originalEnv = new Map<string, string | undefined>()
let fixtureDir = ""
let requests: Array<Promise<WireResult>> = []
let requestControllers: AbortController[] = []

function testApp(): App {
  return createProxyServer({ port: 0, host: "127.0.0.1", silent: true,
    profiles: [{ id: "fixture", type: "api", apiKey: "non-authentic-test-fixture" }], defaultProfile: "fixture" }).app
}

function post(app: App, sessionId: string, script: Script, body: Record<string, unknown>, auxiliary = false,
  controller?: AbortController): Promise<WireResult> {
  scripts.push(script)
  if (controller) requestControllers.push(controller)
  const pending = Promise.resolve(app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.286",
      "x-meridian-profile": "fixture", ...(auxiliary ? { "x-claude-code-request-class": "auxiliary" } : {}) },
    body: JSON.stringify({ model: "haiku", max_tokens: 100, stream: false,
      metadata: { user_id: JSON.stringify({ session_id: sessionId }) }, ...body }), signal: controller?.signal,
  }))).then(async response => {
    const raw = await response.text()
    let errorType: string | undefined
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      for (const event of parseSSE(raw)) {
        const error = event.data.error
        if (event.event === "error" && error && typeof error === "object" && "type" in error
          && typeof error.type === "string") errorType = error.type
      }
    } else {
      const result = JSON.parse(raw) as { error?: { type?: string } }
      errorType = result.error?.type
    }
    return { status: response.status, raw, errorType }
  })
  requests.push(pending)
  return pending
}

async function waitForStarted(index: number): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!captured[index]?.started) {
    if (Date.now() >= deadline) throw new Error(`SDK query ${index} was not admitted`)
    await Bun.sleep(1)
  }
}

function expectReadSchema(query: CapturedQuery | undefined): void {
  const tools = query?.options.mcpServers?.oc?.tools
  expect(tools?.map(tool => tool.name)).toEqual(["read"])
  const readSchema = tools?.[0]?.inputSchema
  expect(readSchema?.file_path?.safeParse("fixture.txt").success).toBe(true)
  expect(readSchema?.file_path?.safeParse(123).success).toBe(false)
  expect(readSchema?.file_path?.safeParse(undefined).success).toBe(false)
  expect(readSchema?.content).toBeUndefined()
}

beforeEach(() => {
  originalEnv = new Map(managedEnv.map(key => [key, process.env[key]]))
  fixtureDir = mkdtempSync(join(tmpdir(), "meridian-auxiliary-recovery-"))
  process.env.MERIDIAN_CONFIG_DIR = fixtureDir
  process.env.MERIDIAN_SESSION_DIR = join(fixtureDir, "sessions")
  process.env.MERIDIAN_ROUTING = "active"
  process.env.MERIDIAN_PASSTHROUGH = "1"
  process.env.MERIDIAN_TELEMETRY_PERSIST = "0"
  process.env.MERIDIAN_NO_UPDATE_CHECK = "1"
  delete process.env.MERIDIAN_PASSTHROUGH_UNCAPTURED_TOOL_RECOVERY
  setSessionStoreDir(join(fixtureDir, "sessions"))
  scripts = []; captured = []; requests = []; requestControllers = []
  clearSessionCache()
})
afterEach(async () => {
  for (const controller of requestControllers) controller.abort()
  for (const query of captured) query.release()
  await Promise.allSettled(requests)
  expect(captured.every(query => query.stopped)).toBe(true)
  clearSessionCache()
  setSessionStoreDir(null)
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(fixtureDir, { recursive: true, force: true })
})

describe("Claude auxiliary calls preserve a real recovered tool schema", () => {
  for (const withTools of [false, true]) {
    for (const outcome of ["success", "failure", "cancel"] as const) {
      it(`preserves the original continuation after auxiliary ${outcome}, tools=${withTools}`, async () => {
        const app = testApp()
        const session = crypto.randomUUID()
        const recovered = await post(app, session, "recover", { stream: true, tools: [READ], messages: OPENING })
        expect(recovered.status).toBe(200)
        expect(recovered.errorType).toBeUndefined()
        expect(recovered.raw).toContain('"stop_reason":"tool_use"')
        expect(captured[0]?.options.allowedTools).toContain("mcp__oc__read")
        expectReadSchema(captured[0])

        const controller = outcome === "cancel" ? new AbortController() : undefined
        const auxiliary = post(app, session, outcome, { stream: outcome === "cancel", messages: CONTINUATION,
          ...(withTools ? { tools: [WRITE] } : {}) }, true, controller)
        if (controller) { await waitForStarted(1); controller.abort() }
        const side = await auxiliary
        if (outcome === "success") {
          expect(side.status).toBe(200)
          expect(side.raw).toContain("COMPLETED")
        } else expect(side.errorType).toBeDefined()
        expect(captured[1]?.options.resume).toBeUndefined()
        expect(captured[1]?.options.allowedTools ?? []).not.toContain("mcp__oc__read")
        if (withTools) expect(captured[1]?.options.allowedTools).toContain("mcp__oc__write")

        const continuation = await post(app, session, "success", { messages: CONTINUATION })
        expect(continuation.status).toBe(200)
        expect(continuation.errorType).toBeUndefined()
        expect(continuation.raw).toContain("COMPLETED")
        expect(captured[2]?.options.resume).toBeUndefined()
        expect(captured[2]?.options.allowedTools).toContain("mcp__oc__read")
        expect(captured[2]?.options.allowedTools ?? []).not.toContain("mcp__oc__write")
        expectReadSchema(captured[2])
      })
    }
  }

  it("consumes the grant exactly once even if its eligible continuation fails before publication", async () => {
    const app = testApp()
    const session = crypto.randomUUID()
    const recovered = await post(app, session, "recover", { stream: true, tools: [READ], messages: OPENING })
    expect(recovered.errorType).toBeUndefined()
    expect(recovered.raw).toContain('"stop_reason":"tool_use"')
    const failed = await post(app, session, "failure", { messages: CONTINUATION })
    expect(failed.errorType).toBeDefined()
    expect(captured[1]?.options.allowedTools).toContain("mcp__oc__read")
    expectReadSchema(captured[1])
    const repeated = await post(app, session, "success", { messages: CONTINUATION })
    expect(repeated.status).toBe(200)
    expect(repeated.errorType).toBeUndefined()
    expect(captured[2]?.options.resume).toBeUndefined()
    expect(captured[2]?.options.allowedTools ?? []).not.toContain("mcp__oc__read")
    expect(captured).toHaveLength(3)
  })
})

describe("Claude auxiliary idle accounting is independent", () => {
  it.each([false, true])("a different successful side call cannot erase the blocked primary ceiling, stream=%s", async stream => {
    const app = testApp()
    const session = crypto.randomUUID()
    const main = { stream, messages: [{ role: "user", content: "The blocked primary turn" }] }
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await post(app, session, "idle", main)).errorType)
        .toBe(attempt < 3 ? "upstream_timeout" : "invalid_request_error")
    }
    const side = await post(app, session, "success", { stream,
      messages: [{ role: "user", content: "A different auxiliary classifier request" }] }, true)
    expect(side.errorType).toBeUndefined()
    expect(side.raw).toContain("COMPLETED")
    const queryCount = captured.length
    const blocked = await post(app, session, "idle", main)
    expect(blocked.status).toBe(400)
    expect(blocked.errorType).toBe("invalid_request_error")
    expect(captured).toHaveLength(queryCount)
  })

  it.each([false, true])("keeps the primary ceiling across successful and stalled side calls, stream=%s", async stream => {
    const app = testApp()
    const session = crypto.randomUUID()
    const main = { stream, messages: [{ role: "user", content: "The unchanged primary turn" }] }
    for (let attempt = 1; attempt <= 3; attempt++) {
      const stalled = await post(app, session, "idle", main)
      expect(stalled.errorType).toBe(attempt < 3 ? "upstream_timeout" : "invalid_request_error")
    }
    // The exact same body tests that a side call does not inherit the primary
    // block. A different successful body must not reset it either.
    const identicalSide = await post(app, session, "success", main, true)
    expect(identicalSide.errorType).toBeUndefined()
    expect(identicalSide.raw).toContain("COMPLETED")
    const changedSide = await post(app, session, "success", { stream, messages: [{ role: "user", content: "Auxiliary classifier" }] }, true)
    expect(changedSide.errorType).toBeUndefined()
    for (let attempt = 0; attempt < 4; attempt++) {
      const sideStall = await post(app, session, "idle", main, true)
      expect(sideStall.errorType).toBe("upstream_timeout")
    }
    const attemptsBeforeBlockedPrimary = captured.length
    const blocked = await post(app, session, "failure", main)
    expect(blocked.status).toBe(400)
    expect(blocked.errorType).toBe("invalid_request_error")
    expect(captured).toHaveLength(attemptsBeforeBlockedPrimary)
    // The refused attempt must not leave an SDK script for the next request.
    scripts = []
    const recoveredMain = await post(app, session, "success", { stream, messages: [{ role: "user", content: "Revised primary turn" }] })
    expect(recoveredMain.errorType).toBeUndefined()
    const primaryRetry = await post(app, session, "idle", main)
    expect(primaryRetry.errorType).toBe("upstream_timeout")
    expect(captured).toHaveLength(attemptsBeforeBlockedPrimary + 2)
  })

  it.each([false, true])("an ordinary completed primary turn resets its own idle streak, stream=%s", async stream => {
    const app = testApp()
    const session = crypto.randomUUID()
    const body = { stream, messages: [{ role: "user", content: "Same primary turn" }] }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await post(app, session, "idle", body)).errorType).toBe("upstream_timeout")
    }
    const completed = await post(app, session, "success", body)
    expect(completed.errorType).toBeUndefined()
    expect(completed.raw).toContain("COMPLETED")
    const retried = await post(app, session, "idle", body)
    expect(retried.errorType).toBe("upstream_timeout")
    expect(captured).toHaveLength(4)
  })
})
