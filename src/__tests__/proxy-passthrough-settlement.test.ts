/**
 * Tests for passthrough settlement in lineage verification.
 *
 * In passthrough mode the PreToolUse hook denies every tool call with a
 * placeholder reason string. The SDK records a synthetic `user` message whose
 * `tool_result` content is that placeholder. When the client sends back the
 * real tool_result, verifyLineage must classify this as a continuation
 * (passthrough settlement) rather than modified-history, which would re-fire
 * the deny hook and loop.
 */
import { describe, it, expect } from "bun:test"
import {
  isPassthroughDenyToolResult,
  FORWARDED_TOOL_DENY,
  EXACT_DUPLICATE_DENY,
  SAME_TOOL_REPEAT_DENY,
} from "../proxy/denyReasons"
import {
  verifyLineage,
  computeLineageHash,
  computeMessageHashes,
  computeMessageBlockHashes,
  type SessionState,
} from "../proxy/session/lineage"

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    claudeSessionId: "sdk-1",
    lastAccess: Date.now(),
    messageCount: 0,
    lineageHash: "",
    ...overrides,
  }
}

function msg(role: string, content: any) {
  return { role, content }
}

function toolResult(id: string, content: string) {
  return { type: "tool_result", tool_use_id: id, content }
}

function toolUse(id: string, name: string) {
  return { type: "tool_use", id, name, input: {} }
}

// --- isPassthroughDenyToolResult ---

describe("isPassthroughDenyToolResult", () => {
  it("matches FORWARDED_TOOL_DENY", () => {
    expect(isPassthroughDenyToolResult(FORWARDED_TOOL_DENY)).toBe(true)
  })

  it("matches EXACT_DUPLICATE_DENY", () => {
    expect(isPassthroughDenyToolResult(EXACT_DUPLICATE_DENY)).toBe(true)
  })

  it("matches SAME_TOOL_REPEAT_DENY", () => {
    expect(isPassthroughDenyToolResult(SAME_TOOL_REPEAT_DENY)).toBe(true)
  })

  it("rejects a normal tool_result payload", () => {
    expect(isPassthroughDenyToolResult("contents of a.txt")).toBe(false)
  })

  it("rejects empty string", () => {
    expect(isPassthroughDenyToolResult("")).toBe(false)
  })

  it("rejects non-string content (e.g. array)", () => {
    expect(isPassthroughDenyToolResult(["not a string"])).toBe(false)
  })

  it("rejects null/undefined", () => {
    expect(isPassthroughDenyToolResult(null)).toBe(false)
    expect(isPassthroughDenyToolResult(undefined)).toBe(false)
  })

  it("rejects a string that merely CONTAINS a deny reason (not exact match)", () => {
    expect(isPassthroughDenyToolResult("prefix " + FORWARDED_TOOL_DENY + " suffix")).toBe(false)
  })
})

// --- verifyLineage passthrough settlement ---

describe("verifyLineage passthrough settlement", () => {
  function sessionFor(messages: Array<{ role: string; content: any }>, overrides: Partial<SessionState> = {}): SessionState {
    return makeSession({
      lastAccess: 0,
      lineageHash: computeLineageHash(messages),
      messageCount: messages.length,
      messageHashes: computeMessageHashes(messages),
      messageBlockHashes: computeMessageBlockHashes(messages),
      passthroughToolCallIds: ["toolu_1"],
      passthroughToolCallAssistantUuid: "uuid-assistant",
      ...overrides,
    })
  }

  it("returns continuation when trailing placeholder is replaced by real tool_result", () => {
    // Stored: user asks, assistant calls tool, user gets deny placeholder
    const stored = [
      msg("user", "read file a.txt"),
      { role: "assistant", content: [toolUse("toolu_1", "read")] },
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
    ]
    // Incoming: same prefix, but the last user message has the REAL result
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [toolResult("toolu_1", "contents of a.txt")] },
    ]

    const result = verifyLineage(sessionFor(stored), incoming)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      expect(result.resumeFrom).toBe(2)
      expect(result.resumeContentFrom).toBe(0)
    }
  })

  it("returns continuation when placeholder is replaced AND new messages follow", () => {
    const stored = [
      msg("user", "read file a.txt"),
      { role: "assistant", content: [toolUse("toolu_1", "read")] },
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [toolResult("toolu_1", "contents of a.txt")] },
      { role: "assistant", content: "Here are the contents." },
      msg("user", "thanks"),
    ]

    const result = verifyLineage(sessionFor(stored), incoming)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      expect(result.resumeFrom).toBe(2)
      expect(result.resumeContentFrom).toBe(0)
    }
  })

  it("returns continuation with multiple parallel forwarded tool IDs", () => {
    const stored = [
      msg("user", "run both"),
      { role: "assistant", content: [
        toolUse("toolu_a", "read"),
        toolUse("toolu_b", "bash"),
      ]},
      { role: "user", content: [
        toolResult("toolu_a", FORWARDED_TOOL_DENY),
        toolResult("toolu_b", FORWARDED_TOOL_DENY),
      ]},
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [
        toolResult("toolu_a", "file contents"),
        toolResult("toolu_b", "command output"),
      ]},
      { role: "assistant", content: "Both done." },
    ]

    const result = verifyLineage(sessionFor(stored, {
      passthroughToolCallIds: ["toolu_a", "toolu_b"],
    }), incoming)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      expect(result.resumeFrom).toBe(2)
      expect(result.resumeContentFrom).toBe(0)
    }
  })

  it("still returns modified-history when passthroughToolCallIds is absent", () => {
    // Same shape but no checkpoint — this is a genuine content rewrite
    const stored = [
      msg("user", "read file a.txt"),
      { role: "assistant", content: [toolUse("toolu_1", "read")] },
      { role: "user", content: [toolResult("toolu_1", "old content")] },
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [toolResult("toolu_1", "new content")] },
      msg("assistant", "next"),
    ]

    const session = sessionFor(stored, { passthroughToolCallIds: undefined })
    const result = verifyLineage(session, incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("modified-history")
  })

  it("still returns modified-history when tool_use_id does not match forwarded ids", () => {
    const stored = [
      msg("user", "read file a.txt"),
      { role: "assistant", content: [toolUse("toolu_1", "read")] },
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
    ]
    // Incoming has a DIFFERENT tool_use_id than what was forwarded
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [toolResult("toolu_WRONG", "contents")] },
      msg("assistant", "next"),
    ]

    const result = verifyLineage(sessionFor(stored), incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("modified-history")
  })

  it("returns continuation when incoming tool_result is still a placeholder (fast-path match)", () => {
    // Client re-sends the same placeholder — the fast path catches this as
    // a strict prefix match (continuation), not a divergence. This is correct:
    // the SDK resumes at the assistant UUID and the delta is the same deny
    // result the SDK already has, so the hook re-fires harmlessly.
    const stored = [
      msg("user", "read file a.txt"),
      { role: "assistant", content: [toolUse("toolu_1", "read")] },
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
      msg("assistant", "next"),
    ]

    const result = verifyLineage(sessionFor(stored), incoming)
    // Fast path: prefix hash matches exactly, so this is a continuation
    expect(result.type).toBe("continuation")
  })

  it("returns replayed-request when incoming is identical to stored (same placeholder, no new messages)", () => {
    const stored = [
      msg("user", "read file a.txt"),
      { role: "assistant", content: [toolUse("toolu_1", "read")] },
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
    ]
    const incoming = [...stored]

    const result = verifyLineage(sessionFor(stored), incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("replayed-request")
  })

  it("still returns modified-history for a mid-history content rewrite", () => {
    // Genuine modified-history: a message in the middle changed, not the last one
    const stored = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "how are you?"),
    ]
    const incoming = [
      msg("user", "hello"),
      msg("assistant", "hi"),
      msg("user", "how are you? EDITED"),
      msg("assistant", "good"),
    ]

    const result = verifyLineage(sessionFor(stored, { passthroughToolCallIds: undefined }), incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("modified-history")
  })

  it("append-only parallel tool results still work (existing branch not disturbed)", () => {
    const stored = [
      { role: "user", content: [{ type: "text", text: "run both" }] },
      { role: "assistant", content: [
        toolUse("call-a", "bash"),
        toolUse("call-b", "bash"),
      ]},
      { role: "user", content: [toolResult("call-a", "a-result")] },
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [
        toolResult("call-a", "a-result"),
        toolResult("call-b", "b-result"),
      ]},
      { role: "assistant", content: [toolUse("call-c", "bash")] },
      { role: "user", content: [toolResult("call-c", "c-result")] },
    ]

    const result = verifyLineage(sessionFor(stored, { passthroughToolCallIds: undefined }), incoming)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      expect(result.resumeFrom).toBe(2)
      expect(result.resumeContentFrom).toBe(1)
    }
  })

  it("does not fire when prefixOverlap is less than messageCount - 1 (mid-history change)", () => {
    const stored = [
      msg("user", "a"),
      msg("assistant", "b"),
      msg("user", "c"),
      { role: "user", content: [toolResult("toolu_1", FORWARDED_TOOL_DENY)] },
    ]
    // Message at index 1 changed — not trailing-only
    const incoming = [
      msg("user", "a"),
      msg("assistant", "b CHANGED"),
      msg("user", "c"),
      { role: "user", content: [toolResult("toolu_1", "real result")] },
      msg("assistant", "next"),
    ]

    const result = verifyLineage(sessionFor(stored), incoming)
    expect(result.type).toBe("diverged")
  })
})