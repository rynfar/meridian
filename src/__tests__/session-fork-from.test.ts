import { beforeEach, describe, expect, it } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"
import { assistantMessage, withMockSdkSessionId } from "./helpers"

interface CapturedQuery {
  prompt: string | AsyncIterable<unknown>
  options: Options
}
const captured: Array<{ options: Options; prompt: string }> = []
installSdkMock(() => ({
  query: (params: CapturedQuery) => (async function* () {
    let prompt = ""
    if (typeof params.prompt === "string") prompt = params.prompt
    else for await (const message of params.prompt) prompt += JSON.stringify(message)
    captured.push({ options: params.options, prompt })
    yield withMockSdkSessionId(assistantMessage([{ type: "text", text: "acknowledged" }]), params.options)
  })(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: { tool: () => {}, registerTool: () => ({}) } }),
  tool: () => ({}),
}), "session-fork-from.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { lookupSharedSession } = await import("../proxy/sessionStore")

beforeEach(async () => { await clearSessionCache(); captured.length = 0 })

type Message = { role: string; content: string }

describe("x-meridian-fork-from", () => {
  const post = async (
    app: { fetch: (request: Request) => Response | Promise<Response> },
    session: string,
    messages: Message[],
    forkFrom?: string,
  ) => {
    const response = await app.fetch(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-session-affinity": session,
        ...(forkFrom ? { "x-meridian-fork-from": forkFrom } : {}),
      },
      body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 128, stream: false, messages }),
    }))
    expect(response.status).toBe(200)
    await response.text()
    return captured.at(-1)!
  }

  it("starts a new conversation from the source session without replaying it", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const parent = crypto.randomUUID()
    const history: Message[] = [{ role: "user", content: "SHARED_HISTORY_FORK" }]
    await post(app, parent, history)
    const source = lookupSharedSession(parent)!

    const lane = crypto.randomUUID()
    const laneCall = await post(app, lane, [...history,
      { role: "assistant", content: "acknowledged" }, { role: "user", content: "Lane brief." }], parent)

    expect(laneCall.options.resume).toBe(source.claudeSessionId)
    expect(laneCall.prompt).not.toContain("SHARED_HISTORY_FORK")
    expect(laneCall.prompt).toContain("Lane brief.")
    const laneMapping = lookupSharedSession(lane)!
    expect(laneMapping.claudeSessionId).not.toBe(source.claudeSessionId)
    expect(lookupSharedSession(parent)!.claudeSessionId).toBe(source.claudeSessionId)

    // The source conversation still resumes its own session afterwards.
    const parentCall = await post(app, parent, [...history,
      { role: "assistant", content: "acknowledged" }, { role: "user", content: "Parent continues." }])
    expect(parentCall.options.resume).toBe(source.claudeSessionId)
    expect(parentCall.prompt).not.toContain("SHARED_HISTORY_FORK")
  })

  it("forks at the shared turn when the source has already moved on", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const parent = crypto.randomUUID()
    const history: Message[] = [{ role: "user", content: "SHARED_HISTORY_MOVED" }]
    await post(app, parent, history)
    const shared = [...history, { role: "assistant", content: "acknowledged" }]
    await post(app, parent, [...shared, { role: "user", content: "Parent went on." }])
    const advanced = lookupSharedSession(parent)!

    const lane = crypto.randomUUID()
    const laneCall = await post(app, lane, [...shared, { role: "user", content: "Lane brief." }], parent)

    expect(laneCall.options.resume).toBe(advanced.claudeSessionId)
    expect(laneCall.options.resumeSessionAt).toBeDefined()
    expect(laneCall.prompt).not.toContain("SHARED_HISTORY_MOVED")
    expect(lookupSharedSession(parent)!.claudeSessionId).toBe(advanced.claudeSessionId)
  })

  it("replays as before when the source is unknown or the key already has a session", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const history: Message[] = [{ role: "user", content: "UNSEEDED_HISTORY" }]
    const lane = crypto.randomUUID()
    const fresh = await post(app, lane, history, crypto.randomUUID())
    expect(fresh.options.resume).toBeUndefined()

    const parent = crypto.randomUUID()
    await post(app, parent, [{ role: "user", content: "OTHER_SOURCE" }])
    const own = lookupSharedSession(lane)!
    const next = await post(app, lane, [...history,
      { role: "assistant", content: "acknowledged" }, { role: "user", content: "Next." }], parent)
    expect(next.options.resume).toBe(own.claudeSessionId)
  })
})

describe("/v1/responses session key", () => {
  it("keys a turn by the client's session header, not its shared prompt_cache_key", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const sharedCacheKey = crypto.randomUUID()
    const sessions = [crypto.randomUUID(), crypto.randomUUID()]
    for (const session of sessions) {
      const response = await app.fetch(new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-affinity": session },
        body: JSON.stringify({ model: "claude-haiku-5-5", prompt_cache_key: sharedCacheKey, input: `Turn for ${session}` }),
      }))
      expect(response.status).toBe(200)
      await response.text()
    }
    expect(lookupSharedSession(sharedCacheKey)).toBeUndefined()
    const [first, second] = sessions.map(session => lookupSharedSession(session))
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(first!.claudeSessionId).not.toBe(second!.claudeSessionId)
  })
})
