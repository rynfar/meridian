/** Recovery and completeness checks for fully streamed client tool calls
 * rejected by CLI dispatch or stranded before PreToolUse capture. */
import { describe, expect, it } from "bun:test"
import {
  canRecoverUncapturedToolUses,
  cliRejectedToolResults,
  isStreamedToolBlockComplete,
  streamedToolBlockVeto,
  uncapturedRecoveryVeto,
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

  it("accepts explicit CLI rejection at the deferred-tools budget, despite hidden-digest drops", () => {
    const confirmed = { ...eligibleBase, uncapturedRecoveryEnabled: false, confirmedToolUnavailable: true, earlyStopFired: true }
    expect(canRecoverUncapturedToolUses({ ...confirmed, attemptedMaxTurns: 4 })).toBe(true)
    expect(canRecoverUncapturedToolUses({ ...confirmed, attemptedMaxTurns: 4, droppedToolUseIds: 2 })).toBe(true)
    expect(canRecoverUncapturedToolUses({ ...confirmed, attemptedMaxTurns: undefined })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...confirmed, attemptedMaxTurns: 4, capturedToolUses: 1 })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...confirmed, attemptedMaxTurns: 4, forceSingleToolUse: true })).toBe(false)
  })

  it("keeps the unproven opt-in path at the one-turn cap with no drops", () => {
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, attemptedMaxTurns: 4 })).toBe(false)
    expect(canRecoverUncapturedToolUses({ ...eligibleBase, droppedToolUseIds: 1 })).toBe(false)
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

describe("uncapturedRecoveryVeto", () => {
  it("names nothing for an eligible turn", () => {
    expect(uncapturedRecoveryVeto(eligibleBase)).toBeUndefined()
  })

  it("names the first condition that blocks recovery", () => {
    expect(uncapturedRecoveryVeto({ ...eligibleBase, uncapturedRecoveryEnabled: false })).toBe("disabled")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, passthrough: false })).toBe("not_passthrough")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, reason: "aborted" })).toBe("not_max_turns")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, attemptedMaxTurns: undefined })).toBe("turn_budget")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, attemptedMaxTurns: 4 })).toBe("turn_budget")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, capturedToolUses: 1 })).toBe("captured")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, streamedToolUses: 0 })).toBe("nothing_streamed")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, droppedToolUseIds: 1 })).toBe("dropped")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, sawDuplicateToolUse: true })).toBe("duplicate")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, forceSingleToolUse: true })).toBe("forced_single")
    expect(uncapturedRecoveryVeto({ ...eligibleBase, earlyStopFired: true })).toBe("early_stop")
  })
})

// The CLI envelope Claude Code 2.1.296 writes when fine-grained tool streaming
// delivers arguments it cannot parse (here a raw TAB inside a string), with
// synthetic arguments. Validation runs before PreToolUse and before execution.
const UNPARSED_RAW = '{"path": "/repo/lib/render.ts", "edits": [{"oldText":"\tlet total = 0;\\n\\tfor (const item of items) {\\n\\t\\ttotal += item.size;\\n\\t}",' +
  '"newText":"\tlet total = 0;\\n\\tfor (const item of items) total += item.size;"}]}'
const UNPARSED_INPUT_RESULT = "<tool_use_error>InputValidationError: mcp__oc__edit was called with input that could not be parsed as JSON.\n" +
  `You sent (first ${Math.min(UNPARSED_RAW.length, 200)} of ${UNPARSED_RAW.length} bytes): ${UNPARSED_RAW.slice(0, 200)}\n` +
  "Common causes: unescaped backslashes in file paths (use / or \\\\), unescaped control characters, or truncated output. Retry with valid JSON.</tool_use_error>"

describe("cliRejectedToolResults", () => {
  it("recognizes only the CLI's id-correlated dispatch refusal", () => {
    expect(cliRejectedToolResults([
      { type: "tool_result", tool_use_id: "t1", is_error: true, content: "<tool_use_error>Error: No such tool available: read</tool_use_error>" },
      { type: "tool_result", tool_use_id: "t2", is_error: true, content: "permission denied" },
      { type: "tool_result", tool_use_id: "t3", is_error: false, content: "<tool_use_error>Error: No such tool available: glob</tool_use_error>" },
    ])).toEqual([{ id: "t1", name: "read" }])
  })

  it("recognizes the CLI's unparseable-input rejection in the exact CLI envelope", () => {
    expect(cliRejectedToolResults([
      { type: "tool_result", tool_use_id: "toolu_unparsed_1", is_error: true, content: UNPARSED_INPUT_RESULT },
    ])).toEqual([{ id: "toolu_unparsed_1", name: "mcp__oc__edit" }])
  })

  it("can isolate name-dispatch refusals from malformed-input recovery", () => {
    expect(cliRejectedToolResults([
      { type: "tool_result", tool_use_id: "name", is_error: true, content: "<tool_use_error>Error: No such tool available: read</tool_use_error>" },
      { type: "tool_result", tool_use_id: "json", is_error: true, content: UNPARSED_INPUT_RESULT },
    ], true)).toEqual([{ id: "name", name: "read" }])
  })

  it("requires the error flag and the complete CLI envelope for unparseable input", () => {
    expect(cliRejectedToolResults([
      { type: "tool_result", tool_use_id: "t1", is_error: false, content: UNPARSED_INPUT_RESULT },
      { type: "tool_result", tool_use_id: "t2", is_error: true, content: UNPARSED_INPUT_RESULT.replace("</tool_use_error>", "") },
      { type: "tool_result", tool_use_id: "t3", is_error: true, content: `note: ${UNPARSED_INPUT_RESULT}` },
      { type: "tool_result", is_error: true, content: UNPARSED_INPUT_RESULT },
    ])).toEqual([])
  })

  it("does not treat schema validation failures as dispatch rejections", () => {
    expect(cliRejectedToolResults([
      { type: "tool_result", tool_use_id: "t1", is_error: true,
        content: "<tool_use_error>InputValidationError: mcp__oc__read failed due to the following issue:\nThe required parameter `file_path` is missing</tool_use_error>" },
    ])).toEqual([])
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

  // Fine-grained tool streaming passes model JSON through unvalidated. The
  // client receives these deltas as-is, and Pi repairs exactly these defects.
  it("accepts object JSON whose strings hold raw control characters", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"path":"/x","edits":[{"oldText":"\tlet a","newText":"\tlet b"}]}' }))).toBe(true)
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"command":"echo a\necho b"}' }))).toBe(true)
  })

  it("refuses object JSON whose strings hold an invalid backslash escape", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"file_path":"C:\\dev\\x"}' }))).toBe(false)
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"file_path":"C:\\Users\\new"}' }))).toBe(false)
  })

  it("still refuses truncated or non-object JSON after repair", () => {
    expect(isStreamedToolBlockComplete(completeBlock({ json: '{"text":"a\tb"' }))).toBe(false)
    expect(isStreamedToolBlockComplete(completeBlock({ json: '["a\tb"]' }))).toBe(false)
  })
})

describe("streamedToolBlockVeto", () => {
  it("names why a streamed block cannot be delivered", () => {
    expect(streamedToolBlockVeto(completeBlock())).toBeUndefined()
    expect(streamedToolBlockVeto(completeBlock({ forwardedStart: false }))).toBe("unforwarded")
    expect(streamedToolBlockVeto(completeBlock({ naturalStop: false }))).toBe("unclosed")
    expect(streamedToolBlockVeto(completeBlock({ json: '{"file_path":' }))).toBe("incomplete_json")
    expect(streamedToolBlockVeto(completeBlock({ json: "", startedInputObject: false }))).toBe("incomplete_json")
  })
})
