/**
 * The silent-turn invariant: a terminal envelope must carry text or a tool call.
 *
 * These tests pin the three production shapes that motivated the module, using
 * the numbers actually recorded in telemetry for each. If a future change makes
 * any of them classify as productive, the guard stops guarding and the class of
 * defect goes invisible again.
 */
import { describe, it, expect } from "bun:test"
import {
  classifyTurnOutcome,
  hasTruncatableText,
  createRecoveryLifter,
  shouldAttemptRecovery,
  SILENT_TURN_NUDGE,
  type TurnOutcome,
} from "../proxy/turnOutcome"

describe("hasTruncatableText", () => {
  it("retains nonempty prose, including alongside thinking", () => {
    expect(hasTruncatableText([{ type: "text", text: "partial" }])).toBe(true)
    expect(hasTruncatableText([{ type: "thinking", thinking: "private" }, { type: "text", text: "partial" }])).toBe(true)
  })

  it("rejects empty, malformed, and thinking-only content", () => {
    expect(hasTruncatableText([])).toBe(false)
    expect(hasTruncatableText([null, false, "text", { type: "text", text: 1 }, { type: "text", text: "" }])).toBe(false)
    expect(hasTruncatableText([{ type: "thinking", thinking: "private" }])).toBe(false)
  })

  it("does not legitimize an uncaptured tool call even alongside prose", () => {
    const text = { type: "text", text: "partial" }
    const call = { type: "tool_use", id: "unhandled", name: "write", input: {} }
    expect(hasTruncatableText([call])).toBe(false)
    expect(hasTruncatableText([text, call])).toBe(false)
    expect(hasTruncatableText([call, text])).toBe(false)
  })
})

describe("classifyTurnOutcome", () => {
  it("counts prose as productive", () => {
    expect(classifyTurnOutcome({ textEvents: 12, toolUses: 0, blocksForwarded: 3 }))
      .toEqual({ kind: "productive" })
  })

  it("counts a tool call with no prose as productive — the client has work to do", () => {
    expect(classifyTurnOutcome({ textEvents: 0, toolUses: 2, blocksForwarded: 5 }))
      .toEqual({ kind: "productive" })
  })

  // The spent-deny signature: 61 blocks, 667 output tokens, zero text events
  // (request abf94a0a, 2026-08-10 13:04 UTC). All of it thinking plus an empty
  // text block. This is the case that must never read as healthy.
  it("calls thinking with an empty text block silent, however many blocks it spent", () => {
    expect(classifyTurnOutcome({ textEvents: 0, toolUses: 0, blocksForwarded: 61 }))
      .toEqual({ kind: "silent", reason: "no_actionable_content" })
  })

  it("distinguishes a turn that forwarded nothing at all", () => {
    expect(classifyTurnOutcome({ textEvents: 0, toolUses: 0, blocksForwarded: 0 }))
      .toEqual({ kind: "silent", reason: "no_blocks" })
  })

  // An empty text BLOCK yields a start and a stop with no delta between them,
  // so block counting cannot see it — only delta counting can. Guards the
  // reason the input is textEvents and not textBlocks.
  it("does not accept an empty text block as text", () => {
    expect(classifyTurnOutcome({ textEvents: 0, toolUses: 0, blocksForwarded: 2 }).kind)
      .toBe("silent")
  })
})

describe("classifyTurnOutcome: the announce window", () => {
  // The live case that slipped past the silent invariant (request a342c863,
  // 2026-08-11 10:54 UTC): a deny-boundary continuation on a session's second
  // exchange — thinking, then one short text that only announced the work
  // ("I'll start by auditing…", 131 chars), zero tool calls, end_turn. Text
  // arrived, so silence detection stays quiet; only the length test inside
  // the narrow window can see it.
  // The window this once classified as "announce" — deny-boundary continuation,
  // short text, short conversation — measured against a live model as the shape
  // of an ordinary concise answer: 12 recoveries across 12 healthy turns, one of
  // which rewrote a finished answer into a tool_use envelope. Text is an answer.
  const shortTextOnDenyBoundary = {
    textEvents: 2,
    toolUses: 0,
    blocksForwarded: 4,
  }

  it("a short text-only final on a deny boundary is productive, not recovered", () => {
    expect(classifyTurnOutcome(shortTextOnDenyBoundary)).toEqual({ kind: "productive" })
  })

  it("a tool call is productive with no text at all", () => {
    expect(classifyTurnOutcome({ textEvents: 0, toolUses: 1, blocksForwarded: 2 }))
      .toEqual({ kind: "productive" })
  })

  it("no text and no tool call is still silent", () => {
    expect(classifyTurnOutcome({ ...shortTextOnDenyBoundary, textEvents: 0 }).kind)
      .toBe("silent")
  })
})

describe("shouldAttemptRecovery", () => {
  const silent: TurnOutcome = { kind: "silent", reason: "no_actionable_content" }
  const base = {
    outcome: silent,
    alreadyAttempted: false,
    clientGone: false,
    sessionId: "sdk-session-1",
    enabled: true,
  }

  it("recovers a silent turn once", () => {
    expect(shouldAttemptRecovery(base)).toBe(true)
  })

  it("never recovers a productive turn", () => {
    expect(shouldAttemptRecovery({ ...base, outcome: { kind: "productive" } })).toBe(false)
  })

  // One attempt, not a loop. A model that answers empty twice is not going to
  // be argued into answering, and each attempt is a billed turn.
  it("does not retry a second time", () => {
    expect(shouldAttemptRecovery({ ...base, alreadyAttempted: true })).toBe(false)
  })

  it("does not spend a turn writing into a closed socket", () => {
    expect(shouldAttemptRecovery({ ...base, clientGone: true })).toBe(false)
  })

  it("needs a session to continue from", () => {
    expect(shouldAttemptRecovery({ ...base, sessionId: undefined })).toBe(false)
  })

  it("honours the kill switch", () => {
    expect(shouldAttemptRecovery({ ...base, enabled: false })).toBe(false)
  })
})

describe("SILENT_TURN_NUDGE", () => {
  // The CLI's own nudge failed on all three observed cases because it left the
  // offending instruction standing. This one has to discharge it, or it is the
  // same failed move under a new name.
  it("discharges the end-turn instruction rather than just asking again", () => {
    expect(SILENT_TURN_NUDGE.toLowerCase()).toContain("discharged")
    expect(SILENT_TURN_NUDGE.toLowerCase()).toContain("applied only to")
  })

  it("allows a tool call as a valid answer, not only prose", () => {
    expect(SILENT_TURN_NUDGE.toLowerCase()).toContain("tool call")
  })

  it("adds no transcript markers for the model to imitate (#496)", () => {
    expect(SILENT_TURN_NUDGE).not.toContain("Human:")
    expect(SILENT_TURN_NUDGE).not.toContain("[Assistant:")
  })
})

describe("createRecoveryLifter", () => {
  const textStart = { type: "content_block_start", content_block: { type: "text" } }
  const delta = (text: string) => ({ type: "content_block_delta", delta: { type: "text_delta", text } })
  const stop = { type: "content_block_stop" }

  const lifterAt = (first: number) => {
    let next = first
    return createRecoveryLifter(() => next++)
  }

  it("allocates the block index from the caller's space, so the recovery block continues the open message's numbering", () => {
    expect(lifterAt(7).lift(textStart)).toEqual({
      kind: "block_start",
      frame: { type: "content_block_start", index: 7, content_block: { type: "text", text: "" } },
    })
  })

  it("rewrites deltas onto the allocated index and reports their length", () => {
    const lifter = lifterAt(7)
    lifter.lift(textStart)
    expect(lifter.lift(delta("done"))).toEqual({
      kind: "text_delta",
      frame: { type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "done" } },
      textChars: 4,
    })
  })

  it("drops a delta arriving before any text block opened — emitting it would be malformed SSE", () => {
    expect(lifterAt(0).lift(delta("orphan"))).toBeUndefined()
  })

  it("releases the index on stop and drops trailing deltas and stops", () => {
    const lifter = lifterAt(3)
    lifter.lift(textStart)
    expect(lifter.lift(stop)).toEqual({ kind: "block_stop", frame: { type: "content_block_stop", index: 3 } })
    expect(lifter.lift(delta("late"))).toBeUndefined()
    expect(lifter.lift(stop)).toBeUndefined()
  })

  it("ignores non-text blocks entirely — a tool call is not lifted", () => {
    const lifter = lifterAt(0)
    expect(lifter.lift({ type: "content_block_start", content_block: { type: "tool_use" } })).toBeUndefined()
    expect(lifter.lift(delta("x"))).toBeUndefined()
  })

  it("gives a second text block a fresh index", () => {
    const lifter = lifterAt(5)
    lifter.lift(textStart)
    lifter.lift(stop)
    expect(lifter.lift(textStart)).toEqual({
      kind: "block_start",
      frame: { type: "content_block_start", index: 6, content_block: { type: "text", text: "" } },
    })
  })
})
