/**
 * Letta Code adapter.
 *
 * Letta Code reaches Meridian over the generic OpenAI-compatible transport
 * (`POST /v1/chat/completions`). It brings its own harness instructions, so the
 * Claude Code preset stays off, exactly as for `openai` and `jcode`.
 *
 * Letta sends no session header. Its conversation identity travels in the
 * request body instead: a `<system-reminder>` block in one of Letta's own user
 * messages names the conversation. Letta emits that block once, in the opening
 * user message; later turns carry it only because the client replays the
 * history.
 *
 *   <system-reminder> This is an automated message providing information about you.
 *   - **Agent ID (also stored in `AGENT_ID` env var)**: agent-<uuid>
 *   - **Conversation ID (also stored in `CONVERSATION_ID` env var)**: conv-<uuid>
 *
 * Reading it matters because the fingerprint fallback cannot stand in here.
 * getConversationFingerprint strips `<system-reminder>` blocks before hashing —
 * correctly, since they are per-machine environment noise for every other
 * client — which for Letta removes the only thing distinguishing one
 * conversation from another. What remains is the user's opening message plus
 * the working directory, and a Letta user who opens two conversations with the
 * same words in one project would put both under a single session key. The id
 * is right there in the body, so read it rather than hash around it.
 *
 * Parsing a client's own payload for identity is the established pattern here:
 * `pi` reads its cwd out of system-prompt prose, `claudecode` reads
 * `metadata.user_id`, `opencode` parses an `<env>` block.
 *
 * Detection and identity come from the same signal. A body carrying this
 * reminder is a Letta request; a body without one is not, and falls through to
 * the `openai` adapter unchanged. Letta's User-Agent is the generic OpenAI JS
 * SDK string, which many OpenAI-protocol clients also send, so it does not
 * identify Letta and must not be used for detection — a User-Agent heuristic
 * would silently change behaviour for unrelated clients.
 *
 * NOTE: Letta-specific. Keep this a thin specialization of openAiAdapter; do
 * not fork behaviour here.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { openAiAdapter } from "./openai"

/**
 * Carries the resolved conversation id across Meridian's internal hop, so the
 * inner `/v1/messages` handler resolves the same session without re-parsing a
 * body that has since been translated to Anthropic shape. Same role as
 * `x-jcode-session`.
 */
export const LETTA_CONVERSATION_HEADER = "x-letta-conversation"

/**
 * A Letta conversation id is `conv-` followed by a UUID, and only that shape is
 * accepted. The literal `default` is deliberately rejected: it is the id that
 * every subagent conversation of an agent shares, so keying all of them to one
 * session would be worse than leaving them unidentified. Requests carrying it
 * keep the generic `openai` behaviour (see `docs/agents.md`).
 */
const CONVERSATION_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

const LETTA_CONVERSATION_ID = new RegExp(`^conv-${CONVERSATION_UUID}$`, "i")

/**
 * The labelled id inside the agent-info reminder. Anchored on the label rather
 * than on a bare `conv-…` match so a conversation id quoted in ordinary task
 * text cannot be mistaken for this request's own identity.
 */
const CONVERSATION_MARKER = new RegExp(
  `\\*\\*Conversation ID[^*]*\\*\\*:\\s*(conv-${CONVERSATION_UUID})`,
  "i",
)
const SYSTEM_REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/gi

/** Return the value if it is a well-formed Letta conversation id, else undefined. */
export function normalizeLettaConversationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && LETTA_CONVERSATION_ID.test(trimmed) ? trimmed.toLowerCase() : undefined
}

/**
 * Flatten a message's content to text across both the OpenAI and Anthropic
 * shapes, keeping only the text parts of array content, so the scan below can
 * match against it. Mirrors the private helper each sibling adapter carries
 * (jcode, claudecode, forgecode, pi, prime, droid, passthrough); the
 * duplication is deliberate — a thin adapter stays self-contained rather than
 * reaching into another adapter's module.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text)
    }
  }
  return parts.join("\n")
}

/**
 * Extract the conversation id Letta injects into its own user messages.
 *
 * Walks user messages newest-first, so the scan stops at the nearest copy
 * rather than reading a long history in the common case. Returns undefined for
 * every non-Letta body, which is what keeps this inert for other clients on
 * the same endpoint.
 */
export function extractLettaConversationId(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined
  const messages = body.messages
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== "user") continue
    let id: string | undefined
    for (const reminder of messageText(message.content).matchAll(SYSTEM_REMINDER)) {
      const match = reminder[1]?.match(CONVERSATION_MARKER)
      if (match) id = match[1]?.toLowerCase()
    }
    if (id) return id
  }
  return undefined
}

export const lettaAdapter: AgentAdapter = {
  ...openAiAdapter,
  name: "letta",

  /**
   * The forwarded header first: on the inner hop the body has been translated
   * to Anthropic shape and the reminder text survives, but the header is the
   * value the outer handler already resolved and is cheaper and exact. The
   * body parse remains as the fallback so the adapter also works when selected
   * directly on `/v1/messages`.
   */
  getSessionId(c: Context, body?: unknown): string | undefined {
    return normalizeLettaConversationId(c.req.header(LETTA_CONVERSATION_HEADER))
      ?? extractLettaConversationId(body)
  },
}
