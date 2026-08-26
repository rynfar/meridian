/**
 * OpenCode's title agent must not be able to break or de-cache the user's turn.
 *
 * Reproduced live against OpenCode 1.18.11 (3/3 runs). OpenCode fires its
 * internal `title` agent concurrently with the user's first real turn, and both
 * carry the SAME session id:
 *
 *   seq 1  agent=title  mode=subagent  tools=0   msgs=1  x-opencode-session: ses_fe4b…
 *   seq 2  agent=build  mode=primary   tools=10  msgs=1  x-opencode-session: ses_fe4b…
 *
 * One key meant one lineage and one per-session turn lease. The title turn wins
 * the race and commits a one-message lineage under the shared key; the user's
 * turn then waits behind the lease (5-12s observed) and is measured against a
 * conversation that is not its own — `unrelated-history`.
 *
 * Two outcomes, both bad, both covered here:
 *   - since #825: HTTP 400 `session_turn_conflict`, which OpenCode surfaces as
 *     a non-retryable APIError and the user's first turn is simply lost.
 *   - before #825: the same divergence silently fell through to a full-history
 *     replay on a fresh SDK session — a cold prompt cache every time a title
 *     was generated.
 *
 * This is an HTTP-layer test on purpose: the unit tests pin the derived key,
 * and this pins what the client actually receives.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir } from "../proxy/sessionStore"

let isolatedSessionDir = ""
beforeEach(() => {
  isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-http-test-"))
  setSessionStoreDir(isolatedSessionDir)
})
afterEach(async () => {
  await Bun.sleep(25)
  rmSync(isolatedSessionDir, { recursive: true, force: true })
})
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

let mockMessages: unknown[] = []
let capturedOptions: any[] = []

/** Set to hold the title request inside query() so it keeps the turn lease
 *  while the user's turn arrives — the live race, made deterministic. */
let holdTitleUntil: Promise<void> | undefined
/** Fired when the title request's generator body starts running. The lease is
 *  taken in the route handler before the SDK call, so by this point the title
 *  request definitively holds it — which is what makes the race a signal and
 *  not a sleep. */
let onTitleEnteredQuery: (() => void) | undefined

mock.module("@anthropic-ai/claude-agent-sdk", () => ({
  query: (params: any) => {
    const options = params.options || {}
    capturedOptions.push(options)
    const sessionId = resolveMockSdkSessionId(options)
    if (!sessionId) throw new Error("Expected Meridian to select or resume an SDK session")
    const isTitle = typeof params.prompt === "string" && params.prompt.includes("Generate a title")
    return (async function* () {
      if (isTitle) {
        onTitleEnteredQuery?.()
        if (holdTitleUntil) await holdTitleUntil
      }
      for (const msg of mockMessages) yield { ...(msg as object), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}))

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

mock.module("../mcpTools", () => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { telemetryStore } = await import("../telemetry")

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

const SESSION = "ses_fe4bfa3daffexvfr3lL7db1lcU"

/** OpenCode's internal title one-shot: no tools, one message, subagent mode. */
const TITLE_HEADERS = {
  "x-opencode-session": SESSION,
  "x-opencode-agent-mode": "subagent",
  "x-opencode-agent-name": "title",
}
const TITLE_BODY = {
  model: "claude-haiku-4-5",
  max_tokens: 128,
  stream: false,
  messages: [{
    role: "user",
    content: 'Generate a title for this conversation:\n"Read notes.txt and tell me the second line."',
  }],
}

/** The user's own turn, same OpenCode session id. */
const USER_HEADERS = {
  "x-opencode-session": SESSION,
  "x-opencode-agent-mode": "primary",
  "x-opencode-agent-name": "build",
}
const USER_TURN_1 = {
  model: "claude-haiku-4-5",
  max_tokens: 1024,
  stream: false,
  tools: [{ name: "read", description: "read a file", input_schema: { type: "object", properties: {} } }],
  messages: [{ role: "user", content: "Read notes.txt and tell me the second line." }],
}
const USER_TURN_2 = {
  ...USER_TURN_1,
  messages: [
    ...USER_TURN_1.messages,
    { role: "assistant", content: "ok" },
    { role: "user", content: "And the third line?" },
  ],
}

describe("OpenCode title agent vs the user's conversation", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedOptions = []
    holdTitleUntil = undefined
    onTitleEnteredQuery = undefined
    telemetryStore.clear()
    clearSessionCache()
  })
  afterEach(() => {
    holdTitleUntil = undefined
    onTitleEnteredQuery = undefined
    clearSessionCache()
  })

  it("does not refuse the user's turn after a title turn on the same session id", async () => {
    const app = createTestApp()
    expect((await post(app, TITLE_BODY, TITLE_HEADERS)).status).toBe(200)
    const userTurn = await post(app, USER_TURN_1, USER_HEADERS)
    expect(userTurn.status).toBe(200)
    const body = await userTurn.json() as any
    expect(body.error?.message ?? "").not.toContain("session advanced")
  })

  it("lets the user's conversation resume after a title turn interleaves", async () => {
    const app = createTestApp()
    await post(app, USER_TURN_1, USER_HEADERS)
    const userSessionId = capturedOptions.at(-1)?.sessionId
    expect(userSessionId).toMatch(/^[0-9a-f-]{36}$/)
    await post(app, TITLE_BODY, TITLE_HEADERS)
    const turn2 = await post(app, USER_TURN_2, USER_HEADERS)
    expect(turn2.status).toBe(200)
    // The title turn must not have displaced the conversation's stored lineage:
    // turn 2 still resumes the exact session Meridian selected for turn 1.
    expect(capturedOptions.at(-1)?.resume).toBe(userSessionId)
  })

  it("keeps the title turn itself working and independent", async () => {
    const app = createTestApp()
    await post(app, USER_TURN_1, USER_HEADERS)
    await post(app, USER_TURN_2, USER_HEADERS)
    const title = await post(app, TITLE_BODY, TITLE_HEADERS)
    expect(title.status).toBe(200)
    // A one-shot has nothing of its own to resume, and must not inherit the
    // user's session either.
    expect(capturedOptions.at(-1)?.resume).toBeUndefined()
  })
  /**
   * The live shape: the title turn is still in flight when the user's turn
   * arrives, so the user's turn queues on the per-session turn lease and is
   * then judged against whatever the title turn committed. This is what
   * returned HTTP 400 `session_turn_conflict` against real OpenCode.
   */
  it("does not refuse the user's turn that queued behind an in-flight title turn", async () => {
    const app = createTestApp()
    let release!: () => void
    let titleHasLease!: Promise<void>
    holdTitleUntil = new Promise<void>((resolve) => { release = resolve })
    titleHasLease = new Promise<void>((resolve) => { onTitleEnteredQuery = resolve })

    const titlePromise = post(app, TITLE_BODY, TITLE_HEADERS)
    // Signal, not sleep: wait until the title request is inside query(), which
    // is after the route handler took the turn lease.
    await titleHasLease

    const userPromise = post(app, USER_TURN_1, USER_HEADERS)
    // Give the user's turn time to reach the lease and block on it. Bounded,
    // and the sessionQueueWaitMs assertion below fails loudly if it did not —
    // a race harness that silently stops racing is worse than no test.
    for (let i = 0; i < 50 && capturedOptions.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 2))
    }
    // The title query is still gated. Entering the user's query before release
    // proves the scoped requests did not contend on the same turn lease. This
    // is stronger and less clock-sensitive than requiring a 0 ms metric.
    const userEnteredBeforeRelease = capturedOptions.length === 2
    release()

    const [title, user] = await Promise.all([titlePromise, userPromise])
    expect(userEnteredBeforeRelease).toBe(true)
    expect(title.status).toBe(200)
    expect(user.status).toBe(200)
    const userBody = await user.json() as any
    expect(JSON.stringify(userBody)).not.toContain("session advanced")
  })
})
