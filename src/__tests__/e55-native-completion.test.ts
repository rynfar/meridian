import { describe, expect, test } from "bun:test"
import { isE55CanonicalCompletion } from "../../scripts/e2e-passthrough-claude-code-native.mjs"

const success = {
  requiredModel: "claude-sonnet-5-5", models: ["claude-sonnet-5-5"],
  completed: true, flagValid: true, terminalTargetMatched: true,
  subtype: "success", isError: false, inputTokens: 20, outputTokens: 10,
  cost: 0.01, maxTurns: 1, nativeTurns: 1, toolCalls: 0, assistantResponses: 1,
}

describe("E55 original native completion receipts", () => {
  test("accepts a canonical success or an actual one-turn tool checkpoint", () => {
    expect(isE55CanonicalCompletion(success)).toBe(true)
    expect(isE55CanonicalCompletion({ ...success, subtype: "error_max_turns", isError: true, toolCalls: 1, nativeTurns: 2 })).toBe(true)
  })

  test("does not reinterpret errors or missing boolean flags as success", () => {
    expect(isE55CanonicalCompletion({ ...success, isError: true })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, flagValid: false, isError: null })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, subtype: "error_during_execution" })).toBe(false)
  })

  test("a max-turn error needs the original capped tool witness", () => {
    const capped = { ...success, subtype: "error_max_turns", isError: true, toolCalls: 1, nativeTurns: 2 }
    expect(isE55CanonicalCompletion({ ...capped, toolCalls: 0 })).toBe(false)
    expect(isE55CanonicalCompletion({ ...capped, maxTurns: 4 })).toBe(false)
    expect(isE55CanonicalCompletion({ ...capped, nativeTurns: 0 })).toBe(false)
    expect(isE55CanonicalCompletion({ ...capped, assistantResponses: 2 })).toBe(false)
    expect(isE55CanonicalCompletion({ ...capped, assistantResponses: 0 })).toBe(false)
  })

  test("another model, another session or missing usage cannot qualify", () => {
    expect(isE55CanonicalCompletion({ ...success, models: ["claude-sonnet-5"] })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, models: [] })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, terminalTargetMatched: false })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, inputTokens: 0 })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, outputTokens: 0 })).toBe(false)
    expect(isE55CanonicalCompletion({ ...success, cost: NaN })).toBe(false)
  })
})
