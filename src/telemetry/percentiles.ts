/**
 * Shared percentile computation used by all telemetry store implementations.
 */

import type { CacheKeepaliveSummary, RequestMetric, PhaseTiming, TelemetrySummary } from "./types"
import { computeCostEstimate, type ModelPricing } from "./pricing"

export function computePercentiles(values: number[]): PhaseTiming {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 }

  const sorted = [...values].sort((a, b) => a - b)
  const sum = sorted.reduce((a, b) => a + b, 0)

  return {
    p50: sorted[Math.floor(sorted.length * 0.5)]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
    p99: sorted[Math.floor(sorted.length * 0.99)]!,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    avg: Math.round(sum / sorted.length),
  }
}

/** `requestSource` of a prompt-cache keepalive beat (proxy/cacheKeepalive.ts). */
export const CACHE_KEEPALIVE_REQUEST_SOURCE = "cache-keepalive"

/** A keepalive beat: background work that answered no client. */
export function isCacheKeepaliveMetric(metric: RequestMetric): boolean {
  return metric.requestSource === CACHE_KEEPALIVE_REQUEST_SOURCE
}

function summarizeCacheKeepalive(
  beats: RequestMetric[],
  pricingOverrides?: Record<string, ModelPricing>,
): CacheKeepaliveSummary {
  const summary: CacheKeepaliveSummary = {
    beats: beats.length,
    reached: 0,
    notReached: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedUsd: beats.length > 0 ? computeCostEstimate(beats, pricingOverrides).totalUsd : 0,
  }
  for (const beat of beats) {
    // A beat reached upstream when it got usage back (status 200), even if
    // joining its child afterwards failed.
    if (beat.status === 200) summary.reached++
    else summary.notReached++
    summary.inputTokens += beat.inputTokens ?? 0
    summary.outputTokens += beat.outputTokens ?? 0
    summary.cacheReadTokens += beat.cacheReadInputTokens ?? 0
    summary.cacheCreationTokens += beat.cacheCreationInputTokens ?? 0
  }
  return summary
}

/**
 * Compute a TelemetrySummary from an array of RequestMetric.
 * Both MemoryTelemetryStore and SqliteTelemetryStore use this
 * to guarantee identical output.
 *
 * pricingOverrides: user-defined model rates (from pricingStore) applied
 * to the cost estimate; omit for built-in pricing only.
 */
export function computeSummary(
  allMetrics: RequestMetric[],
  windowMs: number,
  pricingOverrides?: Record<string, ModelPricing>,
): TelemetrySummary {
  // Keepalive beats are not requests: counted, costed and reported apart.
  const metrics = allMetrics.filter(metric => !isCacheKeepaliveMetric(metric))
  const cacheKeepalive = summarizeCacheKeepalive(allMetrics.filter(isCacheKeepaliveMetric), pricingOverrides)
  if (metrics.length === 0) {
    const emptyPhase: PhaseTiming = { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 }
    return {
      windowMs,
      totalRequests: 0,
      errorCount: 0,
      envelopeViolationCount: 0,
      requestsPerMinute: 0,
      queueWait: emptyPhase,
      sessionQueueWait: emptyPhase,
      sdkQueueWait: emptyPhase,
      proxyOverhead: emptyPhase,
      ttfb: emptyPhase,
      upstreamDuration: emptyPhase,
      totalDuration: emptyPhase,
      byModel: {},
      byMode: {},
      tokenUsage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        avgCacheHitRate: 0,
        cacheMissOnResumeCount: 0,
      },
      costEstimate: { totalUsd: 0, byModel: {}, unpricedRequestCount: 0, byProfile: {} },
      cacheKeepalive,
    }
  }

  const errorCount = metrics.filter(m => m.error !== null).length
  const envelopeViolationCount = metrics.reduce((sum, m) => sum + (m.envelopeViolations?.length ?? 0), 0)

  const oldest = metrics[metrics.length - 1]!.timestamp
  const newest = metrics[0]!.timestamp
  const spanMs = Math.max(newest - oldest, 1)
  const requestsPerMinute = (metrics.length / spanMs) * 60_000

  const queueWaits = metrics.map(m => m.queueWaitMs)
  const sessionQueueWaits = metrics.map(m => m.sessionQueueWaitMs ?? 0)
  const sdkQueueWaits = metrics.map(m => m.sdkQueueWaitMs ?? 0)
  const overheads = metrics.map(m => m.proxyOverheadMs)
  const ttfbs = metrics.filter(m => m.ttfbMs !== null).map(m => m.ttfbMs!)
  const upstreams = metrics.map(m => m.upstreamDurationMs)
  const totals = metrics.map(m => m.totalDurationMs)

  const byModel: Record<string, { count: number; totalMs: number }> = {}
  for (const m of metrics) {
    const modelKey = m.requestModel || m.model
    const entry = byModel[modelKey] ??= { count: 0, totalMs: 0 }
    entry.count++
    entry.totalMs += m.totalDurationMs
  }

  const byMode: Record<string, { count: number; totalMs: number }> = {}
  for (const m of metrics) {
    const entry = byMode[m.mode] ??= { count: 0, totalMs: 0 }
    entry.count++
    entry.totalMs += m.totalDurationMs
  }

  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCacheReadTokens = 0
  let totalCacheCreationTokens = 0
  let cacheHitRateSum = 0
  let cacheHitRateCount = 0
  let cacheMissOnResumeCount = 0

  for (const m of metrics) {
    totalInputTokens += m.inputTokens ?? 0
    totalOutputTokens += m.outputTokens ?? 0
    totalCacheReadTokens += m.cacheReadInputTokens ?? 0
    totalCacheCreationTokens += m.cacheCreationInputTokens ?? 0
    if (m.cacheHitRate !== undefined) {
      cacheHitRateSum += m.cacheHitRate
      cacheHitRateCount++
    }
    if (m.isResume && m.cacheHitRate !== undefined && m.cacheHitRate === 0) {
      cacheMissOnResumeCount++
    }
  }

  return {
    windowMs,
    totalRequests: metrics.length,
    errorCount,
    envelopeViolationCount,
    requestsPerMinute: Math.round(requestsPerMinute * 100) / 100,
    queueWait: computePercentiles(queueWaits),
    sessionQueueWait: computePercentiles(sessionQueueWaits),
    sdkQueueWait: computePercentiles(sdkQueueWaits),
    proxyOverhead: computePercentiles(overheads),
    ttfb: ttfbs.length > 0 ? computePercentiles(ttfbs) : { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 },
    upstreamDuration: computePercentiles(upstreams),
    totalDuration: computePercentiles(totals),
    byModel: Object.fromEntries(
      Object.entries(byModel).map(([k, v]) => [k, { count: v.count, avgTotalMs: Math.round(v.totalMs / v.count) }])
    ),
    byMode: Object.fromEntries(
      Object.entries(byMode).map(([k, v]) => [k, { count: v.count, avgTotalMs: Math.round(v.totalMs / v.count) }])
    ),
    tokenUsage: {
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
      avgCacheHitRate: cacheHitRateCount > 0
        ? Math.round((cacheHitRateSum / cacheHitRateCount) * 100) / 100
        : 0,
      cacheMissOnResumeCount,
    },
    costEstimate: computeCostEstimate(metrics, pricingOverrides),
    cacheKeepalive,
  }
}
