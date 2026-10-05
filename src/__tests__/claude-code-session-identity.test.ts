import { describe, expect, it } from "bun:test"
import type { Context } from "hono"
import { claudeCodeAdapter, claudeCodeSessionKey } from "../proxy/adapters/claudecode"
import { SessionTreeRegistry } from "../proxy/sessionTree"

const PREFIX = "\u0000meridian-claude-code:1:"
const body = (sessionId: string, parentSessionId?: string) => ({
  metadata: { user_id: { session_id: sessionId, ...(parentSessionId ? { parent_session_id: parentSessionId } : {}) } },
})
const context = (agentId?: string): Context => ({
  req: { header: (name: string) => name === "x-claude-code-agent-id" ? agentId : undefined },
} as unknown as Context)

describe("Claude Code internal session identity", () => {
  it("separates the old derived/bare collision without changing ordinary main keys", () => {
    const agent = claudeCodeSessionKey("a", body("s"))
    const main = claudeCodeSessionKey(undefined, body("s:agent:a"))
    expect(main).toBe("s:agent:a")
    expect(agent).not.toBe(main)
    expect(claudeCodeSessionKey(undefined, body("native-uuid"))).toBe("native-uuid")
  })

  it("escapes a main ID equal to a reserved agent key into a disjoint main key", () => {
    const agent = claudeCodeSessionKey("a", body("s"))
    if (!agent) throw new Error("missing synthetic agent key")
    const main = claudeCodeSessionKey(undefined, body(agent))
    expect(main).not.toBe(agent)
    expect(main).toBe(`${PREFIX}${JSON.stringify(["main", agent])}`)
    expect(claudeCodeSessionKey("a", body(agent))).not.toBe(main)
  })

  it("preserves separator, quote, slash, Unicode and NUL distinctions", () => {
    const identities = ["s", "s:agent:a", 's\"', "s\\", "s\n", "\u0000s", "é", PREFIX, `${PREFIX}[]`]
    const keys = identities.flatMap(id => [claudeCodeSessionKey(undefined, body(id)), claudeCodeSessionKey("a", body(id))])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("falls malformed headers back to the same escaped main key", () => {
    const identity = body(`${PREFIX}owner-chosen`)
    const expected = claudeCodeSessionKey(undefined, identity)
    for (const id of ["", "has space", "a/b", "é", "a".repeat(129)]) {
      expect(claudeCodeSessionKey(id, identity)).toBe(expected)
    }
  })

  it("keeps account root affinity while requiring namespace ownership only on reserved keys", () => {
    expect(claudeCodeAdapter.getRootSessionId?.(context("a"), body("s"))).toBe("s")
    expect(claudeCodeAdapter.getSessionNamespace?.(context(), body("s"))).toBeUndefined()
    expect(claudeCodeAdapter.getSessionNamespace?.(context("a"), body("s"))).toBe("claude-code:1")
    const reserved = body(`${PREFIX}owner-chosen`)
    expect(claudeCodeAdapter.getRootSessionId?.(context("a"), reserved))
      .toBe(claudeCodeSessionKey(undefined, reserved))
    expect(claudeCodeAdapter.getSessionNamespace?.(context(), reserved)).toBe("claude-code:1")
    expect(claudeCodeAdapter.getSessionNamespace?.(context("a"), {})).toBeUndefined()
  })

  it("preserves a raw public root-cancel alias and declared main ancestry", () => {
    const parentId = `${PREFIX}parent`
    expect(claudeCodeAdapter.getParentSessionId?.(context("a"), body("child", parentId)))
      .toBe(claudeCodeSessionKey(undefined, body(parentId)))
    expect(claudeCodeAdapter.getParentSessionId?.(context("a"), body("s"))).toBeUndefined()
    expect(claudeCodeAdapter.getSessionCancelKey?.(context(), body(parentId))).toBe(parentId)
    expect(claudeCodeAdapter.getRootSessionCancelKey?.(context("a"), body(parentId))).toBe(parentId)
    expect(claudeCodeAdapter.getSessionCancelKey?.(context("a"), body("s")))
      .toBe(claudeCodeSessionKey("a", body("s")))
  })
})

describe("Explicit conversation cancellation is separate from automatic ancestry", () => {
  it("reaches native agents only for explicit root cancellation, with private leaves once", () => {
    const registry = new SessionTreeRegistry()
    const aborted: string[] = []
    const registrations = [
      registry.register({ requestId: "main", sessionKey: "root", explicitRootKey: "root", abort: () => aborted.push("main") }),
      registry.register({ requestId: "agent", sessionKey: "agent-key", explicitRootKey: "root", abort: () => aborted.push("agent") }),
      registry.register({ requestId: "aux", sessionKey: "private-leaf", parentKey: "agent-key", explicitRootKey: "root", abort: () => aborted.push("aux") }),
      registry.register({ requestId: "declared", sessionKey: "child", parentKey: "root", abort: () => aborted.push("declared") }),
      registry.register({ requestId: "other", sessionKey: "other", explicitRootKey: "other", abort: () => aborted.push("other") }),
    ]
    expect(registry.cancelDescendants("root").requestIds).toEqual(["declared"])
    aborted.length = 0
    expect(registry.cancelSubtree("root").requestIds).toEqual(["main", "agent", "aux", "declared"])
    expect(aborted).toEqual(["main", "agent", "aux", "declared"])
    aborted.length = 0
    expect(registry.cancelSubtree("agent-key").requestIds).toEqual(["agent", "aux"])
    expect(aborted).toEqual(["agent", "aux"])
    registrations.forEach(registration => registration.release())
    expect(registry.stats().tracked).toBe(0)
    expect(registry.cancelSubtree("root").requestIds).toEqual([])
  })

  it("prefers an exact live raw root over another agent's equal-looking cancel alias", () => {
    const registry = new SessionTreeRegistry()
    const aborted: string[] = []
    registry.register({ requestId: "agent", sessionKey: "reserved-key", explicitRootKey: "s", abort: () => aborted.push("agent") })
    registry.register({ requestId: "raw-root", sessionKey: "escaped-key", explicitCancelKey: "reserved-key", explicitRootKey: "reserved-key", explicitRootSessionKey: "escaped-key", abort: () => aborted.push("raw-root") })
    registry.register({ requestId: "declared-child", sessionKey: "child", parentKey: "escaped-key", abort: () => aborted.push("declared-child") })
    expect(registry.cancelSubtree("reserved-key").requestIds).toEqual(["raw-root", "declared-child"])
    expect(aborted).toEqual(["raw-root", "declared-child"])
    registry.clear()
    expect(registry.stats().tracked).toBe(0)
  })
})
