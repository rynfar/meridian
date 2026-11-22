/**
 * Client-owned tool search: a client that defers tools and also sends a loaded
 * `ToolSearch` tool gets the only search path. Meridian keeps that client's
 * eager tools registered, registers a deferred tool eagerly once the
 * conversation references it, leaves unreferenced deferred tools unregistered,
 * and adds no inner ToolSearch of its own.
 */

import { describe, it, expect } from "bun:test"
import {
  clientOwnsToolSearch,
  referencedToolNames,
  clientSearchRegistrationTools,
} from "../proxy/passthroughTools"

const tool = (name: string, extra: { defer_loading?: boolean } = {}) => ({
  name,
  description: "t",
  input_schema: { type: "object" as const, properties: {} },
  ...extra,
})

describe("clientOwnsToolSearch", () => {
  it("is true when a deferred tool coexists with a loaded ToolSearch tool", () => {
    expect(clientOwnsToolSearch([
      tool("ToolSearch"),
      tool("DeferredToolPlaceholder", { defer_loading: true }),
    ])).toBe(true)
  })

  it("is false without a deferred tool or without a loaded ToolSearch tool", () => {
    expect(clientOwnsToolSearch([tool("read")])).toBe(false)
    expect(clientOwnsToolSearch([tool("read"), tool("deferred_one", { defer_loading: true })])).toBe(false)
  })

  it("is false when ToolSearch itself is the deferred tool", () => {
    expect(clientOwnsToolSearch([
      tool("read"),
      tool("ToolSearch", { defer_loading: true }),
      tool("DeferredToolPlaceholder", { defer_loading: true }),
    ])).toBe(false)
  })
})

describe("referencedToolNames", () => {
  it("collects tool_reference names from user tool results", () => {
    const messages = [
      { role: "assistant", content: [{ type: "tool_use", id: "a", name: "ToolSearch", input: {} }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: [
          { type: "tool_reference", tool_name: "mcp__graph__graph_update" },
          { type: "tool_reference", tool_name: "mcp__graph__graph_read" },
          { type: "text", text: "loaded" },
        ] },
        { type: "text", text: "go on" },
      ] },
    ]
    expect(referencedToolNames(messages)).toEqual(new Set(["mcp__graph__graph_update", "mcp__graph__graph_read"]))
  })

  it("ignores malformed input of every shape", () => {
    const malformed: unknown[] = [
      undefined, null, "nope", 42,
      [],
      [null],
      ["str"],
      [{ role: "user" }],
      [{ role: "user", content: "string content" }],
      [{ role: "assistant", content: [{ type: "tool_result", content: [{ type: "tool_reference", tool_name: "x" }] }] }],
      [{ role: "user", content: [{ type: "tool_result", content: "string content" }] }],
      [{ role: "user", content: [{ type: "tool_result", content: [null, 7, { type: "tool_reference" }] }] }],
    ]
    for (const messages of malformed) {
      expect(referencedToolNames(messages)).toEqual(new Set())
    }
  })
})

describe("clientSearchRegistrationTools", () => {
  it("registers referenced deferred tools eagerly and drops the never-referenced", () => {
    const tools = [
      tool("read"),
      tool("ToolSearch"),
      tool("DeferredToolPlaceholder", { defer_loading: true }),
      tool("mcp__graph__graph_update", { defer_loading: true }),
    ]
    const registered = clientSearchRegistrationTools(tools, new Set(["mcp__graph__graph_update"]))
    expect(registered.map(entry => entry.name)).toEqual(["read", "ToolSearch", "mcp__graph__graph_update"])
    expect("defer_loading" in registered[2]!).toBe(false)
  })

  it("never mutates its inputs", () => {
    const placeholder = tool("DeferredToolPlaceholder", { defer_loading: true })
    const referenced = tool("graph_update", { defer_loading: true })
    const tools = [placeholder, referenced]
    const before = JSON.stringify(tools)
    const registered = clientSearchRegistrationTools(tools, new Set(["graph_update"]))
    expect(JSON.stringify(tools)).toBe(before)
    expect(referenced.defer_loading).toBe(true)
    expect(registered.map(entry => entry.name)).toEqual(["graph_update"])
    expect(registered[0]!.defer_loading).toBeUndefined()
  })
})
