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
import { detectAdapter } from "../proxy/adapters/detect"
import { openAiAdapter } from "../proxy/adapters/openai"
import { openCodeAdapter } from "../proxy/adapters/opencode"

function makeContext(extraHeaders: Record<string, string> = {}): any {
  const allHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(extraHeaders)) allHeaders[k.toLowerCase()] = v
  return {
    req: {
      header: (name?: string) => (name ? allHeaders[name.toLowerCase()] : { ...allHeaders }),
    },
  }
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
})
