import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
let capturedOptions: Record<string, unknown> = {}
let mockMessages: unknown[] = []
let queryCalls = 0
let waitBeforeMessages: Promise<void> | undefined

import { withMockSdkSessionId } from "./helpers"

installSdkMock(() => ({
  query: (params: { options?: Record<string, unknown> }) => {
    queryCalls += 1
    capturedOptions = params.options ?? {}
    return (async function* () {
      if (waitBeforeMessages) await waitBeforeMessages
      for (const message of mockMessages) {
        yield withMockSdkSessionId(message, params.options)
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-structured-output.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const {
  clearSharedSessions,
  evictSharedSession,
  lookupSharedSessionResult,
} = await import("../proxy/sessionStore")

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
}

function resultMessage(structuredOutput: unknown) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: JSON.stringify(structuredOutput),
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: { input_tokens: 12, output_tokens: 7 },
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: crypto.randomUUID(),
    session_id: "structured-session",
    structured_output: structuredOutput,
  }
}

function request(
  stream: boolean,
  outputConfig: unknown = { format: { type: "json_schema", schema } },
  extra: Record<string, unknown> = {},
  sessionId?: string,
) {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionId ? { "x-opencode-session": sessionId } : {}),
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      stream,
      messages: [{ role: "user", content: "Return an answer." }],
      output_config: outputConfig,
      ...extra,
    }),
  })
}

describe("native structured output", () => {
  let originalPassthrough: string | undefined

  beforeEach(() => {
    originalPassthrough = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    capturedOptions = {}
    mockMessages = []
    queryCalls = 0
    waitBeforeMessages = undefined
    clearSessionCache()
    clearSharedSessions()
  })

  afterEach(() => {
    if (originalPassthrough === undefined) delete process.env.MERIDIAN_PASSTHROUGH
    else process.env.MERIDIAN_PASSTHROUGH = originalPassthrough
  })

  it("maps output_config.format to the Agent SDK and returns authoritative JSON", async () => {
    mockMessages = [resultMessage({ answer: "grounded" })]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(request(false))
    const body = await response.json() as any

    expect(response.status).toBe(200)
    expect(capturedOptions.outputFormat).toEqual({ type: "json_schema", schema })
    expect(body.stop_reason).toBe("end_turn")
    expect(body.content).toEqual([{ type: "text", text: '{"answer":"grounded"}' }])
    expect(body.usage).toEqual({ input_tokens: 12, output_tokens: 7 })
  })

  it("buffers structured streaming until validation and emits one valid SSE message", async () => {
    mockMessages = [resultMessage({ answer: "streamed" })]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(request(true))
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    expect(capturedOptions.outputFormat).toEqual({ type: "json_schema", schema })
    expect(body).toContain("event: message_start")
    expect(body).toContain('"text":"{\\"answer\\":\\"streamed\\"}"')
    expect(body).toContain('"stop_reason":"end_turn"')
    expect(body).toContain("event: message_stop")
  })

  it("withholds resumed structured success when exact publication loses its CAS", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const sessionId = "structured-publication-order"
    mockMessages = [resultMessage({ answer: "seed" })]
    const seed = await app.fetch(request(false, undefined, {}, sessionId))
    expect(seed.status).toBe(200)
    await seed.text()

    const source = lookupSharedSessionResult(sessionId)
    expect(source.status).toBe("found")
    if (source.status !== "found") throw new Error("seed mapping was not stored")
    expect(source.generation).toBeDefined()

    let releaseResult = () => {}
    waitBeforeMessages = new Promise<void>((resolve) => { releaseResult = resolve })
    mockMessages = [resultMessage({ answer: "must-not-finalize" })]
    const responsePromise = app.fetch(request(true, undefined, {
      messages: [
        { role: "user", content: "Return an answer." },
        { role: "assistant", content: '{"answer":"seed"}' },
        { role: "user", content: "Return another answer." },
      ],
    }, sessionId))

    for (let index = 0; index < 1_000 && queryCalls < 2; index++) await Bun.sleep(1)
    expect(queryCalls).toBe(2)
    expect(evictSharedSession(sessionId, source.generation)).toBe(true)
    releaseResult()

    const response = await responsePromise
    const body = await response.text()
    expect(body).toContain("event: error")
    expect(body).not.toContain('"stop_reason":"end_turn"')
    expect(body).not.toContain("must-not-finalize")
  })

  it("never publishes a resumed structured target canceled before its buffered envelope", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
    const sessionId = "structured-cancel-order"
    mockMessages = [resultMessage({ answer: "seed" })]
    const seed = await app.fetch(request(false, undefined, {}, sessionId))
    await seed.text()
    const source = lookupSharedSessionResult(sessionId)
    if (source.status !== "found") throw new Error("seed mapping was not stored")

    let releaseResult = () => {}
    waitBeforeMessages = new Promise<void>((resolve) => { releaseResult = resolve })
    mockMessages = [resultMessage({ answer: "canceled-hidden-turn" })]
    const response = await app.fetch(request(true, undefined, {
      messages: [
        { role: "user", content: "Return an answer." },
        { role: "assistant", content: '{"answer":"seed"}' },
        { role: "user", content: "Return another answer." },
      ],
    }, sessionId))
    for (let index = 0; index < 1_000 && queryCalls < 2; index++) await Bun.sleep(1)
    expect(queryCalls).toBe(2)
    const canceledTarget = capturedOptions.sessionId
    expect(canceledTarget).not.toBe(source.session.claudeSessionId)

    await response.body!.cancel("structured test cancellation")
    releaseResult()
    await Bun.sleep(100)

    const durable = lookupSharedSessionResult(sessionId)
    expect(durable.status).toBe("found")
    if (durable.status !== "found") throw new Error("source mapping was not preserved")
    expect(durable.session.claudeSessionId).toBe(source.session.claudeSessionId)
    expect(durable.session.claudeSessionId).not.toBe(canceledTarget)
  })

  it("rejects requests that combine tools with output_config.format", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const tools = [{
      name: "get_weather",
      description: "Get the weather",
      input_schema: { type: "object", properties: {}, additionalProperties: false },
    }]
    const response = await app.fetch(request(false, undefined, { tools }))
    const body = await response.json() as any

    expect(response.status).toBe(400)
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("tools")
    expect(queryCalls).toBe(0)
  })

  it("rejects malformed output formats before starting an SDK query", async () => {
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(request(false, { format: { type: "xml", schema } }))
    const body = await response.json() as any

    expect(response.status).toBe(400)
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("Only 'json_schema' is supported")
    expect(queryCalls).toBe(0)
  })

  it("fails instead of returning fallback prose when the SDK omits structured_output", async () => {
    mockMessages = [{
      type: "result",
      subtype: "success",
      session_id: "missing-structured-output",
      usage: { input_tokens: 1, output_tokens: 1 },
    }]
    const app = createProxyServer({ port: 0, host: "127.0.0.1" }).app

    const response = await app.fetch(request(false))
    const body = await response.json() as any

    expect(response.status).toBeGreaterThanOrEqual(500)
    expect(body.type).toBe("error")
  })
})
