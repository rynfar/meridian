/**
 * Which auxiliary requests fork the conversation's session (auxiliaryLineage):
 * only a side call that adds user text, with any system notes, after a
 * completed turn. Every other shape replays fresh, because a resumed fork
 * would hand the model a history the client does not hold, and says why.
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
    expect(auxiliaryLineage(result, [FIRST, REPLY, RECAP])).toEqual({ lineage: result })
    // omp's side-channel reminder and the prompt as two user messages.
    expect(auxiliaryLineage(result, [FIRST, REPLY, { role: "user", content: "<system-reminder>side</system-reminder>" }, RECAP]).lineage).toBe(result)
  })

  it("forks a side call whose prompt carries a mid-conversation system note", () => {
    // Captured from omp 18.20.3: `… → assistant[text] → user[text] → system[] → user[text]`.
    const result = continuation()
    const note = { role: "system", content: [] }
    expect(auxiliaryLineage(result, [FIRST, REPLY, { role: "user", content: "a note" }, note, RECAP]).lineage).toBe(result)
  })

  it("replays a side call carrying a reply snapshot after a later user message", () => {
    const probe = [FIRST, REPLY, { role: "user", content: "and the tests?" }, { role: "assistant", content: "running" }, RECAP]
    expect(auxiliaryLineage(continuation(), probe)).toEqual({ lineage: { type: "diverged", reason: "independent-request" }, refusal: "not-side-prompt" })
  })

  it("replays when the copied reply calls a tool or a tool result follows", () => {
    const toolCall = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }
    expect(auxiliaryLineage(continuation(), [FIRST, toolCall, RECAP]).refusal).toBe("not-side-prompt")
    const result = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "x" }] }
    expect(auxiliaryLineage(continuation(), [FIRST, REPLY, result, RECAP]).refusal).toBe("not-side-prompt")
  })

  it("replays over a pending tool checkpoint", () => {
    expect(auxiliaryLineage(continuation({ passthroughToolCallIds: ["t1"] }), [FIRST, REPLY, RECAP]).refusal).toBe("pending-tool")
  })

  it("replays a request that adds nothing, or one the conversation does not continue", () => {
    expect(auxiliaryLineage(continuation(), [FIRST, REPLY]).refusal).toBe("not-side-prompt")
    const undo: LineageResult = { type: "undo", session: session(), prefixOverlap: 1, rollbackUuid: "u1" }
    expect(auxiliaryLineage(undo, [FIRST, RECAP]).refusal).toBe("lineage-undo")
    expect(auxiliaryLineage({ type: "diverged", reason: "not-found" }, [FIRST, RECAP])).toEqual({
      lineage: { type: "diverged", reason: "independent-request" },
      refusal: "lineage-diverged:not-found",
    })
  })

  it("replays a partial-message or regrouped resume", () => {
    const partial: LineageResult = { type: "continuation", session: session(), resumeFrom: 1, resumeContentFrom: 2 }
    expect(auxiliaryLineage(partial, [FIRST, REPLY, RECAP]).refusal).toBe("partial-message")
    const regrouped: LineageResult = { ...continuation(), regrouped: { runs: 1, storedMessages: 1, incomingMessages: 1 } }
    expect(auxiliaryLineage(regrouped, [FIRST, REPLY, RECAP]).refusal).toBe("regrouped")
  })
})
