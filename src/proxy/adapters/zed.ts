/**
 * Zed agent adapter.
 *
 * Zed's agent panel reaches Meridian over the generic OpenAI-compatible
 * transport (`POST /v1/chat/completions`) through an `openai_compatible`
 * provider entry. Everything else about it is a coding agent that owns its
 * tool loop, so it is a thin specialization of the OpenAI adapter:
 *
 * - It identifies itself by User-Agent (`Zed/<version> (...)`).
 * - It sends its full tool catalog as OpenAI functions and executes every
 *   tool itself; the proxy forwards tool calls (passthrough) and the results
 *   come back as `tool` messages.
 * - It sends its thread id as `prompt_cache_key` when the model's
 *   `prompt_cache_key` capability is on. That is a durable conversation
 *   identity, so it is the session key; without it the request is
 *   headerless and falls back to the conversation fingerprint.
 * - It ships its own system prompt, with the user's personal AGENTS.md and
 *   the open project's rules, so the Claude Code preset and host CLAUDE.md
 *   stay off (see sdkFeatures.ADAPTER_DEFAULTS.zed).
 * - Besides thread turns it sends one-shot requests for the thread title and
 *   summary. They carry the same thread id and the thread's messages but no
 *   agent system prompt, so by fingerprint they looked like the thread and
 *   resumed each other's SDK sessions. They are auxiliary requests: never
 *   resumed, never stored, no turn lease.
 * - The SDK subprocess runs in a neutral, empty directory of the proxy's
 *   own, on any host. Zed executes every tool, so the subprocess reads no
 *   file; running it in the proxy's checkout made Claude Code attach that
 *   repository's CLAUDE.md and git status to every Zed conversation.
 *
 * NOTE: Zed-specific. Keep this a thin specialization of openAiAdapter.
 */

import type { Context } from "hono"
import type { AgentAdapter } from "../adapter"
import { neutralWorkingDirectory } from "../cwd"
import { resolvePassthrough } from "../../env"
import { openAiAdapter } from "./openai"

/**
 * Carries the thread id across Meridian's internal hop, so the inner
 * `/v1/messages` handler resolves the same session without re-parsing a body
 * that has since been translated to Anthropic shape. Same role as
 * `x-jcode-session`.
 */
export const ZED_SESSION_HEADER = "x-zed-session"

const ZED_SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/

export function isZedUserAgent(userAgent: string | undefined): boolean {
  return (userAgent ?? "").startsWith("Zed/")
}

/** Return the value if it is a bounded, wire-safe Zed thread id, else undefined. */
export function normalizeZedSessionId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed && ZED_SESSION_ID.test(trimmed) ? trimmed : undefined
}

/** The thread id Zed sends as `prompt_cache_key`, on the OpenAI-shaped body. */
export function extractZedSessionId(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined
  return normalizeZedSessionId((body as { prompt_cache_key?: unknown }).prompt_cache_key)
}

function isTextSystemBlock(value: unknown): value is { type: "text"; text: string } {
  if (value === null || typeof value !== "object") return false
  const part = value as Record<string, unknown>
  return part.type === "text" && typeof part.text === "string"
}

/** The request's system prompt as one string, "" when there is none. */
export function extractZedSystemText(body: unknown): string {
  if (body === null || typeof body !== "object") return ""
  const system = (body as { system?: unknown }).system
  if (typeof system === "string") return system
  if (Array.isArray(system)) return system.filter(isTextSystemBlock).map(part => part.text).join("\n")
  return ""
}

/**
 * The first root directory Zed lists in its system prompt:
 *
 *   The current project contains the following root directories:
 *
 *   - `C:\workspaces\project`
 *
 * It is the client's own path, used for fingerprint bucketing and the cwd
 * note; the SDK never runs there (see extractWorkingDirectory).
 */
export function extractZedRootDirectory(body: unknown): string | undefined {
  const match = extractZedSystemText(body).match(/root directories:[^`]*`([^`]+)`/)
  return match?.[1]?.trim() || undefined
}

export const zedAdapter: AgentAdapter = {
  ...openAiAdapter,
  name: "zed",

  /**
   * The forwarded header first (the outer handler resolved it from the
   * OpenAI body); the body as fallback, so the adapter also works when
   * selected directly on `/v1/messages` with a `prompt_cache_key`.
   */
  getSessionId(c: Context, body?: unknown): string | undefined {
    return normalizeZedSessionId(c.req.header(ZED_SESSION_HEADER)) ?? extractZedSessionId(body)
  },

  /**
   * NOTE: Zed-specific. A thread turn always carries Zed's agent system
   * prompt (with the "root directories" block), whatever profile or tool set
   * the user picked; the title and summary one-shots never do.
   */
  isAuxiliaryRequest(_c: Context, body?: unknown): boolean {
    return !extractZedSystemText(body)
  },

  /**
   * NOTE: Zed-specific. A neutral, empty directory of the proxy's own, on any
   * host. MERIDIAN_WORKDIR still wins when an operator sets it.
   */
  extractWorkingDirectory(_body: unknown): string | undefined {
    return neutralWorkingDirectory()
  },

  extractClientWorkingDirectory(body: unknown): string | undefined {
    return extractZedRootDirectory(body)
  },

  // NOTE: Zed-specific. Zed owns tool execution; MERIDIAN_PASSTHROUGH=0 opts out.
  usesPassthrough(): boolean {
    return resolvePassthrough(true)
  },

  // NOTE: Zed-specific. Nothing from the proxy host: Zed ships the user's
  // AGENTS.md and the project's rules in its own system prompt.
  getSettingSources() {
    return []
  },

  supportsThinking(): boolean {
    return true
  },

  /**
   * NOTE: Zed-specific. Zed's panel shows every create_file/edit_file call as
   * a tool card, so Meridian's synthetic "Files changed:" block at the end of
   * the answer would only duplicate it.
   */
  shouldTrackFileChanges(): boolean {
    return false
  },
}
