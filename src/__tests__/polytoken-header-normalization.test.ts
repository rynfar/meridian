/**
 * Polytoken native session-header normalization — direct unit tests.
 *
 * The native contract: X-Polytoken-Session is the session identity. It is
 * trimmed of surrounding whitespace, passed through unchanged when nonempty,
 * and treated as absent when missing, empty, or whitespace-only.
 *
 * Deliberately NOT like jcode: no charset restriction, no fixed fallback, no
 * profile prefix, no affinity-header fallback. The value the client sent is
 * the value Meridian uses.
 */
import { describe, it, expect } from "bun:test"
import { normalizePolytokenSessionId } from "../proxy/adapters/polytoken"

describe("normalizePolytokenSessionId", () => {
  it("returns a plain value unchanged", () => {
    expect(normalizePolytokenSessionId("sess-abc-123")).toBe("sess-abc-123")
  })

  it("preserves internal whitespace and case exactly", () => {
    expect(normalizePolytokenSessionId("Session ABC_01:turn-2")).toBe("Session ABC_01:turn-2")
  })

  it("trims surrounding whitespace", () => {
    expect(normalizePolytokenSessionId("  sess-1\t")).toBe("sess-1")
    expect(normalizePolytokenSessionId("\n sess-2 \n")).toBe("sess-2")
  })

  it("returns undefined for missing/empty/whitespace-only values", () => {
    expect(normalizePolytokenSessionId(undefined)).toBeUndefined()
    expect(normalizePolytokenSessionId("")).toBeUndefined()
    expect(normalizePolytokenSessionId("   ")).toBeUndefined()
    expect(normalizePolytokenSessionId("\t\n")).toBeUndefined()
  })

  it("keeps values that look like other adapters' ids (no charset restriction)", () => {
    // A UUID, a path-ish string, a unicode id — all valid native session ids.
    expect(normalizePolytokenSessionId("0f3a9d2e-8b71-4c3d-9f0a-6e5d4c3b2a1f")).toBe(
      "0f3a9d2e-8b71-4c3d-9f0a-6e5d4c3b2a1f",
    )
    expect(normalizePolytokenSessionId("/home/user/session#42")).toBe("/home/user/session#42")
    expect(normalizePolytokenSessionId("会话-1")).toBe("会话-1")
  })

  it("does not apply a profile prefix or any fallback (identity is passthrough)", () => {
    // Whatever goes in comes out unchanged; no synthesized key for blank input.
    expect(normalizePolytokenSessionId("profile-a:sess-1")).toBe("profile-a:sess-1")
    // A value that is entirely whitespace after trimming is absent — no fallback.
    expect(normalizePolytokenSessionId("profile-a: ")).toBe("profile-a:")
    expect(normalizePolytokenSessionId(":\t ")).toBe(":")
    expect(normalizePolytokenSessionId(" \t\n ")).toBeUndefined()
  })
})