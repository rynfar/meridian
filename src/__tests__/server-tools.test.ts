/**
 * Unit tests for native Anthropic server-tool detection — pure functions, no mocks.
 *
 * Meridian bridges to Claude Max via the Agent SDK, which cannot execute
 * Anthropic's native *server* tools (`web_search_*`, `web_fetch_*`). Those are
 * a raw Messages-API feature (API-key billed) that produce `server_tool_use` /
 * `web_search_tool_result` blocks the SDK never emits. When a client (e.g. the
 * opencode-websearch plugin, #488; Cherry Studio, #481) points such a request
 * at Meridian, we detect it up front and fail fast with an actionable error
 * instead of silently bouncing an unrunnable tool back to the agent.
 */
import { describe, it, expect } from "bun:test"
import { detectServerTools, serverToolErrorMessage } from "../proxy/tools"

describe("detectServerTools", () => {
  it("returns [] when tools is missing or not an array", () => {
    expect(detectServerTools(undefined)).toEqual([])
    expect(detectServerTools(null)).toEqual([])
    expect(detectServerTools("web_search" as unknown)).toEqual([])
  })

  it("returns [] for ordinary custom/passthrough tools (name + input_schema, no server type)", () => {
    const tools = [
      { name: "read", description: "read a file", input_schema: { type: "object" } },
      { name: "web-search", description: "opencode custom tool", input_schema: { type: "object", properties: { query: { type: "string" } } } },
      { name: "bash", input_schema: {} },
    ]
    expect(detectServerTools(tools)).toEqual([])
  })

  it("detects the native web_search server tool", () => {
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }]
    expect(detectServerTools(tools)).toEqual(["web_search_20250305"])
  })

  it("detects the native web_fetch server tool", () => {
    const tools = [{ type: "web_fetch_20250910", name: "web_fetch" }]
    expect(detectServerTools(tools)).toEqual(["web_fetch_20250910"])
  })

  it("detects newer date-suffixed variants (matches the family, not one exact date)", () => {
    const tools = [{ type: "web_search_20260209", name: "web_search" }]
    expect(detectServerTools(tools)).toEqual(["web_search_20260209"])
  })

  it("collects every offending type when several are present, deduped and in order", () => {
    const tools = [
      { name: "read", input_schema: {} },
      { type: "web_search_20250305", name: "web_search" },
      { type: "web_fetch_20250910", name: "web_fetch" },
      { type: "web_search_20250305", name: "web_search" },
    ]
    expect(detectServerTools(tools)).toEqual(["web_search_20250305", "web_fetch_20250910"])
  })

  it("ignores a non-server 'type' such as the explicit custom-tool marker", () => {
    const tools = [{ type: "custom", name: "web-search", input_schema: { type: "object" } }]
    expect(detectServerTools(tools)).toEqual([])
  })
})

describe("serverToolErrorMessage", () => {
  it("names the offending tool types", () => {
    const msg = serverToolErrorMessage(["web_search_20250305"])
    expect(msg).toContain("web_search_20250305")
  })

  it("explains that server tools need the real Anthropic API, not the Max/SDK path", () => {
    const msg = serverToolErrorMessage(["web_search_20250305"])
    expect(msg.toLowerCase()).toContain("api.anthropic.com")
    expect(msg).toContain("ANTHROPIC_API_KEY")
  })
})
