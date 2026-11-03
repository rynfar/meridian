/**
 * The interrupted-turn check (session spec, *Interrupted turns*).
 *
 * A client stopped a streaming turn after output reached it. The session that
 * turn resumed still ends at the last completed turn, so it may be resumed
 * only when the client's next request adds nothing but user content to what
 * the session holds. A wrong resume makes the model and the client diverge
 * silently; a wrong replay only costs the prompt cache.
 */
import { describe, expect, it } from "bun:test"
import { computeLineageHash, formatDivergence, type LineageResult, type SessionState } from "../proxy/session/lineage"
import {
  classifyInterruptedContinuation,
  forkStillCopiesCandidate,
  interruptCandidateOf,
  interruptedMappingAction,
  interruptedTurnOf,
  markableSource,
  recordStillMarks,
  resolveInterruptedTurn,
  waitedOutOwnInterruption,
  type InterruptedTurn,
  type InterruptedTurnRecord,
} from "../proxy/session/interruptedTurn"

type Message = { role: string; content: any }

// The session was published after "u1"; its SDK transcript holds u1 and a1.
const PREFIX: Message[] = [{ role: "user", content: "u1" }]
const REPLY: Message = { role: "assistant", content: [{ type: "text", text: "a1" }] }
const STOPPED_USER: Message = { role: "user", content: "u2" }
const NEXT_USER: Message = { role: "user", content: "u3" }
// The request the client stopped: the session's reply, then the new user turn.
const STOPPED_REQUEST = [...PREFIX, REPLY, STOPPED_USER]

function turnOf(messages: Message[], prefix = PREFIX): InterruptedTurn {
  const turn = interruptedTurnOf(messages, prefix.length, computeLineageHash(prefix))
  if (!turn) throw new Error("expected an interrupted turn")
  return turn
}

const decide = (messages: Message[], turn = turnOf(STOPPED_REQUEST)) => classifyInterruptedContinuation(turn, messages)

describe("interruptedTurnOf", () => {
  it("records the prefix and the reply the session holds", () => {
    const turn = turnOf(STOPPED_REQUEST)
    expect(turn.prefixCount).toBe(1)
    expect(turn.lineageHash).toBe(computeLineageHash(PREFIX))
    expect(turn.replyHashes).toHaveLength(1)
    expect(turn.replyToolUseIds).toEqual([])
  })

  it("records the tool calls the reply made", () => {
    const reply = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] }
    expect(turnOf([...PREFIX, reply, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "r" }] }]).replyToolUseIds)
      .toEqual(["toolu_1"])
  })

  it("keeps nothing for a request with no user turn after the prefix", () => {
    expect(interruptedTurnOf([...PREFIX, REPLY], 1, computeLineageHash(PREFIX))).toBeUndefined()
  })

  it("keeps nothing for a request that already carried assistant turns the session never wrote", () => {
    const request = [...PREFIX, REPLY, STOPPED_USER, { role: "assistant", content: "elsewhere" }, NEXT_USER]
    expect(interruptedTurnOf(request, 1, computeLineageHash(PREFIX))).toBeUndefined()
  })

  it("keeps nothing without a prefix or its proof", () => {
    expect(interruptedTurnOf(STOPPED_REQUEST, 0, computeLineageHash(PREFIX))).toBeUndefined()
    expect(interruptedTurnOf(STOPPED_REQUEST, 1, "")).toBeUndefined()
    expect(interruptedTurnOf(PREFIX, 1, computeLineageHash(PREFIX))).toBeUndefined()
  })
})

describe("classifyInterruptedContinuation", () => {
  describe("resumes when the client discarded the partial", () => {
    it("and appended a new user turn after the stopped one (Pi, Prime Agent)", () => {
      expect(decide([...STOPPED_REQUEST, NEXT_USER])).toEqual({ resume: true })
    })

    it("and appended several user messages", () => {
      expect(decide([...STOPPED_REQUEST, NEXT_USER, { role: "user", content: [{ type: "text", text: "u4" }] }]))
        .toEqual({ resume: true })
    })

    it("and resent the stopped request unchanged", () => {
      expect(decide(STOPPED_REQUEST)).toEqual({ resume: true })
    })

    it("and resent the stopped user message", () => {
      expect(decide([...STOPPED_REQUEST, STOPPED_USER])).toEqual({ resume: true })
    })

    it("and replaced the stopped user message with an edited one", () => {
      expect(decide([...PREFIX, REPLY, { role: "user", content: "u2, rephrased" }])).toEqual({ resume: true })
    })

    it("and settled the reply's tool calls before going on", () => {
      const reply = { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: {} }] }
      const results = { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "r" }] }
      const turn = turnOf([...PREFIX, reply, results])
      expect(decide([...PREFIX, reply, results, NEXT_USER], turn)).toEqual({ resume: true })
    })
  })

  describe("replays when the client kept the partial", () => {
    it.each([
      ["assistant text", { role: "assistant", content: [{ type: "text", text: "partial" }] }],
      ["a string assistant turn", { role: "assistant", content: "partial" }],
      ["thinking only", { role: "assistant", content: [{ type: "thinking", thinking: "partial", signature: "sig" }] }],
      ["an empty assistant message", { role: "assistant", content: [] }],
      ["a tool call", { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "read", input: {} }] }],
    ])("as %s", (_label, partial) => {
      expect(decide([...STOPPED_REQUEST, partial, NEXT_USER])).toEqual({ resume: false, reason: "kept-assistant" })
    })

    it("even as the last message", () => {
      expect(decide([...STOPPED_REQUEST, { role: "assistant", content: "partial" }]))
        .toEqual({ resume: false, reason: "kept-assistant" })
    })

    it("as a tool call with its aborted result (Oh My Pi)", () => {
      expect(decide([
        ...STOPPED_REQUEST,
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "aborted", is_error: true }] },
        NEXT_USER,
      ])).toEqual({ resume: false, reason: "kept-assistant" })
    })

    it("in place of the stopped user message", () => {
      // The partial sits where the session's own reply would be compared.
      expect(decide([...PREFIX, REPLY, { role: "assistant", content: "partial" }, NEXT_USER]))
        .toEqual({ resume: false, reason: "kept-assistant" })
    })
  })

  describe("replays when the history no longer matches the session", () => {
    it("after an edited earlier message", () => {
      expect(decide([{ role: "user", content: "u1, edited" }, REPLY, STOPPED_USER, NEXT_USER]))
        .toEqual({ resume: false, reason: "prefix-changed" })
    })

    it("when the history is shorter than the prefix", () => {
      expect(decide([])).toEqual({ resume: false, reason: "prefix-changed" })
    })

    it("when the session's own reply was altered", () => {
      expect(decide([...PREFIX, { role: "assistant", content: [{ type: "text", text: "a1, edited" }] }, STOPPED_USER, NEXT_USER]))
        .toEqual({ resume: false, reason: "reply-changed" })
    })

    it("when the session's own reply was dropped", () => {
      expect(decide([...PREFIX, STOPPED_USER, NEXT_USER])).toEqual({ resume: false, reason: "reply-changed" })
    })

    it("when a kept partial stands where the session's reply was", () => {
      expect(decide([...PREFIX, { role: "assistant", content: "partial" }, NEXT_USER]))
        .toEqual({ resume: false, reason: "reply-changed" })
    })

    it("when nothing follows the session's reply", () => {
      expect(decide([...PREFIX, REPLY])).toEqual({ resume: false, reason: "no-user-turn" })
    })

    it("when user content answers a tool call the session never made", () => {
      expect(decide([
        ...STOPPED_REQUEST,
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: "aborted" }] },
      ])).toEqual({ resume: false, reason: "unknown-tool-result" })
    })
  })
})

// --- Orchestration predicates (server.ts calls these; they hold no state) ---

const PROOF = computeLineageHash(PREFIX)
const SESSION: SessionState = {
  claudeSessionId: "sess-1", lastAccess: 0, messageCount: PREFIX.length, lineageHash: PROOF,
}
const CONTINUATION: LineageResult = { type: "continuation", session: SESSION, resumeFrom: PREFIX.length }
const candidateInput = {
  sideRequest: false,
  priorityPublication: false,
  lineage: CONTINUATION,
  isResume: true,
  resumeSessionId: "sess-1" as string | undefined,
  messages: STOPPED_REQUEST,
}

describe("interruptCandidateOf", () => {
  it("records a plain continuation that resumes the session it read", () => {
    expect(interruptCandidateOf(candidateInput)).toEqual({
      source: { claudeSessionId: "sess-1", messageCount: 1, lineageHash: PROOF },
      turn: turnOf(STOPPED_REQUEST),
    })
  })

  it("records nothing for a side request", () => {
    expect(interruptCandidateOf({ ...candidateInput, sideRequest: true })).toBeUndefined()
  })

  it("records nothing for a priority publication", () => {
    expect(interruptCandidateOf({ ...candidateInput, priorityPublication: true })).toBeUndefined()
  })

  it("records nothing unless the turn resumes exactly that session", () => {
    expect(interruptCandidateOf({ ...candidateInput, isResume: false })).toBeUndefined()
    expect(interruptCandidateOf({ ...candidateInput, resumeSessionId: undefined })).toBeUndefined()
    expect(interruptCandidateOf({ ...candidateInput, resumeSessionId: "sess-2" })).toBeUndefined()
  })

  it("records nothing for any lineage but a plain continuation from the stored prefix", () => {
    const undo: LineageResult = { type: "undo", session: SESSION, prefixOverlap: 1, rollbackUuid: "u" }
    const compaction: LineageResult = { type: "compaction", session: SESSION, resumeFrom: 1, suffixOverlap: 2 }
    const appended: LineageResult = { ...CONTINUATION, resumeContentFrom: 1 }
    const elsewhere: LineageResult = { type: "continuation", session: SESSION, resumeFrom: 0 }
    for (const lineage of [undo, compaction, appended, elsewhere, { type: "diverged", reason: "not-found" } as LineageResult]) {
      expect(interruptCandidateOf({ ...candidateInput, lineage })).toBeUndefined()
    }
  })

  it("records nothing for a session without its resume proof", () => {
    const unproved: LineageResult = { ...CONTINUATION, session: { ...SESSION, lineageHash: "" } }
    expect(interruptCandidateOf({ ...candidateInput, lineage: unproved })).toBeUndefined()
  })
})

describe("forkStillCopiesCandidate", () => {
  const candidate = interruptCandidateOf(candidateInput)
  const base = { candidate, freshTarget: false, superseded: false, forkSourceSessionId: "sess-1" as string | undefined }

  it("holds while the fork copies the candidate's session", () => {
    expect(forkStillCopiesCandidate(base)).toBe(true)
  })

  it("fails for a fork of another session, a fresh target, a superseded fork or no candidate", () => {
    expect(forkStillCopiesCandidate({ ...base, forkSourceSessionId: "sess-2" })).toBe(false)
    expect(forkStillCopiesCandidate({ ...base, forkSourceSessionId: undefined })).toBe(false)
    expect(forkStillCopiesCandidate({ ...base, freshTarget: true })).toBe(false)
    expect(forkStillCopiesCandidate({ ...base, superseded: true })).toBe(false)
    expect(forkStillCopiesCandidate({ ...base, candidate: undefined })).toBe(false)
  })
})

describe("interruptedMappingAction", () => {
  const base = {
    managedFork: true,
    managedForkPublished: false,
    clientAssistantContentExposed: true,
    clientToolUseExposed: false,
    interruptible: true,
    clientStopped: true,
  }

  it("keeps the source behind the check when the client stopped a turn it saw", () => {
    expect(interruptedMappingAction(base)).toBe("interrupt")
  })

  it("leaves the mapping as it was when nothing reached the client, whatever stopped it", () => {
    for (const clientStopped of [true, false]) {
      expect(interruptedMappingAction({ ...base, clientAssistantContentExposed: false, clientStopped })).toBe("preserve")
    }
  })

  it("evicts once the turn could have moved the mapped transcript", () => {
    expect(interruptedMappingAction({ ...base, managedFork: false })).toBe("evict")
    expect(interruptedMappingAction({ ...base, managedForkPublished: true })).toBe("evict")
  })

  it("evicts a turn that already streamed a tool call", () => {
    expect(interruptedMappingAction({ ...base, clientToolUseExposed: true })).toBe("evict")
  })

  it("evicts a turn that cannot be checked later", () => {
    expect(interruptedMappingAction({ ...base, interruptible: false })).toBe("evict")
  })

  it("evicts a stop the client did not make", () => {
    expect(interruptedMappingAction({ ...base, clientStopped: false })).toBe("evict")
  })
})

describe("resolveInterruptedTurn", () => {
  const restored: SessionState = { ...SESSION }
  const record = { turn: turnOf(STOPPED_REQUEST), restored }

  it("continues the restored session from the stored prefix when the client discarded the partial", () => {
    expect(resolveInterruptedTurn(record, [...STOPPED_REQUEST, NEXT_USER])).toEqual({
      decision: { resume: true },
      lineage: { type: "continuation", session: restored, resumeFrom: 1 },
    })
  })

  it("replays and names the check's reason otherwise", () => {
    const kept = resolveInterruptedTurn(record, [...STOPPED_REQUEST, { role: "assistant", content: "partial" }, NEXT_USER])
    expect(kept.lineage).toEqual({ type: "diverged", reason: "interrupted-turn-kept", detail: "kept-assistant" })
    expect(formatDivergence(kept.lineage)).toBe("interrupted-turn-kept:kept-assistant")
  })
})

describe("recordStillMarks", () => {
  const record: InterruptedTurnRecord = { generation: "g2", markedFrom: "g1", claudeSessionId: "sess-1", turn: turnOf(STOPPED_REQUEST) }
  const stored = { claudeSessionId: "sess-1", messageCount: 1, lineageHash: "", clientLineageHash: PROOF }

  it("holds for the exact mapping the record wrote", () => {
    expect(recordStillMarks(record, "g2", stored)).toBe(true)
  })

  it("fails for any other generation of the mapping", () => {
    expect(recordStillMarks(record, "g3", stored)).toBe(false)
    expect(recordStillMarks(record, "g1", stored)).toBe(false)
    expect(recordStillMarks(record, undefined, stored)).toBe(false)
  })

  it("fails when the proof is no longer withheld", () => {
    expect(recordStillMarks(record, "g2", { ...stored, lineageHash: PROOF })).toBe(false)
    expect(recordStillMarks(record, "g2", { ...stored, clientLineageHash: "other" })).toBe(false)
  })

  it("fails for another session or prefix, or no mapping", () => {
    expect(recordStillMarks(record, "g2", { ...stored, claudeSessionId: "sess-2" })).toBe(false)
    expect(recordStillMarks(record, "g2", { ...stored, messageCount: 3 })).toBe(false)
    expect(recordStillMarks(record, "g2", undefined)).toBe(false)
  })
})

describe("markableSource", () => {
  const source = { claudeSessionId: "sess-1", messageCount: 1, lineageHash: PROOF }
  const turn = turnOf(STOPPED_REQUEST)

  it("accepts the published session the turn resumed", () => {
    expect(markableSource({ claudeSessionId: "sess-1", messageCount: 1, lineageHash: PROOF }, source, turn)).toBe(true)
  })

  it("accepts that session already marked by an earlier stopped turn", () => {
    expect(markableSource({ claudeSessionId: "sess-1", messageCount: 1, lineageHash: "", clientLineageHash: PROOF }, source, turn))
      .toBe(true)
  })

  it("refuses another session, prefix or proof, and a record that does not match its source", () => {
    expect(markableSource({ claudeSessionId: "sess-2", messageCount: 1, lineageHash: PROOF }, source, turn)).toBe(false)
    expect(markableSource({ claudeSessionId: "sess-1", messageCount: 2, lineageHash: PROOF }, source, turn)).toBe(false)
    expect(markableSource({ claudeSessionId: "sess-1", messageCount: 1, lineageHash: "other" }, source, turn)).toBe(false)
    expect(markableSource({ claudeSessionId: "sess-1", messageCount: 1, lineageHash: PROOF }, { ...source, lineageHash: "" }, turn))
      .toBe(false)
    expect(markableSource({ claudeSessionId: "sess-1", messageCount: 1, lineageHash: PROOF }, source, { ...turn, prefixCount: 2 }))
      .toBe(false)
  })
})

describe("waitedOutOwnInterruption", () => {
  it("holds only when the request arrived at the generation the marking replaced", () => {
    expect(waitedOutOwnInterruption("g1", { markedFrom: "g1" })).toBe(true)
    expect(waitedOutOwnInterruption("g0", { markedFrom: "g1" })).toBe(false)
    expect(waitedOutOwnInterruption(undefined, { markedFrom: "g1" })).toBe(false)
    expect(waitedOutOwnInterruption(null, { markedFrom: "g1" })).toBe(false)
    expect(waitedOutOwnInterruption("g1", undefined)).toBe(false)
  })
})

