/**
 * A generic OpenAI client that runs its own tool loop sends no session header.
 * Every round it resends the whole growing conversation, ending in the `tool`
 * message it just produced, so `isClientDrivenLoop` holds and the request takes
 * the headerless-tool-result bypass: no session lookup, no cache write, a fresh
 * SDK session per round. Measured on a LiteLLM-fronted agent loop, #820 put
 * that at 35k-56k cache-write tokens per turn against 46-53 direct.
 *
 * The bypass exists for a reason. The conversation fingerprint is (first user
 * message, cwd), so two runs of one workflow started from the same prompt in
 * the same directory hash to a single key, and one would resume the other's
 * Claude session — premature end_turn, dropped tool calls. Letting the
 * fingerprint stand in for a key would reintroduce exactly that.
 *
 * The loop's own first tool-call id is the missing discriminator: issued per
 * generation so concurrent runs never share one, and retained in the history so
 * every later round of the same run derives the same key.
 */
import { describe, it, expect } from "bun:test"
import { deriveToolLoopSessionId, openAiAdapter } from "../proxy/adapters/openai"

function ctx(headers: Record<string, string | undefined>) {
  return { req: { header: (name: string) => headers[name.toLowerCase()] } } as any
}

const PROMPT = "List the files in the repo and summarise the build setup."

/** Round 1: the client's opening request, before any tool has been called. */
const opening = [
  { role: "user", content: PROMPT },
]

/** Round 2: assistant asked for a tool, client sends the result back. */
function firstRound(callId: string) {
  return [
    ...opening,
    { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: callId, content: "README.md src/" },
  ]
}

/** Round 3: the same loop, one tool round later. */
function secondRound(callId: string, nextCallId: string) {
  return [
    ...firstRound(callId),
    { role: "assistant", content: null, tool_calls: [{ id: nextCallId, type: "function", function: { name: "bash", arguments: "{}" } }] },
    { role: "tool", tool_call_id: nextCallId, content: "bun test" },
  ]
}

describe("deriveToolLoopSessionId", () => {
  it("derives nothing for an ordinary chat, so unkeyed chats are untouched", () => {
    expect(deriveToolLoopSessionId({ messages: opening })).toBeUndefined()
    expect(deriveToolLoopSessionId({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] }))
      .toBeUndefined()
  })

  it("derives nothing from a malformed or message-less body", () => {
    expect(deriveToolLoopSessionId(undefined)).toBeUndefined()
    expect(deriveToolLoopSessionId({})).toBeUndefined()
    expect(deriveToolLoopSessionId({ messages: "not an array" })).toBeUndefined()
  })

  it("derives a key once the loop has called a tool", () => {
    const key = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })
    expect(key).toBeDefined()
    expect(key).toMatch(/^tool-loop:[0-9a-f]{16}$/)
  })

  it("holds the key steady as the same loop grows — the property that makes resume possible", () => {
    const round2 = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })
    const round3 = deriveToolLoopSessionId({ messages: secondRound("call_abc123", "call_def456") })
    expect(round3).toBe(round2!)
  })

  it("anchors on the FIRST tool call, not the newest, so later rounds do not rekey", () => {
    const withLaterCalls = deriveToolLoopSessionId({ messages: secondRound("call_abc123", "call_def456") })
    const firstOnly = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })
    expect(withLaterCalls).toBe(firstOnly!)
  })

  it("separates two concurrent runs of the same prompt — the collision the guard was written for", () => {
    const runA = deriveToolLoopSessionId({ messages: firstRound("call_run_a") })
    const runB = deriveToolLoopSessionId({ messages: firstRound("call_run_b") })
    expect(runA).toBeDefined()
    expect(runB).not.toBe(runA!)
  })

  it("separates two conversations that happen to share a tool-call id", () => {
    const a = deriveToolLoopSessionId({ messages: firstRound("call_same") })
    const b = deriveToolLoopSessionId({
      messages: [
        { role: "user", content: "A completely different opening question." },
        { role: "assistant", content: null, tool_calls: [{ id: "call_same", type: "function", function: { name: "bash", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_same", content: "README.md src/" },
      ],
    })
    expect(b).not.toBe(a!)
  })

  it("reads an orphaned tool result, for clients that omit the assistant turn", () => {
    const key = deriveToolLoopSessionId({
      messages: [
        { role: "user", content: PROMPT },
        { role: "tool", tool_call_id: "call_orphan", content: "README.md" },
      ],
    })
    expect(key).toMatch(/^tool-loop:[0-9a-f]{16}$/)
  })

  it("reads array-shaped user content", () => {
    const array = deriveToolLoopSessionId({
      messages: [
        { role: "user", content: [{ type: "text", text: PROMPT }] },
        ...firstRound("call_abc123").slice(1),
      ],
    })
    expect(array).toBe(deriveToolLoopSessionId({ messages: firstRound("call_abc123") })!)
  })

  it("ignores an empty tool-call id rather than keying every such client alike", () => {
    expect(deriveToolLoopSessionId({
      messages: [
        { role: "user", content: PROMPT },
        { role: "assistant", content: null, tool_calls: [{ id: "", type: "function", function: { name: "bash", arguments: "{}" } }] },
      ],
    })).toBeUndefined()
  })

  it("round-trips through the affinity header the inner hop already reads", () => {
    const key = deriveToolLoopSessionId({ messages: firstRound("call_abc123") })!
    expect(openAiAdapter.getSessionId(ctx({ "x-session-affinity": key }))).toBe(key)
  })

  it("yields to a key the client sent itself", () => {
    // The handler only derives when the adapter resolved nothing, so a client
    // key always wins. Asserted here so that precedence stays visible.
    expect(openAiAdapter.getSessionId(ctx({ "x-session-affinity": "client-key" }))).toBe("client-key")
    expect(openAiAdapter.getSessionId(ctx({}))).toBeUndefined()
  })
})
