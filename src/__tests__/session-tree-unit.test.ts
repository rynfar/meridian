/**
 * Unit tests for the live session-tree registry (issue #902).
 *
 * Pure module, no mocks: registration, settle-removal, transitive subtree
 * computation, and the hostile shapes that arrive off the wire (cycles,
 * self-links, absurd depth).
 */
import { describe, it, expect } from "bun:test"
import {
  SessionTreeRegistry,
  processSessionTree,
  truncateSessionKey,
} from "../proxy/sessionTree"

interface Aborted {
  requestId: string
  reason?: unknown
}

function tracker() {
  const aborted: Aborted[] = []
  const entry = (requestId: string, sessionKey: string, parentKey?: string) => ({
    requestId,
    sessionKey,
    parentKey,
    abort: (reason?: unknown) => { aborted.push({ requestId, reason }) },
  })
  return { aborted, entry }
}

describe("SessionTreeRegistry — registration and settle-removal", () => {
  it("tracks live requests and reports how many declared a parent", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    expect(registry.stats()).toEqual({
      tracked: 0, linked: 0, propagations: 0, cancelledDescendants: 0,
    })

    const root = registry.register(entry("r1", "parent"))
    const child = registry.register(entry("r2", "child", "parent"))

    expect(registry.stats().tracked).toBe(2)
    expect(registry.stats().linked).toBe(1)

    root.release()
    child.release()
    expect(registry.stats().tracked).toBe(0)
    expect(registry.stats().linked).toBe(0)
  })

  it("leaves nothing behind after every request settles", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    for (let i = 0; i < 50; i++) {
      const a = registry.register(entry(`p${i}`, `parent-${i}`))
      const b = registry.register(entry(`c${i}`, `child-${i}`, `parent-${i}`))
      b.release()
      a.release()
    }

    expect(registry.stats().tracked).toBe(0)
    // The parent index must drain too — a leaked empty Set per session key is
    // exactly the unbounded growth this registry exists to avoid.
    expect(registry.descendantsOf("parent-7")).toEqual([])
    registry.register(entry("late", "child-7", "parent-7"))
    expect(registry.descendantsOf("parent-7").map((e) => e.requestId)).toEqual(["late"])
  })

  it("release is idempotent and does not disturb a sibling", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    const first = registry.register(entry("r1", "child", "parent"))
    registry.register(entry("r2", "child", "parent"))

    first.release()
    first.release()
    first.release()

    expect(registry.stats().tracked).toBe(1)
    expect(registry.descendantsOf("parent").map((e) => e.requestId)).toEqual(["r2"])
  })

  it("keeps concurrent requests apart when the client reuses one request id", () => {
    const registry = new SessionTreeRegistry()
    const { aborted, entry } = tracker()

    // x-request-id is client-supplied, so a collision is a client's choice, not
    // a proxy invariant. Keying the registry on it would unregister the wrong
    // entry and silently drop a live child from cancellation.
    const first = registry.register(entry("same-id", "child-a", "parent"))
    registry.register(entry("same-id", "child-b", "parent"))
    first.release()

    registry.cancelDescendants("parent")
    expect(aborted.map((a) => a.requestId)).toEqual(["same-id"])
    expect(registry.descendantsOf("parent").map((e) => e.sessionKey)).toEqual(["child-b"])
  })
})

describe("SessionTreeRegistry — subtree computation", () => {
  it("walks a multi-level tree transitively, nearest level first", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    registry.register(entry("r-root", "root"))
    registry.register(entry("r-a", "a", "root"))
    registry.register(entry("r-b", "b", "root"))
    registry.register(entry("r-a1", "a1", "a"))
    registry.register(entry("r-a1x", "a1x", "a1"))
    registry.register(entry("r-unrelated", "elsewhere", "other-root"))

    expect(registry.descendantsOf("root").map((e) => e.requestId))
      .toEqual(["r-a", "r-b", "r-a1", "r-a1x"])
    expect(registry.descendantsOf("a").map((e) => e.requestId)).toEqual(["r-a1", "r-a1x"])
    expect(registry.descendantsOf("a1x")).toEqual([])
    expect(registry.descendantsOf("root").some((e) => e.sessionKey === "elsewhere")).toBe(false)
  })

  it("includes every live request sharing one child key", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    // The turn coordinator serializes turns per key, so a second request on the
    // same child key is queued rather than absent — and it is the one a parent
    // abort most needs to reach.
    registry.register(entry("running", "child", "parent"))
    registry.register(entry("queued", "child", "parent"))
    registry.register(entry("grandchild", "grandchild", "child"))

    expect(registry.descendantsOf("parent").map((e) => e.requestId))
      .toEqual(["running", "queued", "grandchild"])
  })

  it("terminates on a cycle stamped by the client", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    registry.register(entry("r-a", "a", "b"))
    registry.register(entry("r-b", "b", "a"))

    expect(registry.descendantsOf("a").map((e) => e.requestId)).toEqual(["r-b", "r-a"])
    expect(registry.descendantsOf("b").map((e) => e.requestId)).toEqual(["r-a", "r-b"])
  })

  it("ignores a self-link so a request is never its own descendant", () => {
    const registry = new SessionTreeRegistry()
    const { aborted, entry } = tracker()

    registry.register(entry("r-self", "same", "same"))

    expect(registry.descendantsOf("same")).toEqual([])
    expect(registry.stats().linked).toBe(1)
    registry.cancelDescendants("same")
    expect(aborted).toEqual([])
  })

  it("bounds a pathologically deep chain", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    for (let i = 1; i <= 500; i++) {
      registry.register(entry(`r${i}`, `k${i}`, `k${i - 1}`))
    }

    const reached = registry.descendantsOf("k0")
    expect(reached.length).toBeGreaterThan(0)
    expect(reached.length).toBeLessThan(500)
  })
})

describe("SessionTreeRegistry — cancellation", () => {
  it("aborts the whole subtree and leaves the origin request alone", () => {
    const registry = new SessionTreeRegistry()
    const { aborted, entry } = tracker()

    registry.register(entry("r-root", "root"))
    registry.register(entry("r-a", "a", "root"))
    registry.register(entry("r-a1", "a1", "a"))

    const reason = new Error("parent cancelled")
    const result = registry.cancelDescendants("root", reason)

    expect(aborted.map((a) => a.requestId)).toEqual(["r-a", "r-a1"])
    expect(aborted.every((a) => a.reason === reason)).toBe(true)
    expect(result.keys).toEqual(["a", "a1"])
    expect(result.requestIds).toEqual(["r-a", "r-a1"])
  })

  it("counts propagations and cancelled descendants", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    registry.register(entry("r-a", "a", "root"))
    registry.register(entry("r-a1", "a1", "a"))
    registry.cancelDescendants("root")

    expect(registry.stats().propagations).toBe(1)
    expect(registry.stats().cancelledDescendants).toBe(2)

    // An idle subtree is not a propagation: there was nothing in flight, which
    // is the normal case for a client that spawns no subagents.
    registry.cancelDescendants("nobody-here")
    expect(registry.stats().propagations).toBe(1)
    expect(registry.stats().cancelledDescendants).toBe(2)
  })

  it("cancels every sibling even when one abort handle throws", () => {
    const registry = new SessionTreeRegistry()
    const aborted: string[] = []

    registry.register({
      requestId: "r-bad", sessionKey: "bad", parentKey: "root",
      abort: () => { throw new Error("teardown exploded") },
    })
    registry.register({
      requestId: "r-good", sessionKey: "good", parentKey: "root",
      abort: () => { aborted.push("r-good") },
    })

    const result = registry.cancelDescendants("root")
    expect(aborted).toEqual(["r-good"])
    expect(result.requestIds).toEqual(["r-bad", "r-good"])
  })

  it("cancelSubtree also aborts live requests on the origin key", () => {
    const registry = new SessionTreeRegistry()
    const { aborted, entry } = tracker()

    registry.register(entry("r-root", "root"))
    registry.register(entry("r-a", "a", "root"))

    const result = registry.cancelSubtree("root")
    expect(aborted.map((a) => a.requestId)).toEqual(["r-root", "r-a"])
    expect(result.keys).toEqual(["root", "a"])
    // Only the descendant counts as a propagated child cancellation.
    expect(registry.stats().cancelledDescendants).toBe(1)
  })

  it("does not reach a request that already settled", () => {
    const registry = new SessionTreeRegistry()
    const { aborted, entry } = tracker()

    const child = registry.register(entry("r-a", "a", "root"))
    child.release()

    expect(registry.cancelDescendants("root")).toEqual({ keys: [], requestIds: [] })
    expect(aborted).toEqual([])
  })

  it("clear() resets both the live index and the counters", () => {
    const registry = new SessionTreeRegistry()
    const { entry } = tracker()

    registry.register(entry("r-a", "a", "root"))
    registry.cancelDescendants("root")
    registry.clear()

    expect(registry.stats()).toEqual({
      tracked: 0, linked: 0, propagations: 0, cancelledDescendants: 0,
    })
  })
})

describe("truncateSessionKey", () => {
  it("shortens long keys and leaves short ones alone", () => {
    expect(truncateSessionKey("0123456789abcdef")).toBe("01234567…")
    expect(truncateSessionKey("short")).toBe("short")
    expect(truncateSessionKey("0123456789", 4)).toBe("0123…")
  })
})

describe("processSessionTree", () => {
  it("is a shared registry so a parent and child on different proxy instances still link", () => {
    processSessionTree.clear()
    const aborted: string[] = []
    const child = processSessionTree.register({
      requestId: "r-child",
      sessionKey: "child",
      parentKey: "parent",
      abort: () => { aborted.push("r-child") },
    })

    expect(processSessionTree.cancelDescendants("parent").requestIds).toEqual(["r-child"])
    expect(aborted).toEqual(["r-child"])

    child.release()
    processSessionTree.clear()
  })
})
