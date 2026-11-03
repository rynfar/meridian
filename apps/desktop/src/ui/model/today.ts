/** Today screen: hero numbers, the live feed and "Needs attention". Pure. */
import { number, object } from '../../core'
import type { WindowKind } from '../../uiData'
import { windowRange } from '../../uiData'
import { fmtTok, plural } from './format'
import { limitPill, type AccountsModel, type AccountView } from './accounts'
import { groupFailures, type FailureGroup } from './failures'
import type { RequestRow } from './requests'
import type { PromptShare } from './prompt'

export interface Hero { hit: number | null; reused: number; missesOnResume: number; requests: number | null; failed: number; totalP50: number | null; ttfbP50: number | null }
export function hero(summary: unknown): Hero {
  const s = object(summary)
  const tokens = object(s.tokenUsage)
  const requests = number(s.totalRequests) ?? null
  return {
    hit: requests ? number(tokens.avgCacheHitRate) ?? null : null,
    reused: number(tokens.totalCacheReadTokens) ?? 0,
    missesOnResume: number(tokens.cacheMissOnResumeCount) ?? 0,
    requests, failed: number(s.errorCount) ?? 0,
    totalP50: requests ? number(object(s.totalDuration).p50) ?? null : null,
    ttfbP50: requests ? number(object(s.ttfb).p50) ?? null : null,
  }
}
/** Under the "Prompt from cache" hero: "26.9M of 28.5M prompt tokens reused · 1 miss on resume". */
export function heroPromptDetail(prompt: Pick<PromptShare, 'read' | 'total'>, missesOnResume: number): string {
  return `${fmtTok(prompt.read)} of ${fmtTok(prompt.total)} prompt tokens reused · ${missesOnResume} ${missesOnResume === 1 ? 'miss' : 'misses'} on resume`
}

export interface FeedRow {
  id: string; timestamp: number; model: string; longContext: boolean; client: string; profile: string;
  failed: boolean; status: number | null; cacheHit: number | null;
  /** Prompt split for the ribbon. */
  cacheRead: number; cacheWrite: number; inputTokens: number;
  /** "HTTP 500 · api_error" for a failed request, else empty. */
  failure: string;
  /** Shown only when the request did not continue the stored conversation. */
  lineage: string | null; promptTokens: number; totalMs: number | null;
}
/** The failure as the list shows it in place of the ribbon: "HTTP 500 · api_error". */
export function failureText(row: Pick<RequestRow, 'failed' | 'status' | 'error' | 'envelope'>): string {
  if (!row.failed) return ''
  const status = row.status ? `HTTP ${row.status}` : ''
  const error = row.error.trim().replace(/\s+/g, ' ').slice(0, 60) || (row.envelope.length ? 'incomplete response' : '')
  return [status, error].filter(Boolean).join(' · ') || 'failed'
}

export function feedRows(requests: readonly RequestRow[], limit = 10): FeedRow[] {
  return requests.filter(row => !row.keepalive).slice(0, limit).map(row => ({
    id: row.id, timestamp: row.timestamp, model: row.model, longContext: row.longContext,
    client: row.adapter || row.source || 'client', profile: row.profile || 'default',
    failed: row.failed, status: row.status, cacheHit: row.cacheHit,
    cacheRead: row.cacheRead, cacheWrite: row.cacheWrite, inputTokens: row.inputTokens, failure: failureText(row),
    lineage: row.lineage === 'continuation' ? null : row.lineage || 'new',
    promptTokens: row.promptTokens, totalMs: row.totalMs,
  }))
}

export type AttentionItem =
  | { kind: 'limit'; account: AccountView; title: string; detail: string; pill: string }
  | { kind: 'failure'; group: FailureGroup }
/** Account limits first, then failures grouped by cause in the window. */
export function attention(model: AccountsModel, requests: readonly RequestRow[], kind: WindowKind, now: number): AttentionItem[] {
  const serving = model.accounts.find(account => account.id === (model.active.claude ?? model.active.chatgpt))
  const limits: AttentionItem[] = model.accounts.filter(account => account.limited).map(account => {
    const limit = account.limited!
    const stay = account.active ? 'Requests to this account fail or fail over until it resets.' : serving && serving.id !== account.id ? `Requests stay on ${serving.id} until it resets.` : 'It is skipped until it resets.'
    const what = limit.source === 'refusing' ? `refusing requests${limit.short !== 'rate' ? ` (${limit.label.toLowerCase()})` : ''}`
      : limit.source === 'benched' ? `benched by the pool router${limit.rationale ? ` · ${limit.rationale}` : ''}`
      : `${limit.label.toLowerCase()} limit reached`
    return { kind: 'limit', account, title: what, detail: stay, pill: limitPill(limit).replace(/^(5h|weekly) /, '') }
  })
  const range = windowRange(kind, now)
  const failures: AttentionItem[] = groupFailures(requests, { start: range.start, end: now + 1 }).map(group => ({ kind: 'failure', group }))
  return [...limits, ...failures]
}
export function attentionFootnote(failed: number, kind: WindowKind, scope: 'window' | 'service' = 'window'): string {
  const when = scope === 'service' ? 'since the service started' : kind === 'today' ? 'today' : kind === '1h' ? 'in the last hour' : kind === '24h' ? 'in the last 24 hours' : 'in the last 7 days'
  return failed ? `${plural(failed, 'failed request')} ${when} · open Traffic for all of them` : `No failed requests ${when}`
}

/**
 * How much of the window the loaded requests (newest 500, failover chains
 * collapsed) cover. `partial` when they stop short of the window start and
 * hold fewer requests than the summary counts for it.
 */
export function requestCoverage(requests: readonly RequestRow[], summary: unknown, since: number): { loaded: number; total: number | null; partial: boolean } {
  const loaded = requests.filter(row => !row.keepalive && row.timestamp >= since).length
  const total = number(object(summary).totalRequests) ?? null
  const oldest = requests.length ? Math.min(...requests.map(row => row.timestamp)) : Infinity
  return { loaded, total, partial: total !== null && loaded < total && oldest > since }
}
