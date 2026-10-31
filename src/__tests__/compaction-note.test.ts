/**
 * Unit tests for the compaction notice helpers (pure, no mocks).
 */
import { describe, it, expect } from "bun:test"
import { describeCompaction, extractCompaction, formatCompactionNote } from "../proxy/compactionNote"

const boundary = (compact_metadata: Record<string, unknown>) => ({
  type: "system",
  subtype: "compact_boundary",
  compact_metadata,
  uuid: "u1",
  session_id: "s1",
})

describe("extractCompaction", () => {
  it("reads the SDK compact boundary", () => {
    expect(extractCompaction(boundary({ trigger: "auto", pre_tokens: 180_000, post_tokens: 42_000, duration_ms: 3_100 }))).toEqual({
      trigger: "auto",
      preTokens: 180_000,
      postTokens: 42_000,
      durationMs: 3_100,
    })
  })

  it("keeps a manual trigger and tolerates missing optional fields", () => {
    expect(extractCompaction(boundary({ trigger: "manual", pre_tokens: 90_000 }))).toEqual({ trigger: "manual", preTokens: 90_000 })
    expect(extractCompaction(boundary({}))).toEqual({ trigger: "auto", preTokens: 0 })
  })

  it("ignores every other SDK message", () => {
    expect(extractCompaction({ type: "system", subtype: "init", session_id: "s1" })).toBeUndefined()
    expect(extractCompaction({ type: "assistant", message: { content: [] } })).toBeUndefined()
    expect(extractCompaction({ type: "stream_event", event: { type: "message_start" } })).toBeUndefined()
    expect(extractCompaction(null)).toBeUndefined()
    expect(extractCompaction("compact_boundary")).toBeUndefined()
  })
})

describe("formatCompactionNote", () => {
  it("names the trigger and both sizes, and ends with a blank line", () => {
    expect(formatCompactionNote({ trigger: "auto", preTokens: 180_000, postTokens: 42_000 })).toBe(
      "[meridian] Claude Code compacted this conversation's context automatically: 180,000 tokens before, 42,000 tokens after. " +
      "The model now sees the earlier turns as a summary.\n\n",
    )
  })

  it("says only what it knows when the size after is missing", () => {
    expect(formatCompactionNote({ trigger: "manual", preTokens: 90_000 })).toBe(
      "[meridian] Claude Code compacted this conversation's context on request: 90,000 tokens before. " +
      "The model now sees the earlier turns as a summary.\n\n",
    )
  })
})

describe("describeCompaction", () => {
  it("is one log line with the sizes and the duration when known", () => {
    expect(describeCompaction({ trigger: "auto", preTokens: 180_000, postTokens: 42_000, durationMs: 3_100 })).toBe(
      "context_compacted: auto compaction, 180,000 tokens before, 42,000 tokens after in 3100 ms",
    )
    expect(describeCompaction({ trigger: "manual", preTokens: 90_000 })).toBe(
      "context_compacted: manual compaction, 90,000 tokens before",
    )
  })
})
