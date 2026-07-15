/**
 * Tests for SDK parameter passthrough fields in buildQueryOptions.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { buildQueryOptions, type QueryContext } from "../proxy/query"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"

function makeContext(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Hello",
    model: "sonnet",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS,
    incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME,
    allowedMcpTools: ALLOWED_MCP_TOOLS,
    ...overrides,
  }
}

describe("buildQueryOptions — SDK parameter passthrough", () => {
  it("passes effort to SDK options when provided", () => {
    const result = buildQueryOptions(makeContext({ effort: "high" }))
    expect(result.options.effort).toBe("high")
  })

  it("passes thinking config to SDK options when provided", () => {
    const thinking = { type: "enabled" as const, budgetTokens: 4096 }
    const result = buildQueryOptions(makeContext({ thinking }))
    expect(result.options.thinking).toEqual(thinking)
  })

  it("passes taskBudget to SDK options when provided", () => {
    const result = buildQueryOptions(makeContext({ taskBudget: { total: 10000 } }))
    expect(result.options.taskBudget).toEqual({ total: 10000 })
  })

  it("passes betas to SDK options when provided", () => {
    const result = buildQueryOptions(makeContext({ betas: ["context-1m-2025-08-07"] }))
    expect(result.options.betas).toEqual(["context-1m-2025-08-07"])
  })

  it("omits effort, thinking, taskBudget, and betas from SDK options when not provided", () => {
    const result = buildQueryOptions(makeContext())
    expect(result.options.effort).toBeUndefined()
    expect(result.options.thinking).toBeUndefined()
    expect(result.options.taskBudget).toBeUndefined()
    expect(result.options.betas).toBeUndefined()
  })

  it("passes all four params simultaneously", () => {
    const thinking = { type: "enabled" as const, budgetTokens: 2048 }
    const result = buildQueryOptions(makeContext({
      effort: "low",
      thinking,
      taskBudget: { total: 5000 },
      betas: ["context-1m-2025-08-07"],
    }))
    expect(result.options.effort).toBe("low")
    expect(result.options.thinking).toEqual(thinking)
    expect(result.options.taskBudget).toEqual({ total: 5000 })
    expect(result.options.betas).toEqual(["context-1m-2025-08-07"])
  })

  it("empty betas array is omitted from SDK options", () => {
    const result = buildQueryOptions(makeContext({ betas: [] }))
    expect(result.options.betas).toBeUndefined()
  })

  it("effort values low/medium/high/max are all accepted", () => {
    const levels = ["low", "medium", "high", "max"] as const
    for (const level of levels) {
      const result = buildQueryOptions(makeContext({ effort: level }))
      expect(result.options.effort).toBe(level)
    }
  })

  it("thinking disabled config is passed through", () => {
    const thinking = { type: "disabled" as const }
    const result = buildQueryOptions(makeContext({ thinking }))
    expect(result.options.thinking).toEqual(thinking)
  })

  it("thinking adaptive config is passed through", () => {
    const thinking = { type: "adaptive" as const }
    const result = buildQueryOptions(makeContext({ thinking }))
    expect(result.options.thinking).toEqual(thinking)
  })
})

describe("scratchpad suppression via CLAUDE_CODE_SESSION_KIND (#627)", () => {
  // The CLI advertises its scratchpad directory (a PROXY-HOST path) in the
  // model's context; in passthrough the CLIENT executes tools, and OpenCode
  // 1.18's permission model rejects that alien path (external_directory).
  // The CLI skips the scratchpad block when CLAUDE_CODE_SESSION_KIND=bg —
  // its own headless-background mode, which is semantically what Meridian's
  // subprocess is.
  let saved: string | undefined
  beforeEach(() => { saved = process.env.MERIDIAN_SUPPRESS_SCRATCHPAD; delete process.env.MERIDIAN_SUPPRESS_SCRATCHPAD })
  afterEach(() => {
    if (saved === undefined) delete process.env.MERIDIAN_SUPPRESS_SCRATCHPAD
    else process.env.MERIDIAN_SUPPRESS_SCRATCHPAD = saved
  })

  it("sets CLAUDE_CODE_SESSION_KIND=bg in passthrough mode", () => {
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect((result.options.env as Record<string, string>).CLAUDE_CODE_SESSION_KIND).toBe("bg")
  })

  it("does NOT set it in internal mode (SDK executes tools; scratchpad is valid there)", () => {
    const result = buildQueryOptions(makeContext({ passthrough: false }))
    expect((result.options.env as Record<string, string>).CLAUDE_CODE_SESSION_KIND).toBeUndefined()
  })

  it("respects an explicit value from profile env overrides", () => {
    const result = buildQueryOptions(makeContext({
      passthrough: true,
      envOverrides: { CLAUDE_CODE_SESSION_KIND: "daemon" },
    }))
    expect((result.options.env as Record<string, string>).CLAUDE_CODE_SESSION_KIND).toBe("daemon")
  })

  it("kill switch MERIDIAN_SUPPRESS_SCRATCHPAD=0 disables it", () => {
    process.env.MERIDIAN_SUPPRESS_SCRATCHPAD = "0"
    const result = buildQueryOptions(makeContext({ passthrough: true }))
    expect((result.options.env as Record<string, string>).CLAUDE_CODE_SESSION_KIND).toBeUndefined()
  })
})
