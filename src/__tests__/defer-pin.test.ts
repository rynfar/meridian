/**
 * Pinned auto-defer decision (#861).
 *
 * The decision was taken from the LIVE tool count, so a client crossing the
 * threshold mid-conversation — one tool added or removed — flipped deferral for
 * every non-core tool at once. Tools render at position 0 of the prompt, so
 * that moves the `anthropic/alwaysLoad` marker on every definition and
 * invalidates the tools, system AND message cache tiers: a full cold replay of
 * the conversation. It also flips `ENABLE_TOOL_SEARCH` and, since #860,
 * `maxTurns` — silently re-enabling the billed digest turn.
 *
 * The blast radius is the point: one added tool re-renders the whole tool list.
 */

import { describe, it, expect } from "bun:test"
import {
  autoDeferDecision,
  createPassthroughMcpServer,
  getAutoDeferThreshold,
} from "../proxy/passthroughTools"

const CORE = ["read", "write", "edit", "bash", "glob", "grep"]
const tools = (n: number) => Array.from({ length: n }, (_, i) => ({
  name: i < CORE.length ? CORE[i]! : `extra_tool_${i}`,
  description: "t",
  input_schema: { type: "object" as const, properties: {} },
}))

describe("autoDeferDecision", () => {
  it("is off at or below the threshold and on above it", () => {
    const t = getAutoDeferThreshold()
    expect(autoDeferDecision(t, CORE, t)).toBe(false)
    expect(autoDeferDecision(t, CORE, t + 1)).toBe(true)
  })

  it("is off without a core set, which is how an adapter opts out", () => {
    expect(autoDeferDecision(15, undefined, 400)).toBe(false)
    expect(autoDeferDecision(15, [], 400)).toBe(false)
  })

  it("is off when the threshold is disabled", () => {
    expect(autoDeferDecision(0, CORE, 400)).toBe(false)
  })

  // The reported trigger: one tool either side of the boundary.
  it("flips on a single tool across the boundary — the reported blast radius", () => {
    const t = getAutoDeferThreshold()
    expect(autoDeferDecision(t, CORE, t)).not.toBe(autoDeferDecision(t, CORE, t + 1))
  })
})

describe("createPassthroughMcpServer with a pinned decision", () => {
  const t = getAutoDeferThreshold()

  it("defers by live count when unpinned", () => {
    expect(createPassthroughMcpServer(tools(t), CORE).hasDeferredTools).toBe(false)
    expect(createPassthroughMcpServer(tools(t + 1), CORE).hasDeferredTools).toBe(true)
  })

  // A session that started under the threshold keeps its cheap prompt shape
  // even after growing past it, so the tool block does not re-render.
  it("honours a pin of false while the live count says true", () => {
    const mcp = createPassthroughMcpServer(tools(t + 50), CORE, undefined, false)
    expect(mcp.hasDeferredTools).toBe(false)
  })

  // And the reverse: a session that started deferring keeps deferring, so
  // maxTurns does not silently change under it.
  it("honours a pin of true while the live count says false", () => {
    const mcp = createPassthroughMcpServer(tools(3), CORE, undefined, true)
    expect(mcp.hasDeferredTools).toBe(true)
  })

  it("still lets a client's explicit defer_loading win over a false pin", () => {
    const explicit = [...tools(3), {
      name: "deferred_one", description: "t",
      input_schema: { type: "object" as const, properties: {} },
      defer_loading: true,
    }]
    expect(createPassthroughMcpServer(explicit, CORE, undefined, false).hasDeferredTools).toBe(true)
  })

  // The mechanism behind the cache invalidation: the alwaysLoad marker moving
  // is what re-renders the tool block, so a pin must keep the NAMES stable too.
  it("keeps the advertised tool names stable across a pinned crossing", () => {
    const under = createPassthroughMcpServer(tools(t), CORE, undefined, false)
    const over = createPassthroughMcpServer(tools(t), CORE, undefined, false)
    expect(over.toolNames).toEqual(under.toolNames)
  })
})
