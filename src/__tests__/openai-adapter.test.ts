/**
 * Tests for the OpenAI-compatible endpoint adapter.
 *
 * `/v1/chat/completions` serves generic OpenAI chat clients (Open WebUI,
 * LibreChat, curl). These are NOT coding agents, so the inner hop is tagged
 * `x-meridian-agent: openai` to resolve a dedicated adapter whose system-prompt
 * preset defaults OFF — mirroring the `passthrough` precedent (#190). The
 * adapter otherwise behaves exactly like `opencode` (tools, MCP, passthrough).
 */
import { describe, it, expect } from "bun:test"
import { Context } from "hono"
import { detectAdapter } from "../proxy/adapters/detect"
import { openAiAdapter } from "../proxy/adapters/openai"
import { openCodeAdapter } from "../proxy/adapters/opencode"

function makeContext(extraHeaders: Record<string, string> = {}) {
  return new Context(new Request("http://localhost/v1/chat/completions", { headers: extraHeaders }))
}

describe("openAiAdapter", () => {
  it("is named 'openai'", () => {
    expect(openAiAdapter.name).toBe("openai")
  })

  it("is resolved via the x-meridian-agent: openai override", () => {
    const adapter = detectAdapter(makeContext({ "x-meridian-agent": "openai" }))
    expect(adapter).toBe(openAiAdapter)
    expect(adapter.name).toBe("openai")
  })

  it("shares opencode's tool + MCP identity (no tool-execution regression)", () => {
    expect(openAiAdapter.getMcpServerName()).toBe(openCodeAdapter.getMcpServerName())
    expect(openAiAdapter.getCoreToolNames?.()).toEqual(openCodeAdapter.getCoreToolNames?.())
    expect(openAiAdapter.getBlockedBuiltinTools()).toEqual(openCodeAdapter.getBlockedBuiltinTools())
    expect(openAiAdapter.getAllowedMcpTools()).toEqual(openCodeAdapter.getAllowedMcpTools())
  })

  it("reads x-session-affinity and x-opencode-session as session identity", () => {
    expect(openAiAdapter.getSessionId(makeContext({ "x-session-affinity": "affinity-key" })))
      .toBe("affinity-key")
    expect(openAiAdapter.getSessionId(makeContext({ "x-opencode-session": "opencode-key" })))
      .toBe("opencode-key")
    expect(openAiAdapter.getSessionId(makeContext())).toBeUndefined()
  })

  it("reads x-session-id after the OpenCode headers", () => {
    expect(openAiAdapter.getSessionId(makeContext({ "x-session-id": "generic-key" })))
      .toBe("generic-key")
    // OpenCode sends both with one value; its own header and agent scoping win.
    expect(openAiAdapter.getSessionId(makeContext({
      "x-session-affinity": "affinity-key",
      "x-session-id": "generic-key",
    }))).toBe("affinity-key")
    expect(openAiAdapter.getSessionId(makeContext({
      "x-opencode-session": "base-key",
      "x-opencode-agent-mode": "subagent",
      "x-opencode-agent-name": "title",
      "x-session-id": "generic-key",
    }))).toBe("base-key#title")
  })

  it("ignores a blank x-session-id", () => {
    expect(openAiAdapter.getSessionId(makeContext({ "x-session-id": "" }))).toBeUndefined()
    expect(openAiAdapter.getSessionId(makeContext({ "x-session-id": "  " }))).toBeUndefined()
  })

  it("leaves the opencode adapter's identity unchanged", () => {
    expect(openCodeAdapter.getSessionId(makeContext({ "x-session-id": "generic-key" }))).toBeUndefined()
  })
})
