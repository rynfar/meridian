/** Chart data for the selected window: server buckets, or the recent-requests fallback. Pure. */
import type { DesktopState } from '../../contracts'
import { bucketRequests, localMidnight, windowRange, type Timeseries, type TimeseriesBucket, type WindowKind } from '../../uiData'
import { hhmm } from './format'

export interface ChartSeries { series: Timeseries; estimated: boolean; note?: string }

/**
 * `timeseries` when the server answered; null + note means it cannot
 * (older Meridian): bucket the recent requests instead. null without a note is
 * still loading.
 */
export function chartSeries(state: Pick<DesktopState, 'timeseries' | 'timeseriesNote' | 'requests' | 'window'>, now: number): ChartSeries | null {
  if (state.timeseries) return { series: state.timeseries, estimated: state.timeseries.estimated === true }
  if (state.timeseriesNote === undefined || state.requests === null) return null
  return { series: bucketRequests(state.requests, windowRange(state.window.kind, now)), estimated: true, note: state.timeseriesNote }
}

/** One slot per bucket; for Today, the whole day so the rest of it reads as "not yet". */
export function slots(series: Timeseries, kind: WindowKind, now: number): (TimeseriesBucket | null)[] {
  if (kind !== 'today') return series.buckets
  const midnight = localMidnight(now)
  const hour = 3_600_000
  return Array.from({ length: 24 }, (_, index) => {
    const start = midnight + index * hour
    if (start > now) return null
    return series.buckets.find(bucket => bucket.start >= start && bucket.start < start + hour) ?? null
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
  return Math.min(1, (now - localMidnight(now)) / 86_400_000)
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
  return Math.floor((now - localMidnight(now)) / 3_600_000) + 1
}

/** "Prompt tokens per hour", "… per 5 minutes", "… per 6 hours". */
export function bucketWord(bucketMs: number): string {
  if (bucketMs >= 86_400_000) return 'day'
  if (bucketMs >= 2 * 3_600_000) return `${Math.round(bucketMs / 3_600_000)} hours`
  if (bucketMs >= 3_600_000) return 'hour'
  return `${Math.max(1, Math.round(bucketMs / 60_000))} minutes`
}
