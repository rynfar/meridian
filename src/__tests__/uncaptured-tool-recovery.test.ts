/** Recovery and completeness checks for fully streamed client tool calls
 * rejected by CLI dispatch or stranded before PreToolUse capture. */
import { describe, expect, it } from "bun:test"
import {
  canRecoverUncapturedToolUses,
  isStreamedToolBlockComplete,
  unavailableToolResults,
  type StreamedToolBlockRecord,
} from "../proxy/errors"

const eligibleBase = {
  reason: "max_turns" as const,
  passthrough: true,
  capturedToolUses: 0,
  streamedToolUses: 1,
  droppedToolUseIds: 0,
  sawDuplicateToolUse: false,
  forceSingleToolUse: false,
  earlyStopFired: false,
  uncapturedRecoveryEnabled: true,
  confirmedToolUnavailable: false,
  attemptedMaxTurns: 1,
}

const completeBlock = (overrides: Partial<StreamedToolBlockRecord> = {}): StreamedToolBlockRecord => ({
  id: "toolu_1",
  name: "read",
  json: '{"file_path":"/x"}',
  startedInputObject: false,
  forwardedStart: true,
  naturalStop: true,
  ...overrides,
})

describe("canRecoverUncapturedToolUses", () => {
  it("accepts the canonical incident shape", () => {
    expect(canRecoverUncapturedToolUses(eligibleBase)).toBe(true)
  })

  it("refuses when the kill switch is off (default)", () => {
    expect(canRecoverUncapturedToolUses({
      ...eligibleBase,
      uncapturedRecoveryEnabled: false,
    })).toBe(false)
  })

  it("refuses non-max_turns reasons", () => {
    for (const reason of ["aborted", "upstream_idle", "process_exit", "unknown", "context_overflow"] as const) {
      expect(canRecoverUncapturedToolUses({ ...eligibleBase, reason })).toBe(false)
    }
  })

  it("refuses a turn this proxy did not cap at 1", () => {
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, attemptedMaxTurns: undefined })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, attemptedMaxTurns: 3 })).toBe(false)
  })

  it("refuses non-passthrough requests", () => {
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, passthrough: false })).toBe(false)
  })

  it("refuses when anything was captured (existing recovery owns that)", () => {
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, capturedToolUses: 1 })).toBe(false)
  })

  it("refuses when nothing streamed", () => {
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, streamedToolUses: 0 })).toBe(false)
  })

  it("refuses dropped / duplicate / forced-single / early-stop shapes", () => {
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, droppedToolUseIds: 1 })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, sawDuplicateToolUse: true })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, forceSingleToolUse: true })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, earlyStopFired: true })).toBe(false)
  })

  it("accepts explicit CLI rejection despite an early-stop signal", () => {
    expect(canRecoverUncapturedToolUses({
      ...eligibleBase,
      uncapturedRecoveryEnabled: false,
      confirmedToolUnavailable: true,
      earlyStopFired: true,
    })).toBe(true)
  })
})

describe("unavailableToolResults", () => {
  it("recognizes only the CLI's id-correlated dispatch refusal", () => {
    expect(unavailableToolResults([
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: "<tool_use_error>Error: No such tool available: read</tool_use_error>" },
      { type: "tool_result", tool_use_id: "t2", is_error: true, content: "permission denied" },
      { type: "tool_result", tool_use_id: "t3", is_error: false, content: "<tool_use_error>Error: No such tool available: glob</tool_use_error>" },
    ])).toEqual([{ id: "t1", name: "read" }])
  })
})


describe("isStreamedToolBlockComplete", () => {
  it("accepts a fully forwarded block with parseable object JSON", () => {
    expect(isStreamedToolBlockComplete(completeBlock())).toBe(true)
  })

  it("accepts a zero-argument call streamed as {} deltas", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: "{}" }))).toBe(true)
  })

  it("accepts an inline start input with no deltas", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: "", startedInputObject: true }))).toBe(true)
  })

  it("refuses a block that never saw its real content_block_stop", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ naturalStop: false }))).toBe(false)
  })

  it("refuses truncated JSON", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"file_path":' }))).toBe(false)
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"file_path":', startedInputObject: true }))).toBe(false)
  })

  it("refuses non-object JSON payloads", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: '["a","b"]' }))).toBe(false)
    expect(isStreamedToolBlockComplete(completeBlock({ json: '"just text"' }))).toBe(false)
    expect(isStreamedToolBlockComplete(completeBlock({ json: "42" }))).toBe(false)
  })

  it("refuses a block with no deltas and no inline input", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: "", startedInputObject: false }))).toBe(false)
  })

  it("refuses a record whose start was never forwarded", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ forwardedStart: false }))).toBe(false)
  })
})
