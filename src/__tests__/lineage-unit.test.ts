/**
 * Unit tests for lineage hashing and verification functions.
 * These test the pure functions directly, without HTTP/SDK mocking.
 */
import { describe, it, expect } from "bun:test"
import {
  describeLineageMismatch,
  formatLineageMismatch,
  computeLineageHash,
  hashMessage,
  computeMessageHashes,
  computeMessageBlockHashes,
  measurePrefixOverlap,
  measureSuffixOverlap,
  verifyLineage,
  normalizeContextUsage,
  withClientAssistantUuid,
  reconcileReturnedSessionUuids,
  MIN_SUFFIX_FOR_COMPACTION,
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
  it("returns diverged for an unverifiable legacy session", () => {
    const session = makeSession({ lineageHash: "", messageCount: 0 })
    const result = verifyLineage(session, [msg("user", "hi")])
    expect(result).toEqual({ type: "diverged", reason: "unverifiable" })
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
    const result = verifyLineage(session, extended)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      expect(result.resumeFrom).toBe(msgs.length)
    }
  })

  it("returns diverged when no per-message hashes and lineage mismatches", () => {
    const session = makeSession({
      lineageHash: "abcd1234",
      messageCount: 2,
      messageHashes: undefined,
    })
    const result = verifyLineage(session, [msg("user", "different")])
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
    const result = verifyLineage(session, undone)
    expect(result.type).toBe("undo")
    if (result.type === "undo") {
      expect(result.prefixOverlap).toBe(2)
      expect(result.rollbackUuid).toBe("uuid-1")
    }
  })

  it("returns diverged when messages grow after a cached message changed", () => {
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
    const result = verifyLineage(session, extended)
    expect(result).toMatchObject({
      type: "diverged",
      reason: "modified-history",
      prefixOverlap: 6,
    })
  })

  it("does not mutate cached state when a stale 515-message session receives 727 messages", () => {
    const cachedMessages = Array.from({ length: 515 }, (_, i) =>
      msg(i % 2 === 0 ? "user" : "assistant", `cached-${i}`)
    )
    const session = makeSession({
      lineageHash: computeLineageHash(cachedMessages),
      messageCount: cachedMessages.length,
      messageHashes: computeMessageHashes(cachedMessages),
    })
    const originalHashes = [...session.messageHashes!]
    const incoming = [
      ...cachedMessages.slice(0, 514),
      msg("user", "changed-boundary"),
      ...Array.from({ length: 212 }, (_, i) =>
        msg((i + 515) % 2 === 0 ? "user" : "assistant", `new-${i}`)
      ),
    ]

    const result = verifyLineage(session, incoming)

    expect(incoming).toHaveLength(727)
    expect(result).toMatchObject({
      type: "diverged",
      reason: "modified-history",
      prefixOverlap: 514,
    })
    expect(session.messageCount).toBe(515)
    expect(session.lineageHash).toBe(computeLineageHash(cachedMessages))
    expect(session.messageHashes).toEqual(originalHashes)
  })

  it("ignores cache_control changes when verifying a strict continuation", () => {
    const cachedMessages = [{
      role: "user",
      content: [{ type: "text", text: "hello" }],
    }]
    const session = makeSession({
      lineageHash: computeLineageHash(cachedMessages),
      messageCount: cachedMessages.length,
      messageHashes: computeMessageHashes(cachedMessages),
    })
    const incoming = [
      {
        role: "user",
        content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
      },
      msg("assistant", "hi"),
      msg("user", "continue"),
    ]

    const result = verifyLineage(session, incoming)

    expect(result.type).toBe("continuation")
  })

  it("replays a replacement assistant tail instead of dropping it", () => {
    // An assistant-tail rewrite is not a new user turn to send after rollback.
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
    // The replacement assistant content must survive the replay.
    const modified = [
      msg("user", "a"), msg("assistant", "b"),
      msg("user", "c"), msg("assistant", "d-modified"),
    ]
    const result = verifyLineage(session, modified)
    expect(result).toMatchObject({ type: "diverged", reason: "undo-gap" })
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
    const result = verifyLineage(session, undone)
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
    const result = verifyLineage(session, msgs)
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
    const result = verifyLineage(session, msgs)
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
    const result = verifyLineage(session, extended)
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
    const originalLineageHash = session.lineageHash
    const originalMessageHashes = [...session.messageHashes!]
    // Compaction: change beginning, keep the stored suffix, append a new turn.
    const compacted = [
      msg("user", "summary"), // replaced
      msg("user", "e"), msg("assistant", "f"), // preserved suffix
      msg("assistant", "new response"), msg("user", "continue"),
    ]
    const result = verifyLineage(session, compacted)
    expect(result.type).toBe("compaction")
    if (result.type === "compaction") {
      expect(result.resumeFrom).toBe(3)
      expect(result.suffixOverlap).toBe(2)
    }
    expect(session.messageCount).toBe(msgs.length)
    expect(session.lineageHash).toBe(originalLineageHash)
    expect(session.messageHashes).toEqual(originalMessageHashes)
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
    const result = verifyLineage(session, incoming)
    // Must NOT be compaction — the suffix is at the wrong position
    expect(result.type).not.toBe("compaction")
    expect(result.type).toBe("diverged")
  })
})

describe("verifyLineage stale modified continuation (#689)", () => {
  // Client-driven tool loops run on throwaway sessions that never persist
  // back to the lineage store, so the stored session can be many messages
  // behind the incoming conversation. Resuming such a session sends only
  // the last user message and drops the intervening tool_use/tool_result
  // pairs from the SDK context.
  //
  // #700 bounded this: resume was allowed when only the last stored slot had
  // churned and at most one exchange was appended. #692 removed the bound —
  // a changed slot means the SDK session still holds content the client no
  // longer claims, so every shape here diverges and replays in full.

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

  it("diverges when the last stored slot churned and one exchange was appended", () => {
    // The healthy-looking capture in #689: overlap 5/6, incoming 8, gap 2.
    // #700 allowed this to resume as benign churn; #692 does not, because the
    // stored SDK session holds the pre-churn content of slot 5.
    const stored = conversation(6)
    const session = sessionFor(stored)
    const incoming = [
      ...churn(stored, 5),
      msg("assistant", "round 1 summary"),
      msg("user", "thanks"),
    ]
    const result = verifyLineage(session, incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("modified-history")
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
    const result = verifyLineage(session, incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("modified-history")
  })

  it("leaves the cached session untouched when it diverges", () => {
    // #692 makes verification side-effect free: the caller evicts and commits
    // new lineage only after the upstream request succeeds, so a stale entry
    // is never rewritten by a failed turn.
    const stored = conversation(6)
    const session = sessionFor(stored)
    const before = { count: session.messageCount, hash: session.lineageHash }
    const incoming = [...churn(stored, 5), msg("assistant", "a"), msg("user", "b")]
    verifyLineage(session, incoming)
    expect(session.messageCount).toBe(before.count)
    expect(session.lineageHash).toBe(before.hash)
  })

  it("treats churn deeper than the last stored slot as diverged even with a small gap", () => {
    // The stored SDK session holds the old content of the churned message;
    // resuming would keep stale context the client no longer has.
    const stored = conversation(4)
    const session = sessionFor(stored)
    const incoming = [...churn(stored, 1), msg("user", "one more")]
    const result = verifyLineage(session, incoming)
    expect(result.type).toBe("diverged")
  })
})

// #767 asked for exactly this: "prefix overlap 50/51" says how many messages
// matched and never which one stopped. The answer was always in hand at the
// point of the decision — it just was not reported.
describe("describeLineageMismatch", () => {
  function sessionFor(messages: Array<{ role: string; content: any }>): SessionState {
    return makeSession({
      lastAccess: 0,
      lineageHash: computeLineageHash(messages),
      messageCount: messages.length,
      messageHashes: computeMessageHashes(messages),
    })
  }

  it("names the first index that stopped matching, with both digests", () => {
    const stored = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]
    const incoming = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three-EDITED" },
    ]

    const detail = describeLineageMismatch(sessionFor(stored), incoming)
    expect(detail.index).toBe(2)
    expect(detail.storedDigest).toBeDefined()
    expect(detail.incomingDigest).toBeDefined()
    expect(detail.storedDigest).not.toBe(detail.incomingDigest)
    // The preceding index matched — that is what makes the named index the seam.
    expect(detail.previousDigest).toBe(computeMessageHashes(stored)[1])
    expect(detail.storedCount).toBe(3)
    expect(detail.incomingCount).toBe(3)
  })

  it("reports shape without ever carrying content", () => {
    const secret = "SECRET-do-not-log-this"
    const stored = [{ role: "user", content: "one" }]
    const incoming = [{ role: "user", content: [
      { type: "text", text: secret },
      { type: "tool_result", tool_use_id: "t1", content: secret },
    ] }]

    const detail = describeLineageMismatch(sessionFor(stored), incoming)
    expect(detail.incomingShape).toEqual({ role: "user", blocks: "text,tool_result", bytes: expect.any(Number) })
    expect(JSON.stringify(detail)).not.toContain(secret)
  })

  it("reports -1 when the shared prefix matches all the way", () => {
    const stored = [{ role: "user", content: "one" }]
    const incoming = [{ role: "user", content: "one" }, { role: "assistant", content: "two" }]
    expect(describeLineageMismatch(sessionFor(stored), incoming).index).toBe(-1)
  })
})

// The log line this feeds is the whole point: core already knew which message
// broke, and reported only a count nobody could act on.
describe("formatLineageMismatch", () => {
  const base = {
    index: 50,
    storedDigest: "19d133336ded0000000000000000aaaa",
    incomingDigest: "d546681fb008000000000000000bbbbb",
    previousDigest: "d61d1384ce00000000000000000ccccc",
    incomingShape: { role: "user", blocks: "tool_result,tool_result", bytes: 812 },
    storedCount: 51,
    incomingCount: 53,
  }

  it("names the index, truncates both digests, and reports the shape", () => {
    const out = formatLineageMismatch(base)!
    expect(out).toContain("first mismatch at index 50")
    expect(out).toContain("stored=19d133336ded")
    expect(out).toContain("incoming=d546681fb008")
    expect(out).toContain("user[tool_result,tool_result] 812B")
  })

  // A trailing-only mismatch is a late tool result; a mid-history one means the
  // transcript was rewritten. The overlap count cannot tell them apart.
  it("calls out a trailing-only mismatch", () => {
    expect(formatLineageMismatch(base)).toContain("trailing message only")
  })

  it("does not call a mid-history mismatch trailing", () => {
    expect(formatLineageMismatch({ ...base, index: 2 })).not.toContain("trailing")
  })

  it("returns nothing when the shared prefix matched all the way", () => {
    expect(formatLineageMismatch({ ...base, index: -1 })).toBeUndefined()
  })

  it("never carries content", () => {
    const secret = "SECRET-do-not-log"
    const out = formatLineageMismatch({
      ...base,
      incomingShape: { role: "user", blocks: "text", bytes: secret.length },
    })!
    expect(out).not.toContain(secret)
  })
})

describe("verifyLineage append-only tool-result extension", () => {
  const toolResult = (id: string, content: string) => ({
    type: "tool_result",
    tool_use_id: id,
    content,
  })

  function sessionFor(messages: Array<{ role: string; content: any }>): SessionState {
    return makeSession({
      lastAccess: 0,
      lineageHash: computeLineageHash(messages),
      messageCount: messages.length,
      messageHashes: computeMessageHashes(messages),
      messageBlockHashes: computeMessageBlockHashes(messages),
    })
  }

  it("resumes from only the newly appended parallel tool result", () => {
    const stored = [
      { role: "user", content: [{ type: "text", text: "run both" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "call-a", name: "bash", input: { command: "a" } },
        { type: "tool_use", id: "call-b", name: "bash", input: { command: "b" } },
      ] },
      { role: "user", content: [toolResult("call-a", "a-result")] },
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [
        toolResult("call-a", "a-result"),
        toolResult("call-b", "b-result"),
      ] },
      { role: "assistant", content: [
        { type: "tool_use", id: "call-c", name: "bash", input: { command: "c" } },
      ] },
      { role: "user", content: [toolResult("call-c", "c-result")] },
    ]

    expect(verifyLineage(sessionFor(stored), incoming)).toEqual({
      type: "continuation",
      session: sessionFor(stored),
      resumeFrom: 2,
      resumeContentFrom: 1,
    })
  })

  // #767: OpenCode + Opus reported `prefix overlap N/N+1` on nearly every turn,
  // each one forcing a fresh replay (cache 97% -> 32%, ~3.9x cost). The reported
  // shape is exactly this path: the trailing stored message is the user turn
  // carrying tool_results, a parallel call lands late and extends it, and the
  // conversation grows by an assistant+user pair on top. Opus issues parallel
  // tool calls far more readily than Haiku, which is the model correlation the
  // report measured (85% clean on Haiku vs 30-40% on Opus).
  it("continues on the #767 signature: trailing message extended, history grown", () => {
    // 51 stored messages, the last one a user turn with one result of two.
    const head: Array<{ role: string; content: any }> = []
    for (let i = 0; i < 49; i++) {
      head.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `turn ${i}` }] })
    }
    const assistantWithParallelCalls = { role: "assistant", content: [
      { type: "tool_use", id: "call-a", name: "bash", input: { command: "a" } },
      { type: "tool_use", id: "call-b", name: "bash", input: { command: "b" } },
    ] }
    const stored = [
      ...head,
      assistantWithParallelCalls,
      { role: "user", content: [toolResult("call-a", "a-result")] },
    ]
    expect(stored.length).toBe(51)

    const incoming = [
      ...head,
      assistantWithParallelCalls,
      // The late sibling result extends the SAME message rather than adding one.
      { role: "user", content: [toolResult("call-a", "a-result"), toolResult("call-b", "b-result")] },
      { role: "assistant", content: [{ type: "text", text: "and the answer" }] },
      { role: "user", content: [{ type: "text", text: "next question" }] },
    ]
    expect(incoming.length).toBe(53)

    const result = verifyLineage(sessionFor(stored), incoming)
    expect(result.type).toBe("continuation")
    if (result.type === "continuation") {
      expect(result.resumeFrom).toBe(50)
      expect(result.resumeContentFrom).toBe(1)
    }
  })

  // The caveat that decides whether a fix is visible in the field: block hashes
  // are only recorded from 1.61.0 on, so a session cached by an older build
  // keeps replaying until it is started fresh.
  it("a session stored without block hashes still diverges (pre-1.61.0 cache entry)", () => {
    const stored = [
      { role: "user", content: [{ type: "text", text: "run both" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "call-a", name: "bash", input: { command: "a" } },
        { type: "tool_use", id: "call-b", name: "bash", input: { command: "b" } },
      ] },
      { role: "user", content: [toolResult("call-a", "a-result")] },
    ]
    const legacySession = makeSession({
      lastAccess: 0,
      lineageHash: computeLineageHash(stored),
      messageCount: stored.length,
      messageHashes: computeMessageHashes(stored),
      // messageBlockHashes deliberately absent — what a pre-1.61.0 entry holds.
    })
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [toolResult("call-a", "a-result"), toolResult("call-b", "b-result")] },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ]

    expect(verifyLineage(legacySession, incoming).type).toBe("diverged")
  })

  it("still diverges when an existing tool result changed", () => {
    const stored = [
      { role: "user", content: [{ type: "text", text: "run both" }] },
      { role: "assistant", content: [
        { type: "tool_use", id: "call-a", name: "bash", input: { command: "a" } },
      ] },
      { role: "user", content: [toolResult("call-a", "old-result")] },
    ]
    const incoming = [
      stored[0]!,
      stored[1]!,
      { role: "user", content: [
        toolResult("call-a", "changed-result"),
        toolResult("call-b", "new-result"),
      ] },
      { role: "assistant", content: "next" },
    ]

    expect(verifyLineage(sessionFor(stored), incoming)).toMatchObject({
      type: "diverged",
      reason: "modified-history",
      prefixOverlap: 2,
    })
  })

  it("still diverges when arbitrary user text is appended to the changed slot", () => {
    const stored = [
      { role: "user", content: [{ type: "text", text: "first" }] },
    ]
    const incoming = [
      { role: "user", content: [
        { type: "text", text: "first" },
        { type: "text", text: "edited continuation" },
      ] },
      { role: "assistant", content: "next" },
    ]

    expect(verifyLineage(sessionFor(stored), incoming).type).toBe("diverged")
  })

  it("still diverges when a prior tool result is appended again", () => {
    const stored = [
      { role: "user", content: [toolResult("call-a", "a-result")] },
    ]
    const incoming = [
      { role: "user", content: [
        toolResult("call-a", "a-result"),
        toolResult("call-a", "a-result"),
      ] },
      { role: "assistant", content: "next" },
    ]

    expect(verifyLineage(sessionFor(stored), incoming).type).toBe("diverged")
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

describe("verifyLineage compaction that reaches the end of the incoming array", () => {
  // Stateless chat frontends (SillyTavern and most roleplay clients) re-send the
  // whole history every turn and append a constant trailing block after the
  // user's own message — an injected assistant line plus a prefill sent as a
  // user message. When the user repeats a turn verbatim, that trailing block
  // matches the stored tail for several slots, so the suffix anchor lands on the
  // final message and resumeFrom comes out equal to messages.length.
  //
  // The slice is then empty and the caller falls back to getLastUserMessage(),
  // which returns the constant prefill rather than the turn the user just typed,
  // so the request reaches the model with the user's input missing entirely.
  const FAKE_ASSISTANT = "[injected] let's look at what the user wrote"
  const LATEST = "<latest_human_message>\ngo on\n</latest_human_message>"
  const PREFILL = "done thinking."

  const head = [
    msg("user", "turn one"),
    msg("assistant", "reply one"),
    msg("user", "turn two"),
    msg("assistant", "reply two"),
  ]
  const trailingBlock = [
    msg("user", "go on"),
    msg("assistant", FAKE_ASSISTANT),
    msg("user", LATEST),
    msg("user", PREFILL),
  ]
  const stored = [...head, ...trailingBlock]
  const incoming = [
    ...head,
    msg("user", "go on"),
    msg("assistant", "reply three"),
    ...trailingBlock,
  ]

  const session = makeSession({
    messageCount: stored.length,
    lineageHash: computeLineageHash(stored),
    messageHashes: computeMessageHashes(stored),
  })

  it("does not resume with nothing left to send", () => {
    const result = verifyLineage(session, incoming)
    if (result.type === "continuation" || result.type === "compaction") {
      expect(result.resumeFrom).toBeLessThan(incoming.length)
    }
  })

  it("replays in full so the user's turn is not dropped", () => {
    const result = verifyLineage(session, incoming)
    expect(result.type).toBe("diverged")
    if (result.type === "diverged") expect(result.reason).toBe("modified-history")
  })

  it("still detects a real compaction that appends a new turn", () => {
    // The genuine shape: a long head replaced by a short summary, preserved
    // tail intact, and the new turn appended after it. resumeFrom stays inside
    // the array, so this must keep resuming — the fix must not cost it.
    const compacted = [
      msg("user", "summary of earlier"),
      ...stored.slice(-3),
      msg("assistant", "reply three"),
      msg("user", "a brand new turn"),
    ]
    const result = verifyLineage(session, compacted)
    expect(result.type).toBe("compaction")
    if (result.type === "compaction") expect(result.resumeFrom).toBeLessThan(compacted.length)
  })
})


describe("withClientAssistantUuid", () => {
  it("overwrites parallel SDK fragments at one future client-assistant slot", () => {
    let map: Array<string | null> = [null]
    map = withClientAssistantUuid(map, 1, "assistant-fragment-1")
    map = withClientAssistantUuid(map, 1, "assistant-fragment-2")
    expect(map).toEqual([null, "assistant-fragment-2"])
  })

  it("clears an older fragment when a later assistant UUID is missing", () => {
    const map = withClientAssistantUuid([null, "older-fragment"], 1, undefined)
    expect(map).toEqual([null, null])
  })

  it("pads missing client user slots without shifting the assistant UUID", () => {
    expect(withClientAssistantUuid([null, "prior-assistant"], 3, "next-assistant"))
      .toEqual([null, "prior-assistant", null, "next-assistant"])
  })
})

describe("reconcileReturnedSessionUuids", () => {
  it("clears copied UUIDs after an observed session change and keeps the current output", () => {
    expect(reconcileReturnedSessionUuids(
      [null, "copied-assistant", null, "current-assistant"],
      3,
      "current-assistant",
      "source-session",
      "fork-session",
    )).toEqual([null, null, null, "current-assistant"])
  })

  it("keeps the UUID map when the SDK returns the resumed session", () => {
    const map = [null, "existing-assistant", null, "current-assistant"]
    expect(reconcileReturnedSessionUuids(map, 3, "current-assistant", "same-session", "same-session"))
      .toBe(map)
  })

  it("does not discard fresh-request UUIDs", () => {
    const map = [null, "fresh-assistant"]
    expect(reconcileReturnedSessionUuids(map, 1, "fresh-assistant", undefined, "fresh-session"))
      .toBe(map)
  })
})

describe("fork-remapped undo boundaries", () => {
  const stored = [
    msg("user", "one"),
    msg("assistant", "reply one"),
    msg("user", "two"),
    msg("assistant", "reply two"),
    msg("user", "three"),
    msg("assistant", "new fork output"),
    msg("user", "four"),
  ]
  const session = makeSession({
    messageCount: stored.length,
    lineageHash: computeLineageHash(stored),
    messageHashes: computeMessageHashes(stored),
    sdkMessageUuids: [null, null, null, null, null, "new-fork-output-uuid", null],
  })

  it("leaves an undo boundary empty when the preserved prefix has only remapped UUIDs", () => {
    const result = verifyLineage(session, [
      ...stored.slice(0, 2),
      msg("user", "branch before the new fork output"),
    ])
    expect(result).toMatchObject({ type: "undo", prefixOverlap: 2, rollbackUuid: undefined })
  })

  it("uses the newly observed fork output UUID when the undo preserves it", () => {
    const result = verifyLineage(session, [
      ...stored.slice(0, 6),
      msg("user", "branch after the new fork output"),
    ])
    expect(result).toMatchObject({
      type: "undo",
      prefixOverlap: 6,
      rollbackUuid: "new-fork-output-uuid",
    })
  })
})
