/**
 * Letta Code adapter.
 *
 * Letta Code reaches Meridian over the generic OpenAI-compatible transport
 * (`POST /v1/chat/completions`). It brings its own harness instructions, so the
 * Claude Code preset stays off, exactly as for `openai` and `jcode`.
 *
 * Letta sends no session header. Its conversation identity travels in the
 * request body instead: a `<system-reminder>` block that Letta re-injects on
 * every turn names the conversation.
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
 * the `openai` adapter unchanged. Letta's User-Agent is the generic OpenAI SDK
 * string shared with Open WebUI, LibreChat and curl, so there is deliberately
 * no User-Agent heuristic — widening one would silently change behaviour for
 * unrelated clients.
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

/** A Letta conversation id is `conv-` followed by a UUID. */
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

/** Return the value if it is a well-formed Letta conversation id, else undefined. */
export function normalizeLettaConversationId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && LETTA_CONVERSATION_ID.test(trimmed) ? trimmed.toLowerCase() : undefined
}

/**
 * Flatten a message's content to text across both the OpenAI and Anthropic
 * shapes, keeping only the text parts of array content, so the scan below can
 * match against it. Mirrors the private helper each sibling adapter carries
 * (jcode, claudecode, forgecode, pi, prime, droid, passthrough, opencode); the
 * duplication is deliberate — a thin adapter stays self-contained rather than
 * reaching into another adapter's module.
 */
function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("\n")
}

/**
 * Extract the conversation id Letta injects into its own user messages.
 *
 * Walks user messages newest-first: the reminder is re-injected every turn, so
 * the freshest copy is nearest the end, and a long history is not scanned in
 * full on the common path. Returns undefined for every non-Letta body, which
 * is what keeps this inert for other clients on the same endpoint.
 */
export function extractLettaConversationId(body: unknown): string | undefined {
  const messages = (body as { messages?: unknown })?.messages
  if (!Array.isArray(messages)) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: unknown; content?: unknown } | undefined
    if (message?.role !== "user") continue
    const match = messageText(message.content).match(CONVERSATION_MARKER)
    if (match) return match[1]!.toLowerCase()
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
