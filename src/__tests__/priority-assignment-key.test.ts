/**
 * Unit tests for the priority-pool assignment key.
 *
 * An explicit session id always wins. Without one, the conversation
 * fingerprint stands in — that is what gives keyless clients (Pylon's main
 * process, OpenCode setups that omit x-opencode-session) pool affinity.
 */

import { describe, expect, it } from "bun:test"
import { getPriorityAssignmentKey } from "../proxy/session/fingerprint"

const MESSAGES = [{ role: "user", content: "first message" }]

describe("getPriorityAssignmentKey", () => {
  it("returns the session id verbatim when one is present", () => {
    expect(getPriorityAssignmentKey("sess-1", MESSAGES, "/proj")).toBe("sess-1")
  })

  it("returns a session id verbatim even when it looks like a fingerprint key", () => {
    // Collision in this direction is impossible, but the passthrough must be
    // unconditional — never re-derive a key for an already-keyed client.
    expect(getPriorityAssignmentKey("fp:deadbeef", MESSAGES, "/proj")).toBe("fp:deadbeef")
  })

  it("falls back to a namespaced fingerprint when there is no session id", () => {
    const key = getPriorityAssignmentKey(undefined, MESSAGES, "/proj")
    expect(key).toStartWith("fp:")
    expect(key?.length).toBeGreaterThan(3)
  })

  it("is stable across calls for the same conversation", () => {
    const a = getPriorityAssignmentKey(undefined, MESSAGES, "/proj")
    const b = getPriorityAssignmentKey(undefined, MESSAGES, "/proj")
    expect(a).toBe(b)
  })

  it("uses the FIRST user message, so later turns of one conversation share a key", () => {
    const turn1 = [{ role: "user", content: "first message" }]
    const turn2 = [
      { role: "user", content: "first message" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "a follow-up question" },
    ]
    expect(getPriorityAssignmentKey(undefined, turn2, "/proj"))
      .toBe(getPriorityAssignmentKey(undefined, turn1, "/proj"))
  })

  it("distinguishes conversations with different first messages", () => {
    const other = [{ role: "user", content: "a different opening" }]
    expect(getPriorityAssignmentKey(undefined, other, "/proj"))
      .not.toBe(getPriorityAssignmentKey(undefined, MESSAGES, "/proj"))
  })

  it("distinguishes the same first message in different working directories", () => {
    expect(getPriorityAssignmentKey(undefined, MESSAGES, "/proj-a"))
      .not.toBe(getPriorityAssignmentKey(undefined, MESSAGES, "/proj-b"))
  })

  it("returns null when there is no user message", () => {
    expect(getPriorityAssignmentKey(undefined, [{ role: "assistant", content: "hi" }], "/proj")).toBeNull()
  })

  it("returns null when the first user message has no text content", () => {
    const noText = [{ role: "user", content: [{ type: "image", source: {} }] }]
    expect(getPriorityAssignmentKey(undefined, noText, "/proj")).toBeNull()
  })

  it("returns null for an empty message list rather than inventing a key", () => {
    expect(getPriorityAssignmentKey(undefined, [], "/proj")).toBeNull()
  })

  it("still derives a key when no working directory is available", () => {
    expect(getPriorityAssignmentKey(undefined, MESSAGES, undefined)).toStartWith("fp:")
  })
})
