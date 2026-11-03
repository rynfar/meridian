/**
 * Pure view models behind the React desktop renderer (apps/desktop/src/ui/model).
 * The screens only lay these out, so the product rules live and are tested here.
 */
import { describe, expect, test } from 'bun:test'
import { buildAccounts, servingAccount, limitedCount, moveInOrder } from '../../apps/desktop/src/ui/model/accounts'
import { groupFailures, failureCause, lastFailure } from '../../apps/desktop/src/ui/model/failures'
import { requestRows } from '../../apps/desktop/src/ui/model/requests'
import { utilTone, barWidth } from '../../apps/desktop/src/ui/model/tone'
import { sparkPaths } from '../../apps/desktop/src/ui/model/series'
import { cacheMisses } from '../../apps/desktop/src/ui/model/cache'
import { hero } from '../../apps/desktop/src/ui/model/today'

const NOW = new Date(2026, 9, 27, 21, 41).getTime()
const MIN = 60_000
const settings = { values: {}, unavailable: [], errors: [] }
const window5h = (u: number) => ({ type: 'five_hour', utilization: u, resetsAt: NOW + 60 * MIN })
const weekly = (u: number) => ({ type: 'seven_day', utilization: u, resetsAt: NOW + 3 * 24 * 60 * MIN })

describe('accounts model', () => {
  const inputs = {
    profiles: {
      activeProfile: 'personal',
      profiles: [
        { id: 'personal', email: 'p@example.com', organizationName: 'Personal Org', subscriptionType: 'max' },
        { id: 'work', email: 'w@example.com', organizationName: 'Centeva', subscriptionType: 'team', duplicateOf: ['work-twin'], duplicateBasis: 'account-organization' },
      ],
    },
    quota: { profiles: [
      { id: 'personal', fetchedAt: NOW, windows: [window5h(0.06), weekly(0.05)] },
      { id: 'work', fetchedAt: NOW, windows: [window5h(1), weekly(0.22)] },
    ] },
    providers: undefined, routesSummary: null, summary: null, settings,
  }
  test('organization, active account, limits and duplicates come through', () => {
    const model = buildAccounts(inputs, NOW)
    const personal = model.accounts.find(a => a.id === 'personal')!
    const work = model.accounts.find(a => a.id === 'work')!
    expect(personal.organization).toBe('Personal Org')
    expect(servingAccount(model)?.id).toBe('personal')
    expect(work.limited?.label).toBe('5-hour')
    expect(limitedCount(model)).toBe(1)
    expect(work.duplicateOf).toEqual(['work-twin'])
    expect(work.duplicateTitle).toContain('work-twin')
  })
  test('follow mode is surfaced so switching can be disabled', () => {
    const model = buildAccounts({ ...inputs, profiles: { ...inputs.profiles, follow: { url: 'http://127.0.0.1:3456', stale: false } } }, NOW)
    expect(model.follow).toEqual({ url: 'http://127.0.0.1:3456', stale: false })
  })
  test('a stale reading is never shown as fresh capacity', () => {
    const model = buildAccounts({ ...inputs, quota: { profiles: [{ id: 'personal', fetchedAt: NOW - 10 * MIN, windows: [window5h(0.1)] }] } }, NOW)
    expect(model.accounts.find(a => a.id === 'personal')?.usageNote).toContain('Last reading')
  })
  test('reorder moves one step within the order', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moveInOrder(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })
})

describe('failures', () => {
  const raw = [
    ...Array.from({ length: 8 }, (_, i) => ({ requestId: `f${i}`, timestamp: NOW - 600 * MIN + i * 1000, status: 429, error: 'rate_limit_error', profileId: 'personal', adapter: 'pi', model: 'opus[1m]' })),
    { requestId: 'ok1', timestamp: NOW - MIN, status: 200, error: null, profileId: 'personal', adapter: 'pi', model: 'opus[1m]' },
  ]
  test('identical failures collapse into one group that says it cleared', () => {
    const groups = groupFailures(requestRows(raw))
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ cause: 'Anthropic rate limit on personal (429)', count: 8, outcome: { state: 'cleared' } })
    expect(lastFailure(requestRows(raw))?.cause).toBe('Anthropic rate limit on personal (429)')
  })
  test('causes are said plainly', () => {
    expect(failureCause({ error: 'api_error', status: 500, profile: '', provider: 'claude', envelope: [] })).toBe('Anthropic server error (500)')
  })
  test('a keepalive beat that did not reach upstream is not a failure', () => {
    expect(requestRows([{ requestId: 'k', timestamp: NOW, status: 0, error: 'skipped', requestSource: 'cache-keepalive' }])[0]?.failed).toBe(false)
  })
})

describe('charts and tones', () => {
  test('utilization thresholds follow DESIGN.md', () => {
    expect([utilTone(0.59), utilTone(0.6), utilTone(0.85), utilTone(null)]).toEqual(['green', 'yellow', 'red', 'muted'])
    expect(barWidth(0)).toBe(0.02)
    expect(barWidth(null)).toBe(0)
  })
  test('hours without traffic break the sparkline instead of bridging it', () => {
    expect(sparkPaths([0.9, 0.95, null, null, 0.97], 100, 40, [0.8, 1]).runs).toBe(2)
  })
  test('hero has no hit rate when there were no requests', () => {
    expect(hero({ totalRequests: 0, tokenUsage: { avgCacheHitRate: 0 } }).hit).toBeNull()
    expect(hero({ totalRequests: 3, errorCount: 1, tokenUsage: { avgCacheHitRate: 0.96 } })).toMatchObject({ hit: 0.96, failed: 1 })
  })
})

describe('cache misses', () => {
  test('low-cache continuations in the window, with a reason', () => {
    const rows = requestRows([
      { requestId: 'a', timestamp: NOW - 90 * MIN, sdkSessionId: 's', lineageType: 'continuation', cacheHitRate: 0.99, model: 'opus' },
      { requestId: 'b', timestamp: NOW - 10 * MIN, sdkSessionId: 's', lineageType: 'continuation', cacheHitRate: 0, model: 'opus' },
    ])
    const misses = cacheMisses(rows)
    expect(misses.map(m => m.row.id)).toEqual(['b'])
    expect(misses[0]?.why).toContain('one-hour cache')
    expect(cacheMisses(rows, 0.5, 50, NOW - 5 * MIN)).toHaveLength(0)
  })
})
