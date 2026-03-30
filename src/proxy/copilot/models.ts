/**
 * GitHub Copilot model definitions for Meridian.
 */

/** Models routed through the Copilot /chat/completions endpoint. */
const CHAT_MODELS = new Set([
  "claude-opus-4.6",
  "claude-sonnet-4.6",
])

/** Models that require the Copilot /responses endpoint (Codex family). */
const RESPONSES_MODELS = new Set([
  "gpt-5.3-codex",
])

/** All Copilot model IDs supported by this proxy. */
export const ALL_COPILOT_MODELS: readonly string[] = [
  ...CHAT_MODELS,
  ...RESPONSES_MODELS,
]

export function isCopilotModel(model: string): boolean {
  return CHAT_MODELS.has(model) || RESPONSES_MODELS.has(model)
}

export function usesResponsesEndpoint(model: string): boolean {
  return RESPONSES_MODELS.has(model)
}
