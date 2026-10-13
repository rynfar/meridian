import { describe, expect, test } from "bun:test"
import { DetachedLifecycle, DetachedRequestFrame, DETACHED_FRAME_BYTES, authenticatesDetachedRequest, parseDetachedRequest } from "../cli/detachedProtocol"

const identity = { instanceId: "12".repeat(16), nonce: "ab".repeat(32) }
const request = { version: 1, action: "stop", ...identity }
const encoded = Buffer.from(JSON.stringify(request) + "\n")

describe("private detached control admission", () => {
  test("fragmented request authenticates only its exact incarnation", () => {
    const frame = new DetachedRequestFrame()
    expect(frame.push(encoded.subarray(0, 19))).toBeUndefined()
    const parsed = frame.push(encoded.subarray(19))
    expect(parsed).toBeDefined()
    if (!parsed) throw new Error("Expected request")
    expect(authenticatesDetachedRequest(parsed, identity)).toBe(true)
    expect(authenticatesDetachedRequest(parsed, { ...identity, instanceId: "34".repeat(16) })).toBe(false)
    expect(authenticatesDetachedRequest(parsed, { ...identity, nonce: "ac".repeat(32) })).toBe(false)
    expect(authenticatesDetachedRequest(parsed, { ...identity, nonce: "ab" })).toBe(false)
  })

  test("rejects arbitrary commands and malformed identities before execution", () => {
    for (const value of [null, [], {}, { ...request, version: 2 }, { ...request, action: "kill" },
      { ...request, pid: 123 }, { ...request, nonce: "ab".repeat(32) + "x" },
      { ...request, instanceId: "12".repeat(16) + "\n" }, { ...request, nonce: "gg".repeat(32) }]) {
      expect(parseDetachedRequest(value)).toBeUndefined()
    }
  })

  test("bounds a fragmented frame before retaining its final chunk", () => {
    const frame = new DetachedRequestFrame()
    expect(frame.push(Buffer.alloc(DETACHED_FRAME_BYTES - 1, 32))).toBeUndefined()
    expect(() => frame.push(Buffer.from("xx"))).toThrow("too large")
    expect(() => frame.push(encoded)).toThrow("already complete")
  })

  test("does not admit request smuggling or invalid UTF-8", () => {
    expect(() => new DetachedRequestFrame().push(Buffer.concat([encoded, encoded]))).toThrow("one frame")
    expect(() => new DetachedRequestFrame().push(Buffer.from([0xff, 10]))).toThrow("Invalid")
    const frame = new DetachedRequestFrame()
    expect(frame.push(encoded)?.action).toBe("stop")
    expect(() => frame.push(encoded)).toThrow("already complete")
  })
})

describe("detached shutdown authority", () => {
  test("concurrent/repeated stop admits exactly one graceful action", () => {
    const lifecycle = new DetachedLifecycle()
    expect(lifecycle.ready()).toBe(true)
    expect([lifecycle.stop(), lifecycle.stop(), lifecycle.stop()]).toEqual([true, false, false])
    expect(lifecycle.phase).toBe("draining")
    lifecycle.exited()
    expect(lifecycle.stop()).toBe(false)
    expect(lifecycle.ready()).toBe(false)
    expect(lifecycle.phase).toBe("exited")
  })
  test("a late readiness notification cannot revive a cancelled startup", () => {
    const lifecycle = new DetachedLifecycle()
    expect(lifecycle.stop()).toBe(true)
    expect(lifecycle.ready()).toBe(false)
    expect(lifecycle.phase).toBe("draining")
    lifecycle.exited()
    expect(lifecycle.ready()).toBe(false)
  })
})
