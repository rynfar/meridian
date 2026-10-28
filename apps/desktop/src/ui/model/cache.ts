/** Cache screen: totals, savings vs no cache, keepalive and the misses with their likely cause. Pure. */
import { number, object } from '../../core'
import { resolveModelPricing } from '../../../../../src/telemetry/pricing'
import type { PricingOverrides, RequestRow } from './requests'

export interface CacheTotals { hit: number | null; read: number; write: number; uncached: number; output: number; missesOnResume: number }
export function cacheTotals(summary: unknown): CacheTotals | null {
  const tokens = object(object(summary).tokenUsage)
  if (number(tokens.totalCacheReadTokens) === undefined && number(tokens.avgCacheHitRate) === undefined) return null
  const requests = number(object(summary).totalRequests) ?? 0
  return {
    hit: requests > 0 ? number(tokens.avgCacheHitRate) ?? null : null,
    read: number(tokens.totalCacheReadTokens) ?? 0, write: number(tokens.totalCacheCreationTokens) ?? 0,
    uncached: number(tokens.totalInputTokens) ?? 0, output: number(tokens.totalOutputTokens) ?? 0,
    missesOnResume: number(tokens.cacheMissOnResumeCount) ?? 0,
  }
}

export interface Savings { savedUsd: number; writePremiumUsd: number; netUsd: number; partial: boolean }
/**
 * What caching saved at list prices: every cache read billed as uncached input
 * instead, minus the premium cache writes cost over uncached input.
 */
export function cacheSavings(summary: unknown, overrides: PricingOverrides): Savings | null {
  const byModel = object(object(object(summary).costEstimate).byModel)
  const models = Object.entries(byModel)
  if (!models.length) return null
  let saved = 0, premium = 0, partial = false, priced = 0
  for (const [model, raw] of models) {
    const m = object(raw)
    // byModel is keyed by requestModel || model; base rates, as the server resolves them.
    const rates = resolveModelPricing(model, overrides)
    if (!rates) { partial = true; continue }
    priced++
    saved += (number(m.cacheReadTokens) ?? 0) * (rates.inputPerMTok - rates.cacheReadPerMTok) / 1e6
    premium += (number(m.cacheCreationTokens) ?? 0) * (rates.cacheWritePerMTok - rates.inputPerMTok) / 1e6
  }
  if (!priced) return null
  return { savedUsd: saved, writePremiumUsd: premium, netUsd: saved - premium, partial }
}

export interface Keepalive { beats: number; reached: number; skipped: number; read: number; write: number; costUsd: number | null }
export function keepalive(summary: unknown): Keepalive | null {
  const k = object(object(summary).cacheKeepalive)
  const beats = number(k.beats) ?? 0
  if (!beats) return null
  return { beats, reached: number(k.reached) ?? 0, skipped: number(k.notReached) ?? 0, read: number(k.cacheReadTokens) ?? 0, write: number(k.cacheCreationTokens) ?? 0, costUsd: number(k.estimatedUsd) ?? null }
}

/**
 * Prompt cache lifetimes without a hit: subscription sessions through the
 * Agent SDK write the one-hour tier; API-key and Extra Usage traffic the
 * five-minute one (measured 2026-10-26, see proxy-core keepalive decision).
 */
export const CACHE_TTL_MS = 5 * 60_000
export const CACHE_TTL_LONG_MS = 60 * 60_000
export interface CacheMiss { row: RequestRow; why: string; severity: 'miss' | 'low' }
/**
 * Continuations that reused little of the cache, newest first, with the most
 * likely reason from the previous turn of the same session.
 */
export function cacheMisses(rows: readonly RequestRow[], threshold = 0.5, limit = 50, since = -Infinity): CacheMiss[] {
  const ordered = [...rows].filter(row => !row.failed).sort((a, b) => a.timestamp - b.timestamp)
  const previous = new Map<string, RequestRow>()
  const misses: CacheMiss[] = []
  for (const row of ordered) {
    const prior = row.sessionId ? previous.get(row.sessionId) : undefined
    if (row.sessionId) previous.set(row.sessionId, row)
    if (row.timestamp < since || !(row.isResume || row.lineage === 'continuation') || row.cacheHit === null || row.cacheHit > threshold) continue
    misses.push({ row, why: missReason(row, prior), severity: row.cacheHit === 0 ? 'miss' : 'low' })
  }
  return misses.reverse().slice(0, limit)
}

export function missReason(row: RequestRow, prior: RequestRow | undefined): string {
  if (row.lineage === 'compaction') return 'History was compacted, so the cached prefix no longer matches'
  if (row.lineage === 'undo') return 'Recent messages were undone, which forks the conversation'
  if (row.lineage === 'diverged') return 'The history no longer matches the stored session'
  if (!prior) return 'Resumed a conversation whose earlier turns are not among the loaded requests — most likely idle past its cache lifetime'
  if (prior.profile && row.profile && prior.profile !== row.profile) return `Switched from ${prior.profile} to ${row.profile} — each account has its own cache`
  if (prior.model !== row.model) return `Model changed from ${prior.model} to ${row.model} — caches are per model`
  const gap = row.timestamp - prior.timestamp
  if (gap > CACHE_TTL_LONG_MS) return `${Math.round(gap / 60_000)} min since the previous turn — past even the one-hour cache`
  if (gap > CACHE_TTL_MS) return `${Math.round(gap / 60_000)} min since the previous turn — past the five-minute cache (API key or Extra Usage)`
  if (prior.toolCount !== null && row.toolCount !== null && prior.toolCount !== row.toolCount) return `Tool list changed (${prior.toolCount} → ${row.toolCount}), which changes the prompt prefix`
  return 'The prompt prefix changed (system prompt, tools or early messages)'
}
