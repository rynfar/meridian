/** Chart data for the selected window: server buckets, or the recent-requests fallback. Pure. */
import type { DesktopState } from '../../contracts'
import { bucketRequests, localMidnight, windowRange, type Timeseries, type TimeseriesBucket, type WindowKind } from '../../uiData'
import { number, object } from '../../core'
import { hhmm } from './format'

export interface ChartSeries { series: Timeseries; estimated: boolean; note?: string }

/**
 * `timeseries` when the server answered; null + note means it cannot
 * (older Meridian): bucket the recent requests instead. null without a note is
 * still loading.
 */
export function chartSeries(state: Pick<DesktopState, 'timeseries' | 'timeseriesNote' | 'requests' | 'window'> & { summary?: unknown }, now: number): ChartSeries | null {
  if (state.timeseries) return { series: state.timeseries, estimated: state.timeseries.estimated === true }
  if (state.timeseriesNote === undefined || state.requests === null) return null
  const expected = number(object(state.summary).totalRequests)
  return { series: bucketRequests(state.requests, windowRange(state.window.kind, now), 500, expected), estimated: true, note: state.timeseriesNote }
}

/**
 * The one line under a chart that says what it does not show, or null. A
 * server-truncated range means Meridian no longer holds the start of the
 * window (memory ring full or retention), so every window figure misses it.
 */
export function historyNote(chart: ChartSeries | null): string | null {
  if (!chart) return null
  if (chart.estimated) return chart.series.truncated
    ? 'Estimated from the latest requests, which do not reach back to the start of this window; earlier hours look empty.'
    : 'Estimated from the latest requests; this Meridian has no hourly history.'
  return chart.series.truncated ? 'Meridian no longer holds the start of this window (retention or memory limit); earlier requests are not counted.' : null
}

/** Local wall-clock hour `index` of the day holding `now` (JS normalizes a skipped DST hour forward). */
function localHour(now: number, index: number): number {
  const day = new Date(localMidnight(now))
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), index).getTime()
}
/** Buckets that fall in one wall-clock slot (two on the repeated DST hour), as one. */
function mergeBuckets(items: readonly TimeseriesBucket[]): TimeseriesBucket | null {
  const first = items[0]
  if (!first || items.length === 1) return first ?? null
  const sum = (key: 'requests' | 'errors' | 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'outputTokens') => items.reduce((total, item) => total + item[key], 0)
  const rated = items.filter(item => item.cacheHitRate !== null && item.requests > 0)
  const weight = rated.reduce((total, item) => total + item.requests, 0)
  const busiest = [...items].sort((a, b) => b.requests - a.requests)[0] ?? first
  const costs = items.map(item => item.costUsd).filter((value): value is number => value !== null)
  return {
    start: first.start, requests: sum('requests'), errors: sum('errors'), inputTokens: sum('inputTokens'), cacheReadTokens: sum('cacheReadTokens'),
    cacheCreationTokens: sum('cacheCreationTokens'), outputTokens: sum('outputTokens'),
    cacheHitRate: weight ? rated.reduce((total, item) => total + (item.cacheHitRate ?? 0) * item.requests, 0) / weight : null,
    // Medians do not add; show the busier hour's.
    p50TotalMs: busiest.p50TotalMs, p50TtfbMs: busiest.p50TtfbMs,
    costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    ...(items.some(item => item.unpricedRequests !== undefined) ? { unpricedRequests: items.reduce((total, item) => total + (item.unpricedRequests ?? 0), 0) } : {}),
  }
}
/**
 * One slot per bucket; for Today, one per wall-clock hour of the whole day so
 * the rest of it reads as "not yet". On DST days the slots follow the clock:
 * the skipped hour is an empty slot and the repeated hour holds both buckets.
 */
export function slots(series: Timeseries, kind: WindowKind, now: number): (TimeseriesBucket | null)[] {
  if (kind !== 'today') return series.buckets
  return Array.from({ length: 24 }, (_, index) => {
    const start = localHour(now, index), end = localHour(now, index + 1)
    if (start > now) return null
    return mergeBuckets(series.buckets.filter(bucket => bucket.start >= start && bucket.start < end))
  })
}

/** Axis labels under a sparkline: 00:00 · 06:00 · 12:00 · 18:00 · now 21:41 for Today. */
export function axisLabels(kind: WindowKind, series: Timeseries | undefined, now: number): string[] {
  if (kind === 'today') return ['00:00', '06:00', '12:00', '18:00', `now ${hhmm(now)}`]
  const start = series?.start ?? windowRange(kind, now).start
  const day = (t: number) => new Date(t).toLocaleDateString('en-US', { weekday: 'short' })
  if (kind === '7d') return [day(start), day(start + (now - start) / 3), day(start + 2 * (now - start) / 3), `now ${hhmm(now)}`]
  return [hhmm(start), hhmm(start + (now - start) / 3), hhmm(start + 2 * (now - start) / 3), `now ${hhmm(now)}`]
}

/** Where "now" sits along today's 24 slots, 0..1; null for rolling windows (now is the right edge). */
export function nowFraction(kind: WindowKind, now: number): number | null {
  if (kind !== 'today') return null
  // Wall-clock position, so it lines up with the hour slots on DST days too.
  const date = new Date(now)
  return Math.min(1, (date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600) / 24)
}

export interface SparkPaths { line: string; area: string; runs: number }
/**
 * SVG paths for values on equal-width slots. A null slot (no traffic) breaks
 * the line into separate runs instead of bridging it; a lone point is drawn as
 * a short flat segment across its slot so it stays visible.
 */
export function sparkPaths(values: readonly (number | null)[], width: number, height: number, domain: [number, number], pad = 4): SparkPaths {
  const step = values.length ? width / values.length : width
  const [lo, hi] = domain
  const y = (value: number) => {
    const t = hi > lo ? (Math.min(hi, Math.max(lo, value)) - lo) / (hi - lo) : 1
    return +(height - pad - t * (height - 2 * pad)).toFixed(1)
  }
  const runs: [number, number][][] = []
  let current: [number, number][] | null = null
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) { current = null; return }
    if (!current) { current = []; runs.push(current) }
    current.push([+(index * step + step / 2).toFixed(1), y(value)])
  })
  const widen = (run: [number, number][]): [number, number][] => {
    const only = run[0]
    if (run.length !== 1 || !only) return run
    return [[+(only[0] - step / 2 + 1).toFixed(1), only[1]], [+(only[0] + step / 2 - 1).toFixed(1), only[1]]]
  }
  const toPath = (run: [number, number][]) => run.map(([px, py], index) => `${index ? 'L' : 'M'}${px} ${py}`).join(' ')
  const line = runs.map(run => toPath(widen(run))).join(' ')
  const area = runs.map(run => {
    const points = widen(run)
    const first = points[0], last = points[points.length - 1]
    return first && last ? `${toPath(points)} L${last[0]} ${height} L${first[0]} ${height} Z` : ''
  }).join(' ')
  return { line, area, runs: runs.length }
}

/** A domain that keeps a 96–99% hit rate readable instead of a flat line at the top. */
export function hitDomain(values: readonly (number | null)[]): [number, number] {
  const real = values.filter((value): value is number => value !== null && Number.isFinite(value))
  if (!real.length) return [0, 1]
  const min = Math.min(...real)
  const lo = Math.max(0, Math.floor((min - 0.05) * 10) / 10)
  return [Math.min(lo, 0.8), 1]
}

/** Prompt tokens of a bucket split for the cache chart. */
export function cacheSplit(bucket: TimeseriesBucket): { read: number; write: number; uncached: number } {
  return { read: bucket.cacheReadTokens, write: bucket.cacheCreationTokens, uncached: bucket.inputTokens }
}

/** Bucket axis tick: hour for short windows, weekday + hour for 7d. */
export function bucketLabel(start: number, bucketMs: number): string {
  if (bucketMs >= 6 * 3_600_000) return `${new Date(start).toLocaleDateString('en-US', { weekday: 'short' })} ${hhmm(start)}`
  return hhmm(start)
}

/** Index of the first Today slot still in the future (Infinity for rolling windows). */
export function firstFutureSlot(kind: WindowKind, now: number): number {
  if (kind !== 'today') return Infinity
  return new Date(now).getHours() + 1
}

/** "Prompt tokens per hour", "… per 5 minutes", "… per 6 hours". */
export function bucketWord(bucketMs: number): string {
  if (bucketMs >= 86_400_000) return 'day'
  if (bucketMs >= 2 * 3_600_000) return `${Math.round(bucketMs / 3_600_000)} hours`
  if (bucketMs >= 3_600_000) return 'hour'
  return `${Math.max(1, Math.round(bucketMs / 60_000))} minutes`
}
