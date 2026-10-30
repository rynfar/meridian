/**
 * Post-merge review of the desktop redesign (#1470): failed reads, window
 * scope, truncated history, keepalive beats, failure outcomes, benched
 * accounts, rounding, DST days and text contrast. All pure view models.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { buildAccounts, accountAction, latestServed, limitPill, servingLine, servingNote } from '../../apps/desktop/src/ui/model/accounts'
import { requestRows, type RequestRow } from '../../apps/desktop/src/ui/model/requests'
import { cacheMisses } from '../../apps/desktop/src/ui/model/cache'
import { groupFailures } from '../../apps/desktop/src/ui/model/failures'
import { sourceRead, summaryScope } from '../../apps/desktop/src/ui/model/status'
import { chartSeries, historyNote } from '../../apps/desktop/src/ui/model/series'
import { retentionLine, rowsInWindow, trafficStats } from '../../apps/desktop/src/ui/model/traffic'
import { attention, attentionFootnote, requestCoverage } from '../../apps/desktop/src/ui/model/today'
import { fmtTok, pct, percentFigure } from '../../apps/desktop/src/ui/model/format'
import { bucketRequests, type Timeseries } from '../../apps/desktop/src/uiData'
import { desktopThemeCss } from '../telemetry/profileBar'

const NOW = new Date(2026, 9, 28, 10, 17).getTime()
const MIN = 60_000, HOUR = 60 * MIN
const settings = { values: {}, unavailable: [], errors: [] }

const row = (patch: Record<string, unknown>) => ({ requestId: `r${Math.random()}`, timestamp: NOW, model: 'claude-opus-4-8', status: 200, profileId: 'personal', sdkSessionId: 's1', ...patch })
const parsed = (raws: Record<string, unknown>[]): RequestRow[] => requestRows(raws)

describe('a read that failed is said plainly', () => {
  const base = { summary: null, requests: null, dataErrors: [] as string[] }
  test('null with its path in dataErrors is failed; null without is loading; present is ready', () => {
    expect(sourceRead({ ...base, dataErrors: ['Error: /telemetry/summary?window=3600000: HTTP 500 boom'] }, 'summary')).toEqual({ kind: 'failed', message: 'Error: /telemetry/summary?window=3600000: HTTP 500 boom' })
    expect(sourceRead({ ...base, dataErrors: ['Error: /telemetry/summary: HTTP 500'] }, 'requests')).toEqual({ kind: 'loading' })
    expect(sourceRead({ ...base, requests: [] }, 'requests')).toEqual({ kind: 'ready' })
    expect(sourceRead(undefined, 'summary')).toEqual({ kind: 'loading' })
  })
  test('Antigravity totals are labelled since the service started', () => {
    expect(summaryScope({ health: { backend: 'antigravity' } })).toBe('service')
    expect(summaryScope({ health: { backend: 'claude' } })).toBe('window')
    expect(attentionFootnote(2, 'today', 'service')).toBe('2 failed requests since the service started · open Traffic for all of them')
  })
})

describe('keepalive beats are not client requests', () => {
  test('a cold beat is neither a cache miss nor the previous turn of a real one', () => {
    const rows = parsed([
      row({ requestId: 'turn1', timestamp: NOW - 70 * MIN, cacheHitRate: 0.9, isResume: true }),
      row({ requestId: 'beat', timestamp: NOW - 2 * MIN, requestSource: 'cache-keepalive', cacheHitRate: 0, isResume: true }),
      row({ requestId: 'turn2', timestamp: NOW, cacheHitRate: 0.1, isResume: true }),
    ])
    const misses = cacheMisses(rows)
    expect(misses.map(miss => miss.row.id)).toEqual(['turn2'])
    // The previous real turn is 70 minutes back, not the beat 2 minutes back.
    expect(misses[0]?.why).toContain('70 min since the previous turn')
  })
  test('the Traffic table and failure groups leave beats out', () => {
    const rows = parsed([row({ requestId: 'a' }), row({ requestId: 'beat', requestSource: 'cache-keepalive', status: 500, error: 'api_error' })])
    expect(rowsInWindow(rows, NOW - HOUR).map(item => item.id)).toEqual(['a'])
    expect(groupFailures(rows)).toEqual([])
  })
})

describe('a failure outcome', () => {
  test('one success in 41 later requests is still failing, not "mostly cleared"', () => {
    const later = Array.from({ length: 41 }, (_, index) => row({ requestId: `l${index}`, timestamp: NOW - 30 * MIN + index * MIN, ...(index === 40 ? {} : { status: 529, error: 'overloaded_error' }) }))
    const groups = groupFailures(parsed([row({ requestId: 'first', timestamp: NOW - HOUR, status: 500, error: 'api_error' }), ...later]))
    const server = groups.find(group => group.cause.startsWith('Anthropic server error'))
    expect(server?.outcome).toEqual({ state: 'ongoing', text: 'Still failing · only 1 of 41 requests since succeeded' })
  })
  test('most later requests succeeding is mostly cleared', () => {
    const later = Array.from({ length: 4 }, (_, index) => row({ requestId: `l${index}`, timestamp: NOW - 10 * MIN + index * MIN, ...(index === 0 ? { status: 500, error: 'api_error' } : {}) }))
    const groups = groupFailures(parsed([row({ requestId: 'first', timestamp: NOW - HOUR, status: 500, error: 'api_error' }), ...later]))
    expect(groups[0]?.outcome.state).toBe('cleared')
  })
})

describe('accounts the pool router benched', () => {
  const input = (until: number) => ({
    profiles: { activeProfile: 'personal', profiles: [{ id: 'personal' }, { id: 'work' }], exhausted: [{ id: 'work', until, reason: 'weekly limit' }] },
    quota: { profiles: [{ id: 'personal', fetchedAt: NOW, windows: [] }, { id: 'work', fetchedAt: NOW, windows: [{ type: 'five_hour', utilization: 0.2, resetsAt: NOW + HOUR }] }] },
    providers: undefined, routesSummary: null, summary: null, settings,
  })
  test('are held until the bench lapses, never offered as free', () => {
    const model = buildAccounts(input(NOW + 30 * MIN), NOW)
    const work = model.accounts.find(account => account.id === 'work')!
    expect(work.limited).toMatchObject({ source: 'benched', resetsAt: NOW + 30 * MIN, rationale: 'weekly limit' })
    expect(limitPill(work.limited!)).toBe('benched')
    expect(accountAction(work, false, NOW).kind).toBe('held')
    expect(attention(model, [], 'today', NOW)[0]).toMatchObject({ kind: 'limit', title: 'benched by the pool router · weekly limit' })
  })
  test('a lapsed bench does not hold the account', () => {
    const work = buildAccounts(input(NOW - MIN), NOW).accounts.find(account => account.id === 'work')!
    expect(work.limited).toBeNull()
    expect(accountAction(work, false, NOW).kind).toBe('use')
  })
})

describe('which account is active', () => {
  const model = (active: Partial<Record<'claude' | 'chatgpt' | 'antigravity', string>>, providers: ('claude' | 'chatgpt' | 'antigravity')[]) => ({ active, accounts: providers.map(provider => ({ provider })) })
  test('the latest successful client request per provider, as the server records rows', () => {
    const accounts = [{ id: 'personal', provider: 'claude' as const, aliases: [] }, { id: 'work', provider: 'claude' as const, aliases: [] }, { id: 'seat-b', provider: 'chatgpt' as const, aliases: [] }, { id: 'Antigravity account', provider: 'antigravity' as const, aliases: [] }]
    const rows = parsed([
      row({ requestId: 'a', timestamp: NOW - 3 * MIN, profileId: 'work' }),
      row({ requestId: 'b', timestamp: NOW - 2 * MIN, profileId: 'personal', status: 500, error: 'api_error' }),
      row({ requestId: 'c', timestamp: NOW - MIN, profileId: 'personal', requestSource: 'cache-keepalive' }),
      // ChatGPT turns carry the seat's profile and adapter, no provider (recordChatGptTurn).
      row({ requestId: 'd', timestamp: NOW, profileId: 'seat-b', adapter: 'chatgpt' }),
      // Antigravity rows name no listed account.
      row({ requestId: 'e', timestamp: NOW, profileId: 'agy-account', provider: 'antigravity' }),
    ])
    expect(latestServed(rows, accounts)).toEqual({ claude: { profile: 'work', timestamp: NOW - 3 * MIN }, chatgpt: { profile: 'seat-b', timestamp: NOW } })
  })
  test('rows recorded under a renamed account\'s old id count for it, under its current id', () => {
    const accounts = [{ id: 'home', provider: 'claude' as const, aliases: ['personal'] }, { id: 'work', provider: 'claude' as const, aliases: [] }]
    const latest = latestServed(parsed([row({ timestamp: NOW - 5 * MIN, profileId: 'work' }), row({ timestamp: NOW, profileId: 'personal' })]), accounts)
    expect(latest).toEqual({ claude: { profile: 'home', timestamp: NOW } })
    expect(servingNote({ id: 'home', provider: 'claude', active: true }, { active: { claude: 'home' } }, latest)).toBeNull()
  })
  test('a ChatGPT turn never reads as the Claude selection serving elsewhere', () => {
    const accounts = [{ id: 'personal', provider: 'claude' as const, aliases: [] }, { id: 'seat-b', provider: 'chatgpt' as const, aliases: [] }]
    const latest = latestServed(parsed([row({ timestamp: NOW - MIN, profileId: 'personal' }), row({ timestamp: NOW, profileId: 'seat-b', adapter: 'chatgpt' })]), accounts)
    expect(servingNote({ id: 'personal', provider: 'claude', active: true }, { active: { claude: 'personal', chatgpt: 'seat-b' } }, latest)).toBeNull()
  })
  test('a selection that did not serve the latest request is flagged on both cards', () => {
    const latest = { claude: { profile: 'work', timestamp: NOW } }
    const accounts = { active: { claude: 'personal' } }
    expect(servingNote({ id: 'personal', provider: 'claude', active: true }, accounts, latest)).toEqual({ kind: 'elsewhere', other: 'work', timestamp: NOW })
    expect(servingNote({ id: 'work', provider: 'claude', active: false }, accounts, latest)).toEqual({ kind: 'here', other: 'personal', timestamp: NOW })
    expect(servingNote({ id: 'kraken', provider: 'claude', active: false }, accounts, latest)).toBeNull()
    expect(servingNote({ id: 'personal', provider: 'claude', active: true }, accounts, { claude: { profile: 'personal', timestamp: NOW } })).toBeNull()
    expect(servingNote({ id: 'personal', provider: 'claude', active: true }, accounts, {})).toBeNull()
  })
  test('the header names the serving account, per provider when several', () => {
    expect(servingLine(model({ claude: 'personal' }, ['claude']))).toBe('serving personal')
    expect(servingLine(model({ claude: 'personal', chatgpt: 'seat-b' }, ['claude', 'chatgpt']))).toBe('serving Claude personal · ChatGPT seat-b')
    expect(servingLine(model({}, []))).toBe('')
    expect(servingLine(model({ claude: 'personal' }, ['claude']), { follow: true })).toBe('following personal')
    expect(servingLine(model({ claude: 'personal', chatgpt: 'seat-b' }, ['claude', 'chatgpt']), { providers: ['claude'] })).toBe('serving personal')
    expect(servingLine(model({ claude: 'personal', antigravity: 'Antigravity account' }, ['claude', 'antigravity']))).toBe('serving personal')
  })
})

describe('history the window cannot show', () => {
  const series = (patch: Partial<Timeseries>): Timeseries => ({ start: NOW - HOUR, end: NOW, bucketMs: HOUR, truncated: false, buckets: [], ...patch })
  test('a server-truncated range is said under the chart', () => {
    expect(historyNote({ series: series({ truncated: true }), estimated: false })).toContain('no longer holds the start of this window')
    expect(historyNote({ series: series({}), estimated: false })).toBeNull()
    expect(historyNote({ series: series({ truncated: true }), estimated: true })).toContain('do not reach back to the start')
  })
  test('the fallback is truncated when the list holds fewer requests than the summary, even below the fetch limit', () => {
    const range = { start: NOW - 4 * HOUR, end: NOW, bucketMs: HOUR }
    const list = [row({ timestamp: NOW - HOUR }), row({ timestamp: NOW - 2 * HOUR })]
    expect(bucketRequests(list, range, 500, 2).truncated).toBe(false)
    expect(bucketRequests(list, range, 500, 40).truncated).toBe(true)
    // Reaching back past the start covers the window whatever the count.
    expect(bucketRequests([...list, row({ timestamp: NOW - 5 * HOUR })], range, 500, 40).truncated).toBe(false)
    const state = { timeseries: null, timeseriesNote: 'old Meridian', requests: list, window: { kind: '24h' as const }, summary: { totalRequests: 40 } }
    expect(chartSeries(state, NOW)?.series.truncated).toBe(true)
  })
  test('requests coverage is partial when the loaded rows stop short of the window and the summary', () => {
    const rows = parsed([row({ timestamp: NOW }), row({ timestamp: NOW - MIN })])
    expect(requestCoverage(rows, { totalRequests: 1240 }, NOW - HOUR)).toEqual({ loaded: 2, total: 1240, partial: true })
    expect(requestCoverage(rows, { totalRequests: 2 }, NOW - HOUR).partial).toBe(false)
  })
  test('retention is described as the web dashboard does', () => {
    expect(retentionLine({ kind: 'memory', held: 1000, capacity: 1000, oldestTimestamp: NOW - 2 * HOUR }, NOW)?.text).toBe('1,000 of 1,000 requests in memory · back to 2h · lost on restart')
    expect(retentionLine({ kind: 'sqlite', held: 1, retentionDays: 30, oldestTimestamp: null, dbBytes: 2048, dbPath: '/x.db' }, NOW)).toEqual({ text: '1 request in SQLite · 30d retention · 2 KB · survives restart', title: 'Persistent telemetry at /x.db' })
    expect(retentionLine(null, NOW)).toBeNull()
  })
  test('an empty window shows no timings, not 0.00s', () => {
    const cells = trafficStats({ totalRequests: 0, errorCount: 0, totalDuration: { p50: 0, p95: 0 }, ttfb: { p50: 0, p95: 0 } }, null)
    expect(cells.find(cell => cell.label === 'Total')).toMatchObject({ value: '—' })
    expect(cells.find(cell => cell.label === 'First token')).toMatchObject({ value: '—' })
  })
})

describe('figures never round into a claim', () => {
  test('99.6% is 99, 0.4% is 1, and 100% stays 100', () => {
    expect(percentFigure(0.996)).toBe(99)
    expect(percentFigure(0.004)).toBe(1)
    expect(percentFigure(1)).toBe(100)
    expect(percentFigure(0)).toBe(0)
    expect(pct(0.996)).toBe('99%')
  })
  test('token counts roll over to the next unit', () => {
    expect(fmtTok(999_499)).toBe('999k')
    expect(fmtTok(999_500)).toBe('1.0M')
    expect(fmtTok(999_950_000)).toBe('1.0B')
    expect(fmtTok(999)).toBe('999')
    expect(fmtTok(1_000)).toBe('1k')
  })
})

describe('Today on a daylight-saving day', () => {
  // Run in a child process started with TZ set: a process-wide TZ change made
  // mid-suite is not reliably honoured once other tests have used the clock.
  const series = join(import.meta.dir, '../../apps/desktop/src/ui/model/series.ts')
  const probe = `
    const { slots, nowFraction, firstFutureSlot } = await import(${JSON.stringify(series)})
    const HOUR = 3_600_000
    const bucket = start => ({ start, requests: 1, errors: 0, inputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 0, outputTokens: 1, cacheHitRate: 0.5, p50TotalMs: 100, p50TtfbMs: 10, costUsd: null })
    const day = (y, m, d, hours) => {
      const midnight = new Date(y, m, d).getTime()
      const series = { start: midnight, end: midnight + hours * HOUR, bucketMs: HOUR, truncated: false, buckets: Array.from({ length: hours }, (_, i) => bucket(midnight + i * HOUR)) }
      const slotted = slots(series, 'today', new Date(y, m, d, 23, 59).getTime())
      return { length: slotted.length, total: slotted.reduce((t, s) => t + (s ? s.requests : 0), 0), one: slotted[1] ? slotted[1].requests : null, two: slotted[2], threeStart: slotted[3] ? slotted[3].start : null, threeLocal: new Date(y, m, d, 3).getTime(), noon: nowFraction('today', new Date(y, m, d, 12).getTime()), future: firstFutureSlot('today', new Date(y, m, d, 12, 30).getTime()) }
    }
    console.log(JSON.stringify({ fall: day(2026, 10, 1, 25), spring: day(2026, 2, 8, 23) }))
  `
  const run = () => {
    const result = spawnSync(process.execPath, ['-e', probe], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as Record<'fall' | 'spring', { length: number; total: number; one: number | null; two: unknown; threeStart: number | null; threeLocal: number; noon: number; future: number }>
  }
  test('the 25-hour fall-back day keeps every hour; the repeated hour holds both', () => {
    const { fall } = run()
    expect(fall).toMatchObject({ length: 24, total: 25, one: 2, noon: 0.5, future: 13 })
  })
  test('the 23-hour spring-forward day leaves the skipped hour empty and keeps labels on the clock', () => {
    const { spring } = run()
    expect(spring).toMatchObject({ length: 24, total: 23, two: null, noon: 0.5 })
    expect(spring.threeStart).toBe(spring.threeLocal)
  })
})

describe('text contrast in the desktop theme', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [0, 2, 4].map(index => Number.parseInt(hex.slice(1 + index, 3 + index), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi! + 0.05) / (lo! + 0.05) }
  const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map(match => [match[1], match[2]]))
  const [light, dark] = desktopThemeCss.split('@media (prefers-color-scheme: dark)')
  for (const [name, block] of [['light', light ?? ''], ['dark', dark ?? '']] as const) {
    test(`${name}: every text token reaches 4.5:1 on every surface`, () => {
      const t = tokens(block)
      for (const text of ['text', 't2', 'muted', 'accent', 'accent2', 'green', 'yellow', 'red']) {
        for (const surface of ['bg', 'surface', 'surface2', 'well']) {
          expect({ text, surface, ok: ratio(t[text]!, t[surface]!) >= 4.5 }).toEqual({ text, surface, ok: true })
        }
      }
    })
  }
})
