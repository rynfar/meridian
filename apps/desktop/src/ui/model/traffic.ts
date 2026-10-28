/** Traffic screen: header stats, filters and facets. Pure. */
import { number, object } from '../../core'
import { fmtInt, pct, seconds, usd } from './format'
import type { RequestRow } from './requests'

export type RequestKind = 'all' | 'errors' | 'low-cache'
export interface RequestFilter { query: string; kind: RequestKind; provider: string; client: string; profile: string }
export const emptyFilter: RequestFilter = { query: '', kind: 'all', provider: 'all', client: 'all', profile: 'all' }

/** Search covers operational metadata only, never request content. */
export function filterRows<T extends RequestRow>(rows: readonly T[], filter: RequestFilter): T[] {
  const search = filter.query.trim().toLowerCase()
  return rows.filter(row => {
    if (search && ![row.provider, row.id, row.model, row.requestModel, row.profile, row.adapter, row.source, row.error, row.sessionId].some(value => value.toLowerCase().includes(search))) return false
    if (filter.kind === 'errors' && !row.failed) return false
    if (filter.kind === 'low-cache' && !(row.lineage === 'continuation' && row.cacheHit !== null && row.cacheHit <= 0.05)) return false
    if (filter.provider !== 'all' && row.provider !== filter.provider) return false
    if (filter.client !== 'all' && (row.adapter || row.source) !== filter.client) return false
    if (filter.profile !== 'all' && row.profile !== filter.profile) return false
    return true
  })
}

/** The request table covers the selected window, like the stats and chart above it. */
export function rowsInWindow<T extends RequestRow>(rows: readonly T[], since: number): T[] {
  return rows.filter(row => row.timestamp >= since)
}

/**
 * A deep-linked request comes from every loaded request, not only the
 * window: one outside it still opens, with a quiet note saying so.
 */
export function findRequest<T extends RequestRow>(rows: readonly T[], id: string, since: number): { row: T; note?: string } | undefined {
  const row = id ? rows.find(candidate => candidate.id === id) : undefined
  if (!row) return undefined
  return row.timestamp < since ? { row, note: 'outside the selected window' } : { row }
}

export function facets(rows: readonly RequestRow[]): { providers: string[]; clients: string[]; profiles: string[] } {
  const distinct = (values: string[]) => [...new Set(values.filter(Boolean))].sort()
  return { providers: distinct(rows.map(row => row.provider)), clients: distinct(rows.map(row => row.adapter || row.source)), profiles: distinct(rows.map(row => row.profile)) }
}

export interface StatCell { label: string; value: string; detail: string; tone?: 'red' | 'yellow' | 'green' | 'violet' }
/** One stats strip for the window, from /telemetry/summary and /telemetry/routes. */
export function trafficStats(summary: unknown, routes: unknown): StatCell[] {
  const s = object(summary)
  if (number(s.totalRequests) === undefined) return []
  const total = number(s.totalRequests) ?? 0
  const errors = number(s.errorCount) ?? 0
  const phase = (key: string) => object(s[key])
  const cost = object(s.costEstimate)
  const r = object(routes)
  const cells: StatCell[] = [
    { label: 'Requests', value: fmtInt(total), detail: `${(number(s.requestsPerMinute) ?? 0).toFixed(1)} per minute` },
    { label: 'Failed', value: fmtInt(errors), detail: total ? `${((errors / total) * 100).toFixed(1)}% of requests` : 'no requests', tone: errors ? 'red' : undefined },
    { label: 'Total', value: seconds(phase('totalDuration').p50), detail: `p95 ${seconds(phase('totalDuration').p95)}` },
    { label: 'First token', value: seconds(phase('ttfb').p50), detail: `p95 ${seconds(phase('ttfb').p95)}` },
  ]
  const failedOver = number(r.failedOver) ?? 0, unserved = number(r.unserved) ?? 0
  if (failedOver || unserved || Object.keys(object(r.byProfile)).length > 1) {
    cells.push({ label: 'Failovers', value: fmtInt(failedOver), detail: `of ${fmtInt(r.requests)} requests${unserved ? ` · ${unserved} unserved` : ''}`, tone: failedOver ? 'yellow' : undefined })
  }
  const envelope = number(s.envelopeViolationCount) ?? 0
  if (envelope) cells.push({ label: 'Envelope', value: fmtInt(envelope), detail: 'wire-contract violations', tone: 'red' })
  if (number(cost.totalUsd) !== undefined) {
    const unpriced = number(cost.unpricedRequestCount) ?? 0
    cells.push({ label: 'API-equivalent', value: usd(cost.totalUsd), detail: unpriced ? `${unpriced} unpriced requests excluded` : 'list prices · not billed' })
  }
  return cells
}

export interface PercentileRow { label: string; p50: number | null; p95: number | null; p99: number | null; min: number | null; max: number | null; avg: number | null }
export function percentileRows(summary: unknown): PercentileRow[] {
  const s = object(summary)
  const rows: [string, string][] = [['Queue wait', 'queueWait'], ['Session queue', 'sessionQueueWait'], ['SDK queue', 'sdkQueueWait'], ['Proxy overhead', 'proxyOverhead'], ['First token', 'ttfb'], ['Upstream', 'upstreamDuration'], ['Total', 'totalDuration']]
  return rows.filter(([, key]) => s[key] !== undefined).map(([label, key]) => {
    const p = object(s[key])
    const get = (k: string) => number(p[k]) ?? null
    return { label, p50: get('p50'), p95: get('p95'), p99: get('p99'), min: get('min'), max: get('max'), avg: get('avg') }
  })
}

export interface ModelRow { model: string; requests: number; avgMs: number | null; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number | null }
export function modelRows(summary: unknown): ModelRow[] {
  const s = object(summary)
  const byModel = object(s.byModel)
  const costs = object(object(s.costEstimate).byModel)
  const names = [...new Set([...Object.keys(byModel), ...Object.keys(costs)])]
  return names.map(model => {
    const m = object(byModel[model]), c = object(costs[model])
    return { model, requests: number(m.count) ?? number(c.requests) ?? 0, avgMs: number(m.avgTotalMs) ?? null, input: number(c.inputTokens) ?? 0, output: number(c.outputTokens) ?? 0, cacheRead: number(c.cacheReadTokens) ?? 0, cacheWrite: number(c.cacheCreationTokens) ?? 0, costUsd: c.estimatedUsd === null ? null : number(c.estimatedUsd) ?? null }
  }).sort((a, b) => b.requests - a.requests)
}

export interface AccountTrafficRow { id: string; served: number; refused: number; refusedOn: string; costUsd: number | null }
export function accountTrafficRows(summary: unknown, routes: unknown): AccountTrafficRow[] {
  const byProfile = object(object(routes).byProfile)
  const costs = object(object(object(summary).costEstimate).byProfile)
  const ids = [...new Set([...Object.keys(byProfile), ...Object.keys(costs)])]
  return ids.map(id => {
    const t = object(byProfile[id])
    const buckets = object(t.refusedBuckets)
    return { id, served: number(t.served) ?? number(object(costs[id]).requests) ?? 0, refused: number(t.refused) ?? 0, refusedOn: Object.entries(buckets).map(([bucket, count]) => `${bucket.replaceAll('_', ' ')} ×${count}`).join(', '), costUsd: number(object(costs[id]).estimatedUsd) ?? null }
  }).sort((a, b) => b.served - a.served || b.refused - a.refused || a.id.localeCompare(b.id))
}

/** Lineage counts over the loaded requests. */
export function lineageCounts(rows: readonly RequestRow[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.lineage || 'unknown', (counts.get(row.lineage || 'unknown') ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

export const hitText = (row: RequestRow) => (row.cacheHit === null ? '—' : pct(row.cacheHit))
