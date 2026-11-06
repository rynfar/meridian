/**
 * Opt-in partial replay: where a diverged history may fork its stored SDK
 * session (planRollbackTail), what the fork keeps (inheritSdkUuids,
 * messagesHeld) and how its tail splits into native results and rendered
 * context. HTTP behaviour is in proxy-rollback-tail.test.ts.
 */
import { describe, expect, it } from "bun:test"
import {
  computeLineageHash,
  computeMessageHashes,
  formatRollbackTail,
  inheritSdkUuids,
  planRollbackTail,
  verifyLineage,
  type SessionState,
} from "../proxy/session/lineage"
import { messagesHeld } from "../proxy/session/cache"
import { leadWithToolResults, splitRollbackTail } from "../proxy/replay"
import { resolveSwitch } from "../env"

type Message = { role: string; content: unknown }

const user = (text: string): Message => ({ role: "user", content: text })
const assistant = (text: string): Message => ({
  role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "text", text }],
})
const toolCall = (...ids: string[]): Message => ({
  role: "assistant", content: ids.map(id => ({ type: "tool_use", id, name: "read", input: { path: id } })),
})
const toolResults = (...ids: string[]): Message => ({
  role: "user", content: ids.map(id => ({ type: "tool_result", tool_use_id: id, content: `result ${id}` })),
})

function stored(messages: Message[], overrides: Partial<SessionState> = {}): SessionState {
  return {
    claudeSessionId: "source",
    lastAccess: 0,
    messageCount: messages.length,
    lineageHash: computeLineageHash(messages),
    messageHashes: computeMessageHashes(messages),
    sdkMessageUuids: messages.map((message, index) => message.role === "assistant" ? `uuid-${index}` : null),
    ...overrides,
  }
}

/** user, assistant, …: `count` alternating text turns. */
const conversation = (count: number): Message[] =>
  Array.from({ length: count }, (_, index) => index % 2 === 0 ? user(`user ${index}`) : assistant(`assistant ${index}`))

describe("planRollbackTail", () => {
  it("forks at the last assistant inside the proved prefix", () => {
    const history = conversation(9)
    const incoming = [...history.slice(0, 6), user("rewritten 6"), assistant("assistant 7"), user("new 8")]
    expect(planRollbackTail(stored(history), incoming, 6)).toEqual({
      session: stored(history), rollbackIndex: 5, rollbackUuid: "uuid-5", settledToolIds: [],
    })
  })

  it("passes over an assistant without an SDK UUID", () => {
    const history = conversation(9)
    const uuids = history.map((message, index) => message.role === "assistant" && index !== 5 ? `uuid-${index}` : null)
    const plan = planRollbackTail(stored(history, { sdkMessageUuids: uuids }), [...history.slice(0, 6), user("new")], 6)
    expect(plan?.rollbackIndex).toBe(3)
    expect(plan?.rollbackUuid).toBe("uuid-3")
  })

  it("keeps a tool-call fork point whose next message settles exactly its calls", () => {
    const history = [user("go"), toolCall("a", "b"), toolResults("a", "b"), assistant("done"), user("next")]
    const incoming = [...history.slice(0, 3), assistant("done, revised"), user("next")]
    expect(planRollbackTail(stored(history), incoming, 3)).toMatchObject({
      rollbackIndex: 1, rollbackUuid: "uuid-1", settledToolIds: ["a", "b"],
    })
  })

  it("accepts ordinary content after the settling results", () => {
    const settling = { role: "user", content: [...(toolResults("a").content as unknown[]), { type: "text", text: "and also" }] }
    const history = [user("go"), toolCall("a"), settling, assistant("done"), user("next")]
    expect(planRollbackTail(stored(history), [...history.slice(0, 3), assistant("other"), user("next")], 3)?.rollbackIndex).toBe(1)
  })

  for (const [label, next] of [
    ["a missing result", toolResults("a")],
    ["an extra result", toolResults("a", "b", "c")],
    ["a duplicated result", toolResults("a", "a", "b")],
    ["a result after other content", { role: "user", content: [{ type: "text", text: "first" }, ...(toolResults("a", "b").content as unknown[])] }],
    ["plain text", user("no results")],
  ] as const) {
    it(`moves to an earlier assistant when the next message has ${label}`, () => {
      const history = [user("go"), assistant("plan"), user("do it"), toolCall("a", "b"), next, assistant("done"), user("next")]
      const incoming = [...history.slice(0, 5), assistant("other"), user("next")]
      expect(planRollbackTail(stored(history), incoming, 5)).toMatchObject({ rollbackIndex: 1, settledToolIds: [] })
    })
  }

  it("refuses a tool call without an id to settle", () => {
    const unnamed = { role: "assistant", content: [{ type: "tool_use", name: "read", input: {} }] }
    const history = [user("go"), unnamed, user("x"), assistant("done"), user("next")]
    expect(planRollbackTail(stored(history), [...history.slice(0, 3), assistant("other"), user("next")], 3)).toBeUndefined()
  })

  it("needs a user turn to answer, allowing trailing system notes", () => {
    const history = conversation(7)
    const base = [...history.slice(0, 4), user("rewritten")]
    expect(planRollbackTail(stored(history), [...base, assistant("prefill")], 4)).toBeUndefined()
    expect(planRollbackTail(stored(history), [...base, { role: "system", content: "note" }], 4)?.rollbackIndex).toBe(3)
  })

  it("refuses a session without SDK-prefix proof", () => {
    const history = conversation(7)
    const unproved = stored(history, { lineageHash: "", clientLineageHash: computeLineageHash(history) })
    expect(planRollbackTail(unproved, [...history.slice(0, 4), user("new")], 4)).toBeUndefined()
  })

  it("finds nothing when no assistant in the prefix has a UUID", () => {
    const history = conversation(7)
    expect(planRollbackTail(stored(history, { sdkMessageUuids: [] }), [...history.slice(0, 4), user("new")], 4)).toBeUndefined()
  })
})

describe("verifyLineage with partialReplay", () => {
  // The production shape: 444 stored, 443 incoming, message 440 rewritten,
  // 439 an assistant[thinking,text], the stored trailing turn gone.
  const history = conversation(444)
  const incoming = [...history.slice(0, 440), user("rewritten 440"), history[441]!, user("new 442")]

  it("attaches the fork point to an undo-gap only when asked", () => {
    expect(verifyLineage(stored(history), incoming)).not.toHaveProperty("rollbackTail")
    expect(verifyLineage(stored(history), incoming, { partialReplay: true })).toMatchObject({
      type: "diverged", reason: "undo-gap", prefixOverlap: 440,
      rollbackTail: { rollbackIndex: 439, rollbackUuid: "uuid-439", settledToolIds: [] },
    })
  })

  it("attaches the fork point to modified history", () => {
    const grown = [...history.slice(0, 440), user("rewritten 440"), assistant("reply 441"), user("new 442"),
      assistant("reply 443"), user("new 444"), assistant("reply 445"), user("new 446")]
    expect(verifyLineage(stored(history), grown, { partialReplay: true })).toMatchObject({
      type: "diverged", reason: "modified-history", rollbackTail: { rollbackIndex: 439 },
    })
  })

  it("leaves other classifications untouched", () => {
    expect(verifyLineage(stored(history), [...history, assistant("reply"), user("next")], { partialReplay: true }))
      .toMatchObject({ type: "continuation" })
    expect(verifyLineage(stored(history), [...history.slice(0, 440), user("replacement")], { partialReplay: true }))
      .toMatchObject({ type: "undo", rollbackUuid: "uuid-439" })
  })
})

describe("what a rollback-tail keeps", () => {
  const history = conversation(9)
  const incoming = [...history.slice(0, 6), user("rewritten"), assistant("reply"), user("new")]
  const tail = { type: "rollback-tail" as const, cause: "undo-gap" as const, ...planRollbackTail(stored(history), incoming, 6)! }

  it("inherits the SDK UUIDs through the fork point only", () => {
    expect(inheritSdkUuids(stored(history), tail, incoming)).toEqual([null, "uuid-1", null, "uuid-3", null, "uuid-5"])
  })

  it("holds the messages through the fork point", () => {
    expect(messagesHeld(tail, incoming)).toBe(6)
  })

  it("formats its log fields", () => {
    expect(formatRollbackTail(tail, incoming.length)).toBe("from=undo-gap prefix=6 tail=3")
  })
})

describe("splitRollbackTail", () => {
  it("keeps the fork point's results native and renders everything else", () => {
    const first = { role: "user", content: [
      { type: "tool_result", tool_use_id: "a", content: "A" },
      { type: "tool_result", tool_use_id: "b", content: "B" },
      { type: "text", text: "note" },
    ] }
    const rest = [assistant("later"), toolResults("x"), user("live")]
    expect(splitRollbackTail([first, ...rest], ["a", "b"])).toEqual({
      toolResults: [first.content[0], first.content[1]],
      rendered: [{ role: "user", content: [{ type: "text", text: "note" }] }, ...rest],
    })
  })

  it("drops a first message that held only the results", () => {
    expect(splitRollbackTail([toolResults("a"), user("live")], ["a"]).rendered).toEqual([user("live")])
  })

  it("renders the whole tail when the fork point made no calls", () => {
    const tail = [toolResults("a"), user("live")]
    expect(splitRollbackTail(tail, [])).toEqual({ toolResults: [], rendered: tail })
  })

  it("leads one SDK input with the results", () => {
    const result = { type: "tool_result", tool_use_id: "a", content: "A" }
    expect(leadWithToolResults([result], "framed")).toEqual([result, { type: "text", text: "framed" }])
    expect(leadWithToolResults([result], "")).toEqual([result])
    expect(leadWithToolResults([result], [{ message: { content: [{ type: "image" }] } }, { message: { content: "text" } }]))
      .toEqual([result, { type: "image" }, { type: "text", text: "text" }])
  })
})

describe("resolveSwitch", () => {
  it("lets the environment force the switch either way over the setting", () => {
    expect(resolveSwitch(undefined, () => undefined)).toBe(false)
    expect(resolveSwitch(undefined, () => true)).toBe(true)
    expect(resolveSwitch(" ON ", () => false)).toBe(true)
    expect(resolveSwitch("0", () => true)).toBe(false)
    expect(resolveSwitch("maybe", () => true)).toBe(true)
    expect(resolveSwitch(undefined, () => "true")).toBe(false)
  })
})
