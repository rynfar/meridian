import type { AdapterFeatures } from "../sdkFeatures"

/** NOTE: OpenCode-specific. Hidden title/summary agents own a one-shot
 * instruction contract. The native coding preset can answer their input
 * instead. Use their client prompt alone only when that prompt is enabled;
 * preserve the configured preset if the operator suppresses client prompts. */
export function getOpenCodeSourceFeatureOverrides(
  requestSource: string | undefined,
  includeClientPrompt = true,
): Partial<AdapterFeatures> {
  return includeClientPrompt && (requestSource === "subagent-title" || requestSource === "subagent-summary")
    ? { codeSystemPrompt: false }
    : {}
}
