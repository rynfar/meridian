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
  shouldAttemptRecovery,
  SILENT_TURN_NUDGE,
  type TurnOutcome,
} from "../proxy/turnOutcome"

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
