/**
 * Transcript retention, through the HTTP path and the mocked SDK.
 *
 * Two things are pinned here. Every SDK child is handed the retention period
 * in its flag settings, resolved per request, so a saved change reaches the
 * next request without a restart. And a conversation whose transcript the
 * retention sweep has already deleted still gets its answer: the resume is
 * refused, and Meridian replays the history into a fresh session instead of
 * failing the request.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir } from "../proxy/sessionStore"
import { setSetting } from "../settings"
import { messageStart, textBlockStart, textDelta, blockStop, messageDelta, messageStop, resolveMockSdkSessionId } from "./helpers"

// Linear backoff is real time; the retry path is what is under test, not the wait.
process.env.MERIDIAN_BUSY_RETRY_DELAY_MS = "5"

interface RecordedCall {
  options: Record<string, unknown>
  prompt: string
}

let queryCalls: RecordedCall[] = []
/** Resuming this SDK session fails the way the CLI does once its transcript is gone. */
let sweptSessionId: string | undefined

async function promptText(prompt: unknown): Promise<string> {
  if (typeof prompt === "string") return prompt
  if (prompt !== null && typeof prompt === "object" && Symbol.asyncIterator in prompt) {
    const parts: string[] = []
    for await (const message of prompt as AsyncIterable<unknown>) parts.push(JSON.stringify(message))
    return parts.join("\n")
  }
  return ""
}

installSdkMock(() => ({
  query: (args: { prompt: unknown; options?: Record<string, unknown> }) => {
    const callIndex = queryCalls.length + 1
    const options = args.options ?? {}
    const returnedSessionId = resolveMockSdkSessionId(options, "sdk-fresh")
    const withSessionId = <T extends object>(message: T) => ({ ...message, session_id: returnedSessionId })
    return (async function* () {
      queryCalls.push({ options, prompt: await promptText(args.prompt) })
      if (sweptSessionId !== undefined && options.resume === sweptSessionId) {
        // Claude Code 2.1.284, asked to resume a session whose transcript was
        // deleted, ends with an error result carrying exactly this text.
        throw new Error(`Claude Code returned an error result: No conversation found with session ID: ${sweptSessionId}`)
      }
      if (options.includePartialMessages === true) {
        yield withSessionId(messageStart(`msg-${callIndex}`))
        yield withSessionId(textBlockStart(0))
        yield withSessionId(textDelta(0, `response-${callIndex}`))
        yield withSessionId(blockStop(0))
        yield withSessionId(messageDelta("end_turn"))
        yield withSessionId(messageStop())
      }
      yield withSessionId({
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
      })
    })()
  },
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "proxy-transcript-retention.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

installMcpToolsMock(() => ({
  createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: { tool: () => {}, registerTool: () => ({}) } }),
}))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { storeSession, getSessionByClaudeId } = await import("../proxy/session/cache")

function post(app: { fetch: (request: Request) => Response | Promise<Response> }, body: unknown, sessionId: string) {
  return app.fetch(new Request("http://localhost/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": sessionId },
    body: JSON.stringify(body),
  }))
}

function flagSettings(call: RecordedCall | undefined): Record<string, unknown> {
  const settings = call?.options.settings
  if (settings === null || typeof settings !== "object") throw new Error("expected inline flag settings")
  return { ...settings }
}

const ENV_KEYS = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_TRANSCRIPT_RETENTION_DAYS", "CLAUDE_CONFIG_DIR"]

describe("transcript retention through the proxy", () => {
  let dir: string
  let claudeConfigDir: string
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-proxy-transcript-retention-"))
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = join(dir, "meridian")
    // The SDK child's config root, where its own settings.json would live.
    claudeConfigDir = join(dir, "claude-config")
    mkdirSync(claudeConfigDir, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir
    setSessionStoreDir(join(dir, "sessions"))
    clearSessionCache()
    queryCalls = []
    sweptSessionId = undefined
  })

  afterEach(async () => {
    // Request completion releases the cross-process lease asynchronously.
    await Bun.sleep(25)
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const createApp = () => createProxyServer({ port: 0, host: "127.0.0.1" }).app

  it("hands a new conversation's SDK child the default 30-day period, with no settings source enabled", async () => {
    const app = createApp()
    for (const stream of [false, true]) {
      queryCalls = []
      const response = await post(app, { model: "sonnet", stream, messages: [{ role: "user", content: "hello" }] }, `sess-default-${stream}`)
      expect(response.status).toBe(200)
      await response.text()
      expect(flagSettings(queryCalls[0]).cleanupPeriodDays).toBe(30)
      expect(queryCalls[0]?.options.settingSources).toEqual([])
    }
  })

  it("applies a saved change to the next request, and passes no period at all when it is off", async () => {
    const app = createApp()
    setSetting("transcriptRetentionDays", 5)
    await (await post(app, { model: "sonnet", stream: false, messages: [{ role: "user", content: "one" }] }, "sess-five")).text()
    expect(flagSettings(queryCalls.at(-1)).cleanupPeriodDays).toBe(5)

    setSetting("transcriptRetentionDays", 0)
    await (await post(app, { model: "sonnet", stream: false, messages: [{ role: "user", content: "two" }] }, "sess-off")).text()
    expect(flagSettings(queryCalls.at(-1))).not.toHaveProperty("cleanupPeriodDays")
  })

  it("keeps the period named by the child's own config root", async () => {
    writeFileSync(join(claudeConfigDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 120 }))
    const app = createApp()
    await (await post(app, { model: "sonnet", stream: false, messages: [{ role: "user", content: "hi" }] }, "sess-own")).text()
    expect(flagSettings(queryCalls[0]).cleanupPeriodDays).toBe(120)
  })

  describe("a conversation whose transcript the sweep already deleted", () => {
    const priorMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "remember the codeword PELICAN" },
      { role: "assistant", content: "noted" },
    ]
    const continuation = [...priorMessages, { role: "user", content: "what was the codeword?" }]

    for (const stream of [false, true]) {
      it(`answers from a fresh session that replays the history (${stream ? "streaming" : "non-streaming"})`, async () => {
        const app = createApp()
        const sessionId = `sess-swept-${stream}`
        sweptSessionId = `sdk-swept-${stream}`
        storeSession(sessionId, priorMessages, sweptSessionId, "/tmp/test")

        const response = await post(app, { model: "sonnet", stream, messages: continuation }, sessionId)
        expect(response.status).toBe(200)
        const body = await response.text()
        expect(body).toContain(`response-${queryCalls.length}`)

        // The resume was tried, refused every time, and never retried past
        // its budget; the answer came from one fresh query.
        expect(queryCalls[0]?.options.resume).toBe(sweptSessionId)
        expect(queryCalls.filter((call) => call.options.resume === sweptSessionId)).toHaveLength(4)
        expect(queryCalls).toHaveLength(5)
        const fresh = queryCalls[4]
        expect(fresh?.options.resume).toBeUndefined()
        expect(fresh?.prompt).toContain("PELICAN")
        expect(fresh?.prompt).toContain("what was the codeword?")
        expect(flagSettings(fresh).cleanupPeriodDays).toBe(30)

        // The swept session is no longer mapped, so the next turn resumes the
        // replacement instead of paying for the refused resume again.
        expect(getSessionByClaudeId(sweptSessionId)).toBeUndefined()
        const replacement = fresh?.options.sessionId
        expect(typeof replacement).toBe("string")
        expect(getSessionByClaudeId(String(replacement))).toBeDefined()
      })
    }
  })
})
