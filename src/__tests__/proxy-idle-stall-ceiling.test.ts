import { beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop } from "./helpers"
import { UpstreamIdleError } from "../proxy/streamIdleGuard"

let stalled = true
let queries = 0
installSdkMock(() => ({
  query: (params: { options: { includePartialMessages?: boolean } }) => (async function* () {
    queries++
    if (stalled) throw new UpstreamIdleError(90_000, 90_001)
    if (params.options.includePartialMessages) {
      for (const event of [messageStart(), textBlockStart(0), textDelta(0, "RECOVERED"), blockStop(0), messageDelta(), messageStop()]) {
        yield withMockSdkSessionId(event, params.options)
      }
    }
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "RECOVERED" }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }),
  tool: () => ({}),
}), "proxy-idle-stall-ceiling.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
type App = ReturnType<typeof createProxyServer>["app"]
async function request(app: App, session: string | undefined, stream: boolean, text = "hello", model = "haiku") {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", ...(session ? { "x-opencode-session": session } : {}) },
    body: JSON.stringify({ model, max_tokens: 100, stream, messages: [{ role: "user", content: text }] }),
  }))
  const raw = await response.text()
  let error: { type?: string } | undefined
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    for (const line of raw.split("\n")) if (line.startsWith("data:")) {
      const event: { type?: string; error?: { type?: string } } = JSON.parse(line.slice(5))
      if (event.type === "error") error = event.error
    }
  } else {
    const result: { error?: { type?: string } } = JSON.parse(raw)
    error = result.error
  }
  return { status: response.status, error, raw }
}

describe("HTTP idle retry ceiling", () => {
  beforeEach(() => { stalled = true; queries = 0; clearSessionCache() })

  it.each([false, true])("rejects a repeated terminal request before invoking the SDK, stream=%s", async (stream) => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await request(app, session, stream)
      expect(result.error?.type).toBe(attempt < 3 ? "upstream_timeout" : "invalid_request_error")
    }
    expect(queries).toBe(3)
    const blocked = await request(app, session, stream)
    expect(blocked.status).toBe(400)
    expect(blocked.error?.type).toBe("invalid_request_error")
    expect(queries).toBe(3)
  })

  it.each([false, true])("allows a changed request and successful recovery, stream=%s", async (stream) => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    for (let attempt = 0; attempt < 3; attempt++) await request(app, session, stream)
    stalled = false
    const recovered = await request(app, session, stream, "revised")
    expect(recovered.status).toBe(200)
    expect(recovered.error).toBeUndefined()
    expect(recovered.raw).toContain("RECOVERED")
    expect(queries).toBe(4)
    stalled = true
    const retry = await request(app, session, stream)
    expect(retry.error?.type).toBe("upstream_timeout")
    expect(queries).toBe(5)
  })

  it("does not combine unrelated client or unidentified requests", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    for (let attempt = 0; attempt < 3; attempt++) await request(app, session, true)
    expect((await request(app, crypto.randomUUID(), true)).error?.type).toBe("upstream_timeout")
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await request(app, undefined, true)).error?.type).toBe("upstream_timeout")
    }
  })

  it("allows a model change immediately", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    for (let attempt = 0; attempt < 3; attempt++) await request(app, session, true)
    expect((await request(app, session, true, "hello", "sonnet")).error?.type).toBe("upstream_timeout")
  })
})
