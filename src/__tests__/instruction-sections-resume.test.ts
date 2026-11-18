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
}), "instruction-sections-resume.test.ts")
installLoggerMock(() => ({
  claudeLog: (event: string, data: unknown) => { events.push({ event, data }) },
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { lookupSharedSession, storeSharedSession } = await import("../proxy/sessionStore")
const { openCodeInstructionSections } = await import("../proxy/adapters/opencodeInstructionSections")
const { instructionSectionState } = await import("../proxy/session/instructionSections")

beforeEach(async () => { await clearSessionCache(); captured.length = 0; events.length = 0 })

const system = (canary: string, tree = "10 files") => [
  "You are OpenCode.",
  `<env>\n  Working directory: /work\n  File tree: ${tree}\n</env>`,
  `Instructions from: /work/AGENTS.md\nCanary token: ${canary}.`,
  "Skills provide specialized instructions and workflows for specific tasks.\n- skill-a",
].join("\n")
const stateOf = (canary: string) => instructionSectionState(openCodeInstructionSections(system(canary)))

for (const stream of [false, true]) describe(`OpenCode instruction sections (stream=${stream})`, () => {
  const conversation = () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    const messages: Array<{ role: string; content: string }> = [{ role: "user", content: "OWNED_HISTORY_SECTIONS" }]
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
    return { session, post, messages }
  }

  it("publishes the rendered sections for a fresh session and ignores dynamic prompt parts on resume", async () => {
    const { session, post } = conversation()
    await post(system("ALPHA-7731"))
    expect(lookupSharedSession(session)!.instructionSections).toEqual(stateOf("ALPHA-7731"))
    const resumed = await post(system("ALPHA-7731", "15 files"))
    expect(resumed.options.resume).toBeDefined()
    expect(lookupSharedSession(session)!.instructionSections).toEqual(stateOf("ALPHA-7731"))
    expect(events.some(entry => entry.event === "session.instruction_sections_changed")).toBe(false)
  })

  it("detects an edited instruction file on resume", async () => {
    const { post } = conversation()
    await post(system("ALPHA-7731"))
    const resumed = await post(system("BETA-4419"))
    expect(resumed.options.resume).toBeDefined()
    expect(events.find(entry => entry.event === "session.instruction_sections_changed")?.data)
      .toEqual({ changed: 1, removed: 0 })
  })

  it("adopts the current sections as the baseline of a mapping published without them", async () => {
    const { session, post } = conversation()
    await post(system("ALPHA-7731"))
    const stored = lookupSharedSession(session)!
    // An old writer published no section state.
    await storeSharedSession(session, stored.claudeSessionId, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null)
    const resumed = await post(system("BETA-4419"))
    expect(resumed.options.resume).toBeDefined()
    expect(lookupSharedSession(session)!.instructionSections).toEqual(stateOf("BETA-4419"))
  })
})
