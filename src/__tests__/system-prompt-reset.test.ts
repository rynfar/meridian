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
const events: Array<{ event: string; data: unknown }> = []
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
}), "system-prompt-reset.test.ts")
installLoggerMock(() => ({
  claudeLog: (event: string, data: unknown) => { events.push({ event, data }) },
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { lookupSharedSession } = await import("../proxy/sessionStore")

beforeEach(async () => { await clearSessionCache(); captured.length = 0; events.length = 0 })

const system = (canary: string) => `You are OpenCode.\nInstructions from: /work/AGENTS.md\nCanary token: ${canary}.`

for (const stream of [false, true]) describe(`system prompt reset (stream=${stream})`, () => {
  const conversation = () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    const messages: Array<{ role: string; content: string }> = [{ role: "user", content: "OWNED_HISTORY_RESET" }]
    const post = async (systemText: string, headers: Record<string, string> = {}) => {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session, ...headers },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 128, stream, system: systemText, messages }),
      }))
      expect(response.status).toBe(200)
      await response.text()
      messages.push({ role: "assistant", content: "acknowledged" }, { role: "user", content: `Continue ${messages.length}.` })
      return captured.at(-1)!
    }
    const arm = async () => {
      const response = await app.fetch(new Request(`http://localhost/v1/sessions/${session}/system-prompt-reset`, { method: "POST" }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ session, pending: true })
    }
    return { session, post, arm }
  }

  const expectReplayed = (call: { options: Options; prompt: string }, canary: string) => {
    expect(call.options.resume).toBeUndefined()
    expect(call.prompt).toContain("OWNED_HISTORY_RESET")
    expect(JSON.stringify(call.options.systemPrompt)).toContain(canary)
  }

  it("replays into a fresh session when the request carries the reset header, then resumes", async () => {
    const { session, post } = conversation()
    await post(system("ALPHA-7731"))
    const first = lookupSharedSession(session)!.claudeSessionId
    expect((await post(system("BETA-4419"))).options.resume).toBe(first)
    const reset = await post(system("BETA-4419"), { "x-meridian-system-prompt-reset": "1" })
    expectReplayed(reset, "BETA-4419")
    expect(lookupSharedSession(session)!.claudeSessionId).not.toBe(first)
    const replayed = lookupSharedSession(session)!.claudeSessionId
    const next = await post(system("BETA-4419"))
    expect(next.options.resume).toBe(replayed)
    expect(next.prompt).not.toContain("OWNED_HISTORY_RESET")
  })

  it("replays the next turn once after the endpoint arms a reset", async () => {
    const { post, arm } = conversation()
    await post(system("ALPHA-7731"))
    await arm()
    expectReplayed(await post(system("BETA-4419")), "BETA-4419")
    expect((await post(system("BETA-4419"))).options.resume).toBeDefined()
  })

  it("keeps an armed reset for a conversation with no stored session until a turn publishes", async () => {
    const { post, arm } = conversation()
    await arm()
    const fresh = await post(system("ALPHA-7731"))
    expect(fresh.options.resume).toBeUndefined()
    expect((await post(system("ALPHA-7731"))).options.resume).toBeDefined()
  })

  it("ignores a false header value", async () => {
    const { post } = conversation()
    await post(system("ALPHA-7731"))
    expect((await post(system("BETA-4419"), { "x-meridian-system-prompt-reset": "0" })).options.resume).toBeDefined()
  })
})
