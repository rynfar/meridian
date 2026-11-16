/**
 * Oh My Pi's side calls (the idle recap, composer predictions) carry the
 * conversation's `metadata.user_id` session id and differ only in
 * `X-Claude-Code-Session-Id: <session>:side:<id>`. Served as turns, they
 * resumed the conversation's SDK session and became its newest state, so the
 * request after one no longer continued the conversation. Served as auxiliary
 * requests they leave the conversation's session and mapping alone.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

const mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
const resumes: Array<string | undefined> = []

installSdkMock(() => ({
  query: (params: { options?: Record<string, unknown> }) => {
    const options = params.options || {}
    resumes.push(typeof options.resume === "string" ? options.resume : undefined)
    const sessionId = resolveMockSdkSessionId(options, "omp-side-call-session")
    return (async function* () {
      for (const msg of mockMessages) yield { ...msg, session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-omp-side-call.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

// Imported after the mocks above are installed, which a static import would precede.
const { createProxyServer, clearSessionCache } = await import("../proxy/server")

const SESSION = "omp-main-session"
const ompMetadata = { user_id: JSON.stringify({ session_id: SESSION }) }
const mainHeaders = { "x-meridian-agent": "pi", "x-claude-code-session-id": SESSION }
const sideHeaders = { "x-meridian-agent": "pi", "x-claude-code-session-id": `${SESSION}:side:15d02de42621c9eb` }

const turn = (...messages: Array<{ role: string; content: string }>) => ({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  metadata: ompMetadata,
  messages,
})

const FIRST = { role: "user", content: "read the config and summarise it" }
const ANSWER = { role: "assistant", content: "ok" }

async function post(app: { fetch: (request: Request) => Response | Promise<Response> }, body: unknown, headers: Record<string, string>) {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
  expect(res.status).toBe(200)
  await res.json()
}

describe("Oh My Pi side calls", () => {
  let errSpy: ReturnType<typeof spyOn>

  beforeEach(async () => {
    resumes.length = 0
    await clearSessionCache()
    errSpy = spyOn(console, "error")
  })

  afterEach(async () => {
    errSpy.mockRestore()
    await clearSessionCache()
  })

  const requestLines = (): string[] => errSpy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.includes("[PROXY]") && line.includes("adapter=") && line.includes("msgCount="))

  it("leave the conversation's mapping alone, so the next real turn continues it", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, turn(FIRST), mainHeaders)
    // The idle recap: the whole conversation plus the recap prompt.
    await post(app, turn(FIRST, ANSWER, { role: "user", content: "Summarise where this session stands." }), sideHeaders)
    await post(app, turn(FIRST, ANSWER, { role: "user", content: "now update the changelog" }), mainHeaders)

    const lines = requestLines()
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("diverged=independent-request:auxiliary-request")
    expect(lines[2]).toContain("lineage=continuation")
    expect(lines[2]).not.toContain("diverged=")
    // Only the real turn resumes a session; the side call started its own.
    expect(resumes.slice(0, 2)).toEqual([undefined, undefined])
    expect(typeof resumes[2]).toBe("string")
  })

  it("keep a side call of another conversation a turn of this one", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, turn(FIRST), mainHeaders)
    await post(app, turn(FIRST, ANSWER, { role: "user", content: "go on" }), {
      ...mainHeaders,
      "x-claude-code-session-id": "another-session:side:1",
    })
    const lines = requestLines()
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain("lineage=continuation")
    expect(lines[1]).not.toContain("auxiliary-request")
  })
})
