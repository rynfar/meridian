/**
 * Unit tests for lineage hashing and verification functions.
 * These test the pure functions directly, without HTTP/SDK mocking.
 */
import { describe, it, expect } from "bun:test"
import {
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  measurePrefixOverlap,
  measureSuffixOverlap,
  verifyLineage,
  normalizeContextUsage,
  MIN_SUFFIX_FOR_COMPACTION,
  MAX_CONTINUATION_GAP,
  type SessionState,
} from "../proxy/session/lineage"

function msg(role: string, content: string) {
  return { role, content }
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    claudeSessionId: "sdk-1",
    lastAccess: Date.now(),
    messageCount: 0,
    lineageHash: "",
    ...overrides,
  }
}

const mockCache = { delete: () => true }

describe("computeLineageHash", () => {
  it("returns empty string for empty array", () => {
    expect(computeLineageHash([])).toBe("")
  })

  it("returns empty string for null/undefined", () => {
    expect(computeLineageHash(null as any)).toBe("")
    expect(computeLineageHash(undefined as any)).toBe("")
  })

  it("returns a 32-char hex hash", () => {
    const hash = computeLineageHash([msg("user", "hello")])
    expect(hash).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it("is deterministic", () => {
    const msgs = [msg("user", "hello"), msg("assistant", "hi")]
    expect(computeLineageHash(msgs)).toBe(computeLineageHash(msgs))
  })

  it("differs for different messages", () => {
    const a = computeLineageHash([msg("user", "hello")])
    const b = computeLineageHash([msg("user", "goodbye")])
    expect(a).not.toBe(b)
  })

  it("differs for different message order", () => {
    const a = computeLineageHash([msg("user", "a"), msg("assistant", "b")])
    const b = computeLineageHash([msg("assistant", "b"), msg("user", "a")])
    expect(a).not.toBe(b)
  })
})

describe("hashMessage", () => {
  it("returns a 32-char hex hash", () => {
    const hash = hashMessage(msg("user", "test"))
    expect(hash).toHaveLength(32)
    expect(hash).toMatch(/^[0-9a-f]{32}$/)
  })

  it("is deterministic", () => {
    const m = msg("user", "test")
    expect(hashMessage(m)).toBe(hashMessage(m))
  })

  it("differs by role", () => {
    expect(hashMessage(msg("user", "x"))).not.toBe(hashMessage(msg("assistant", "x")))
  })
})

describe("computeMessageHashes", () => {
  it("returns empty array for empty input", () => {
    expect(computeMessageHashes([])).toEqual([])
  })

  it("returns one hash per message", () => {
    const hashes = computeMessageHashes([msg("user", "a"), msg("assistant", "b")])
    expect(hashes).toHaveLength(2)
  })
})

describe("measurePrefixOverlap", () => {
  it("returns 0 for no overlap", () => {
    expect(measurePrefixOverlap(["a", "b"], ["x", "y"])).toBe(0)
  })

  it("counts consecutive prefix matches", () => {
    expect(measurePrefixOverlap(["a", "b", "c"], ["a", "b"])).toBe(2)
  })

  it("stops at first mismatch", () => {
    expect(measurePrefixOverlap(["a", "x", "b"], ["a", "b"])).toBe(1)
  })

  it("returns full length for complete match", () => {
    expect(measurePrefixOverlap(["a", "b"], ["a", "b"])).toBe(2)
  })

  it("does not match duplicate hashes at wrong positions", () => {
    // stored[2]="a" is a duplicate of stored[0], but incoming[2]="x"
    expect(measurePrefixOverlap(["a", "b", "a", "c"], ["a", "b", "x"])).toBe(2)
  })
})

describe("measureSuffixOverlap", () => {
  it("returns 0 for no overlap", () => {
    expect(measureSuffixOverlap(["a", "b"], ["x", "y"])).toBe(0)
  })

  it("counts consecutive suffix matches at end of incoming", () => {
    // stored=[a,b,c], incoming=[x,b,c] → stored tail [b,c] found contiguously in incoming
    expect(measureSuffixOverlap(["a", "b", "c"], ["x", "b", "c"])).toBe(2)
  })

  it("stops at first contiguity break walking backward", () => {
    // stored=[a,x,b], incoming=[z,y,b] → anchor at b, then x!=y → overlap=1
    expect(measureSuffixOverlap(["a", "x", "b"], ["z", "y", "b"])).toBe(1)
  })

  it("does not false-match suffix hashes found at wrong positions (regression)", () => {
    // stored ends with [e, f], incoming STARTS with [e, f] but ends with [x, y].
    // The anchor search finds f at position 1, then walks back: e at position 0 → match.
    // But this IS a valid contiguous run of [e, f] at positions 0-1 in incoming.
    // However, this should NOT count as compaction because the last stored hash f
    // appears at position 1 (early in incoming), not near the end.
    // The compaction threshold (MIN_SUFFIX >= 2 AND stored >= 6) plus the
    // verifyLineage logic handles this correctly at the caller level.
    //
    // At the raw measurement level, this returns 2 because [e,f] IS a contiguous
    // run in incoming. The caller's additional checks prevent false compaction.
    expect(measureSuffixOverlap(
      ["a", "b", "c", "d", "e", "f"],
      ["e", "f", "g", "x", "y"]
    )).toBe(2)
  })

  it("handles compaction with new messages appended after preserved suffix", () => {
    // Real-world compaction: stored=[a,b,c,d,e,f], incoming=[summary,e,f,new1,new2]
    // Stored tail hash is f, found at incoming[2]. Walk back: e at incoming[1] → match.
    // summary at incoming[0] != d → stop. Overlap = 2.
    expect(measureSuffixOverlap(
      ["a", "b", "c", "d", "e", "f"],
      ["summary", "e", "f", "new1", "new2"]
    )).toBe(2)
  })

  it("handles different-length arrays correctly", () => {
    // stored=[a,b,c,d], incoming=[x,c,d] → anchor d at incoming[-1], c at incoming[-2]
    expect(measureSuffixOverlap(["a", "b", "c", "d"], ["x", "c", "d"])).toBe(2)
  })

  it("returns 0 when last stored hash is not in incoming at all", () => {
    expect(measureSuffixOverlap(["a", "b", "c"], ["a", "b", "x"])).toBe(0)
  })
})

describe("verifyLineage", () => {
  it("returns continuation for empty lineage hash (legacy)", () => {
    const session = makeSession({ lineageHash: "", messageCount: 0 })
    const result = verifyLineage(session, [msg("user", "hi")], "key", mockCache)
    expect(result.type).toBe("continuation")
  })

  it("returns continuation when prefix matches exactly", () => {
    const msgs = [msg("user", "hello"), msg("assistant", "hi")]
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: computeMessageHashes(msgs),
    })
    // Same messages + one new one = valid continuation
    const extended = [...msgs, msg("user", "how are you?")]
    const result = verifyLineage(session, extended, "key", mockCache)
    expect(result.type).toBe("continuation")
  })

  it("returns diverged when no per-message hashes and lineage mismatches", () => {
    const session = makeSession({
      lineageHash: "abcd1234",
      messageCount: 2,
      messageHashes: undefined,
    })
    const result = verifyLineage(session, [msg("user", "different")], "key", mockCache)
    expect(result.type).toBe("diverged")
  })

  it("returns undo when prefix matches but suffix differs", () => {
    const msgs = [msg("user", "a"), msg("assistant", "b"), msg("user", "c"), msg("assistant", "d")]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
      sdkMessageUuids: [null, "uuid-1", null, "uuid-2"],
    })
    // Undo: keep first 2 messages, replace last 2
    const undone = [msg("user", "a"), msg("assistant", "b"), msg("user", "new")]
    const result = verifyLineage(session, undone, "key", mockCache)
    expect(result.type).toBe("undo")
    if (result.type === "undo") {
      expect(result.prefixOverlap).toBe(2)
      expect(result.rollbackUuid).toBe("uuid-1")
    }
  })

  it("returns continuation (not undo) when messages grow with a modified message", () => {
    // Reproduces the false undo bug: conversation grows from 7 to 9 messages
    // but message[6] was modified (e.g., cache_control added by OpenCode).
    const msgs = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
      msg("user", "e"), msg("assistant", "f"),
      msg("user", "g"),
    ]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
      sdkMessageUuids: [null, "uuid-1", null, "uuid-2", null, "uuid-3", null],
    })
    // Same conversation but message[6] is modified and 2 new messages added
    const extended = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
      msg("user", "e"), msg("assistant", "f"),
      msg("user", "g-modified"),  // Modified last message
      msg("assistant", "h"),      // New
      msg("user", "i"),           // New
    ]
    const result = verifyLineage(session, extended, "key", mockCache)
    // Should be continuation, NOT undo — the conversation grew
    expect(result.type).toBe("continuation")
  })

  it("returns undo when same count but last message replaced", () => {
    // Same message count with last message changed = user replaced last message (undo + retype)
    const msgs = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
    ]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
      sdkMessageUuids: [null, "uuid-1", null, "uuid-2"],
    })
    // Same count, but last message changed — this is undo + new message
    const modified = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d-modified"),
    ]
    const result = verifyLineage(session, modified, "key", mockCache)
    expect(result.type).toBe("undo")
  })

  it("returns undo when fewer messages", () => {
    const msgs = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
      msg("user", "e"),
    ]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
      sdkMessageUuids: [null, "uuid-1", null, "uuid-2", null],
    })
    // Fewer messages — clear undo
    const undone = [msg("user", "a"), msg("assistant", "b"), msg("user", "new")]
    const result = verifyLineage(session, undone, "key", mockCache)
    expect(result.type).toBe("undo")
  })

  it("returns diverged when identical messages are replayed (same count, same content)", () => {
    // Bug fix: identical message arrays should start a fresh session,
    // not resume the old one — otherwise ghost context accumulates.
    const msgs = [msg("user", "say hello world")]
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: computeMessageHashes(msgs),
    })
    const result = verifyLineage(session, msgs, "key", mockCache)
    expect(result.type).toBe("diverged")
  })

  it("returns diverged when identical multi-message conversation is replayed", () => {
    const msgs = [
      msg("user", "hello"), msg("assistant", "hi"),
      msg("user", "how are you?"), msg("assistant", "good"),
    ]
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: computeMessageHashes(msgs),
    })
    const result = verifyLineage(session, msgs, "key", mockCache)
    expect(result.type).toBe("diverged")
  })

  it("still returns continuation when messages grow beyond cached count", () => {
    // Ensure the fix doesn't break normal continuation flow
    const msgs = [msg("user", "hello")]
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: computeMessageHashes(msgs),
    })
    const extended = [...msgs, msg("assistant", "hi"), msg("user", "how are you?")]
    const result = verifyLineage(session, extended, "key", mockCache)
    expect(result.type).toBe("continuation")
  })

  it("returns compaction when suffix matches on long conversation", () => {
    // Need >= 6 stored messages and >= MIN_SUFFIX_FOR_COMPACTION suffix overlap
    const msgs = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
      msg("user", "e"), msg("assistant", "f"),
    ]
    const hashes = computeMessageHashes(msgs)
    const session = makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: hashes,
    })
    // Compaction: change beginning, keep last MIN_SUFFIX_FOR_COMPACTION messages
    const compacted = [
      msg("user", "summary"), // replaced
      msg("user", "e"), msg("assistant", "f"), // preserved suffix
    ]
    const result = verifyLineage(session, compacted, "key", mockCache)
    expect(result.type).toBe("compaction")
  })

  it("does not false-detect compaction when suffix hashes appear at wrong positions (regression #283)", () => {
    // Bug: Set-based suffix overlap matched stored tail hashes found at the
    // START of incoming messages, producing false compaction. The fix uses
    // positional comparison (stored[-i] === incoming[-i]).
    const stored = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d"),
      msg("user", "e"), msg("assistant", "f"),
      msg("user", "shared-1"),       // position 6
      msg("assistant", "shared-2"),  // position 7
    ]
    const session = makeSession({
      lineageHash: computeLineageHash(stored),
      messageCount: stored.length,
      messageHashes: computeMessageHashes(stored),
      sdkMessageUuids: [null, "u1", null, "u2", null, "u3", null, "u4"],
    })
    // Incoming: stored tail hashes appear at the BEGINNING, not the end
    const incoming = [
      msg("user", "shared-1"),       // same hash as stored[6], but at position 0
      msg("assistant", "shared-2"),  // same hash as stored[7], but at position 1
      msg("user", "completely-new"),
      msg("assistant", "also-new"),
    ]
    const result = verifyLineage(session, incoming, "key", mockCache)
    // Must NOT be compaction — the suffix is at the wrong position
    expect(result.type).not.toBe("compaction")
    expect(result.type).toBe("diverged")
  })
})

describe("verifyLineage modified-continuation gap bound (#689)", () => {
  // Client-driven tool loops run on throwaway sessions that never persist
  // back to the lineage store, so the stored session can be many messages
  // behind the incoming conversation. Resuming such a session sends only
  // the last user message and drops the intervening tool_use/tool_result
  // pairs from the SDK context. The bound only allows resume when at most
  // the last stored slot churned and at most one exchange was appended;
  // anything further behind must replay fresh (diverged).

  /** Alternating user/assistant conversation: m0, m1, ... m(n-1). */
  function conversation(n: number) {
    return Array.from({ length: n }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `m${i}`))
  }

  function sessionFor(msgs: Array<{ role: string; content: string }>): SessionState {
    return makeSession({
      lineageHash: computeLineageHash(msgs),
      messageCount: msgs.length,
      messageHashes: computeMessageHashes(msgs),
    })
  }

  /** Copy of msgs with the message at `index` replaced by churned content. */
  function churn(msgs: Array<{ role: string; content: string }>, index: number) {
    return msgs.map((m, i) => (i === index ? msg(m.role, `${m.content}-churned`) : m))
  }

  it("resumes when only the last stored slot churned and one exchange was appended", () => {
    // Mirrors the healthy capture in #689: overlap 5/6, incoming 8, gap 2.
    const stored = conversation(6)
    const session = sessionFor(stored)
    const incoming = [
      ...churn(stored, 5),
      msg("assistant", "round 1 summary"),
      msg("user", "thanks"),
    ]
    const result = verifyLineage(session, incoming, "key", mockCache)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      // The store must adopt the incoming history so the next turn resumes cleanly.
      expect(result.session.messageCount).toBe(incoming.length)
      expect(result.session.lineageHash).toBe(computeLineageHash(incoming))
    }
  })

  it("treats a stored lineage behind by a tool round as diverged (issue repro)", () => {
    // Mirrors the failing capture in #689: overlap 7/8, incoming 13, gap 5.
    // The 5 unseen messages are a client-driven tool round the stored
    // session never saw; resuming would drop them from the SDK context.
    const stored = conversation(8)
    const session = sessionFor(stored)
    const incoming = [
      ...churn(stored, 7),
      msg("assistant", "tool_use GREEN-33 + GOLD-44"),
      msg("user", "tool_result GREEN-33"),
      msg("user", "tool_result GOLD-44"),
      msg("assistant", "both commands succeeded"),
      msg("user", "nice"),
    ]
    expect(incoming.length - stored.length).toBeGreaterThan(MAX_CONTINUATION_GAP)
    const deleted: string[] = []
    const spyCache = { delete: (key: string) => { deleted.push(key); return true } }
    const result = verifyLineage(session, incoming, "stale-key", spyCache)
    expect(result.type).toBe("diverged")
    // The stale entry must be evicted so the fresh replay re-adopts the
    // full history and the store self-heals.
    expect(deleted).toEqual(["stale-key"])
  })

  it("treats a gap just over the bound as diverged", () => {
    const stored = conversation(6)
    const session = sessionFor(stored)
    const appended = Array.from({ length: MAX_CONTINUATION_GAP + 1 }, (_, i) =>
      msg(i % 2 === 0 ? "assistant" : "user", `new${i}`))
    const incoming = [...churn(stored, 5), ...appended]
    const result = verifyLineage(session, incoming, "key", mockCache)
    expect(result.type).toBe("diverged")
  })

  it("treats churn deeper than the last stored slot as diverged even with a small gap", () => {
    // The stored SDK session holds the old content of the churned message;
    // resuming would keep stale context the client no longer has.
    const stored = conversation(4)
    const session = sessionFor(stored)
    const incoming = [...churn(stored, 1), msg("user", "one more")]
    const result = verifyLineage(session, incoming, "key", mockCache)
    expect(result.type).toBe("diverged")
  })
})

describe("normalizeContextUsage", () => {
  it("returns the last iteration when iterations are present", () => {
    const result = normalizeContextUsage({
      input_tokens: 9000,
      output_tokens: 1200,
      iterations: [
        { input_tokens: 9000, output_tokens: 1200, type: "message" },
        { input_tokens: 1200, output_tokens: 80, type: "message" },
      ],
    })
    expect(result.input_tokens).toBe(1200)
    expect(result.output_tokens).toBe(80)
    expect(result.type).toBe("message")
  })

  it("returns top-level usage when no iterations field", () => {
    const result = normalizeContextUsage({
      input_tokens: 500,
      output_tokens: 50,
    })
    expect(result.input_tokens).toBe(500)
    expect(result.output_tokens).toBe(50)
  })

  it("falls back to top-level usage when iterations is empty", () => {
    const usage = {
      input_tokens: 500,
      output_tokens: 50,
      iterations: [],
    }
    const result = normalizeContextUsage(usage)
    expect(result.input_tokens).toBe(500)
    expect(result.output_tokens).toBe(50)
  })
})
