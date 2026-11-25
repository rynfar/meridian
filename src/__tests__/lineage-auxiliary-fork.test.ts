/**
 * Which auxiliary requests fork the conversation's session (auxiliaryLineage):
 * a side call that adds, after the stored session, at most the turn in flight
 * and a side prompt of user text and system notes. The reply still streaming
 * is left out of the fork. Every other shape replays fresh, because a resumed
 * fork would hand the model a history the client does not hold, and says why.
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
const continuation = (overrides: Partial<SessionState> = {}, resumeFrom = 1): LineageResult => ({
  type: "continuation",
  session: session(overrides),
  resumeFrom,
})

const FIRST = { role: "user", content: "read the config" }
const REPLY = { role: "assistant", content: [{ type: "text", text: "done" }] }
const RECAP = { role: "user", content: [{ type: "text", text: "Summarise where this session stands." }] }
const SIDE = { role: "user", content: "<system-reminder>Ephemeral side-channel turn</system-reminder>" }
const CALL = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] }
const NO_RESULT = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "No result provided", is_error: true }] }

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

  it("forks a side call sent while the next turn streams, leaving out the reply in flight", () => {
    // omp 19.1.1 `/btw` during a reply: the prompt that started the turn, the
    // reply streamed so far, then the side call's reminder and prompt.
    const result = continuation()
    const streaming = { role: "assistant", content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Running" }] }
    const probe = [FIRST, REPLY, { role: "user", content: "and the tests?" }, streaming, SIDE, RECAP]
    expect(auxiliaryLineage(result, probe)).toEqual({ lineage: result, inFlight: { from: 3, to: 4 } })
  })

  it("forks over a pending tool checkpoint whose calls the side call settles", () => {
    // A completion probe while the subagent's tool runs: omp fills in a result
    // for the running call, with or without echoing the call first.
    const stored = continuation({ passthroughToolCallIds: ["t1"], messageCount: 2 }, 2)
    expect(auxiliaryLineage(stored, [FIRST, CALL, NO_RESULT, SIDE, RECAP])).toEqual({ lineage: stored })
    const echoed = continuation({ passthroughToolCallIds: ["t1"] })
    expect(auxiliaryLineage(echoed, [FIRST, CALL, NO_RESULT, SIDE, RECAP])).toEqual({ lineage: echoed })
  })

  it("forks over a checkpoint settled by the turn in flight, leaving out its reply", () => {
    const stored = continuation({ passthroughToolCallIds: ["t1"], messageCount: 2 }, 2)
    const realResult = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42 lines" }] }
    const thinking = { role: "assistant", content: [{ type: "thinking", thinking: "the file has" }] }
    expect(auxiliaryLineage(stored, [FIRST, CALL, realResult, thinking, SIDE, RECAP]).inFlight).toEqual({ from: 3, to: 4 })
  })

  it("leaves out a tool call in flight together with the result the client filled in", () => {
    const result = continuation()
    const calling = { role: "assistant", content: [{ type: "text", text: "Let me look" }, { type: "tool_use", id: "t9", name: "read", input: {} }] }
    const filled = { role: "user", content: [{ type: "tool_result", tool_use_id: "t9", content: "No result provided", is_error: true }] }
    const probe = [FIRST, REPLY, { role: "user", content: "and the tests?" }, calling, filled, SIDE, RECAP]
    expect(auxiliaryLineage(result, probe)).toEqual({ lineage: result, inFlight: { from: 3, to: 5 } })
  })

  it("replays a pending checkpoint the side call does not settle exactly", () => {
    expect(auxiliaryLineage(continuation({ passthroughToolCallIds: ["t1"] }), [FIRST, REPLY, RECAP]).refusal).toBe("pending-tool")
    const twoCalls = continuation({ passthroughToolCallIds: ["t1", "t2"], messageCount: 2 }, 2)
    expect(auxiliaryLineage(twoCalls, [FIRST, CALL, NO_RESULT, RECAP]).refusal).toBe("pending-tool")
    const unknown = { role: "user", content: [{ type: "tool_result", tool_use_id: "t7", content: "x" }] }
    expect(auxiliaryLineage(continuation({ passthroughToolCallIds: ["t1"], messageCount: 2 }, 2), [FIRST, CALL, NO_RESULT, unknown, RECAP]).refusal).toBe("not-side-prompt")
  })

  it("replays a tool call or result the session and the turn in flight do not account for", () => {
    // A call without the result the client fills in for it.
    expect(auxiliaryLineage(continuation(), [FIRST, CALL, RECAP]).refusal).toBe("not-side-prompt")
    // A result for a call the session never made.
    expect(auxiliaryLineage(continuation(), [FIRST, REPLY, NO_RESULT, RECAP]).refusal).toBe("not-side-prompt")
    // Two replies after the stored session: more than one turn the session lacks.
    const twoReplies = [FIRST, REPLY, { role: "user", content: "next" }, REPLY, { role: "user", content: "and then" }, REPLY, RECAP]
    expect(auxiliaryLineage(continuation(), twoReplies).refusal).toBe("not-side-prompt")
    // Two calls in flight, but the client's results name only one of them.
    const twoCalls = { role: "assistant", content: [{ type: "tool_use", id: "a", name: "read", input: {} }, { type: "tool_use", id: "b", name: "read", input: {} }] }
    const twiceA = { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x" }, { type: "tool_result", tool_use_id: "a", content: "x" }] }
    expect(auxiliaryLineage(continuation(), [FIRST, REPLY, { role: "user", content: "go" }, twoCalls, twiceA, RECAP]).refusal).toBe("not-side-prompt")
    // A reply without calls does not echo a pending checkpoint.
    const pending = continuation({ passthroughToolCallIds: ["t1"] })
    expect(auxiliaryLineage(pending, [FIRST, REPLY, NO_RESULT, RECAP]).refusal).toBe("pending-tool")
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
