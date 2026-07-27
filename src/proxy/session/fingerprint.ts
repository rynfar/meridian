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
 */
export function getConversationFingerprint(messages: Array<{ role: string; content: any }>, workingDirectory?: string): string {
  const firstUser = messages?.find((m) => m.role === "user")
  if (!firstUser) return ""
  const text = typeof firstUser.content === "string"
    ? firstUser.content
    : Array.isArray(firstUser.content)
      ? firstUser.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("")
      : ""
  if (!text) return ""
  const seed = workingDirectory ? `${workingDirectory}\n${text.slice(0, 2000)}` : text.slice(0, 2000)
  return createHash("sha256").update(seed).digest("hex").slice(0, 16)
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
