import { describe, expect, test } from "bun:test"
import { PASSTHROUGH_DENY_REASON, isForwardedDenial } from "../proxy/passthroughDenial"

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
