/**
 * A conversation that moves to another account and comes back, through the
 * HTTP layer with a mocked SDK.
 *
 * Session mappings are kept per account, and a switch no longer clears them
 * (profile switches preserve resume state), so an account a conversation
 * comes back to still holds the session it had when the conversation left.
 * That session ends where the conversation was then. Whatever the
 * conversation did on the other account in between is not in it, and a
 * resume delta drops assistant turns on the assumption that the session wrote
 * them itself.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, resolveMockSdkSessionId } from "./helpers"

interface SeenQuery {
  dir: string
  resume: string | undefined
  /** The session the turn is written to. */
  target: string
  prompt: string
}
let seen: SeenQuery[] = []

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt
  const parts: string[] = []
  for await (const message of prompt as AsyncIterable<unknown>) parts.push(JSON.stringify(message))
  return parts.join("\n")
}

installSdkMock(() => ({
  query: (params: any) => {
    const dir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "default"
    const sessionId = resolveMockSdkSessionId(params.options, "return-trip-session")
    return (async function* () {
      const prompt = await promptText(params.prompt)
      seen.push({ dir, resume: params.options?.resume, target: sessionId, prompt })
      yield { ...assistantMessage([{ type: "text", text: `answer from ${dir}` }]), session_id: sessionId }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "account-return-trip.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
const { __setFetchOAuthUsageOverride, resetOAuthUsageCache } = await import("../proxy/oauthUsage")
const { rateLimitStore } = await import("../proxy/rateLimitStore")
const { evictSharedSession } = await import("../proxy/sessionStore")

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }
type Message = { role: "user" | "assistant"; content: string }

/**
 * One turn of the conversation, keyed by `session`, or, for null, by its
 * fingerprint: a client that sends no session key (ForgeCode), working in the
 * test's directory.
 */
async function turn(app: TestApp, session: string | null, messages: Message[]) {
  const res = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: session === null
      ? { "Content-Type": "application/json", "x-meridian-agent": "forgecode" }
      : { "Content-Type": "application/json", "x-opencode-session": session },
    body: JSON.stringify({
      model: "claude-sonnet-4-5", max_tokens: 128, stream: false, messages,
      ...(session === null ? { system: `<current_working_directory>${root}</current_working_directory>` } : {}),
    }),
  }))
  expect(res.status).toBe(200)
}

async function setActive(app: TestApp, profile: string) {
  const res = await app.fetch(new Request("http://localhost/profiles/active", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile }),
  }))
  expect(res.status).toBe(200)
}

/** The same conversation: a turn on `work`, two on `backup`, then back to `work`. */
async function awayAndBack(app: TestApp, session: string | null): Promise<{ moved: SeenQuery; stayed: SeenQuery; back: SeenQuery }> {
  await setActive(app, "work")
  const history: Message[] = [{ role: "user", content: "FIRST-QUESTION" }]
  await turn(app, session, history)
  expect(seen.at(-1)?.dir).toContain("work")

  await setActive(app, "backup")
  history.push({ role: "assistant", content: "WORK-ANSWER-1" }, { role: "user", content: "SECOND-QUESTION" })
  await turn(app, session, history)
  const moved = seen.at(-1)!
  history.push({ role: "assistant", content: "BACKUP-ANSWER-2" }, { role: "user", content: "THIRD-QUESTION" })
  await turn(app, session, history)
  const stayed = seen.at(-1)!
  expect(moved.dir).toContain("backup")
  expect(stayed.dir).toContain("backup")

  // Back. The session `work` holds ends at the first answer.
  await setActive(app, "work")
  history.push({ role: "assistant", content: "BACKUP-ANSWER-3" }, { role: "user", content: "FOURTH-QUESTION" })
  await turn(app, session, history)
  const back = seen.at(-1)!
  expect(back.dir).toContain("work")
  return { moved, stayed, back }
}

const savedEnv: Record<string, string | undefined> = {}
let root = ""

beforeEach(() => {
  seen = []
  root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-return-trip-")))
  resetOAuthUsageCache()
  clearSessionCache()
  resetActiveProfile()
  rateLimitStore.clear()
  __setFetchOAuthUsageOverride(async () => null)
  for (const key of ["MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER"]) savedEnv[key] = process.env[key]
  process.env.MERIDIAN_ROUTING = "active+priority"
  process.env.MERIDIAN_PROFILE_ORDER = "work,backup"
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  __setFetchOAuthUsageOverride(null)
  rateLimitStore.clear()
  resetActiveProfile()
  rmSync(root, { recursive: true, force: true })
})

function createApp(): TestApp {
  const profiles = ["work", "backup"].map(id => ({ id, claudeConfigDir: join(root, id) }))
  return createProxyServer({ port: 0, host: "127.0.0.1", profiles, defaultProfile: "work" }).app
}

describe("a conversation that moves to another account and comes back", () => {
  it("is not resumed from the session it left there without the turns it took elsewhere", async () => {
    // No transcript to carry: the history is replayed, all of it.
    const { stayed, back } = await awayAndBack(createApp(), "rt-replay")
    // Where the newest copy is, the conversation still resumes: `work`'s
    // older copy says nothing about `backup`'s.
    expect(stayed.resume).toBeDefined()
    expect(stayed.prompt).not.toContain("<conversation_history>")
    const resumedStale = back.resume !== undefined && !back.prompt.includes("BACKUP-ANSWER-2")
    expect({ resumedStale, prompt: back.prompt }).toEqual({ resumedStale: false, prompt: expect.stringContaining("FOURTH-QUESTION") })
    expect(back.prompt).toContain("BACKUP-ANSWER-2")
    expect(back.prompt).toContain("BACKUP-ANSWER-3")
  })

  it("resumes the stale copy it left there when no other account's copy is on record", async () => {
    // Control: the same trip with `backup`'s newer mapping explicitly
    // evicted before the way back. Nothing says the conversation went on elsewhere, so `work`
    // resumes the session it left, and the turns taken on `backup` reach
    // it as a delta of the user's side only. This is what the guard above
    // prevents while the copy elsewhere is still present and readable.
    // Pruning and expiry differ: they drop the older copy here first, so
    // the way back replays instead.
    const app = createApp()
    await setActive(app, "work")
    const history: Message[] = [{ role: "user", content: "FIRST-QUESTION" }]
    await turn(app, "rt-control", history)
    const workSession = seen.at(-1)!.target
    await setActive(app, "backup")
    history.push({ role: "assistant", content: "WORK-ANSWER-1" }, { role: "user", content: "SECOND-QUESTION" })
    await turn(app, "rt-control", history)
    history.push({ role: "assistant", content: "BACKUP-ANSWER-2" }, { role: "user", content: "THIRD-QUESTION" })
    await turn(app, "rt-control", history)
    expect(evictSharedSession("backup:rt-control")).toBe(true)
    await setActive(app, "work")
    history.push({ role: "assistant", content: "BACKUP-ANSWER-3" }, { role: "user", content: "FOURTH-QUESTION" })
    await turn(app, "rt-control", history)
    const back = seen.at(-1)!
    expect(back.dir).toContain("work")
    expect(back.resume).toBe(workSession)
    expect(back.prompt).toContain("FOURTH-QUESTION")
    expect(back.prompt).not.toContain("BACKUP-ANSWER-2")
    expect(back.prompt).not.toContain("BACKUP-ANSWER-3")
  })

  // A client that sends no session key is keyed by its conversation's
  // fingerprint, which is kept per account just the same.
  it("is not resumed from the session it left there when it is keyed by its fingerprint", async () => {
    const { back } = await awayAndBack(createApp(), null)
    const resumedStale = back.resume !== undefined && !back.prompt.includes("BACKUP-ANSWER-2")
    expect({ resumedStale, prompt: back.prompt }).toEqual({ resumedStale: false, prompt: expect.stringContaining("FOURTH-QUESTION") })
    expect(back.prompt).toContain("BACKUP-ANSWER-3")
  })

  it("resumes its own session when the user rewinds, after a move and back, to a point it holds", async () => {
    const app = createApp()
    await setActive(app, "work")
    await turn(app, "rt-rewind", [{ role: "user", content: "FIRST-QUESTION" }])
    const workSession = seen.at(-1)!.target
    await setActive(app, "backup")
    await turn(app, "rt-rewind", [
      { role: "user", content: "FIRST-QUESTION" }, { role: "assistant", content: "WORK-ANSWER-1" },
      { role: "user", content: "SECOND-QUESTION" },
    ])
    await turn(app, "rt-rewind", [
      { role: "user", content: "FIRST-QUESTION" }, { role: "assistant", content: "WORK-ANSWER-1" },
      { role: "user", content: "SECOND-QUESTION" }, { role: "assistant", content: "BACKUP-ANSWER-2" },
      { role: "user", content: "THIRD-QUESTION" },
    ])
    // Back on `work`, the user edits the second question. What is left of
    // the history before it was all written on `work`, and `backup`'s
    // copy, gone further, holds no more of it.
    await setActive(app, "work")
    await turn(app, "rt-rewind", [
      { role: "user", content: "FIRST-QUESTION" }, { role: "assistant", content: "WORK-ANSWER-1" },
      { role: "user", content: "SECOND-QUESTION-EDITED" },
    ])
    const back = seen.at(-1)!
    expect(back.dir).toContain("work")
    expect({ resume: back.resume, replayed: back.prompt.includes("<conversation_history>") }).toEqual({ resume: workSession, replayed: false })
    expect(back.prompt).toContain("SECOND-QUESTION-EDITED")
  })
})
