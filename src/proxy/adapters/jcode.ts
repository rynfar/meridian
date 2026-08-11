/**
 * Jcode agent adapter.
 *
 * Jcode uses the generic OpenAI-compatible transport, but supplies a durable
 * local session ID and a plain-text working-directory marker.
 *
 * NOTE: Jcode-specific. Keep this as a thin specialization of openAiAdapter.
 */

import type { AgentAdapter } from "../adapter"
import { openAiAdapter } from "./openai"

const JCODE_SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/

export function normalizeJcodeSessionId(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed && JCODE_SESSION_ID.test(trimmed) ? trimmed : undefined
}

function isTextSystemBlock(value: unknown): value is { type: "text"; text: string } {
  if (value === null || typeof value !== "object") return false
  const part = value as Record<string, unknown>
  return part.type === "text" && typeof part.text === "string"
}

export function extractJcodeWorkingDirectory(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined
  const system = (body as { system?: unknown }).system
  const text = typeof system === "string"
    ? system
    : Array.isArray(system)
      ? system.filter(isTextSystemBlock).map(part => part.text).join("\n")
      : ""
  // [^\S\n] not \s — \s spans newlines, so an empty marker would swallow the
  // next line ("Git branch: main") and pass it off as the working directory.
  return text.match(/(?:^|\n)Working directory:[^\S\n]*([^\n]+)/)?.[1]?.trim() || undefined
}

export const jcodeAdapter: AgentAdapter = {
  ...openAiAdapter,
  name: "jcode",

  getSessionId(c): string | undefined {
    return normalizeJcodeSessionId(c.req.header("x-jcode-session"))
  },

  extractWorkingDirectory(body): string | undefined {
    return extractJcodeWorkingDirectory(body)
  },
}
