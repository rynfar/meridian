/**
 * What an open Claude Code conversation goes through once the proxy reads the
 * client's working directory from the messages.
 *
 * Before, a client that sends its environment among the messages ran its SDK
 * child in the proxy's own directory, so its session was filed there. Now the
 * child runs in the client's directory (when it exists on the proxy host), and
 * the SDK looks the session up under that directory, where it is not.
 *
 * A mapping that records where its transcript lives is replayed at once,
 * without a resume the CLI would refuse. One from before transcript locations
 * were recorded is resumed, refused on every retry, and then replayed. Either
 * way it happens once: the replayed session is filed under the new directory.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir } from "../proxy/sessionStore"
import { resolveMockSdkSessionId } from "./helpers"

// Linear backoff is real time; the retry path is what is under test, not the wait.
process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = "5"

/** Where the old proxy filed the session: its own directory. */
const PROXY_DIR = realpathSync(process.cwd())

let queryCalls: Array<Record<string, any>> = []
let queryParams: any[] = []
/** The directory each SDK session was created in, as the CLI files it. */
let filedUnder = new Map<string, string>()

installSdkMock(() => ({
  query: (opts: any) => {
    const options = opts.options || {}
    queryCalls.push(options)
    queryParams.push(opts)
    const callIndex = queryCalls.length
    return (async function* () {
      // The CLI finds a session only under the directory it was created in.
      if (options.resume && filedUnder.get(options.resume) !== options.cwd) {
        throw new Error(`No conversation found with session ID: ${options.resume}`)
      }
      if (!options.resume && typeof options.sessionId === "string") filedUnder.set(options.sessionId, options.cwd)
      yield {
        type: "assistant",
        uuid: `uuid-${callIndex}`,
        message: {
          id: `msg-${callIndex}`,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: `response-${callIndex}` }],
          model: "claude-sonnet-4-5",
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        session_id: resolveMockSdkSessionId(options, "sdk-original"),
      }
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "claude-code-cwd-upgrade.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: any, fn: any) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession } = await import("../proxy/session/cache")

const SESSION_ID = "3f0b6a52-6f0e-4b8e-9d2a-2c5d7c1e8a10"

let isolatedSessionDir = ""
let clientDir = ""
let savedAgent: string | undefined

beforeEach(() => {
  isolatedSessionDir = mkdtempSync(join(tmpdir(), "meridian-http-test-"))
  setSessionStoreDir(isolatedSessionDir)
  clientDir = realpathSync(mkdtempSync(join(tmpdir(), "meridian-client-cwd-")))
  savedAgent = process.env.MERIDIAN_DEFAULT_AGENT
  delete process.env.MERIDIAN_DEFAULT_AGENT
  clearSessionCache()
  queryCalls = []
  queryParams = []
  filedUnder = new Map([["sdk-original", PROXY_DIR]])
})
afterEach(async () => {
  // Request completion releases the cross-process lease asynchronously.
  await Bun.sleep(25)
  rmSync(isolatedSessionDir, { recursive: true, force: true })
  rmSync(clientDir, { recursive: true, force: true })
  if (savedAgent !== undefined) process.env.MERIDIAN_DEFAULT_AGENT = savedAgent
  else delete process.env.MERIDIAN_DEFAULT_AGENT
})

const environmentOf = (cwd: string) =>
  `# Environment\nYou have been invoked in the following environment: \n - Primary working directory: ${cwd}\n - Is a git repository: false\n`

/** A conversation as the client sends it: its environment as a system turn, or none at all. */
function conversation(cwd: string | undefined) {
  const prior = [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    ...(cwd ? [{ role: "system", content: [{ type: "text", text: environmentOf(cwd) }] }] : []),
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
  ]
  return { prior, next: [...prior, { role: "user", content: [{ type: "text", text: "go on" }] }] }
}

async function continueConversation(messages: unknown[]) {
  const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
  const response = await app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "user-agent": "claude-cli/2.1.290 (external, cli)" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
      stream: false,
      system: [{ type: "text", text: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }],
      metadata: { user_id: JSON.stringify({ session_id: SESSION_ID }) },
      messages,
    }),
  }))
  expect(response.status).toBe(200)
  await response.json()
}

const filedUnderProxyDir = {
  sessionId: "sdk-original",
  configDir: join(process.env.HOME!, ".claude"),
  projectDir: PROXY_DIR,
}

describe("an open claude-code conversation filed under the proxy's directory", () => {
  it("still resumes when no directory is read (control)", async () => {
    const { prior, next } = conversation(undefined)
    storeSession(SESSION_ID, prior, "sdk-original", undefined, undefined, undefined, undefined, undefined, filedUnderProxyDir)

    await continueConversation(next)

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]!.cwd).toBe(PROXY_DIR)
    expect(queryCalls[0]!.resume).toBe("sdk-original")
  })

  it("is replayed at once in the client's directory, with no resume attempted", async () => {
    const { prior, next } = conversation(clientDir)
    storeSession(SESSION_ID, prior, "sdk-original", undefined, undefined, undefined, undefined, undefined, filedUnderProxyDir)

    await continueConversation(next)

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]!.cwd).toBe(clientDir)
    expect(queryCalls[0]!.resume).toBeUndefined()
    expect(String(queryParams[0].prompt)).toContain("earlier answer")
  })

  it("from before transcript locations were recorded, is refused on every retry and then replayed", async () => {
    const { prior, next } = conversation(clientDir)
    storeSession(SESSION_ID, prior, "sdk-original")

    await continueConversation(next)

    expect(queryCalls.filter(call => call.resume === "sdk-original")).toHaveLength(4)
    expect(queryCalls).toHaveLength(5)
    expect(queryCalls.every(call => call.cwd === clientDir)).toBe(true)
    expect(queryCalls[4]!.resume).toBeUndefined()
  })

  it("resumes on the turn after the replay", async () => {
    const { prior, next } = conversation(clientDir)
    storeSession(SESSION_ID, prior, "sdk-original", undefined, undefined, undefined, undefined, undefined, filedUnderProxyDir)
    await continueConversation(next)
    const replayedSession = queryCalls[0]!.sessionId
    expect(replayedSession).toBeDefined()

    queryCalls = []
    await continueConversation([
      ...next,
      { role: "assistant", content: [{ type: "text", text: "response-1" }] },
      { role: "user", content: [{ type: "text", text: "and again" }] },
    ])

    expect(queryCalls).toHaveLength(1)
    expect(queryCalls[0]!.cwd).toBe(clientDir)
    expect(queryCalls[0]!.resume).toBe(replayedSession)
  })
})
