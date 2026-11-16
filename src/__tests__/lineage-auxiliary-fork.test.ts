/**
 * Which auxiliary requests fork the conversation's session (auxiliaryLineage):
 * only a side call that adds user text after a completed turn. Every other
 * shape replays fresh, because a resumed fork would hand the model a history
 * the client does not hold.
 */

import { describe, expect, it } from "bun:test"
import { auxiliaryLineage, type LineageResult, type SessionState } from "../proxy/session/lineage"

const session = (overrides: Partial<SessionState> = {}): SessionState => ({
  claudeSessionId: "sdk-main",
  lastAccess: 0,
  messageCount: 1,
  lineageHash: "h",
  ...overrides,
})
const continuation = (overrides: Partial<SessionState> = {}): LineageResult => ({
  type: "continuation",
  session: session(overrides),
  resumeFrom: 1,
})

const FIRST = { role: "user", content: "read the config" }
const REPLY = { role: "assistant", content: [{ type: "text", text: "done" }] }
const RECAP = { role: "user", content: [{ type: "text", text: "Summarise where this session stands." }] }

describe("auxiliaryLineage", () => {
  it("forks a side call that adds user text after the session's last reply", () => {
    const result = continuation()
    expect(auxiliaryLineage(result, [FIRST, REPLY, RECAP])).toBe(result)
    // omp's side-channel reminder and the prompt as two user messages.
    expect(auxiliaryLineage(result, [FIRST, REPLY, { role: "user", content: "<system-reminder>side</system-reminder>" }, RECAP])).toBe(result)
  })

  it("replays a side call carrying a reply snapshot after a later user message", () => {
    const probe = [FIRST, REPLY, { role: "user", content: "and the tests?" }, { role: "assistant", content: "running" }, RECAP]
    expect(auxiliaryLineage(continuation(), probe).type).toBe("diverged")
  })

  it("replays when the copied reply calls a tool or a tool result follows", () => {
    const toolCall = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }
    expect(auxiliaryLineage(continuation(), [FIRST, toolCall, RECAP]).type).toBe("diverged")
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }
    expect(auxiliaryLineage(continuation(), [FIRST, REPLY, result, RECAP]).type).toBe("diverged")
  })

  it("replays over a pending tool checkpoint", () => {
    expect(auxiliaryLineage(continuation({ passthroughToolCallIds: ["t1"] }), [FIRST, REPLY, RECAP]).type).toBe("diverged")
  })

  it("replays a request that adds nothing, or one the conversation does not continue", () => {
    expect(auxiliaryLineage(continuation(), [FIRST, REPLY]).type).toBe("diverged")
    const undo: LineageResult = { type: "undo", session: session(), prefixOverlap: 1, rollbackUuid: "u1" }
    expect(auxiliaryLineage(undo, [FIRST, RECAP]).type).toBe("diverged")
    expect(auxiliaryLineage({ type: "diverged", reason: "not-found" }, [FIRST, RECAP])).toEqual({ type: "diverged", reason: "independent-request" })
  })

  it("replays a partial-message or regrouped resume", () => {
    const partial: LineageResult = { type: "continuation", session: session(), resumeFrom: 1, resumeContentFrom: 2 }
    expect(auxiliaryLineage(partial, [FIRST, REPLY, RECAP]).type).toBe("diverged")
    const regrouped: LineageResult = { ...continuation(), regrouped: { runs: 1, storedMessages: 1, incomingMessages: 1 } }
    expect(auxiliaryLineage(regrouped, [FIRST, REPLY, RECAP]).type).toBe("diverged")
  })
})
