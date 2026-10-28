/**
 * Bucketed request history for GET /telemetry/timeseries.
 *
 * Pure — no I/O, no store access, no clock: the route reads the store and
 * passes rows, the range, the store's retention and `now` in. Counting follows
 * computeSummary (see the telemetry-ui spec), so the buckets of a range sum to
 * the /telemetry/summary totals for it.
 */

import type { RequestMetric, TelemetryRetention } from "./types"
import { computePercentiles, isCacheKeepaliveMetric } from "./percentiles"
import { computeCostEstimate, type ModelPricing } from "./pricing"

export const TIMESERIES_MIN_BUCKET_MS = 60_000
export const TIMESERIES_DEFAULT_BUCKET_MS = 3_600_000
export const TIMESERIES_DEFAULT_WINDOW_MS = 86_400_000
export const TIMESERIES_MAX_RANGE_MS = 31 * 86_400_000
export const TIMESERIES_MAX_BUCKETS = 1000
/** Rows one timeseries read may load; the bound summarize() uses for SQLite. */
export const TIMESERIES_MAX_ROWS = 100_000

const DAY_MS = 86_400_000

export interface TimeseriesRange {
  /** Inclusive epoch ms; buckets are aligned to it. */
  start: number
  /** Exclusive epoch ms; the last bucket is cut short at it. */
  end: number
  bucketMs: number
}

export interface TimeseriesBucket {
  start: number
  requests: number
  errors: number
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  /** Mean per-request hit rate, as summarize()'s avgCacheHitRate; null when
   *  no request in the bucket recorded one. */
  cacheHitRate: number | null
  p50TotalMs: number | null
  p50TtfbMs: number | null
  /** API-equivalent estimate of the priced requests; null when the bucket has
   *  requests and none of them is priced. */
  costUsd: number | null
  /** Requests excluded from costUsd because their model has no price. */
  unpricedRequests: number
}

export interface TimeseriesResponse {
  start: number
  end: number
  bucketMs: number
  truncated: boolean
  buckets: TimeseriesBucket[]
}

export type TimeseriesQueryResult =
  | { ok: true; range: TimeseriesRange }
  | { ok: false; error: string }

/** Absent → undefined; present but blank or unparsable → NaN (rejected). */
function parseMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  return raw.trim() === "" ? Number.NaN : Number(raw)
}

/**
 * Validate the query of GET /telemetry/timeseries. `start` wins over `window`
 * when both are given.
 */
export function parseTimeseriesQuery(
  query: { start?: string; end?: string; window?: string; bucket?: string },
  now: number,
): TimeseriesQueryResult {
  const end = parseMs(query.end) ?? now
  const windowMs = parseMs(query.window) ?? TIMESERIES_DEFAULT_WINDOW_MS
  const explicitStart = parseMs(query.start)
  const start = explicitStart ?? end - windowMs
  const bucketMs = parseMs(query.bucket) ?? TIMESERIES_DEFAULT_BUCKET_MS

  if (!Number.isFinite(end)) return { ok: false, error: "end must be a finite epoch-ms number" }
  if (explicitStart === undefined && !Number.isFinite(windowMs)) {
    return { ok: false, error: "window must be a finite number of ms" }
  }
  if (!Number.isFinite(start)) return { ok: false, error: "start must be a finite epoch-ms number" }
  if (!Number.isFinite(bucketMs)) return { ok: false, error: "bucket must be a finite number of ms" }
  if (start >= end) return { ok: false, error: "start must be before end" }
  if (bucketMs < TIMESERIES_MIN_BUCKET_MS) {
    return { ok: false, error: `bucket must be at least ${TIMESERIES_MIN_BUCKET_MS} ms` }
  }
  if (end - start > TIMESERIES_MAX_RANGE_MS) return { ok: false, error: "range must not exceed 31 days" }
  if (bucketCount({ start, end, bucketMs }) > TIMESERIES_MAX_BUCKETS) {
    return { ok: false, error: `range must not exceed ${TIMESERIES_MAX_BUCKETS} buckets` }
  }
  return { ok: true, range: { start, end, bucketMs } }
}

export function bucketCount(range: TimeseriesRange): number {
  return Math.ceil((range.end - range.start) / range.bucketMs)
}

/**
 * Whether the store may have dropped rows inside [start, …): a full ring has
 * evicted its oldest rows, and SQLite deletes rows past its retention. Either
 * way the range is covered only if the oldest row held reaches back to start.
 * A memory ring that is not full has dropped nothing, so a range reaching back
 * before the first request is empty, not truncated.
 */
export function retentionTruncates(retention: TelemetryRetention, start: number, now: number): boolean {
  const mayHaveDropped = retention.kind === "memory"
    ? retention.capacity !== undefined && retention.held >= retention.capacity
    : retention.retentionDays !== undefined && start < now - retention.retentionDays * DAY_MS
  if (!mayHaveDropped) return false
  return retention.oldestTimestamp === null || retention.oldestTimestamp > start
}

function emptyBucket(start: number): TimeseriesBucket {
  return {
    start,
    requests: 0,
    errors: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    cacheHitRate: null,
    p50TotalMs: null,
    p50TtfbMs: null,
    costUsd: 0,
    unpricedRequests: 0,
  }
}

function aggregateBucket(start: number, rows: RequestMetric[], pricingOverrides?: Record<string, ModelPricing>): TimeseriesBucket {
  const bucket = emptyBucket(start)
  if (rows.length === 0) return bucket

  let hitRateSum = 0
  let hitRateCount = 0
  const totals: number[] = []
  const ttfbs: number[] = []
  for (const row of rows) {
    bucket.requests++
    if (row.error !== null) bucket.errors++
    bucket.inputTokens += row.inputTokens ?? 0
    bucket.cacheReadTokens += row.cacheReadInputTokens ?? 0
    bucket.cacheCreationTokens += row.cacheCreationInputTokens ?? 0
    bucket.outputTokens += row.outputTokens ?? 0
    if (row.cacheHitRate !== undefined) {
      hitRateSum += row.cacheHitRate
      hitRateCount++
    }
    totals.push(row.totalDurationMs)
    if (typeof row.ttfbMs === "number") ttfbs.push(row.ttfbMs)
  }

  bucket.cacheHitRate = hitRateCount > 0 ? Math.round((hitRateSum / hitRateCount) * 100) / 100 : null
  bucket.p50TotalMs = computePercentiles(totals).p50
  bucket.p50TtfbMs = ttfbs.length > 0 ? computePercentiles(ttfbs).p50 : null
  const cost = computeCostEstimate(rows, pricingOverrides)
  bucket.unpricedRequests = cost.unpricedRequestCount
  bucket.costUsd = cost.unpricedRequestCount === rows.length ? null : cost.totalUsd
  return bucket
}

/**
 * Bucket rows over [range.start, range.end). Every bucket is present; rows
 * outside the range and keepalive beats are ignored.
 *
 * @param coverage.limitReached the read hit its row bound, so older rows in
 *                              the range may be missing
 * @param coverage.retention    the store's describe(), checked with `now`
 */
export function buildTimeseries(
  rows: RequestMetric[],
  range: TimeseriesRange,
  coverage: { limitReached?: boolean; retention?: TelemetryRetention; now?: number } = {},
  pricingOverrides?: Record<string, ModelPricing>,
): TimeseriesResponse {
  const count = bucketCount(range)
  const grouped: RequestMetric[][] = Array.from({ length: count }, () => [])
  for (const row of rows) {
    if (isCacheKeepaliveMetric(row)) continue
    if (row.timestamp < range.start || row.timestamp >= range.end) continue
    grouped[Math.floor((row.timestamp - range.start) / range.bucketMs)]!.push(row)
  }

  const truncated = coverage.limitReached === true
    || (coverage.retention !== undefined && coverage.now !== undefined
      && retentionTruncates(coverage.retention, range.start, coverage.now))

  return {
    start: range.start,
    end: range.end,
    bucketMs: range.bucketMs,
    truncated,
    buckets: grouped.map((bucketRows, i) => aggregateBucket(range.start + i * range.bucketMs, bucketRows, pricingOverrides)),
  }
}
