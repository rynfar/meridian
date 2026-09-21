/**
 * OpenAI-compatible endpoint adapter.
 *
 * `/v1/chat/completions` serves generic OpenAI chat clients (Open WebUI,
 * LibreChat, curl, any OpenAI-compatible tool). These are NOT coding agents:
 * they bring their own system prompt and don't want the ~28KB claude_code
 * preset injected on top of it (which would override their intent with the
 * Claude Code persona — see the #526 investigation).
 *
 * The handler tags the internal hop with `x-meridian-agent: openai` so this
 * adapter is selected deterministically instead of falling through to the
 * default `opencode` adapter (whose preset defaults ON). Behaviour is
 * otherwise identical to `opencode` — same tools, MCP server, passthrough,
 * and transforms — the ONLY difference is the system-prompt preset default,
 * which is set OFF in sdkFeatures.ADAPTER_DEFAULTS. This mirrors the
 * `passthrough` adapter precedent (#190).
 *
 * NOTE: agent-specific. Keep this as a thin re-identification of the OpenCode
 * adapter; do not fork behaviour here.
 */

import { createHash } from "node:crypto"
import type { AgentAdapter } from "../adapter"
import { openCodeAdapter } from "./opencode"

export const openAiAdapter: AgentAdapter = {
  ...openCodeAdapter,
  name: "openai",
}

/**
 * Marks an internal hop whose session key Meridian synthesized rather than
 * received from the client (see deriveToolLoopSessionId).
 *
 * The inner handler treats such a key as a declared concurrent flow. A client
 * that never asked for a session key must not be able to earn a 400
 * `session_turn_conflict` from one Meridian invented on its behalf: the worst
 * outcome for a synthesized key stays what it is today, a fresh replay.
 */
export const SYNTHESIZED_SESSION_HEADER = "x-meridian-synthesized-session"

/** Flatten OpenAI message content to text; array content keeps text parts. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
}

/**
 * Derive a stable session key for a client-driven tool loop that sends none.
 *
 * A generic OpenAI client running its own tool loop resends the whole growing
 * conversation each round, ending in the `tool` message it just produced. With
 * no session key those rounds take the headerless-tool-result bypass: no
 * resume, no cache write, a fresh SDK session every round. The bypass is not a
 * mistake — the conversation fingerprint is (first user message, cwd), so two
 * runs of one workflow started from the same prompt in the same directory hash
 * to a single key, and one would resume the other's session (premature
 * end_turn, dropped tool calls).
 *
 * The loop's own first tool-call id closes that hole. It is issued per
 * generation, so concurrent runs of the same script never share one; it stays
 * in the history for the life of the conversation, so every later round of
 * that run derives the same key; and it exists exactly when this path is
 * reached, since a tool loop has by definition called a tool. Hashing it
 * together with the opening user message means a collision now needs both the
 * same prompt and the same id.
 *
 * Returns undefined for a body with no tool call, which is every ordinary
 * chat: those keep today's packed, unkeyed behaviour untouched.
 */
export function deriveToolLoopSessionId(body: unknown): string | undefined {
  const messages = (body as { messages?: unknown })?.messages
  if (!Array.isArray(messages)) return undefined
  let anchorId: string | undefined
  let seedText: string | undefined
  for (const message of messages as any[]) {
    if (anchorId === undefined) {
      const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : []
      const call = calls.find((c: any) => typeof c?.id === "string" && c.id.length > 0)
      if (call) anchorId = call.id as string
      else if (message?.role === "tool" && typeof message.tool_call_id === "string" && message.tool_call_id.length > 0) {
        anchorId = message.tool_call_id
      }
    }
    if (seedText === undefined && message?.role === "user") {
      const text = messageText(message.content)
      if (text) seedText = text
    }
    if (anchorId !== undefined && seedText !== undefined) break
  }
  if (anchorId === undefined) return undefined
  const seed = `${(seedText ?? "").slice(0, 2000)}\n${anchorId}`
  return `tool-loop:${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`
}
