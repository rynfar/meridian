/**
 * The desktop renderer's account, pricing, health and Traffic rules found in
 * review: expired limits, server-identical request valuation, Antigravity
 * parity, ChatGPT seat ownership, failed account reads and deep links.
 * All pure view models (apps/desktop/src/ui/model).
 */
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { accountAction, buildAccounts, chatGptManaged, chatGptOwner, limitedCount, ownerCommands, servingAccount } from '../../apps/desktop/src/ui/model/accounts'
import { pricingTable, requestCost, requestRows } from '../../apps/desktop/src/ui/model/requests'
import { cacheSavings } from '../../apps/desktop/src/ui/model/cache'
import { accountsRead, dataState, failingProvider, healthChip, providerState } from '../../apps/desktop/src/ui/model/status'
import { chartSeries } from '../../apps/desktop/src/ui/model/series'
import { findRequest, rowsInWindow, trafficStats } from '../../apps/desktop/src/ui/model/traffic'
import { attention } from '../../apps/desktop/src/ui/model/today'
import { awaitingText, resetText } from '../../apps/desktop/src/ui/model/pace'
import { trackTone } from '../../apps/desktop/src/ui/model/tone'
import { hhmm } from '../../apps/desktop/src/ui/model/format'
import { defaults } from '../../apps/desktop/src/core'
import type { DesktopState, Timeseries } from '../../apps/desktop/src/contracts'
import { computeCostEstimate } from '../telemetry/pricing'
import type { RequestMetric } from '../telemetry/types'
import type { ProviderSnapshot } from '../telemetry/providerView'

const NOW = new Date(2026, 9, 28, 10, 17).getTime()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
const settings = { values: {}, unavailable: [], errors: [] }

function state(patch: Partial<DesktopState> = {}): DesktopState {
  return {
    desktopVersion: '0.1.0', platform: 'darwin', glass: 'Standard appearance', preferences: { ...defaults, mode: 'attached' }, hasApiKey: false,
    installed: [], available: [], owned: false, health: { status: 'healthy' }, quota: null, requests: [], summary: null, logs: [], profiles: null,
    plugins: null, features: null, connection: { kind: 'ok', message: 'Meridian is answering.', fix: '' },
    instance: { baseUrl: 'http://127.0.0.1:3456', port: 3456, version: '1.87.0', supervisor: { kind: 'launchd', label: 'com.example' }, attachedAt: NOW - HOUR, detectedFrom: 'launchd' },
    window: { kind: 'today' }, timeseries: null, settings, dataErrors: [], incidents: [], serviceLog: [], lastChecked: NOW,
    ...patch,
  }
}

const accountsInput = (quota: unknown[], profiles: unknown[], extra: Record<string, unknown> = {}) => ({
  profiles: { activeProfile: 'personal', profiles, ...extra }, quota: { profiles: quota },
  providers: undefined, routesSummary: null, summary: null, settings,
})

describe('a limit whose reset passed', () => {
  // The kraken snapshot: a weekly window read at 100% whose reset has since passed, the reading itself stale.
  const input = accountsInput([
    { id: 'personal', fetchedAt: NOW, windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: NOW + HOUR }] },
    { id: 'kraken', fetchedAt: NOW - 50 * MIN, stale: true, windows: [{ type: 'five_hour', utilization: 0, resetsAt: null }, { type: 'seven_day', utilization: 1, resetsAt: NOW - 17 * MIN }] },
  ], [{ id: 'personal' }, { id: 'kraken' }])
  const model = buildAccounts(input, NOW)
  const kraken = model.accounts.find(a => a.id === 'kraken')!

  test('is not limited, offers Use and adds no badge or attention item', () => {
    expect(kraken.limited).toBeNull()
    expect(accountAction(kraken, false, NOW)).toEqual({ kind: 'use' })
    expect(limitedCount(model)).toBe(0)
    expect(attention(model, [], 'today', NOW).filter(item => item.kind === 'limit')).toEqual([])
  })
  test('reads "reset at HH:MM, awaiting a new reading", muted', () => {
    expect(kraken.weekly?.expired).toBe(true)
    expect(resetText(kraken.weekly, NOW)).toBe(`reset at ${hhmm(NOW - 17 * MIN)}`)
    expect(awaitingText(kraken.weekly!, NOW)).toBe(`reset at ${hhmm(NOW - 17 * MIN)}, awaiting a new reading`)
    expect(trackTone(kraken.weekly)).toEqual({ tone: 'muted', dim: true })
  })
  test('peak ignores it and carries the stale flag', () => {
    expect(kraken.peak).toBe(0)
    expect(kraken.peakStale).toBe(true)
    expect(kraken.peakWindow?.type).toBe('five_hour')
  })
  test('every window reset: no peak, the last window kept for a muted track', () => {
    const only = buildAccounts(accountsInput([{ id: 'a', fetchedAt: NOW, windows: [{ type: 'seven_day', utilization: 1, resetsAt: NOW - MIN }] }], [{ id: 'a' }]), NOW).accounts[0]!
    expect(only.peak).toBeNull()
    expect(only.peakStale).toBe(true)
    expect(only.peakWindow?.expired).toBe(true)
  })
})

describe('stale readings and refusals', () => {
  test('a stale 20% reading is muted, never green free capacity', () => {
    const account = buildAccounts(accountsInput([{ id: 'personal', fetchedAt: NOW - 10 * MIN, windows: [{ type: 'five_hour', utilization: 0.2, resetsAt: NOW + HOUR }] }], [{ id: 'personal' }]), NOW).accounts[0]!
    expect(account.fiveHour?.stale).toBe(true)
    expect(account.peakStale).toBe(true)
    expect(trackTone(account.fiveHour)).toEqual({ tone: 'muted', dim: true })
  })
  test('a stale full reading keeps its warning colour, dimmed', () => {
    expect(trackTone({ utilization: 0.94, stale: true, expired: false })).toEqual({ tone: 'red', dim: true })
    expect(trackTone({ utilization: 0.2, stale: false, expired: false })).toEqual({ tone: 'green', dim: false })
  })
  test('a stale reading at 100% with a future reset still holds the account', () => {
    const account = buildAccounts(accountsInput([{ id: 'w', fetchedAt: NOW - 10 * MIN, windows: [{ type: 'five_hour', utilization: 1, resetsAt: NOW + HOUR }] }], [{ id: 'w' }]), NOW).accounts[0]!
    expect(account.limited?.stale).toBe(true)
  })
  test('a ChatGPT seat at 100% of its 7d window is held, not offered', () => {
    const seat = buildAccounts(accountsInput([{ id: 'gpt', fetchedAt: NOW, windows: [{ type: '5h', utilization: 0.2, resetsAt: NOW + HOUR }, { type: '7d', utilization: 1, resetsAt: NOW + 48 * HOUR }] }], [{ id: 'gpt', seat: 'seat-1', provider: 'chatgpt' }]), NOW).accounts[0]!
    expect(seat.limited?.window).toBe('7d')
    expect(seat.peak).toBe(1)
    expect(accountAction(seat, false, NOW).kind).toBe('held')
  })
  test('a spent (refusing) limit counts while its until is ahead, and not after', () => {
    const spent = (until: number) => buildAccounts(accountsInput([{ id: 'w', fetchedAt: NOW, windows: [{ type: 'five_hour', utilization: 0.3, resetsAt: NOW + HOUR }] }], [{ id: 'w' }],
      { spent: [{ profileId: 'w', until, diagnosis: { bucket: 'seven_day', rationale: 'Refused with a weekly limit' } }] }), NOW).accounts[0]!
    const held = spent(NOW + 2 * HOUR)
    expect(held.limited?.source).toBe('refusing')
    expect(held.limited?.window).toBe('seven_day')
    expect(accountAction(held, false, NOW)).toEqual({ kind: 'held', text: `until ${hhmm(NOW + 2 * HOUR)}` })
    expect(spent(NOW - MIN).limited).toBeNull()
  })
})

describe('accounts: organisation, follow mode and Extra Usage', () => {
  const input = accountsInput([
    { id: 'personal', fetchedAt: NOW, windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: NOW + HOUR }], extraUsage: { isEnabled: true, monthlyLimit: 200, usedCredits: 50, currency: 'USD' } },
    { id: 'work', fetchedAt: NOW, windows: [] },
  ], [{ id: 'personal', organizationName: "p@example.com's Organization", email: 'p@example.com' }, { id: 'work', organizationName: 'Centeva', email: 'w@centeva.com' }])
  test('organisation comes through for display', () => {
    const model = buildAccounts(input, NOW)
    expect(model.accounts.find(a => a.id === 'work')?.organization).toBe('Centeva')
  })
  test('follow mode turns Use into "followed" (switching happens at the followed Meridian)', () => {
    const model = buildAccounts({ ...input, profiles: { ...input.profiles, follow: { url: 'http://127.0.0.1:3460', stale: false } } }, NOW)
    const work = model.accounts.find(a => a.id === 'work')!
    expect(model.follow?.url).toBe('http://127.0.0.1:3460')
    expect(accountAction(work, Boolean(model.follow), NOW)).toEqual({ kind: 'followed' })
    expect(accountAction(work, false, NOW)).toEqual({ kind: 'use' })
    expect(accountAction(servingAccount(model)!, true, NOW)).toEqual({ kind: 'serving' })
  })
  test('Extra Usage keeps dollars for Accounts and a share for Today', () => {
    const extra = buildAccounts(input, NOW).accounts.find(a => a.id === 'personal')!.extraUsage!
    expect(extra.text).toContain('$50.00 of $200.00')
    expect(extra.summary).toBe('Extra Usage on · 25% of the monthly limit used')
    expect(extra.summary).not.toContain('$')
  })
})

describe('pricing matches the server', () => {
  const row = (raw: Record<string, unknown>) => requestRows([{ requestId: 'r', timestamp: NOW, inputTokens: 1_000_000, outputTokens: 0, ...raw }])[0]!
  test('dated Claude ids price at their family, not the current alias', () => {
    expect(requestCost(row({ model: 'haiku', requestModel: 'claude-haiku-4-5-20251001' }), {})).toBeCloseTo(1, 10)
    expect(requestCost(row({ model: 'opus', requestModel: 'claude-opus-4-1-20250805' }), {})).toBeCloseTo(15, 10)
  })
  test('[1m] and case are normalised', () => {
    expect(requestCost(row({ model: 'sonnet[1m]', requestModel: 'Claude-Sonnet-4-6[1m]' }), {})).toBeCloseTo(3, 10)
  })
  test('the recorded SDK pin wins over the alias', () => {
    expect(requestCost(row({ model: 'haiku', requestModel: 'haiku', resolvedModel: 'claude-haiku-4-5' }), {})).toBeCloseTo(1, 10)
  })
  test('overrides from GET /settings/api/pricing apply, keyed like the server', () => {
    const overrides = pricingTable({ builtin: { sonnet: { inputPerMTok: 99, outputPerMTok: 99 } }, overrides: { 'My-Router[1m]': { inputPerMTok: 2, outputPerMTok: 4 }, broken: { inputPerMTok: -1, outputPerMTok: 1 } } })
    expect(Object.keys(overrides)).toEqual(['my-router'])
    expect(overrides['my-router']?.cacheReadPerMTok).toBeCloseTo(0.2, 10)
    expect(requestCost(row({ model: 'sonnet', requestModel: 'my-router' }), overrides)).toBeCloseTo(2, 10)
    // Built-in rates are the bundled table's, not the response's.
    expect(requestCost(row({ model: 'sonnet', requestModel: 'claude-sonnet-4-6' }), overrides)).toBeCloseTo(3, 10)
  })
  test('an unknown model is unpriced, never $0', () => {
    expect(requestCost(row({ model: 'mystery-model' }), {})).toBeNull()
    expect(requestCost(row({ model: 'gpt-unknown-model' }), {})).toBeNull()
  })
  test('per-request costs sum to computeCostEstimate(...).totalUsd', () => {
    const metric = (id: string, fields: Partial<RequestMetric>): RequestMetric => ({
      requestId: id, timestamp: NOW, model: 'sonnet', mode: 'stream', isResume: false, isPassthrough: false, status: 200,
      queueWaitMs: 0, proxyOverheadMs: 0, ttfbMs: 100, upstreamDurationMs: 100, totalDurationMs: 200, contentBlocks: 1, textEvents: 1, error: null,
      ...fields,
    })
    const metrics = [
      metric('a', { model: 'haiku', requestModel: 'claude-haiku-4-5-20251001', inputTokens: 1200, outputTokens: 300, cacheReadInputTokens: 50_000, cacheCreationInputTokens: 2000 }),
      metric('b', { model: 'opus', requestModel: 'claude-opus-4-1-20250805', inputTokens: 10, outputTokens: 900, cacheReadInputTokens: 80_000 }),
      metric('c', { model: 'sonnet[1m]', requestModel: 'claude-sonnet-4-6[1m]', inputTokens: 500, outputTokens: 100, cacheCreationInputTokens: 300_000 }),
      metric('d', { model: 'haiku', requestModel: 'haiku', inputTokens: 1000, outputTokens: 10, cacheReadInputTokens: 150_000 }),
      metric('e', { model: 'gpt-5-high', inputTokens: 300_000, outputTokens: 5000, cacheReadInputTokens: 10_000 }),
      metric('f', { model: 'sonnet', requestModel: 'my-router', inputTokens: 4000, outputTokens: 4000 }),
      metric('g', { model: 'mystery', inputTokens: 4000 }),
    ]
    const overrides = pricingTable({ overrides: { 'my-router': { inputPerMTok: 2, outputPerMTok: 4 } } })
    const server = computeCostEstimate(metrics, overrides)
    const rows = requestRows(metrics)
    const costs = rows.map(r => requestCost(r, overrides))
    const sum = costs.reduce<number>((total, cost) => total + (cost ?? 0), 0)
    expect(sum).toBeCloseTo(server.totalUsd, 6)
    expect(costs.filter(cost => cost === null).length).toBe(server.unpricedRequestCount)
  })
  test('cache savings use family fallback too', () => {
    const summary = { costEstimate: { byModel: { 'claude-opus-4-1-20250805': { cacheReadTokens: 1_000_000, cacheCreationTokens: 0 }, mystery: { cacheReadTokens: 5 } } } }
    const savings = cacheSavings(summary, {})!
    expect(savings.savedUsd).toBeCloseTo(15 - 1.5, 10)
    expect(savings.partial).toBe(true)
  })
})

describe('Antigravity parity', () => {
  const providers: ProviderSnapshot = { fetchedAt: NOW, providers: [
    { id: 'claude', name: 'Claude', enabled: true, status: 'healthy', endpoint: '/v1/messages', accounts: [] },
    { id: 'antigravity', name: 'Antigravity', enabled: true, status: 'unavailable', endpoint: '/antigravity/v1/messages', error: 'agy is not signed in', accounts: [
      { id: 'google', active: true, fetchedAt: NOW, windows: [{ type: 'gemini-5h', utilization: 0.3, resetsAt: NOW + HOUR }, { type: '3p-5h', utilization: 0.6, resetsAt: NOW + 2 * HOUR }, { type: 'gemini-weekly', utilization: 0.2, resetsAt: NOW + 3 * DAY }, { type: '3p-weekly', utilization: 1, resetsAt: NOW - MIN }] },
    ] },
  ] }
  const model = buildAccounts({ ...accountsInput([], []), providers }, NOW)
  const google = model.accounts.find(a => a.provider === 'antigravity')!
  test('5-hour and weekly come from the gemini and third-party windows', () => {
    expect(google.fiveHour?.type).toBe('3p-5h')
    expect(google.weekly?.type).toBe('gemini-weekly')
    // The weekly window at 100% has reset: not limited.
    expect(google.limited).toBeNull()
    expect(google.peak).toBe(0.6)
  })
  test('Antigravity accounts are never switched from the desktop', () => {
    expect(accountAction(google, false, NOW)).toEqual({ kind: 'serving' })
    expect(accountAction({ ...google, active: false }, false, NOW)).toEqual({ kind: 'none' })
  })
  test('a failing enabled provider reaches the health chip and its section header', () => {
    expect(failingProvider({ providers })).toEqual({ name: 'Antigravity', status: 'unavailable', error: 'agy is not signed in' })
    expect(providerState({ providers }, 'antigravity')).toEqual({ text: 'unavailable · agy is not signed in', failing: true })
    expect(providerState({ providers }, 'claude')).toBeNull()
    const chip = healthChip(state({ providers }), undefined)
    expect(chip.label).toBe('Antigravity unavailable · agy is not signed in')
    expect(chip.tone).toBe('yellow')
    const disabled: ProviderSnapshot = { ...providers, providers: providers.providers.map(p => ({ ...p, enabled: p.id === 'claude' })) }
    expect(healthChip(state({ providers: disabled }), undefined).label).toBe('Working')
  })
})

describe('ChatGPT seat ownership', () => {
  const meridian = { name: 'meridian', mode: 'owned', webSignIn: true, importCommand: 'meridian chatgpt-migrate --step import' }
  const external = { name: 'opencode', mode: 'follow', webSignIn: false, login: 'opencode auth login', loginMethod: 'ChatGPT Plus/Pro', refresh: 'opencode codex-refresh', refreshTool: 'codex-refresh', remove: 'codex-remove index=1 confirm=true' }
  test('Add, Sign in again, Renew and Remove are offered only where Meridian owns the logins', () => {
    expect(chatGptManaged(chatGptOwner(meridian))).toBe(true)
    expect(chatGptManaged(chatGptOwner({ ...meridian, webSignIn: false }))).toBe(false)
    expect(chatGptManaged(chatGptOwner(external))).toBe(false)
    expect(chatGptManaged(null)).toBe(false)
  })
  test('elsewhere the owner commands are shown instead', () => {
    expect(ownerCommands(chatGptOwner(meridian))).toEqual([])
    expect(ownerCommands(chatGptOwner({ ...meridian, webSignIn: false })).map(c => c.command)).toEqual(['meridian chatgpt-migrate --step import'])
    expect(ownerCommands(chatGptOwner(external)).map(c => c.command)).toEqual(['opencode auth login', 'opencode codex-refresh'])
    expect(ownerCommands(chatGptOwner(external), { label: 'Work', expired: false }).map(c => c.label)).toEqual(['Sign in again'])
  })
  test('each seat carries its owner and removal text', () => {
    const model = buildAccounts(accountsInput([], [{ id: 'gpt', seat: 'seat-1', provider: 'chatgpt', owner: external, removal: '"gpt" is a ChatGPT seat that opencode owns.' }], { chatgpt: { owner: external } }), NOW)
    expect(model.chatgpt?.owner?.name).toBe('opencode')
    const seat = model.accounts[0]!
    expect(seat.provider).toBe('chatgpt')
    expect(seat.owner?.login).toBe('opencode auth login')
    expect(seat.removal).toContain('opencode owns')
  })
})

describe('account reads', () => {
  test('both reads failed: the error, never "no accounts"', () => {
    expect(accountsRead(state({ dataErrors: ['ApiError: /profiles/list: HTTP 500', 'ApiError: /v1/usage/quota/all: timed out', 'ApiError: /plugins/list: HTTP 404'] }), 0))
      .toEqual({ kind: 'failed', message: 'ApiError: /profiles/list: HTTP 500 · ApiError: /v1/usage/quota/all: timed out' })
  })
  test('nothing read yet and no error: loading', () => {
    expect(accountsRead(state(), 0)).toEqual({ kind: 'loading' })
  })
  test('an empty list is a real answer; a partial failure is a warning', () => {
    expect(accountsRead(state({ profiles: { profiles: [] }, quota: null }), 0)).toEqual({ kind: 'ready', warning: '' })
    expect(accountsRead(state({ profiles: { profiles: [] }, dataErrors: ['ApiError: /v1/usage/quota/all: HTTP 500'] }), 1).kind).toBe('ready')
  })
})

describe('page and health state', () => {
  test('dataState: loading before the first read, failed with a fix, ready when answering', () => {
    expect(dataState(undefined)).toEqual({ kind: 'loading' })
    expect(dataState(state({ instance: null, lastChecked: undefined }))).toEqual({ kind: 'loading' })
    expect(dataState(state({ connection: { kind: 'starting', message: 'Starting', fix: '' } }))).toEqual({ kind: 'loading' })
    expect(dataState(state({ connection: { kind: 'unauthorized', message: '401', fix: 'Enter the key.' } }))).toEqual({ kind: 'failed', title: 'Meridian rejected the API key', message: '401', fix: 'Enter the key.' })
    expect(dataState(state())).toEqual({ kind: 'ready' })
  })
  test('healthChip names the serving account, a failing upstream and a held account', () => {
    const model = buildAccounts(accountsInput([{ id: 'personal', fetchedAt: NOW, windows: [{ type: 'five_hour', utilization: 1, resetsAt: NOW + HOUR }] }], [{ id: 'personal', subscriptionType: 'max', isActive: true }]), NOW)
    const serving = servingAccount(model)
    expect(healthChip(undefined, undefined).label).toBe('Connecting…')
    expect(healthChip(state({ connection: { kind: 'stopped', message: 'down', fix: '' } }), serving)).toMatchObject({ tone: 'red', label: 'Not running' })
    expect(healthChip(state({ health: { status: 'healthy', upstream: { claude: { state: 'failing', lastErrorKind: 'overloaded' } } } }), serving)).toMatchObject({ tone: 'red', label: 'Claude connection failed · personal · Max' })
    expect(healthChip(state(), serving)).toMatchObject({ tone: 'yellow', label: 'Limited · personal · Max' })
    expect(healthChip(state(), { ...serving!, limited: null })).toMatchObject({ tone: 'green', label: 'Working · personal · Max' })
  })
})

describe('chart series', () => {
  const series: Timeseries = { start: NOW - HOUR, end: NOW, bucketMs: HOUR, truncated: false, buckets: [] }
  test('the server buckets when it answered', () => {
    expect(chartSeries({ timeseries: series, requests: [], window: { kind: 'today' } }, NOW)).toEqual({ series, estimated: false })
  })
  test('null with a note: estimated from the recent requests, and says why', () => {
    const fallback = chartSeries({ timeseries: null, timeseriesNote: 'older Meridian', requests: [{ requestId: 'a', timestamp: NOW - MIN }], window: { kind: 'today' } }, NOW)
    expect(fallback?.estimated).toBe(true)
    expect(fallback?.note).toBe('older Meridian')
    expect(fallback?.series.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(1)
  })
  test('null without a note, or no requests yet: still loading', () => {
    expect(chartSeries({ timeseries: null, requests: [], window: { kind: 'today' } }, NOW)).toBeNull()
    expect(chartSeries({ timeseries: null, timeseriesNote: 'x', requests: null, window: { kind: 'today' } }, NOW)).toBeNull()
  })
})

describe('Traffic', () => {
  const rows = requestRows([
    { requestId: 'now', timestamp: NOW - MIN, status: 200 },
    { requestId: 'early', timestamp: NOW - 2 * HOUR, status: 200 },
    { requestId: 'yesterday', timestamp: NOW - DAY, status: 500, error: 'api_error' },
  ])
  test('the table covers the selected window', () => {
    expect(rowsInWindow(rows, NOW - HOUR).map(r => r.id)).toEqual(['now'])
    expect(rowsInWindow(rows, NOW - 3 * HOUR).map(r => r.id)).toEqual(['now', 'early'])
  })
  test('a deep link resolves outside the window, with a quiet note', () => {
    expect(findRequest(rows, 'yesterday', NOW - HOUR)).toEqual({ row: rows[2]!, note: 'outside the selected window' })
    expect(findRequest(rows, 'now', NOW - HOUR)).toEqual({ row: rows[0]! })
    expect(findRequest(rows, 'missing', NOW - HOUR)).toBeUndefined()
    expect(findRequest(rows, '', NOW - HOUR)).toBeUndefined()
  })
  test('stats: requests, failures, failovers and the server total, flagged when partial', () => {
    const cells = trafficStats({ totalRequests: 10, errorCount: 2, requestsPerMinute: 0.5, totalDuration: { p50: 2000, p95: 9000 }, ttfb: { p50: 800, p95: 1500 }, costEstimate: { totalUsd: 1.234, unpricedRequestCount: 1 } }, { failedOver: 1, unserved: 0, requests: 10, byProfile: { a: {}, b: {} } })
    expect(cells.map(c => c.label)).toEqual(['Requests', 'Failed', 'Total', 'First token', 'Failovers', 'API-equivalent'])
    expect(cells[1]).toMatchObject({ value: '2', tone: 'red', detail: '20.0% of requests' })
    expect(cells[5]?.detail).toBe('1 unpriced requests excluded')
    expect(trafficStats(null, null)).toEqual([])
  })
})

describe('design drift', () => {
  test('chart area gradients stay at or below 0.18 alpha', () => {
    const root = join(import.meta.dir, '../../apps/desktop/src/ui')
    const files = readdirSync(root, { recursive: true }).map(String).filter(file => file.endsWith('.tsx'))
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8')
      for (const match of source.matchAll(/stopOpacity=\{?["']?([\d.]+)/g)) expect(Number(match[1])).toBeLessThanOrEqual(0.18)
    }
  })
  test('the desktop menu owns ⌘R as Refresh data and keeps Reload window on ⇧⌘R', () => {
    const main = readFileSync(join(import.meta.dir, '../../apps/desktop/src/main.ts'), 'utf8')
    expect(main).toContain("label: 'Refresh data', accelerator: 'CommandOrControl+R'")
    expect(main).toContain("label: 'Reload window', role: 'reload', accelerator: 'CommandOrControl+Shift+R'")
    expect(main).not.toContain("{ role: 'reload' }")
  })
})
