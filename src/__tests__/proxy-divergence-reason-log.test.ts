/**
 * The request line names why a turn did not resume (#820).
 *
 * `lineage=` collapses every divergence without a cached session into the
 * literal `new`, so the reporter's log held 6,514 of them and not one line
 * saying why. The most expensive of those — the headerless tool-result bypass
 * — is assigned before `classifyLineage` runs, so it emitted nothing at all;
 * it was identified only by reading `server.ts`.
 *
 * Two reporters measured the cost first: ~280k cache-write tokens per turn
 * against ~214 with a session key, and a drained Max window. Every request
 * returns 200 throughout, which is why nothing in the proxy's own success
 * metrics moved.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let mockMessages: unknown[] = []

installSdkMock(() => ({
  query: (params: any) => {
    const options = params.options || {}
    const sessionId = resolveMockSdkSessionId(options, "divergence-log-session")
    return (async function* () {
      for (const msg of mockMessages) yield { ...(msg as object), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-divergence-reason-log.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetHeaderlessToolLoopWarningForTests } = await import("../proxy/session/cache")

function createTestApp() {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  return app
}

async function post(app: any, body: any, headers: Record<string, string> = {}) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  }))
}

const TURN_1 = {
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  messages: [{ role: "user", content: "read the config and summarise it" }],
}

/** Ends in user[tool_result] — the shape that triggers the bypass. */
const TOOL_TURN = {
  ...TURN_1,
  messages: [
    ...TURN_1.messages,
    { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "read", input: { path: "a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "file contents" }] },
  ],
}

describe("divergence reason on the request line", () => {
  let errSpy: ReturnType<typeof spyOn>
  let warnSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    clearSessionCache()
    resetHeaderlessToolLoopWarningForTests()
    errSpy = spyOn(console, "error")
    warnSpy = spyOn(console, "warn")
  })

  afterEach(() => {
    errSpy.mockRestore()
    warnSpy.mockRestore()
    clearSessionCache()
  })

  const requestLines = (): string[] => errSpy.mock.calls
    .map((c: any) => String(c[0]))
    .filter((l: string) => l.includes("[PROXY]") && l.includes("adapter=") && l.includes("msgCount="))

  const lastRequestLine = (): string => {
    const all = requestLines()
    expect(all.length).toBeGreaterThan(0)
    const last = all.at(-1)
    if (last === undefined) throw new Error("no [PROXY] request line was logged")
    return last
  }

  const warnings = (): string[] => warnSpy.mock.calls.map((c: any) => String(c[0]))
    .filter((l: string) => l.includes("Client-driven tool loop with no session identity"))

  // THE REPORTED CASE. pi sends no session header, and every agentic turn ends
  // in a tool_result, so this fires on every round of every conversation.
  it("names the headerless tool-result bypass", async () => {
    const app = createTestApp()
    expect((await post(app, TOOL_TURN, { "x-meridian-agent": "pi" })).status).toBe(200)
    expect(lastRequestLine()).toContain("diverged=independent-request:headerless-tool-result")
  })

  it("says once per process that the conversation is not resuming", async () => {
    const app = createTestApp()
    await post(app, TOOL_TURN, { "x-meridian-agent": "pi" })
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain("adapter=pi")
    expect(warnings()[0]).toContain("does not resume")

    // A per-round line would bury itself: the reporter's log had 6,019 of these
    // in a single conversation.
    await post(app, TOOL_TURN, { "x-meridian-agent": "pi" })
    await post(app, TOOL_TURN, { "x-meridian-agent": "pi" })
    expect(warnings()).toHaveLength(1)
    expect(requestLines().filter(l => l.includes("headerless-tool-result"))).toHaveLength(3)
  })

  // connor-grady's distinction: "the key never resolved" and "the key resolved
  // and the history did not match" are different bugs with the same symptom.
  it("separates a key that never resolved from the bypass", async () => {
    const app = createTestApp()
    await post(app, TURN_1, { "x-meridian-agent": "pi", "x-session-affinity": "pi-run-1" })
    expect(lastRequestLine()).toContain("diverged=not-found")
    expect(lastRequestLine()).not.toContain("independent-request")
    expect(warnings()).toHaveLength(0)
  })

  it("says nothing at all once the turn actually resumes", async () => {
    const app = createTestApp()
    const headers = { "x-meridian-agent": "pi", "x-session-affinity": "pi-run-2" }
    await post(app, TURN_1, headers)
    await post(app, TOOL_TURN, headers)
    expect(lastRequestLine()).toContain("lineage=continuation")
    expect(lastRequestLine()).not.toContain("diverged=")
    expect(warnings()).toHaveLength(0)
  })

  it("names a headerless fork source, which is a different bypass", async () => {
    const app = createTestApp()
    await post(app, TURN_1, { "x-meridian-source": "fork-memory-extract" })
    expect(lastRequestLine()).toContain("diverged=independent-request:fork-source")
    // The fork guard is deliberate and correct; the tool-loop advice must not
    // fire for it.
    expect(warnings()).toHaveLength(0)
  })

  // REGRESSION GUARD. `lineage=<value> session=<value>` is matched as one unit
  // by e2e-passthrough-turns.mjs and by field log analysis. The reason is a
  // separate field precisely so that pairing survives.
  it("leaves lineage= adjacent to session=", async () => {
    const app = createTestApp()
    await post(app, TOOL_TURN, { "x-meridian-agent": "pi" })
    expect(lastRequestLine()).toMatch(/lineage=\S+ session=\S+/)
    expect(lastRequestLine()).toContain("lineage=new session=")
  })
})
