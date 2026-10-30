import { number, object, rows, text, type WindowKind } from './core'
export type { WindowKind } from './core'

export function filterLogs(data: unknown, query: string) {
  const search = query.trim().toLowerCase()
  return rows(data).filter(log => [log.category, log.level, log.message].some(value => text(value).toLowerCase().includes(search)))
    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
}

/** Search only operational metadata, never arbitrary nested request content. */
export function filterRequests(data: unknown, query: string, kind: string, provider = 'all') {
  const search = query.trim().toLowerCase()
  return rows(data).filter(row => {
    const matchesText = !search || [row.provider, row.requestId, row.model, row.profileId, row.adapter, row.error, row.sdkSessionId].some(value => text(value).toLowerCase().includes(search))
    const matchesKind = kind === 'all' || (kind === 'errors' && Number(row.status) >= 400) || (kind === 'low-cache' && row.lineageType === 'continuation' && number(row.cacheHitRate) !== undefined && Number(row.cacheHitRate) <= .05)
    return matchesText && matchesKind && (provider === 'all' || (text(row.provider) || 'claude') === provider)
  }).sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
}

/**
 * Order profile ids according to an explicit profileOrder sequence.
 * Ids in `order` come first in that sequence; any remaining ids preserve their
 * initial relative order at the end.
 */
export function sortProfilesByConfiguredOrder(ids: string[], order?: readonly string[]): string[] {
  if (!order || order.length === 0) return ids.slice()
  const rank = new Map<string, number>()
  for (let i = 0; i < order.length; i++) {
    const item = order[i]
    if (item && !rank.has(item)) rank.set(item, i)
  }
  return ids
    .map((id, index) => ({ id, index }))
    .sort((a, b) => {
      const ra = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const rb = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
      if (ra !== rb) return ra - rb
      return a.index - b.index
    })
    .map(entry => entry.id)
}

const HOUR = 3_600_000
/** Bucket width per window: 5-minute for 1h, hourly for today/24h, 6-hourly for 7d. */
export const windowBuckets: Record<WindowKind, number> = { '1h': 300_000, today: HOUR, '24h': HOUR, '7d': 6 * HOUR }
const windowSpans: Record<Exclude<WindowKind, 'today'>, number> = { '1h': HOUR, '24h': 24 * HOUR, '7d': 7 * 24 * HOUR }

/** Local midnight (the machine's time zone) of the day containing `now`. */
export function localMidnight(now: number): number { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime() }

/** Milliseconds the summary covers: since local midnight for 'today', else the fixed span. */
export function windowMs(kind: WindowKind, now: number): number {
  // The server reads window=0 as "default (1h)"; one second after midnight is still today.
  return kind === 'today' ? Math.max(1000, now - localMidnight(now)) : windowSpans[kind]
}

export interface TimeRange { start: number; end: number; bucketMs: number }
/**
 * Chart range for a window. 'today' starts at local midnight; rolling windows
 * start on the local bucket grid at or before `now - span`, so hourly buckets
 * read 14:00, 15:00 rather than 14:37, 15:37.
 */
export function windowRange(kind: WindowKind, now: number): TimeRange {
  const bucketMs = windowBuckets[kind]
  const midnight = localMidnight(now)
  if (kind === 'today') return { start: midnight, end: now, bucketMs }
  const earliest = now - windowSpans[kind]
  return { start: midnight + Math.floor((earliest - midnight) / bucketMs) * bucketMs, end: now, bucketMs }
}
/** Summary and routes cover the same range as the chart, so bucket sums match their totals. */
const rangeMs = (kind: WindowKind, now: number) => Math.max(1, now - windowRange(kind, now).start)
export function summaryPath(kind: WindowKind, now: number): string { return `/telemetry/summary?window=${rangeMs(kind, now)}` }
export function routesPath(kind: WindowKind, now: number): string { return `/telemetry/routes?window=${rangeMs(kind, now)}` }
/**
 * How long a window-scoped read may be reused between 10 s polls. Each read
 * scans the window's rows synchronously in the proxy serving live traffic, so
 * long windows are re-read less often; the totals heroes (summary) stay live
 * for the short windows. A forced refresh, a window change or a moved range
 * start always re-reads.
 */
export const windowReadTtl: Record<WindowKind, { summary: number; series: number }> = {
  '1h': { summary: 0, series: 0 },
  today: { summary: 0, series: 30_000 },
  '24h': { summary: 30_000, series: 30_000 },
  '7d': { summary: 60_000, series: 60_000 },
}
export function timeseriesPath(kind: WindowKind, now: number): string {
  const range = windowRange(kind, now)
  return `/telemetry/timeseries?start=${range.start}&end=${range.end}&bucket=${range.bucketMs}`
}

export interface TimeseriesBucket {
  start: number; requests: number; errors: number;
  inputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number;
  cacheHitRate: number | null; p50TotalMs: number | null; p50TtfbMs: number | null; costUsd: number | null;
  unpricedRequests?: number;
}
export interface Timeseries {
  start: number; end: number; bucketMs: number; truncated: boolean; buckets: TimeseriesBucket[];
  /** Set when the buckets were computed here from the recent-requests list, not by the server. */
  estimated?: boolean;
}
const nullableNumber = (value: unknown) => number(value) ?? null
/** Validate a /telemetry/timeseries body; undefined when it is not one. */
export function parseTimeseries(value: unknown): Timeseries | undefined {
  const input = object(value)
  const start = number(input.start), end = number(input.end), bucketMs = number(input.bucketMs)
  if (start === undefined || end === undefined || !bucketMs || !Array.isArray(input.buckets)) return undefined
  return {
    start, end, bucketMs, truncated: input.truncated === true,
    buckets: rows(input.buckets).map(bucket => ({
      start: number(bucket.start) ?? 0, requests: number(bucket.requests) ?? 0, errors: number(bucket.errors) ?? 0,
      inputTokens: number(bucket.inputTokens) ?? 0, cacheReadTokens: number(bucket.cacheReadTokens) ?? 0,
      cacheCreationTokens: number(bucket.cacheCreationTokens) ?? 0, outputTokens: number(bucket.outputTokens) ?? 0,
      cacheHitRate: nullableNumber(bucket.cacheHitRate), p50TotalMs: nullableNumber(bucket.p50TotalMs),
      p50TtfbMs: nullableNumber(bucket.p50TtfbMs), costUsd: nullableNumber(bucket.costUsd),
      ...(number(bucket.unpricedRequests) !== undefined ? { unpricedRequests: number(bucket.unpricedRequests) } : {}),
    })),
  }
}
function median(values: number[]): number | null {
  if (!values.length) return null
  // Same rank as the server's computePercentiles p50.
  return [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.5)] ?? null
}
/**
 * Client-side fallback for Meridian versions without /telemetry/timeseries:
 * bucket the recent-requests list over [start, end). Cost is unknown here
 * (no pricing table), so costUsd is null. `truncated` is set when the list
 * hit its fetch limit before reaching back to `start`.
 */
export function bucketRequests(requests: unknown, range: TimeRange, limit = 500): Timeseries {
  const list = rows(requests)
  const count = range.end > range.start ? Math.ceil((range.end - range.start) / range.bucketMs) : 0
  const groups: Record<string, unknown>[][] = Array.from({ length: count }, () => [])
  let oldest = Infinity
  for (const row of list) {
    const timestamp = number(row.timestamp)
    if (timestamp === undefined) continue
    oldest = Math.min(oldest, timestamp)
    // Keepalive beats are not client requests; the server's summary and timeseries exclude them too.
    if (row.requestSource === 'cache-keepalive') continue
    if (timestamp < range.start || timestamp >= range.end) continue
    groups[Math.floor((timestamp - range.start) / range.bucketMs)]?.push(row)
  }
  const buckets = groups.map((items, index): TimeseriesBucket => {
    const hitRates = items.map(item => number(item.cacheHitRate)).filter((value): value is number => value !== undefined)
    const sum = (key: string) => items.reduce((total, item) => total + (number(item[key]) ?? 0), 0)
    return {
      start: range.start + index * range.bucketMs,
      requests: items.length,
      errors: items.filter(item => text(item.error) !== '' || (number(item.status) ?? 0) >= 400).length,
      inputTokens: sum('inputTokens'), cacheReadTokens: sum('cacheReadInputTokens'),
      cacheCreationTokens: sum('cacheCreationInputTokens'), outputTokens: sum('outputTokens'),
      cacheHitRate: hitRates.length ? Math.round(hitRates.reduce((a, b) => a + b, 0) / hitRates.length * 100) / 100 : null,
      p50TotalMs: median(items.map(item => number(item.totalDurationMs)).filter((value): value is number => value !== undefined)),
      p50TtfbMs: median(items.map(item => number(item.ttfbMs)).filter((value): value is number => value !== undefined)),
      costUsd: null,
    }
  })
  return { start: range.start, end: range.end, bucketMs: range.bucketMs, truncated: list.length >= limit && oldest > range.start, buckets, estimated: true }
}
