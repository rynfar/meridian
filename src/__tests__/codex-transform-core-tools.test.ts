/**
 * The codex transform must switch auto-defer off: it inherits OpenCode's core
 * tool list, which names nothing Codex sends, so a Codex request past the
 * defer threshold deferred every tool (exec_command included) and each
 * tool-calling turn paid the SDK's digest turn on the full context. With no
 * core set the passthrough MCP server never defers and the single-turn cap
 * holds.
 */

import { describe, it, expect } from "bun:test"
import { codexTransforms } from "../proxy/transforms/codex"
import { openCodeTransforms } from "../proxy/transforms/opencode"
import type { RequestContext } from "../proxy/transform"
import { createPassthroughMcpServer } from "../proxy/passthroughTools"

function runCodexPipeline(body: Record<string, unknown>): RequestContext {
  let ctx = { body, adapter: "codex" } as unknown as RequestContext
  for (const t of [...openCodeTransforms, ...codexTransforms]) {
    if ((t.adapters === undefined || t.adapters.includes("codex")) && t.onRequest) ctx = t.onRequest(ctx)
  }
  return ctx
}

describe("codex transform auto-defer", () => {
  it("forces passthrough and leaves no core set so nothing is deferred", () => {
    const tools = Array.from({ length: 40 }, (_, i) => ({ name: i === 0 ? "exec_command" : `mcp__iskron_bridge__tool_${i}` }))
    const ctx = runCodexPipeline({ model: "m", messages: [], tools })
    expect(ctx.passthrough).toBe(true)
    expect(ctx.coreToolNames).toBeUndefined()
    const mcp = createPassthroughMcpServer(tools, ctx.coreToolNames ? [...ctx.coreToolNames] : undefined)
    expect(mcp.hasDeferredTools).toBe(false)
  })
})
