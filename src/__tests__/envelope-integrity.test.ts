/**
 * Envelope integrity checks — pure functions, no mocks.
 *
 * Every #552-family bug (red reads, beheaded parallel calls, lost tool
 * inputs) was visible at response time as a wire-contract violation the
 * proxy could have detected itself: a block left open at stream close, a
 * captured call never delivered, a tool_use delivered with empty input
 * where the tool requires arguments. These checks turn this week's scars
 * into always-on runtime tripwires — violations are logged and counted on
 * the dashboard so the NEXT regression shows up in our logs, not in a
 * user's redacted transcript two months later.
 */
import { describe, it, expect } from "bun:test"
import {
  checkEmptyToolInputs,
  checkUndeliveredToolUses,
  type EnvelopeViolation,
} from "../proxy/envelopeIntegrity"

const schema = (required: string[]) => ({
  type: "object",
  properties: Object.fromEntries(required.map(k => [k, { type: "string" }])),
  required,
})

describe("checkEmptyToolInputs", () => {
  const tools = [
    { name: "read", input_schema: schema(["filePath"]) },
    { name: "list_sessions", input_schema: { type: "object", properties: {} } },
  ]

  it("flags a tool_use with empty input when the tool requires arguments", () => {
    const v = checkEmptyToolInputs(
      [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      tools,
    )
    expect(v).toHaveLength(1)
    expect(v[0]!.type).toBe("empty_tool_input")
    expect(v[0]!.detail).toContain("read")
  })

  it("does NOT flag empty input for a tool with no required fields (legit no-arg call)", () => {
    const v = checkEmptyToolInputs(
      [{ type: "tool_use", id: "t1", name: "list_sessions", input: {} }],
      tools,
    )
    expect(v).toHaveLength(0)
  })

  it("does NOT flag tool_use with populated input", () => {
    const v = checkEmptyToolInputs(
      [{ type: "tool_use", id: "t1", name: "read", input: { filePath: "/a" } }],
      tools,
    )
    expect(v).toHaveLength(0)
  })

  it("does NOT flag unknown tools (no schema to judge against)", () => {
    const v = checkEmptyToolInputs(
      [{ type: "tool_use", id: "t1", name: "mystery", input: {} }],
      tools,
    )
    expect(v).toHaveLength(0)
  })

  it("ignores non-tool_use blocks and tolerates malformed input", () => {
    const v = checkEmptyToolInputs(
      [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t2", name: "read" }, // missing input entirely
      ],
      tools,
    )
    expect(v).toHaveLength(1) // missing input on a required-args tool IS a violation
  })

  it("handles undefined/empty tool list", () => {
    expect(checkEmptyToolInputs([{ type: "tool_use", id: "t", name: "read", input: {} }], undefined)).toHaveLength(0)
    expect(checkEmptyToolInputs([], tools)).toHaveLength(0)
  })
})

describe("checkUndeliveredToolUses", () => {
  it("flags captured calls that never reached the client", () => {
    const v = checkUndeliveredToolUses(
      [{ id: "t1", name: "read" }, { id: "t2", name: "glob" }],
      new Set(["t1"]),
    )
    expect(v).toHaveLength(1)
    expect(v[0]!.type).toBe("undelivered_tool_use")
    expect(v[0]!.detail).toContain("glob")
  })

  it("passes when everything captured was delivered", () => {
    const v = checkUndeliveredToolUses(
      [{ id: "t1", name: "read" }],
      new Set(["t1", "t9"]),
    )
    expect(v).toHaveLength(0)
  })

  it("passes with no captures", () => {
    expect(checkUndeliveredToolUses([], new Set())).toHaveLength(0)
  })
})
