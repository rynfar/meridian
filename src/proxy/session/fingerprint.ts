/**
 * Conversation fingerprinting and client working directory extraction.
 *
 * NOTE: extractClientCwd is OpenCode-specific (parses <env> blocks).
 * When the adapter pattern is implemented, this will move to the
 * OpenCode adapter. getConversationFingerprint is agent-agnostic.
 */

import { createHash } from "crypto"

/**
 * Extract the client's working directory from the system prompt.
 * OpenCode embeds it inside an <env> block:
 *   <env>
 *     Working directory: /path/to/project
 *     ...
 *   </env>
 *
 * Returns the path if found, or undefined to fall back to server defaults.
 */
export function extractClientCwd(body: any): string | undefined {
  let systemText = ""
  if (typeof body.system === "string") {
    systemText = body.system
  } else if (Array.isArray(body.system)) {
    systemText = body.system
      .filter((b: any) => b.type === "text" && b.text)
      .map((b: any) => b.text)
      .join("\n")
  }
  if (!systemText) return undefined

  const match = systemText.match(/<env>\s*[\s\S]*?Working directory:\s*([^\n<]+)/i)
  return match?.[1]?.trim() || undefined
}

/**
 * Hash the first user message + working directory to fingerprint a conversation.
 * Used to find a cached session when no session header is present.
 * Includes workingDirectory (stable per project, unlike systemContext which
 * contains dynamic file trees/diagnostics that change every request).
 * This prevents cross-project collisions when different projects start
 * with the same first message.
 * <system-reminder> blocks injected into user messages are stripped
 * before hashing: they are per-machine environment noise, not conversation
 * identity, and can otherwise dominate the hash window. When a client
 * opens with a reminder-only message (Droid), the seed comes from the
 * first user message that carries actual task text.
 */
export function getConversationFingerprint(messages: Array<{ role: string; content: any }>, workingDirectory?: string): string {
  const users = messages?.filter((m) => m.role === "user") ?? []
  const firstUserText = userText(users[0])
  if (!firstUserText) return ""
  // Client-injected <system-reminder> blocks (environment capture, tool
  // manifests, dynamic context) are identical across conversations in the
  // same project and can exceed the slice window, so distinct conversations
  // collided on one key and diverged as unrelated-history. Hash the user's
  // actual request instead; reminders are replayed verbatim each turn, so
  // stripping preserves within-conversation stability.
  //
  // Clients like Droid open with a reminder-only environment message and
  // deliver the actual request in a LATER user message; that reminder
  // payload is machine-global, so seeding from it would conflate every
  // conversation in the project. Walk the user messages and seed from the
  // first one that carries real task text. A history where every user
  // message is reminder-only keeps the raw first-message window, so that
  // degenerate path is unchanged.
  let seedText = ""
  for (const message of users) {
    const stripped = userText(message).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
    if (stripped) {
      seedText = stripped
      break
    }
  }
  seedText = seedText || firstUserText
  const seed = workingDirectory ? `${workingDirectory}\n${seedText.slice(0, 2000)}` : seedText.slice(0, 2000)
  return createHash("sha256").update(seed).digest("hex").slice(0, 16)
}

function userText(message: { role: string; content: any } | undefined): string {
  if (!message) return ""
  return typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : ""
}

/**
 * Key a conversation for priority-pool assignment.
 *
 * An explicit session id always wins — keyed clients behave exactly as before.
 * Without one, the conversation fingerprint stands in, which is what gives
 * keyless clients pool affinity: Pylon's main process deliberately sends no
 * session key (its provider headers are per-process, so one key would merge
 * every open chat into a single meridian session), and without a fallback
 * such a conversation re-picks its account every turn — bouncing back to the
 * preferred profile the moment its cooldown expires and replaying its whole
 * history against a cold cache.
 *
 * The `fp:` prefix namespaces fingerprint-derived keys so they can never
 * collide with a real session id. An empty fingerprint returns null rather
 * than inventing a key, preserving today's no-affinity behavior for requests
 * we cannot identify.
 *
 * NOTE: this is only ever an ACCOUNT key, never a session key. Two unrelated
 * conversations that share a first message and working directory will share
 * an assignment — that costs nothing, because it selects a profile and never
 * a resumable SDK session.
 */
export function getPriorityAssignmentKey(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  workingDirectory?: string,
): string | null {
  if (sessionId) return sessionId
  const fingerprint = getConversationFingerprint(messages, workingDirectory)
  return fingerprint ? `fp:${fingerprint}` : null
}
