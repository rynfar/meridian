/**
 * The prompt, split by where its tokens came from: cache read, cache write and
 * fresh (uncached) input. One definition for every "from cache" figure — the
 * Today and Cache heroes, the sidebar count and the menu-bar tile — so they
 * always agree. Pure.
 */
import { number, object } from '../../core'
import type { TimeseriesBucket } from '../../uiData'

export interface PromptTokens { read: number; write: number; fresh: number }
export interface PromptShare extends PromptTokens {
  /** read + write + fresh. */
  total: number;
  /** Token-weighted share of the prompt served from cache; null without prompt tokens. */
  share: number | null;
}

/** "Prompt from cache" = cacheRead / (cacheRead + cacheWrite + uncached input), from /telemetry/summary. */
export function promptShare(summary: unknown): PromptShare {
  const tokens = object(object(summary).tokenUsage)
  const read = Math.max(0, number(tokens.totalCacheReadTokens) ?? 0)
  const write = Math.max(0, number(tokens.totalCacheCreationTokens) ?? 0)
  const fresh = Math.max(0, number(tokens.totalInputTokens) ?? 0)
  return shareOf({ read, write, fresh })
}

export function shareOf(tokens: PromptTokens): PromptShare {
  const total = tokens.read + tokens.write + tokens.fresh
  return { ...tokens, total, share: total > 0 ? tokens.read / total : null }
}

export interface RibbonSplit { read: number; write: number; fresh: number }
/**
 * Fractions of the ribbon (summing to 1) for read · write · fresh; null when
 * the prompt is empty. `minFresh` keeps a sliver of fresh input visible when
 * there is any (the specimen uses 0.4% in heroes, 1% in rows), so a 99.99%
 * prompt still reads as "not quite all".
 */
export function ribbonSplit(tokens: PromptTokens, minFresh = 0): RibbonSplit | null {
  const read = Math.max(0, tokens.read), write = Math.max(0, tokens.write)
  let fresh = Math.max(0, tokens.fresh)
  const raw = read + write + fresh
  if (raw <= 0) return null
  if (fresh > 0 && minFresh > 0) fresh = Math.max(fresh, raw * minFresh)
  const total = read + write + fresh
  return { read: read / total, write: write / total, fresh: fresh / total }
}

export type StripState = 'future' | 'empty' | 'data'
export interface StripColumn {
  state: StripState; start: number | null;
  read: number; write: number; fresh: number; requests: number; failed: number;
  /** Token column height as a share of the tallest column, 0..1. */
  height: number;
  /** Successful and failed request bars as a share of the busiest bucket, 0..1. */
  okHeight: number; failHeight: number;
}
/**
 * The day strip: one column per slot with stacked prompt tokens and the
 * request count beneath. Slots after `futureFrom` (an index) have not happened
 * yet; a null slot before it is an empty past bucket.
 */
export function stripColumns(slots: readonly (TimeseriesBucket | null)[], futureFrom = Infinity): StripColumn[] {
  const tokens = (bucket: TimeseriesBucket | null) => bucket ? bucket.cacheReadTokens + bucket.cacheCreationTokens + bucket.inputTokens : 0
  const maxTokens = Math.max(0, ...slots.map(tokens))
  const maxRequests = Math.max(0, ...slots.map(bucket => bucket?.requests ?? 0))
  return slots.map((bucket, index) => {
    const future = index >= futureFrom
    const total = tokens(bucket)
    const requests = bucket?.requests ?? 0, failed = Math.min(requests, bucket?.errors ?? 0)
    const state: StripState = future ? 'future' : !bucket || (total === 0 && requests === 0) ? 'empty' : 'data'
    return {
      state, start: bucket?.start ?? null,
      read: bucket?.cacheReadTokens ?? 0, write: bucket?.cacheCreationTokens ?? 0, fresh: bucket?.inputTokens ?? 0, requests, failed,
      height: state === 'data' && maxTokens > 0 ? total / maxTokens : 0,
      okHeight: state === 'data' && maxRequests > 0 ? (requests - failed) / maxRequests : 0,
      failHeight: state === 'data' && maxRequests > 0 ? failed / maxRequests : 0,
    }
  })
}
