/**
 * Letta Code adapter — unit tests.
 *
 * Letta reaches Meridian over `/v1/chat/completions` and sends no session
 * header. Its conversation id arrives inside the `<system-reminder>` agent-info
 * block in the opening user message; later turns carry it only because the
 * client replays the history. getConversationFingerprint strips those blocks
 * before hashing — so without this adapter a Letta conversation has no
 * identity at all, history is repacked every turn and each tool round takes
 * the headerless bypass.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  lettaAdapter,
  extractLettaConversationId,
  normalizeLettaConversationId,
  LETTA_CONVERSATION_HEADER,
} from "../proxy/adapters/letta"
import { detectAdapter } from "../proxy/adapters/detect"
import { getConversationFingerprint } from "../proxy/session/fingerprint"
import type { Context } from "hono"

const CONV_A = "conv-6dc268b6-06cf-48f6-8706-46f45d4826a7"
const CONV_B = "conv-4dc73925-f4f8-4379-a984-9ffe30e925da"

/** The agent-info reminder Letta injects, verbatim in shape. */
function agentInfoReminder(conversationId?: string): string {
  const conv = conversationId
    ? `\n- **Conversation ID (also stored in \`CONVERSATION_ID\` env var)**: ${conversationId}`
    : ""
  return `<system-reminder> This is an automated message providing information about you.
- **Agent ID (also stored in \`AGENT_ID\` env var)**: agent-659724ce-6392-43c6-af75-d189559cbdae${conv}
- **Agent name**: Axiom (the user can change this with /rename)
</system-reminder>`
}

function ctxFor(headers: Record<string, string> = {}): Context {
  const h = new Headers(headers)
  // Hono's `header()` returns one value when given a name and the whole record
  // when given none; detectAdapter uses both forms.
  const header = (k?: string) =>
    k === undefined ? Object.fromEntries(h.entries()) : (h.get(k) ?? undefined)
  return { req: { header, raw: { headers: h } } } as unknown as Context
}

describe("lettaAdapter identity", () => {
  // Save/restore env so the fallthrough assertion isn't sensitive to ambient
  // state: MERIDIAN_DEFAULT_AGENT is read at call time, so a developer running
  // with it set to "letta" would resolve letta instead of the default.
  let savedDefaultAgent: string | undefined
  beforeEach(() => {
    savedDefaultAgent = process.env.MERIDIAN_DEFAULT_AGENT
    delete process.env.MERIDIAN_DEFAULT_AGENT
  })
  afterEach(() => {
    if (savedDefaultAgent !== undefined) process.env.MERIDIAN_DEFAULT_AGENT = savedDefaultAgent
    else delete process.env.MERIDIAN_DEFAULT_AGENT
  })

  it("is named 'letta'", () => {
    expect(lettaAdapter.name).toBe("letta")
  })

  it("is selected by the x-meridian-agent tag the handler sets on the internal hop", () => {
    expect(detectAdapter(ctxFor({ "x-meridian-agent": "letta" })).name).toBe("letta")
  })

  it("is NOT selected by a generic OpenAI user-agent, which Letta shares with other clients", () => {
    expect(detectAdapter(ctxFor({ "user-agent": "OpenAI/JS 6.48.0" })).name).not.toBe("letta")
  })
})

describe("normalizeLettaConversationId", () => {
  it("accepts a well-formed conversation id, lowercased", () => {
    expect(normalizeLettaConversationId(CONV_A)).toBe(CONV_A)
    expect(normalizeLettaConversationId(`  ${CONV_A.toUpperCase()}  `)).toBe(CONV_A)
  })

  it("rejects anything that is not a conv-<uuid>", () => {
    expect(normalizeLettaConversationId(undefined)).toBeUndefined()
    expect(normalizeLettaConversationId("")).toBeUndefined()
    expect(normalizeLettaConversationId("conv-not-a-uuid")).toBeUndefined()
    expect(normalizeLettaConversationId("agent-659724ce-6392-43c6-af75-d189559cbdae")).toBeUndefined()
  })
})

describe("extractLettaConversationId", () => {
  it("reads the id out of the agent-info reminder", () => {
    const body = { messages: [{ role: "user", content: `${agentInfoReminder(CONV_A)}\nhello` }] }
    expect(extractLettaConversationId(body)).toBe(CONV_A)
  })

  it("reads it from Anthropic-shaped content blocks too", () => {
    const body = {
      messages: [
        { role: "user", content: [{ type: "text", text: agentInfoReminder(CONV_A) }, { type: "text", text: "hello" }] },
      ],
    }
    expect(extractLettaConversationId(body)).toBe(CONV_A)
  })

  it("takes the newest copy when more than one reminder is present", () => {
    const body = {
      messages: [
        { role: "user", content: `${agentInfoReminder(CONV_A)}\nfirst` },
        { role: "assistant", content: "ok" },
        { role: "user", content: `${agentInfoReminder(CONV_B)}\nsecond` },
      ],
    }
    expect(extractLettaConversationId(body)).toBe(CONV_B)
  })

  it("reads the id from the opening message when no later turn carries a reminder", () => {
    // The real wire shape: the reminder appears once, in the opening user
    // message, and later turns carry it only because the client replays the
    // history. A scan that only inspected the newest message would fail here.
    const body = {
      messages: [
        { role: "user", content: `${agentInfoReminder(CONV_A)}\nfirst` },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ],
    }
    expect(extractLettaConversationId(body)).toBe(CONV_A)
  })

  it("ignores reminders on non-user messages", () => {
    const body = { messages: [{ role: "assistant", content: agentInfoReminder(CONV_A) }] }
    expect(extractLettaConversationId(body)).toBeUndefined()
  })

  it("requires the label, so an id quoted in ordinary task text is not identity", () => {
    const body = { messages: [{ role: "user", content: `please look at ${CONV_A} for me` }] }
    expect(extractLettaConversationId(body)).toBeUndefined()
  })

  it("returns undefined when the reminder omits the conversation line", () => {
    const body = { messages: [{ role: "user", content: agentInfoReminder() }] }
    expect(extractLettaConversationId(body)).toBeUndefined()
  })

  it("is inert for every non-Letta body", () => {
    expect(extractLettaConversationId(undefined)).toBeUndefined()
    expect(extractLettaConversationId({})).toBeUndefined()
    expect(extractLettaConversationId({ messages: "not an array" })).toBeUndefined()
    expect(extractLettaConversationId({ messages: [{ role: "user", content: "hello" }] })).toBeUndefined()
  })
})

describe("why the literal `default` id is deliberately rejected", () => {
  it("is rejected by both the normalizer and the body scan", () => {
    // `default` is the id every subagent conversation of an agent shares, so
    // keying them all to one session would merge unrelated conversations
    // (docs/agents.md, "Letta Code").
    expect(normalizeLettaConversationId("default")).toBeUndefined()
    const body = { messages: [{ role: "user", content: `${agentInfoReminder("default")}\nhello` }] }
    expect(extractLettaConversationId(body)).toBeUndefined()
  })
})

describe("lettaAdapter.getSessionId", () => {
  it("reads the forwarded internal-hop header", () => {
    const c = ctxFor({ [LETTA_CONVERSATION_HEADER]: CONV_A })
    expect(lettaAdapter.getSessionId(c, undefined)).toBe(CONV_A)
  })

  it("falls back to the body when no header was forwarded", () => {
    const body = { messages: [{ role: "user", content: agentInfoReminder(CONV_A) }] }
    expect(lettaAdapter.getSessionId(ctxFor(), body)).toBe(CONV_A)
  })

  it("ignores a malformed header rather than keying on it", () => {
    const body = { messages: [{ role: "user", content: agentInfoReminder(CONV_A) }] }
    expect(lettaAdapter.getSessionId(ctxFor({ [LETTA_CONVERSATION_HEADER]: "garbage" }), body)).toBe(CONV_A)
  })

  it("returns undefined when neither source carries an id", () => {
    expect(lettaAdapter.getSessionId(ctxFor(), { messages: [] })).toBeUndefined()
  })

  it("gives distinct conversations distinct keys", () => {
    const bodyFor = (id: string) => ({ messages: [{ role: "user", content: `${agentInfoReminder(id)}\nhey` }] })
    expect(lettaAdapter.getSessionId(ctxFor(), bodyFor(CONV_A)))
      .not.toBe(lettaAdapter.getSessionId(ctxFor(), bodyFor(CONV_B)))
  })
})

describe("why the fingerprint fallback is not enough for Letta", () => {
  it("collides two distinct conversations that open with the same words", () => {
    const messagesFor = (id: string) => [{ role: "user", content: `${agentInfoReminder(id)}\nhey` }]
    // The reminder is stripped before hashing, so all that remains is "hey".
    expect(getConversationFingerprint(messagesFor(CONV_A), "/srv/letta"))
      .toBe(getConversationFingerprint(messagesFor(CONV_B), "/srv/letta"))
  })
})
