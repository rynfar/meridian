/**
 * Official OpenAI list prices, maintained by hand (PURE, no I/O).
 *
 * This is the final guard for scripts/update-openai-pricing.ts: the generated
 * table comes from community catalogs (models.dev, LiteLLM), and the update
 * fails instead of opening a PR when either catalog disagrees with a rate
 * listed here. When OpenAI changes a list price, update this file by hand from
 * the official pages below; the next update run then accepts the new rate.
 *
 * Sources (snapshot 2026-09-27):
 *   - developers.openai.com/api/docs/pricing
 *   - help.openai.com/en/articles/20001106-codex-rate-card
 *
 * Rates are USD per million tokens: uncached input, cached input, output.
 */

export interface OfficialOpenAiRates {
  input: number
  cachedInput: number
  output: number
}

export const OFFICIAL_OPENAI_PRICING: Record<string, OfficialOpenAiRates> = {
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
  "gpt-6-sol": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-6-luna": { input: 0.1, cachedInput: 0.01, output: 0.5 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-5.5": { input: 5, cachedInput: 0.5, output: 30 },
  "gpt-5.4": { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.5 },
  "gpt-5.3-codex": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14 },
  "gpt-5.6-cyber": { input: 12.5, cachedInput: 1.25, output: 75 },
  // Daybreak aliases point at gpt-5.6-sol (blue) and gpt-5.6-cyber (red) and
  // are repriced when OpenAI moves them to a newer model.
  "gpt-daybreak-blue-latest": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-daybreak-red-latest": { input: 12.5, cachedInput: 1.25, output: 75 },
}
