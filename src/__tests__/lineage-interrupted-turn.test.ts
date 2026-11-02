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
import {
  classifyInterruptedContinuation,
  computeLineageHash,
  interruptedTurnOf,
  type InterruptedTurn,
} from "../proxy/session/lineage"

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
