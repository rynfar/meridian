/**
 * Time a request spends waiting on Meridian itself, here for an SDK slot, is
 * not upstream silence. Runs in its own `bun test` invocation because the idle
 * limit is read once, when server.ts loads.
 */
import { beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId, messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop } from "./helpers"

const IDLE_MS = 600
const HOLD_MS = 1_800
process.env.MERIDIAN_UPSTREAM_IDLE_MS = String(IDLE_MS)

let queries = 0
installSdkMock(() => ({
  query: (params: { options: { includePartialMessages?: boolean } }) => (async function* () {
    const holder = queries++ === 0
    const text = holder ? "HOLDER" : "QUEUED"
    if (params.options.includePartialMessages) {
      for (const event of [messageStart(), textBlockStart(0)]) yield withMockSdkSessionId(event, params.options)
      // The holder keeps the only SDK slot busy for three idle windows while
      // never going quiet long enough to stall itself.
      if (holder) {
        for (let elapsed = 0; elapsed < HOLD_MS; elapsed += 100) {
          await Bun.sleep(100)
          yield withMockSdkSessionId(textDelta(0, "."), params.options)
        }
      }
      for (const event of [textDelta(0, text), blockStop(0), messageDelta(), messageStop()]) {
        yield withMockSdkSessionId(event, params.options)
      }
    }
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "fixture", instance: {} }),
  tool: () => ({}),
}), "proxy-idle-guard-queue.test.ts")
installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: <T>(_context: unknown, fn: () => T) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))
const { createProxyServer, clearSessionCache } = await import("../proxy/server")
type App = ReturnType<typeof createProxyServer>["app"]

async function request(app: App, stream: boolean) {
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-opencode-session": crypto.randomUUID() },
    body: JSON.stringify({ model: "haiku", max_tokens: 100, stream, messages: [{ role: "user", content: "hello" }] }),
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

describe("upstream idle guard and the SDK slot queue", () => {
  beforeEach(() => { queries = 0; clearSessionCache() })

  it.each([false, true])("does not count the wait for an SDK slot as upstream silence, stream=%s", async (stream) => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, maxConcurrent: 1 })
    const holder = request(app, true)
    while (queries === 0) await Bun.sleep(10)
    const queuedAt = Date.now()
    const queued = await request(app, stream)
    const waited = Date.now() - queuedAt

    expect(waited).toBeGreaterThan(IDLE_MS)
    expect(queued.error).toBeUndefined()
    expect(queued.status).toBe(200)
    expect(queued.raw).toContain("QUEUED")
    const held = await holder
    expect(held.error).toBeUndefined()
    expect(held.raw).toContain("HOLDER")
    expect(queries).toBe(2)
  })
})
