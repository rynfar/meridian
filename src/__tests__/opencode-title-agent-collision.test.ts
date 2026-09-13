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
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
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
let capturePromptItems = false
let capturedPromptValue: unknown
let capturedPromptItems: unknown[] = []

/** Set to hold the title request inside query() so it keeps the turn lease
 *  while the user's turn arrives — the live race, made deterministic. */
let holdTitleUntil: Promise<void> | undefined
/** Fired when the title request's generator body starts running. The lease is
 *  taken in the route handler before the SDK call, so by this point the title
 *  request definitively holds it — which is what makes the race a signal and
 *  not a sleep. */
let onTitleEnteredQuery: (() => void) | undefined
/** How many title requests have reached the generator body. Used as the
 *  positive control below: two title turns share one lease scope, so the
 *  second must NOT get in while the first is held. */
let titleQueryEntries = 0
/** Fired when a NON-title request reaches the generator body — the same
 *  signal, for the other side of the race.
 *
 *  This replaces a 100 ms poll (`for (let i = 0; i < 50; i++) await
 *  setTimeout(2)`) that gave the user's turn a wall-clock budget to traverse
 *  the route handler. A loaded CI runner does not always manage it: that exact
 *  assertion failed on main at `264cfc3a`
 *  (actions/runs/34315620193) while passing 10/10 locally (#917, #933). A
 *  signal is not a budget. */
let onUserEnteredQuery: (() => void) | undefined

installSdkMock(() => ({
  query: (params: any) => {
    const options = params.options || {}
    capturedOptions.push(options)
    const sessionId = resolveMockSdkSessionId(options)
    if (!sessionId) throw new Error("Expected Meridian to select or resume an SDK session")
    const isTitle = typeof params.prompt === "string" && params.prompt.includes("Generate a title")
    return (async function* () {
      if (isTitle) {
        titleQueryEntries++
        onTitleEnteredQuery?.()
        if (holdTitleUntil) await holdTitleUntil
      } else {
        onUserEnteredQuery?.()
      }
      if (capturePromptItems) capturedPromptValue = params.prompt
      if (
        capturePromptItems
        && params.prompt
        && typeof params.prompt !== "string"
        && typeof params.prompt[Symbol.asyncIterator] === "function"
      ) {
        for await (const item of params.prompt) capturedPromptItems.push(item)
      }
      for (const msg of mockMessages) yield { ...(msg as object), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "opencode-title-agent-collision.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { computeMessageBlockHashes, computeMessageHashes } = await import("../proxy/session/lineage")
const { canonicalizeOpenCodeMessagesForLineage } = await import("../proxy/adapters/opencode")
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

/** A second title turn on the same session — same lease scope as the first. */
const TITLE_BODY_2 = {
  ...TITLE_BODY,
  messages: [
    ...TITLE_BODY.messages,
    { role: "assistant", content: "Reading notes.txt" },
    { role: "user", content: "Generate a title for this conversation:\n\"And the third line?\"" },
  ],
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

const USER_PROMPT_HOOK = {
  type: "text",
  text: `<user-prompt-submit-hook>
${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: "Use a todo list for multi-step work.",
    },
  })}
</user-prompt-submit-hook>`,
}
const HOOK_TURN_1 = {
  ...USER_TURN_1,
  messages: [{
    role: "user",
    content: [
      USER_PROMPT_HOOK,
      { type: "text", text: "first durable prompt", cache_control: { type: "ephemeral" } },
    ],
  }],
}
const HOOK_TURN_2 = {
  ...USER_TURN_1,
  messages: [
    { role: "user", content: [{ type: "text", text: "first durable prompt" }] },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    {
      role: "user",
      content: [
        USER_PROMPT_HOOK,
        { type: "text", text: "second durable prompt", cache_control: { type: "ephemeral" } },
      ],
    },
  ],
}

describe("OpenCode request-scoped lineage metadata", () => {
  it("hashes the active and historical forms of a UserPromptSubmit turn identically", () => {
    const active = canonicalizeOpenCodeMessagesForLineage(HOOK_TURN_1.messages)
    const historical = canonicalizeOpenCodeMessagesForLineage(HOOK_TURN_2.messages.slice(0, 1))

    expect(computeMessageHashes(active)).toEqual(computeMessageHashes(historical))
    expect(computeMessageBlockHashes(active)).toEqual(computeMessageBlockHashes(historical))
    expect(HOOK_TURN_1.messages[0]?.content).toHaveLength(2)
  })

  it("retains malformed, hook-only, and assistant-authored lookalikes", () => {
    const malformed = { type: "text", text: "<user-prompt-submit-hook>not json</user-prompt-submit-hook>" }
    const messages = [
      { role: "user", content: [malformed, { type: "text", text: "durable" }] },
      { role: "user", content: [USER_PROMPT_HOOK] },
      { role: "assistant", content: [USER_PROMPT_HOOK, { type: "text", text: "durable" }] },
    ]

    expect(canonicalizeOpenCodeMessagesForLineage(messages)).toEqual(messages)
  })
})

describe("OpenCode title agent vs the user's conversation", () => {
  beforeEach(() => {
    mockMessages = [assistantMessage([{ type: "text", text: "ok" }])]
    capturedOptions = []
    capturePromptItems = false
    capturedPromptValue = undefined
    capturedPromptItems = []
    holdTitleUntil = undefined
    onTitleEnteredQuery = undefined
    onUserEnteredQuery = undefined
    titleQueryEntries = 0
    telemetryStore.clear()
    clearSessionCache()
  })
  afterEach(() => {
    holdTitleUntil = undefined
    onTitleEnteredQuery = undefined
    onUserEnteredQuery = undefined
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

  it("resumes when OpenCode drops UserPromptSubmit context from a historical turn", async () => {
    const app = createTestApp()
    expect((await post(app, HOOK_TURN_1, USER_HEADERS)).status).toBe(200)
    const firstSessionId = capturedOptions.at(-1)?.sessionId
    expect(firstSessionId).toMatch(/^[0-9a-f-]{36}$/)

    expect((await post(app, HOOK_TURN_2, USER_HEADERS)).status).toBe(200)
    expect(capturedOptions.at(-1)?.resume).toBe(firstSessionId)
    expect(capturedOptions.at(-1)?.forkSession).toBe(true)
  })

  it("keeps canonical block indexes aligned for append-only tool results", async () => {
    const app = createTestApp()
    const first = {
      ...USER_TURN_1,
      messages: [{
        role: "user",
        content: [
          USER_PROMPT_HOOK,
          { type: "tool_result", tool_use_id: "call-a", content: "alpha" },
        ],
      }],
    }
    const second = {
      ...USER_TURN_1,
      messages: [{
        role: "user",
        content: [
          USER_PROMPT_HOOK,
          { type: "tool_result", tool_use_id: "call-a", content: "alpha" },
          { type: "tool_result", tool_use_id: "call-b", content: "bravo" },
        ],
      }],
    }

    expect((await post(app, first, USER_HEADERS)).status).toBe(200)
    const firstSessionId = capturedOptions.at(-1)?.sessionId
    capturePromptItems = true
    expect((await post(app, second, USER_HEADERS)).status).toBe(200)

    expect(capturedOptions.at(-1)?.resume).toBe(firstSessionId)
    const resumedPrompt = JSON.stringify([capturedPromptValue, capturedPromptItems])
    expect(resumedPrompt).toContain("bravo")
    expect(resumedPrompt).not.toContain("alpha")
    expect(resumedPrompt).not.toContain("user-prompt-submit-hook")
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

    const userEnteredQuery = new Promise<void>((resolve) => { onUserEnteredQuery = resolve })
    const userPromise = post(app, USER_TURN_1, USER_HEADERS)
    // The title query is still gated. Entering the user's query before release
    // proves the scoped requests did not contend on the same turn lease.
    //
    // Waited on as a SIGNAL with a generous ceiling, not as a 100 ms poll. The
    // ceiling only has to exceed how long a request takes to reach the SDK
    // call on the slowest host we run on; if the two turns really do share a
    // lease the signal cannot fire before `release()` at any ceiling, which is
    // what the positive control below pins.
    const userEnteredBeforeRelease = await Promise.race([
      userEnteredQuery.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ])
    release()

    const [title, user] = await Promise.all([titlePromise, userPromise])
    expect(userEnteredBeforeRelease).toBe(true)
    expect(title.status).toBe(200)
    expect(user.status).toBe(200)
    const userBody = await user.json() as any
    expect(JSON.stringify(userBody)).not.toContain("session advanced")
  })

  // NEGATIVE CONTROL for the harness above, on the same signal and the same
  // code path: a non-title prompt sent into the TITLE lease scope. `isTitle`
  // is decided by prompt content and the lease scope by the agent headers, so
  // this turn fires `onUserEnteredQuery` and contends. Verified to report
  // `false`, which is what makes the assertion above falsifiable rather than
  // a bound that always holds.
  it("does not report early entry for a turn that shares the held lease", async () => {
    const app = createTestApp()
    let release!: () => void
    holdTitleUntil = new Promise<void>((resolve) => { release = resolve })
    const titleEntered = new Promise<void>((resolve) => { onTitleEnteredQuery = resolve })
    const userEnteredQuery = new Promise<void>((resolve) => { onUserEnteredQuery = resolve })

    const titlePromise = post(app, TITLE_BODY, TITLE_HEADERS)
    await titleEntered
    const samescopePromise = post(app, USER_TURN_1, TITLE_HEADERS)
    // Slowness makes this MORE likely to hold, so the bound is safe: a starved
    // runner delays the contending turn further.
    const enteredBeforeRelease = await Promise.race([
      userEnteredQuery.then(() => true),
      Bun.sleep(400).then(() => false),
    ])
    release()
    await Promise.all([titlePromise, samescopePromise])

    expect(enteredBeforeRelease).toBe(false)
  })

  // POSITIVE CONTROL for the harness above. Raising a bound is only safe if
  // the assertion can still fail, so pin the other direction with turns that
  // genuinely share a lease scope: two title turns on one session. The second
  // must not reach the SDK call while the first is held, at any ceiling.
  it("still sees contention when two turns really do share one lease", async () => {
    const app = createTestApp()
    let release!: () => void
    holdTitleUntil = new Promise<void>((resolve) => { release = resolve })
    const firstEntered = new Promise<void>((resolve) => { onTitleEnteredQuery = resolve })

    const firstPromise = post(app, TITLE_BODY, TITLE_HEADERS)
    await firstEntered
    expect(titleQueryEntries).toBe(1)

    const secondPromise = post(app, TITLE_BODY_2, TITLE_HEADERS)
    // Slowness makes this MORE likely to hold, not less, so the wait is safe
    // to bound: a starved runner delays the second turn further.
    await Bun.sleep(250)
    const secondEnteredEarly = titleQueryEntries > 1
    release()
    await Promise.all([firstPromise, secondPromise])

    expect(secondEnteredEarly).toBe(false)
  })
})
