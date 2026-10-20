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
}), "opencode-agent-context-resume.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, clearSessionCache } = await import("../proxy/server")
const { lookupSharedSession, storeSharedSession } = await import("../proxy/sessionStore")
const { storeSession } = await import("../proxy/session/cache")
const { openCodePrimaryAgentContextHash, requiresOpenCodeAgentReplay } = await import("../proxy/adapters/opencodeAgentContext")

beforeEach(() => { clearSessionCache(); captured.length = 0 })

it("compares only explicit primary-agent identity when the client prompt is enabled", () => {
  const digest = openCodePrimaryAgentContextHash("primary", "build")
  expect(digest).toMatch(/^[a-f0-9]{64}$/)
  expect(requiresOpenCodeAgentReplay(digest, digest)).toBe(false)
  expect(requiresOpenCodeAgentReplay(undefined, digest)).toBe(true)
  expect(requiresOpenCodeAgentReplay(digest, undefined)).toBe(false)
  expect(openCodePrimaryAgentContextHash("subagent", "build")).toBeUndefined()
  expect(openCodePrimaryAgentContextHash(undefined, "build")).toBeUndefined()
  expect(openCodePrimaryAgentContextHash("primary", " ")).toBeUndefined()
  expect(openCodePrimaryAgentContextHash("primary", "build", false)).toBeUndefined()
  expect(openCodePrimaryAgentContextHash("primary", "reviewer")).not.toBe(digest)
})

for (const stream of [false, true]) describe(`OpenCode primary-agent changes (stream=${stream})`, () => {
  it("replays all client history under changed agent instructions, then resumes normally", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    const messages = [{ role: "user", content: "Remember OWNED_HISTORY_1404." }]
    const post = async (system: string, agent = "build") => {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session,
          "x-opencode-agent-mode": "primary", "x-opencode-agent-name": agent },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 128, stream, system, messages }),
      }))
      expect(response.status).toBe(200)
      await response.text()
      return captured.at(-1)!
    }
    await post("You are the build agent.")
    const first = lookupSharedSession(session)!
    messages.push({ role: "assistant", content: "acknowledged" }, { role: "user", content: "Now review the remembered work." })
    const switched = await post("You are the reviewer. CANARY-1404.", "reviewer")
    expect(switched.options.resume).toBeUndefined()
    expect(switched.prompt).toContain("OWNED_HISTORY_1404")
    expect(JSON.stringify(switched.options.systemPrompt)).toContain("CANARY-1404")
    const second = lookupSharedSession(session)!
    expect(second.claudeSessionId).not.toBe(first.claudeSessionId)
    expect(second.resumeContextHash).toBe(openCodePrimaryAgentContextHash("primary", "reviewer"))
    messages.push({ role: "assistant", content: "acknowledged" }, { role: "user", content: "Continue the review." })
    const unchanged = await post("You are the reviewer. CANARY-1404.", "reviewer")
    expect(unchanged.options.resume).toBe(second.claudeSessionId)
    expect(unchanged.prompt).not.toContain("OWNED_HISTORY_1404")
    messages.push({ role: "assistant", content: "acknowledged" }, { role: "user", content: "Return to the build role." })
    const returned = await post("You are the build agent.")
    expect(returned.options.resume).toBeUndefined()
    expect(returned.prompt).toContain("OWNED_HISTORY_1404")
    expect(JSON.stringify(returned.options.systemPrompt)).not.toContain("CANARY-1404")
  })

  it("keeps same-agent resume across dynamic file-tree and diagnostic context", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    const messages = [{ role: "user", content: "OWNED_HISTORY_TO_KEEP" }]
    for (const system of ["File tree: 10 files.", "File tree: 15 files; 3 diagnostics."]) {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session,
          "x-opencode-agent-mode": "primary", "x-opencode-agent-name": "build" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 128, stream, system, messages }),
      }))
      expect(response.status).toBe(200); await response.text()
      messages.push({ role: "assistant", content: "acknowledged" }, { role: "user", content: "Continue." })
    }
    expect(captured.at(-1)!.options.resume).toBe(captured.at(-2)!.options.sessionId)
    expect(captured.at(-1)!.prompt).not.toContain("OWNED_HISTORY_TO_KEEP")
  })

  it("replays a pending checkpoint's exact tool call and result after an agent switch", async () => {
    const previous = process.env.MERIDIAN_PASSTHROUGH
    process.env.MERIDIAN_PASSTHROUGH = "1"
    try {
      const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
      const session = crypto.randomUUID()
      const prior = [{ role: "user", content: "OWNED_CHECKPOINT_OBJECTIVE" }]
      storeSession(session, prior, "owned-old-agent-sdk", undefined, [null, "owned-tool-uuid"], undefined,
        "owned-tool-uuid", ["owned-call-1404"], undefined, undefined, undefined, undefined, true,
        openCodePrimaryAgentContextHash("primary", "build"))
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session,
          "x-opencode-agent-mode": "primary", "x-opencode-agent-name": "reviewer" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 128, stream,
          system: "You are the reviewer.", tools: [{ name: "read", input_schema: { type: "object", properties: { path: { type: "string" } } } }],
          messages: [...prior,
            { role: "assistant", content: [{ type: "tool_use", id: "owned-call-1404", name: "read", input: { path: "fixture.txt" } }] },
            { role: "user", content: [{ type: "tool_result", tool_use_id: "owned-call-1404", content: "EXACT_AGENT_SWITCH_RESULT" }] }],
        }),
      }))
      expect(response.status).toBe(200); await response.text()
      const call = captured.at(-1)!
      expect(call.options.resume).toBeUndefined()
      expect(call.options.resumeSessionAt).toBeUndefined()
      expect(call.prompt).toContain("OWNED_CHECKPOINT_OBJECTIVE")
      expect(call.prompt).toContain("owned-call-1404")
      expect(call.prompt).toContain("EXACT_AGENT_SWITCH_RESULT")
    } finally {
      if (previous === undefined) delete process.env.MERIDIAN_PASSTHROUGH
      else process.env.MERIDIAN_PASSTHROUGH = previous
    }
  })

  it("replays a legacy mapping once and resumes after publishing primary-agent proof", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", silent: true })
    const session = crypto.randomUUID()
    const messages = [{ role: "user", content: "OWNED_LEGACY_HISTORY" }]
    for (let turn = 0; turn < 3; turn++) {
      const response = await app.fetch(new Request("http://localhost/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-opencode-session": session,
          "x-opencode-agent-mode": "primary", "x-opencode-agent-name": "build" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 128, stream, system: "", messages }),
      }))
      expect(response.status).toBe(200); await response.text()
      if (turn === 0) {
        const stored = lookupSharedSession(session)!
        // An old writer has no primary-agent proof; force a real durable read.
        storeSharedSession(session, stored.claudeSessionId, undefined, undefined, undefined, undefined,
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, null)
      } else if (turn === 1) {
        expect(captured.at(-1)!.options.resume).toBeUndefined()
        expect(captured.at(-1)!.prompt).toContain("OWNED_LEGACY_HISTORY")
      } else {
        expect(captured.at(-1)!.options.resume).toBe(captured.at(-2)!.options.sessionId)
        expect(captured.at(-1)!.prompt).not.toContain("OWNED_LEGACY_HISTORY")
      }
      messages.push({ role: "assistant", content: "acknowledged" }, { role: "user", content: "Continue." })
    }
  })
})
