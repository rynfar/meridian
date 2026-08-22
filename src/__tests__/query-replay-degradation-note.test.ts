/**
 * Tests for buildReplayDegradationNote — the addendum that tells the model
 * why this turn required a full conversation replay instead of a fast
 * incremental resume.
 */
import { describe, it, expect } from "bun:test"
import {
  buildQueryOptions,
  buildReplayDegradationNote,
  GIT_STATUS_PROVENANCE_NOTE,
  type QueryContext,
  type ReplayDegradationReason,
} from "../proxy/query"
import { BLOCKED_BUILTIN_TOOLS, CLAUDE_CODE_ONLY_TOOLS, MCP_SERVER_NAME, ALLOWED_MCP_TOOLS } from "../proxy/tools"

/** Mirrors the shared context helper in query.test.ts and query-git-status-note.test.ts. */
function ctx(overrides: Partial<QueryContext> = {}): QueryContext {
  return {
    prompt: "Hello",
    model: "sonnet[1m]",
    workingDirectory: "/tmp/test",
    systemContext: "",
    claudeExecutable: "/usr/bin/claude",
    passthrough: false,
    stream: false,
    sdkAgents: {},
    cleanEnv: {},
    envOverrides: undefined,
    hasDeferredTools: false,
    isUndo: false,
    blockedTools: BLOCKED_BUILTIN_TOOLS,
    incompatibleTools: CLAUDE_CODE_ONLY_TOOLS,
    mcpServerName: MCP_SERVER_NAME,
    allowedMcpTools: ALLOWED_MCP_TOOLS,
    ...overrides,
  }
}

/** The append string for a request that resolves to the preset. */
function presetAppend(overrides: Partial<QueryContext> = {}): string {
  const { options } = buildQueryOptions(ctx(overrides))
  const sp = options.systemPrompt
  if (typeof sp !== "object" || sp === null) {
    throw new Error(`expected preset object, got ${JSON.stringify(sp)}`)
  }
  return (sp as { append?: string }).append ?? ""
}

describe("buildReplayDegradationNote", () => {
  it("returns empty string for undefined reason", () => {
    expect(buildReplayDegradationNote(undefined)).toBe("")
  })

  it("returns empty string for nullish reason", () => {
    // @ts-expect-error testing undefined input
    expect(buildReplayDegradationNote(null)).toBe("")
  })

  it("contains meridian-note tags for checkpoint-incomplete", () => {
    const note = buildReplayDegradationNote("checkpoint-incomplete")
    expect(note).toContain("<meridian-note>")
    expect(note).toContain("</meridian-note>")
  })

  it("mentions parallel tool-call batch for checkpoint-incomplete", () => {
    const note = buildReplayDegradationNote("checkpoint-incomplete")
    expect(note).toContain("parallel tool-call batch")
  })

  it("contains meridian-note tags for concurrent-modified-history", () => {
    const note = buildReplayDegradationNote("concurrent-modified-history")
    expect(note).toContain("<meridian-note>")
    expect(note).toContain("</meridian-note>")
  })

  it("mentions another request in flight for concurrent-modified-history", () => {
    const note = buildReplayDegradationNote("concurrent-modified-history")
    expect(note).toContain("another request")
    expect(note).toContain("in flight")
  })
})

describe("buildQueryOptions — replay degradation note placement", () => {
  it("appends the note when the preset is used with checkpoint-incomplete reason", () => {
    const append = presetAppend({
      codeSystemPrompt: true,
      replayDegradationReason: "checkpoint-incomplete",
    })
    expect(append).toContain("parallel tool-call batch")
    expect(append).toContain("<meridian-note>")
  })

  it("appends the note when the preset is used with concurrent-modified-history reason", () => {
    const append = presetAppend({
      codeSystemPrompt: true,
      replayDegradationReason: "concurrent-modified-history",
    })
    expect(append).toContain("another request")
    expect(append).toContain("in flight")
  })

  it("includes the note in the non-preset branch when systemContext is present", () => {
    const { options } = buildQueryOptions(ctx({
      codeSystemPrompt: false,
      systemContext: "You are helpful.",
      replayDegradationReason: "checkpoint-incomplete",
    }))
    expect(options.systemPrompt).toContain("parallel tool-call batch")
    expect(options.systemPrompt).toContain("You are helpful.")
  })

  it("omits the note when replayDegradationReason is undefined", () => {
    const append = presetAppend({ codeSystemPrompt: true })
    expect(append).not.toContain("full conversation replay")
  })

  it("places the note after cwdNote and before GIT_STATUS_PROVENANCE_NOTE in the preset branch", () => {
    const append = presetAppend({
      codeSystemPrompt: true,
      workingDirectory: "/srv/proxy",
      clientWorkingDirectory: "/Users/alice/app",
      replayDegradationReason: "checkpoint-incomplete",
    })
    expect(append.indexOf("<env>")).toBeLessThan(append.indexOf("full conversation replay"))
    expect(append.indexOf("full conversation replay")).toBeLessThan(append.indexOf("gitStatus"))
  })

  it("includes both cwdNote and replayNote when both are present", () => {
    const append = presetAppend({
      codeSystemPrompt: true,
      workingDirectory: "/srv/proxy",
      clientWorkingDirectory: "/Users/alice/app",
      replayDegradationReason: "concurrent-modified-history",
    })
    expect(append).toContain("Working directory")
    expect(append).toContain("another request")
    expect(append).toContain(GIT_STATUS_PROVENANCE_NOTE.trim())
  })
})