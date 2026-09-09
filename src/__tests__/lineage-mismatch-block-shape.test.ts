/**
 * Lineage mismatch diagnostic: append vs drop vs rewrite (#886).
 *
 * Since #797 the `modified-history` line names the first mismatching index and
 * both message digests, but it reported only what the message looks like NOW.
 * Three different client behaviours were therefore indistinguishable from the
 * log: a block was appended, a block was dropped, or a block was rewritten in
 * place. That distinction is the whole question in #767 — an append can be a
 * safe continuation, a drop means the client no longer claims history the SDK
 * session still holds.
 *
 * The stored block hashes were already in hand (`computeMessageBlockHashes`
 * populates them for every session, and `verifyLineage`'s own boundary
 * tolerance consumes them); the diagnostic simply never read them.
 *
 * Pure unit tests: no mocks, no I/O.
 */

import { describe, it, expect } from "bun:test"
import {
  describeLineageMismatch,
  formatLineageMismatch,
  computeLineageHash,
  computeMessageHashes,
  computeMessageBlockHashes,
  type SessionState,
} from "../proxy/session/lineage"

const toolResult = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content })
const text = (t: string) => ({ type: "text", text: t })

function session(messages: Array<{ role: string; content: any }>, withBlockHashes = true): SessionState {
  return {
    claudeSessionId: "sess",
    lastAccess: 0,
    lineageHash: computeLineageHash(messages),
    messageCount: messages.length,
    messageHashes: computeMessageHashes(messages),
    ...(withBlockHashes ? { messageBlockHashes: computeMessageBlockHashes(messages) } : {}),
  } as SessionState
}

/** A two-message history whose trailing message we then vary. */
function baseline(trailing: any[]) {
  return [
    { role: "user", content: [text("do the thing")] },
    { role: "user", content: trailing },
  ]
}

describe("describeLineageMismatch block accounting", () => {
  it("names an append when the stored blocks survive as an ordered prefix", () => {
    const stored = baseline([toolResult("a", "res")])
    const incoming = baseline([toolResult("a", "res"), text("<system-reminder>note</system-reminder>")])
    const m = describeLineageMismatch(session(stored), incoming)
    expect(m.index).toBe(1)
    expect(m.storedBlockCount).toBe(1)
    expect(m.incomingBlockCount).toBe(2)
    expect(m.blockChange).toBe("appended")
  })

  it("names a drop when the incoming blocks are an ordered prefix of stored", () => {
    const stored = baseline([toolResult("a", "res"), text("note")])
    const incoming = baseline([toolResult("a", "res")])
    const m = describeLineageMismatch(session(stored), incoming)
    expect(m.storedBlockCount).toBe(2)
    expect(m.incomingBlockCount).toBe(1)
    expect(m.blockChange).toBe("dropped")
  })

  it("names an in-place rewrite when the count is unchanged", () => {
    const stored = baseline([text("original")])
    const incoming = baseline([text("edited")])
    const m = describeLineageMismatch(session(stored), incoming)
    expect(m.storedBlockCount).toBe(1)
    expect(m.incomingBlockCount).toBe(1)
    expect(m.blockChange).toBe("rewritten")
  })

  // The distinction that matters for safety: growing is not the same as
  // appending. Dropping one block and adding two also grows the list, and
  // calling that an append would describe a rewrite as safe to resume.
  it("does NOT call a grown-but-altered list an append", () => {
    const stored = baseline([text("first"), text("second")])
    const incoming = baseline([text("CHANGED"), text("second"), text("third")])
    const m = describeLineageMismatch(session(stored), incoming)
    expect(m.incomingBlockCount!).toBeGreaterThan(m.storedBlockCount!)
    expect(m.blockChange).toBe("rewritten")
  })

  it("does NOT call a shrunk-but-altered list a drop", () => {
    const stored = baseline([text("first"), text("second"), text("third")])
    const incoming = baseline([text("CHANGED"), text("second")])
    const m = describeLineageMismatch(session(stored), incoming)
    expect(m.incomingBlockCount!).toBeLessThan(m.storedBlockCount!)
    expect(m.blockChange).toBe("rewritten")
  })

  it("names a reorder when the same blocks moved", () => {
    const stored = baseline([text("alpha"), text("bravo")])
    const incoming = baseline([text("bravo"), text("alpha")])
    const m = describeLineageMismatch(session(stored), incoming)
    expect(m.blockChange).toBe("reordered")
  })

  it("reports unknown for a session cached before block hashes existed", () => {
    const stored = baseline([toolResult("a", "res")])
    const incoming = baseline([toolResult("a", "res"), text("note")])
    const m = describeLineageMismatch(session(stored, false), incoming)
    expect(m.storedBlockCount).toBeUndefined()
    expect(m.blockChange).toBe("unknown")
  })
})

describe("formatLineageMismatch output", () => {
  it("prints the block transition and the verdict", () => {
    const stored = baseline([toolResult("a", "res")])
    const incoming = baseline([toolResult("a", "res"), text("note")])
    const line = formatLineageMismatch(describeLineageMismatch(session(stored), incoming))!
    expect(line).toContain("stored 1 blocks -> incoming 2 blocks")
    expect(line).toContain("(appended)")
  })

  it("says so plainly when the stored block hashes are unavailable", () => {
    const stored = baseline([text("a")])
    const incoming = baseline([text("b")])
    const line = formatLineageMismatch(describeLineageMismatch(session(stored, false), incoming))!
    expect(line).toContain("stored block hashes unavailable")
    expect(line).not.toContain("(unknown)")
  })

  // The line is pasted into public issues; it must stay content-free.
  it("leaks no message content", () => {
    const secret = "SUPER-SECRET-PROMPT-TEXT"
    const stored = baseline([text(secret)])
    const incoming = baseline([text(secret), text("ANOTHER-SECRET")])
    const line = formatLineageMismatch(describeLineageMismatch(session(stored), incoming))!
    expect(line).not.toContain(secret)
    expect(line).not.toContain("ANOTHER-SECRET")
  })

  it("still returns undefined when the whole prefix matched", () => {
    const stored = baseline([text("a")])
    expect(formatLineageMismatch(describeLineageMismatch(session(stored), stored))).toBeUndefined()
  })

  // #886's own captures: four rows were `user[tool_result,text]` and two were
  // `user[text]`, and the reporter could not tell which were appends. Both
  // shapes now classify themselves.
  it("classifies the two shapes from the report's captures", () => {
    const appendShape = describeLineageMismatch(
      session(baseline([toolResult("a", "res")])),
      baseline([toolResult("a", "res"), text("reminder")]),
    )
    expect(appendShape.blockChange).toBe("appended")
    const textOnlyShape = describeLineageMismatch(
      session(baseline([text("turn")])),
      baseline([text("turn edited")]),
    )
    expect(textOnlyShape.blockChange).toBe("rewritten")
  })
})
