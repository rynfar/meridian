import { describe, expect, test } from "bun:test"
import { PASSTHROUGH_DENY_REASON, PASSTHROUGH_HANDLED_REASON, PASSTHROUGH_NOT_FORWARDED_REASON, isForwardedDenial, isPassthroughHookBlock } from "../proxy/passthroughDenial"

function denialBlock(id: string) {
  return { type: "tool_result", tool_use_id: id, is_error: true, content: PASSTHROUGH_DENY_REASON }
}

describe("isForwardedDenial", () => {
  test("recognizes only the forwarding hook's synthetic denial", () => {
    expect(isForwardedDenial(denialBlock("x"))).toBe(true)
    expect(isForwardedDenial({
      type: "tool_result",
      tool_use_id: "x",
      is_error: true,
      content: [{ type: "text", text: PASSTHROUGH_DENY_REASON }],
    })).toBe(true)
    expect(isForwardedDenial({ type: "tool_result", tool_use_id: "x", is_error: true, content: "ENOENT" })).toBe(false)
    expect(isForwardedDenial({ type: "tool_result", tool_use_id: "x", content: PASSTHROUGH_DENY_REASON })).toBe(false)
    expect(isForwardedDenial({ type: "text", content: PASSTHROUGH_DENY_REASON })).toBe(false)
    expect(isForwardedDenial(undefined)).toBe(false)
  })
})

describe("isPassthroughHookBlock", () => {
  test("recognizes every synthetic hook block and no real result", () => {
    for (const reason of [PASSTHROUGH_DENY_REASON, PASSTHROUGH_HANDLED_REASON, PASSTHROUGH_NOT_FORWARDED_REASON]) {
      expect(isPassthroughHookBlock({ type: "tool_result", tool_use_id: "x", is_error: true, content: reason })).toBe(true)
      expect(isPassthroughHookBlock({ type: "tool_result", tool_use_id: "x", content: reason })).toBe(false)
    }
    expect(isPassthroughHookBlock({ type: "tool_result", tool_use_id: "x", is_error: true, content: "ENOENT" })).toBe(false)
    expect(isPassthroughHookBlock(undefined)).toBe(false)
  })
})
