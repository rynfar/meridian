/**
 * Static Anthropic API list pricing and cost estimation (PURE, no I/O).
 *
 * Meridian proxies Claude Max, so requests are covered by the subscription
 * and never billed per token. The numbers produced here answer a different
 * question: "what would this usage have cost at API list prices?", useful
 * for judging how much value the subscription is delivering.
 *
 * Rates are USD per million tokens, verified against the official pricing
 * docs (platform.claude.com/docs/en/about-claude/pricing, snapshot 2026-07).
 * Users can override any rate, or add models missing from this table, via
 * the settings page (persisted by pricingStore.ts; overrides win in
 * resolveModelPricing). Cache rates are derived from the input rate:
 *   - cache read  = 0.10× input
 *   - cache write = 1.25× input (5-minute TTL, the TTL the SDK uses, see
 *     MONITORING.md; 1-hour TTL writes bill at 2×, so if a client opted into
 *     the long TTL this estimate is a floor)
 *
 * Models without a table entry are excluded from the total and surfaced via
 * `unpricedRequestCount` instead of silently costing $0.
 */

import type { RequestMetric, CostEstimate, ModelCostBreakdown } from "./types"

export interface ModelPricing {
  /** USD per 1M uncached input tokens */
  inputPerMTok: number
  /** USD per 1M output tokens */
  outputPerMTok: number
  /** USD per 1M cache-read input tokens */
  cacheReadPerMTok: number
  /** USD per 1M cache-write (creation) input tokens */
  cacheWritePerMTok: number
}

export const CACHE_READ_MULTIPLIER = 0.1
export const CACHE_WRITE_MULTIPLIER = 1.25

/** Normalize a model string for pricing lookup: trimmed, lowercase, [1m] suffix stripped. */
export function normalizeModelKey(model: string): string {
  return model.trim().toLowerCase().replace(/\[1m\]$/, "")
}

function rates(inputPerMTok: number, outputPerMTok: number): ModelPricing {
  return {
    inputPerMTok,
    outputPerMTok,
    cacheReadPerMTok: inputPerMTok * CACHE_READ_MULTIPLIER,
    cacheWritePerMTok: inputPerMTok * CACHE_WRITE_MULTIPLIER,
  }
}

const FABLE = rates(10, 50)
const OPUS = rates(5, 25) // Opus 4.5 and later
const OPUS_LEGACY = rates(15, 75) // Opus 4.1 and earlier
const SONNET = rates(3, 15) // every Sonnet generation to date, standard rate
// Sonnet 5 introductory pricing runs through 2026-08-31; standard 3/15 applies
// from 2026-09-01. Update this entry (or set a settings override) after that.
const SONNET_5_INTRO = rates(2, 10)
const HAIKU = rates(1, 5) // Haiku 4.5
const HAIKU_35 = rates(0.8, 4)
const HAIKU_3 = rates(0.25, 1.25)

/**
 * Exact-match table. Keys are lowercase, checked after stripping the [1m]
 * suffix. Covers the SDK aliases meridian itself uses (opus, sonnet, ...)
 * plus concrete API model IDs that clients commonly send. Dated snapshot
 * IDs (e.g. claude-haiku-4-5-20251001) fall through to the family rules.
 *
 * Exported for the settings page, which lists these models with their
 * default rates so users can override them.
 */
export const BUILTIN_MODEL_PRICING: Record<string, ModelPricing> = {
  fable: FABLE,
  "claude-fable-5": FABLE,
  "claude-mythos-5": FABLE,
  opus: OPUS,
  "claude-opus-4-8": OPUS,
  "claude-opus-4-7": OPUS,
  "claude-opus-4-6": OPUS,
  "claude-opus-4-5": OPUS,
  "claude-opus-4-1": OPUS_LEGACY,
  "claude-opus-4-0": OPUS_LEGACY,
  "claude-opus-4-20250514": OPUS_LEGACY,
  "claude-3-opus-20240229": OPUS_LEGACY,
  sonnet: SONNET,
  "claude-sonnet-5": SONNET_5_INTRO,
  "claude-sonnet-4-6": SONNET,
  "claude-sonnet-4-5": SONNET,
  haiku: HAIKU,
  "claude-haiku-4-5": HAIKU,
  "claude-3-5-haiku-20241022": HAIKU_35,
  "claude-3-haiku-20240307": HAIKU_3,
}

/**
 * Resolve a model string to pricing. User-defined overrides win, then the
 * exact built-in table, then family fallback so versioned/dated IDs
 * (claude-opus-4-8, claude-haiku-4-5-20251001) and future releases still
 * price at their family's current rate.
 * Returns null for unrecognized models; callers must not treat that as $0.
 */
export function resolveModelPricing(
  model: string,
  overrides?: Record<string, ModelPricing>,
): ModelPricing | null {
  const normalized = normalizeModelKey(model)

  if (overrides) {
    const override = overrides[normalized]
    if (override) return override
  }

  const exact = BUILTIN_MODEL_PRICING[normalized]
  if (exact) return exact

  if (normalized.includes("fable") || normalized.includes("mythos")) return FABLE
  if (normalized.includes("haiku")) {
    if (normalized.includes("3-5") || normalized.includes("3.5")) return HAIKU_35
    if (/haiku-3\b|3-haiku/.test(normalized)) return HAIKU_3
    return HAIKU
  }
  if (normalized.includes("opus")) {
    if (/opus-4-1\b|opus-4-1-|opus-4-0|opus-4-2025|3-opus/.test(normalized)) return OPUS_LEGACY
    return OPUS
  }
  if (normalized.includes("sonnet")) return SONNET

  return null
}

/** Estimated USD for a single request's token usage at the given rates. */
export function estimateRequestCostUsd(metric: RequestMetric, pricing: ModelPricing): number {
  return (
    ((metric.inputTokens ?? 0) / 1e6) * pricing.inputPerMTok +
    ((metric.outputTokens ?? 0) / 1e6) * pricing.outputPerMTok +
    ((metric.cacheReadInputTokens ?? 0) / 1e6) * pricing.cacheReadPerMTok +
    ((metric.cacheCreationInputTokens ?? 0) / 1e6) * pricing.cacheWritePerMTok
  )
}

/** Round to micro-dollars to keep JSON output free of float noise. */
function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * Aggregate estimated cost per model across a set of metrics.
 * Grouping key is requestModel || model, matching computeSummary's byModel.
 * Pass overrides (from pricingStore) to apply user-defined rates.
 */
export function computeCostEstimate(
  metrics: RequestMetric[],
  overrides?: Record<string, ModelPricing>,
): CostEstimate {
  const byModel: Record<string, ModelCostBreakdown> = {}
  const byProfile: Record<string, { requests: number; estimatedUsd: number }> = {}
  let totalUsd = 0
  let unpricedRequestCount = 0

  for (const metric of metrics) {
    const modelKey = metric.requestModel || metric.model
    const pricing = resolveModelPricing(modelKey, overrides)
    const profileEntry = byProfile[metric.profileId ?? "default"] ??= { requests: 0, estimatedUsd: 0 }
    profileEntry.requests++
    const entry = byModel[modelKey] ??= {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedUsd: pricing === null ? null : 0,
    }

    entry.requests++
    entry.inputTokens += metric.inputTokens ?? 0
    entry.outputTokens += metric.outputTokens ?? 0
    entry.cacheReadTokens += metric.cacheReadInputTokens ?? 0
    entry.cacheCreationTokens += metric.cacheCreationInputTokens ?? 0

    if (pricing === null) {
      unpricedRequestCount++
      continue
    }
    const cost = estimateRequestCostUsd(metric, pricing)
    entry.estimatedUsd = (entry.estimatedUsd ?? 0) + cost
    profileEntry.estimatedUsd += cost
    totalUsd += cost
  }

  for (const entry of Object.values(byProfile)) {
    entry.estimatedUsd = roundUsd(entry.estimatedUsd)
  }

  for (const entry of Object.values(byModel)) {
    if (entry.estimatedUsd !== null) entry.estimatedUsd = roundUsd(entry.estimatedUsd)
  }

  return { totalUsd: roundUsd(totalUsd), byModel, unpricedRequestCount, byProfile }
}
