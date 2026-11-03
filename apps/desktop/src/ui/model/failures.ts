/**
 * Failures said plainly and grouped by cause. Identical failures collapse into
 * one entry with a count, a time span and whether they cleared.
 */
import { hhmm, plural } from './format'
import type { RequestRow } from './requests'

const PROVIDER: Record<string, string> = { claude: 'Anthropic', chatgpt: 'ChatGPT', antigravity: 'Antigravity' }

/** A short, plain cause for one failed request. */
export function failureCause(row: Pick<RequestRow, 'error' | 'status' | 'profile' | 'provider' | 'envelope'>): string {
  const status = row.status ?? 0
  const who = PROVIDER[row.provider] ?? 'Upstream'
  const on = row.profile ? ` on ${row.profile}` : ''
  const code = status ? ` (${status})` : ''
  const error = row.error.trim()
  if (error === 'rate_limit_error' || status === 429) return `${who} rate limit${on}${code}`
  if (error === 'overloaded_error' || status === 529) return `${who} overloaded${code}`
  if (error === 'authentication_error' || status === 401) return `Sign-in rejected${on}${code}`
  if (error === 'permission_error' || status === 403) return `Access refused${on}${code}`
  if (error === 'invalid_request_error' || status === 400) return `Request rejected as invalid${code}`
  if (error === 'not_found_error' || status === 404) return `Model or route not found${code}`
  if (error === 'request_too_large' || status === 413) return `Request too large${code}`
  if (/timeout|timed out/i.test(error) || status === 504) return `${who} timed out${code}`
  if (error === 'api_error' || status >= 500) return `${who} server error${code}`
  if (!error && row.envelope.length) return `Incomplete response (${row.envelope.join(', ')})`
  const cleaned = error.replace(/\s+/g, ' ').replace(/_/g, ' ')
  return cleaned ? `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1, 120)}${code}` : `Request failed${code}`
}

export interface FailureGroup {
  cause: string; status: number | null; count: number; first: number; last: number;
  clients: string[]; models: string[]; profiles: string[];
  /** Plain outcome: cleared, still failing or unknown. */
  outcome: { state: 'cleared' | 'ongoing' | 'unknown'; text: string };
  /** The span, e.g. "8× between 11:19 and 11:20 · pi · opus". */
  detail: string;
}

/**
 * Group failed requests in [start, end) by cause. `requests` is newest first
 * or any order; later successes on the same account decide whether it cleared.
 */
export function groupFailures(requests: readonly RequestRow[], range?: { start: number; end: number }): FailureGroup[] {
  const inRange = (row: RequestRow) => !range || (row.timestamp >= range.start && row.timestamp < range.end)
  const groups = new Map<string, RequestRow[]>()
  for (const row of requests) {
    // Cache-keepalive beats are not client requests; the summary excludes them too.
    if (!row.failed || row.keepalive || !inRange(row)) continue
    const cause = failureCause(row)
    groups.set(cause, [...(groups.get(cause) ?? []), row])
  }
  return [...groups.entries()].map(([cause, items]) => {
    const times = items.map(item => item.timestamp)
    const first = Math.min(...times), last = Math.max(...times)
    const unique = (values: string[]) => [...new Set(values.filter(Boolean))]
    const clients = unique(items.map(item => item.adapter || item.source))
    const models = unique(items.map(item => item.model))
    const profiles = unique(items.map(item => item.profile))
    const later = requests.filter(row => row.timestamp > last && !row.keepalive && (!profiles.length || profiles.includes(row.profile) || row.profile === ''))
    const laterAny = requests.filter(row => row.timestamp > last && !row.keepalive)
    let outcome: FailureGroup['outcome']
    const who = profiles.length === 1 ? profiles[0] : 'the service'
    const served = later.filter(row => !row.failed).length
    if (later.length && served === later.length) outcome = { state: 'cleared', text: `Cleared on its own · ${who} has served every request since` }
    // "Cleared" needs most later requests to have worked; one success in 41 is still failing.
    else if (served * 2 > later.length) outcome = { state: 'cleared', text: `Mostly cleared · ${served} of ${plural(later.length, 'request')} since succeeded` }
    else if (served > 0) outcome = { state: 'ongoing', text: `Still failing · only ${served} of ${plural(later.length, 'request')} since succeeded` }
    else if (later.length) outcome = { state: 'ongoing', text: `Still failing · every request since has failed` }
    else if (laterAny.some(row => !row.failed)) outcome = { state: 'cleared', text: 'Requests have succeeded since on other accounts' }
    else outcome = { state: 'unknown', text: 'No requests since — it may still be failing' }
    const span = hhmm(first) === hhmm(last) ? `at ${hhmm(last)}` : `between ${hhmm(first)} and ${hhmm(last)}`
    const detail = [`${items.length}× ${span}`, clients.join(', '), models.join(', ')].filter(Boolean).join(' · ')
    return { cause, status: items[0]?.status ?? null, count: items.length, first, last, clients, models, profiles, outcome, detail }
  }).sort((a, b) => b.last - a.last)
}

/** The most recent failure, for the menu bar. */
export function lastFailure(requests: readonly RequestRow[]): { row: RequestRow; cause: string } | undefined {
  const row = [...requests].sort((a, b) => b.timestamp - a.timestamp).find(item => item.failed)
  return row ? { row, cause: failureCause(row) } : undefined
}
