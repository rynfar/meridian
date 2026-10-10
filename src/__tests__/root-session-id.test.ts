/**
 * The conversation root a request routes under. Adapters whose subagents carry
 * session keys of their own declare it; every other adapter is its own root.
 */
import { describe, it, expect } from "bun:test"
import type { Context } from "hono"
import { rootSessionIdOf } from "../proxy/adapter"
import { claudeCodeAdapter } from "../proxy/adapters/claudecode"

function context(headers: Record<string, string> = {}): Context {
  const ctx = { req: { header: (name: string) => headers[name.toLowerCase()] } }
  return ctx as unknown as Context
}

describe("rootSessionIdOf", () => {
  it("uses the session key for an adapter that declares no root", () => {
    const identity = { getSessionId: () => "own-key" }
    expect(rootSessionIdOf(identity, context(), {})).toBe("own-key")
  })

  it("prefers the adapter's declared root", () => {
    const identity = { getSessionId: () => "own-key", getRootSessionId: () => "root-key" }
    expect(rootSessionIdOf(identity, context(), {})).toBe("root-key")
  })

  it("falls back to the session key when the declared root is undefined", () => {
    const identity = { getSessionId: () => "own-key", getRootSessionId: () => undefined }
    expect(rootSessionIdOf(identity, context(), {})).toBe("own-key")
  })

  it("is undefined when the request has no session identity at all", () => {
    const identity = { getSessionId: () => undefined, getRootSessionId: () => undefined }
    expect(rootSessionIdOf(identity, context(), {})).toBeUndefined()
  })
})

describe("claudeCodeAdapter.getRootSessionId", () => {
  const body = { metadata: { user_id: JSON.stringify({ session_id: "conversation-sid" }) } }

  it("roots a Claude Code request at its metadata session id", () => {
    expect(claudeCodeAdapter.getRootSessionId!(context(), body)).toBe("conversation-sid")
  })

  it("is undefined without a metadata session id", () => {
    expect(claudeCodeAdapter.getRootSessionId!(context(), {})).toBeUndefined()
  })
})
