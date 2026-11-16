/**
 * Oh My Pi's side calls (the idle recap, composer predictions) carry the
 * conversation's `metadata.user_id` session id and differ only in
 * `X-Claude-Code-Session-Id: <session>:side:<id>`. Served as turns, they
 * resumed the conversation's SDK session and became its newest state, so the
 * request after one no longer continued the conversation. Served as auxiliary
 * requests they leave the conversation's mapping alone: one that only adds
 * user text to a completed turn forks the conversation's session without
 * publishing the fork, anything else replays fresh.
 */

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

const mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
const queries: Array<{ resume?: string; fork: boolean }> = []
/** When set, the query with this index reports `started` and waits for `release` before it answers. */
let hold: { index: number; started: () => void; release: Promise<void> } | undefined
/** Resumes of this session id are refused as a transcript that no longer exists. */
let goneSession: string | undefined

installSdkMock(() => ({
  query: (params: { options?: Record<string, unknown> }) => {
    const options = params.options || {}
    const index = queries.push({
      resume: typeof options.resume === "string" ? options.resume : undefined,
      fork: options.forkSession === true,
    }) - 1
    const sessionId = resolveMockSdkSessionId(options, "omp-side-call-session")
    const held = hold?.index === index ? hold : undefined
    held?.started()
    return (async function* () {
      if (held) await held.release
      if (goneSession !== undefined && options.resume === goneSession) {
        throw new Error(`No conversation found with session ID: ${goneSession}`)
      }
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
const metadataFor = (session: string) => ({ user_id: JSON.stringify({ session_id: session }) })
const mainHeaders = { "x-meridian-agent": "pi", "x-claude-code-session-id": SESSION }
const sideHeaders = { "x-meridian-agent": "pi", "x-claude-code-session-id": `${SESSION}:side:15d02de42621c9eb` }

type Message = { role: string; content: unknown }
const turnOf = (session: string) => (...messages: Message[]) => ({
  model: "claude-sonnet-4-5",
  max_tokens: 1024,
  stream: false,
  metadata: metadataFor(session),
  messages,
})
const turn = turnOf(SESSION)

const FIRST = { role: "user", content: "read the config and summarise it" }
const ANSWER = { role: "assistant", content: "ok" }
const RECAP = { role: "user", content: "Summarise where this session stands." }

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
    queries.length = 0
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

  it("let the conversation's next turn run while a side call's fork is still answering", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, turn(FIRST), mainHeaders)
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    hold = { index: 1, started: started.resolve, release: release.promise }
    try {
      const side = post(app, turn(FIRST, ANSWER, RECAP), sideHeaders)
      // The side call's fork is in flight on the session the first turn left.
      await started.promise
      await post(app, turn(FIRST, ANSWER, { role: "user", content: "now update the changelog" }), mainHeaders)
      release.resolve()
      await side
    } finally {
      release.resolve()
      hold = undefined
    }
    const lines = requestLines()
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("auxiliary=fork")
    expect(lines[2]).toContain("lineage=continuation")
    expect(queries[2]?.resume).toBe(queries[1]?.resume)
  })

  it("fork the conversation's session after a completed turn without publishing the fork", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, turn(FIRST), mainHeaders)
    // The idle recap: the whole conversation plus the recap prompt.
    await post(app, turn(FIRST, ANSWER, RECAP), sideHeaders)
    await post(app, turn(FIRST, ANSWER, { role: "user", content: "now update the changelog" }), mainHeaders)

    const lines = requestLines()
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("lineage=continuation")
    expect(lines[1]).toContain("auxiliary=fork")
    expect(lines[2]).toContain("lineage=continuation")
    expect(lines[2]).not.toContain("diverged=")
    expect(lines[2]).not.toContain("auxiliary=")
    // The side call resumed the session the first turn left, as a fork; the
    // next real turn resumed that same session, not the side call's fork.
    const source = queries[1]?.resume
    expect(typeof source).toBe("string")
    expect(queries[1]?.fork).toBe(true)
    expect(queries[2]?.resume).toBe(source)
  })

  it("fork under a session key an extension suffixed", async () => {
    const rotated = turnOf(`${SESSION}~rmwj21284`)
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, rotated(FIRST), mainHeaders)
    await post(app, rotated(FIRST, ANSWER, RECAP), sideHeaders)
    const lines = requestLines()
    expect(lines).toHaveLength(2)
    expect(typeof queries[1]?.resume).toBe("string")
    expect(queries[1]?.fork).toBe(true)
    expect(lines[1]).toContain("auxiliary=fork")
  })

  it("replay a side call fresh, without evicting the mapping, when its fork's source is gone", async () => {
    const delay = process.env.MERIDIAN_BUSY_RETRY_DELAY_MS
    process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = "0"
    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
      await post(app, turn(FIRST), mainHeaders)
      // The first query's session id is what the mapping names.
      const lookup = queries.length
      await post(app, turn(FIRST, ANSWER, RECAP), sideHeaders)
      const source = queries[lookup]?.resume
      expect(typeof source).toBe("string")
      goneSession = source
      queries.length = 0
      await post(app, turn(FIRST, ANSWER, RECAP), sideHeaders)
      goneSession = undefined
      // Every resume was refused, then one fresh replay answered.
      expect(queries.at(-1)?.resume).toBeUndefined()
      expect(queries.slice(0, -1).every(query => query.resume === source)).toBe(true)
      expect(errSpy.mock.calls.some((call: unknown[]) => String(call[0]).includes("session unusable (unresumable), replaying as fresh session"))).toBe(true)
      // The mapping still names the source: the next real turn resumes it.
      queries.length = 0
      await post(app, turn(FIRST, ANSWER, { role: "user", content: "now update the changelog" }), mainHeaders)
      expect(queries[0]?.resume).toBe(source)
    } finally {
      goneSession = undefined
      if (delay === undefined) delete process.env.MERIDIAN_BUSY_RETRY_DELAY_MS
      else process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = delay
    }
  })

  it("replay fresh when the side call carries a reply the session never received", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, turn(FIRST), mainHeaders)
    // A completion probe sent while the next turn runs: a snapshot of the
    // reply in flight after the stored history, then the probe's prompt.
    await post(app, turn(FIRST, ANSWER, { role: "user", content: "and the tests?" }, { role: "assistant", content: "running them" }, RECAP), sideHeaders)
    await post(app, turn(FIRST, ANSWER, { role: "user", content: "and the tests?" }), mainHeaders)

    const lines = requestLines()
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain("diverged=independent-request:auxiliary-request")
    expect(lines[1]).toContain("auxiliary=replay:not-side-prompt")
    expect(queries[1]?.resume).toBeUndefined()
    expect(lines[2]).toContain("lineage=continuation")
  })

  it("replay fresh when the conversation has no stored session", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    await post(app, turn(FIRST, ANSWER, RECAP), sideHeaders)
    const lines = requestLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("diverged=independent-request:auxiliary-request auxiliary=replay:lineage-diverged:not-found")
    expect(queries[0]?.resume).toBeUndefined()
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
    expect(lines[1]).not.toContain("auxiliary")
  })
})
