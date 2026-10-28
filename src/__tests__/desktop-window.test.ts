import { describe, expect, test } from 'bun:test'
import { windowKind } from '../../apps/desktop/src/core'
import { bucketRequests, localMidnight, parseTimeseries, summaryPath, timeseriesPath, windowMs, windowRange } from '../../apps/desktop/src/uiData'

const HOUR = 3_600_000
// 14:37:20 local time on an arbitrary day, whatever the test machine's zone.
const now = new Date(2026, 9, 27, 14, 37, 20).getTime()
const midnight = new Date(2026, 9, 27).getTime()

describe('dashboard window', () => {
  test('today is since local midnight; rolling windows are fixed spans', () => {
    expect(localMidnight(now)).toBe(midnight)
    expect(windowMs('today', now)).toBe(now - midnight)
    expect(windowMs('1h', now)).toBe(HOUR)
    expect(windowMs('24h', now)).toBe(24 * HOUR)
    expect(windowMs('7d', now)).toBe(7 * 24 * HOUR)
    // window=0 would mean "default 1h" to the server.
    expect(windowMs('today', midnight)).toBe(1000)
    expect(summaryPath('today', now)).toBe(`/telemetry/summary?window=${now - midnight}`)
  })
  test('timeseries URL per window: start, end and bucket', () => {
    expect(timeseriesPath('today', now)).toBe(`/telemetry/timeseries?start=${midnight}&end=${now}&bucket=${HOUR}`)
    // Rolling windows start on the local bucket grid at or before now - span.
    expect(timeseriesPath('1h', now)).toBe(`/telemetry/timeseries?start=${midnight + 13 * HOUR + 35 * 60_000}&end=${now}&bucket=300000`)
    expect(timeseriesPath('24h', now)).toBe(`/telemetry/timeseries?start=${midnight - 10 * HOUR}&end=${now}&bucket=${HOUR}`)
    const week = windowRange('7d', now)
    expect(week.bucketMs).toBe(6 * HOUR)
    expect(week.start).toBe(midnight - 7 * 24 * HOUR + 12 * HOUR)
    expect(week.start).toBeLessThanOrEqual(now - 7 * 24 * HOUR)
    expect(timeseriesPath('7d', now)).toBe(`/telemetry/timeseries?start=${week.start}&end=${now}&bucket=${6 * HOUR}`)
  })
  test('window kinds are validated', () => {
    expect(windowKind('24h')).toBe('24h')
    expect(windowKind({ kind: 'today' })).toBe('today')
    expect(() => windowKind('30d')).toThrow('Choose')
  })
})

describe('client-side bucketing fallback', () => {
  const range = { start: 0, end: 3 * HOUR, bucketMs: HOUR }
  const requests = [
    { timestamp: 10, inputTokens: 5, cacheReadInputTokens: 100, cacheCreationInputTokens: 3, outputTokens: 7, cacheHitRate: 0.9, totalDurationMs: 300, ttfbMs: 100, error: null },
    { timestamp: 20, inputTokens: 1, outputTokens: 2, cacheHitRate: 0.5, totalDurationMs: 100, ttfbMs: null, error: 'overloaded' },
    { timestamp: 30, totalDurationMs: 200, status: 500 },
    { timestamp: 2 * HOUR + 5, totalDurationMs: 50, inputTokens: 4 },
    { timestamp: 3 * HOUR, totalDurationMs: 1 }, // end is exclusive
    { timestamp: -1, totalDurationMs: 1 },
  ]
  test('matches the server bucket shape over [start, end)', () => {
    const series = bucketRequests(requests, range)
    expect(series).toMatchObject({ start: 0, end: 3 * HOUR, bucketMs: HOUR, truncated: false, estimated: true })
    expect(series.buckets.map(b => b.start)).toEqual([0, HOUR, 2 * HOUR])
    expect(series.buckets[0]).toEqual({ start: 0, requests: 3, errors: 2, inputTokens: 6, cacheReadTokens: 100, cacheCreationTokens: 3, outputTokens: 9, cacheHitRate: 0.7, p50TotalMs: 200, p50TtfbMs: 100, costUsd: null })
    expect(series.buckets[1]).toMatchObject({ requests: 0, cacheHitRate: null, p50TotalMs: null, p50TtfbMs: null })
    expect(series.buckets[2]).toMatchObject({ requests: 1, inputTokens: 4, p50TotalMs: 50 })
  })
  test('marks truncation when the request list hit its limit before reaching start', () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ timestamp: HOUR + i }))
    expect(bucketRequests(full, range).truncated).toBe(true)
    expect(bucketRequests(full, { ...range, start: HOUR + 10 }).truncated).toBe(false)
    expect(bucketRequests(null, range).buckets).toHaveLength(3)
  })
  test('server timeseries bodies are validated', () => {
    const body = { start: 1, end: 2, bucketMs: 60000, truncated: false, buckets: [{ start: 1, requests: 2, errors: 0, inputTokens: 1, cacheReadTokens: 2, cacheCreationTokens: 3, outputTokens: 4, cacheHitRate: null, p50TotalMs: 9, p50TtfbMs: null, costUsd: 0.5, unpricedRequests: 0 }] }
    expect(parseTimeseries(body)).toEqual(body)
    expect(parseTimeseries({ error: 'nope' })).toBeUndefined()
  })
})
