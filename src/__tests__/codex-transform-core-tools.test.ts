/**
 * The codex transform must name Codex's own built-ins as core tools: the
 * inherited OpenCode list matches nothing Codex sends, so auto-defer deferred
 * every tool (exec_command included) and each turn paid a discovery round.
 */

import { describe, it, expect } from "bun:test"
import { codexTransforms } from "../proxy/transforms/codex"
import { openCodeTransforms } from "../proxy/transforms/opencode"
import type { RequestContext } from "../proxy/transform"

function runCodexPipeline(body: Record<string, unknown>): RequestContext {
  let ctx = { body, adapter: "codex" } as unknown as RequestContext
  for (const t of [...openCodeTransforms, ...codexTransforms]) {
    if ((t.adapters === undefined || t.adapters.includes("codex")) && t.onRequest) ctx = t.onRequest(ctx)
  }
  return ctx
}

describe("codex transform core tools", () => {
  it("forces passthrough and names Codex built-ins as the always-loaded set", () => {
    const ctx = runCodexPipeline({ model: "m", messages: [], tools: [{ name: "exec_command" }, { name: "mcp__iskron_bridge__iskron_orient" }] })
    expect(ctx.passthrough).toBe(true)
    expect(ctx.coreToolNames).toContain("exec_command")
    expect(ctx.coreToolNames).toContain("apply_patch")
    expect(ctx.coreToolNames).not.toContain("bash")
  })
})
