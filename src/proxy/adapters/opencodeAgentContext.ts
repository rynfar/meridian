import { createHash } from "node:crypto"

/** NOTE: OpenCode-specific. Primary agents share the client's session key,
 * but native SDK resume restores the first agent's system prompt. A change of
 * explicitly declared primary agent therefore needs complete client replay.
 * Do not hash the whole system prompt: dynamic file trees and diagnostics
 * change independently of agent selection and must retain ordinary resume. */
export function openCodePrimaryAgentContextHash(
  mode: string | undefined,
  name: string | undefined,
  includeClientPrompt = true,
): string | undefined {
  const agent = name?.trim()
  if (!includeClientPrompt || mode !== "primary" || !agent) return undefined
  return createHash("sha256").update(agent).digest("hex")
}

export function requiresOpenCodeAgentReplay(storedHash: string | undefined, currentHash: string | undefined): boolean {
  return currentHash !== undefined && storedHash !== currentHash
}
