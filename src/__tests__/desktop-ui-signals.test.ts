/**
 * The desktop renderer's two signature components and the figures behind
 * them, as pure functions: the prompt ribbon (cache read · cache write ·
 * fresh), "Prompt from cache", the day strip, and pace ticks on limit bars.
 * Also the window shortcuts and the failure text that replaces a ribbon.
 */
import { describe, expect, test } from 'bun:test'
import { promptShare, ribbonSplit, shareOf, stripColumns } from '../../apps/desktop/src/ui/model/prompt'
import { pace, resetClock, resetText, untilText, windowSpan, PACE_BAND } from '../../apps/desktop/src/ui/model/pace'
import { bucketWord, firstFutureSlot } from '../../apps/desktop/src/ui/model/series'
import { failureText, feedRows, heroPromptDetail } from '../../apps/desktop/src/ui/model/today'
import { requestRows } from '../../apps/desktop/src/ui/model/requests'
import { shortcutFor } from '../../apps/desktop/src/ui/shell/nav'
import type { TimeseriesBucket } from '../../apps/desktop/src/uiData'

const NOW = new Date(2026, 9, 28, 10, 17).getTime()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

describe('prompt from cache', () => {
  // The live snapshot behind the approved specimen: 94%, not the 88% per-request mean.
  const summary = { totalRequests: 175, tokenUsage: { totalInputTokens: 1736, totalCacheReadTokens: 26_928_675, totalCacheCreationTokens: 1_588_007, avgCacheHitRate: 0.88 } }
  test('is the token-weighted share: read / (read + write + uncached input)', () => {
    const share = promptShare(summary)
    expect(share.total).toBe(26_928_675 + 1_588_007 + 1736)
    expect(share.share).toBeCloseTo(26_928_675 / (26_928_675 + 1_588_007 + 1736), 10)
    expect(Math.round((share.share ?? 0) * 100)).toBe(94)
  })
  test('ignores the per-request mean entirely', () => {
    expect(promptShare({ tokenUsage: { ...summary.tokenUsage, avgCacheHitRate: 0.1 } }).share).toBe(promptShare(summary).share)
  })
  test('is unknown, never 0%, without prompt tokens', () => {
    expect(promptShare(null).share).toBeNull()
    expect(promptShare({ tokenUsage: {} }).share).toBeNull()
    expect(shareOf({ read: 0, write: 0, fresh: 0 }).share).toBeNull()
  })
  test('the hero caption says reused of total and the misses', () => {
    expect(heroPromptDetail(promptShare(summary), 1)).toBe('26.9M of 28.5M prompt tokens reused · 1 miss on resume')
    expect(heroPromptDetail({ read: 0, total: 10 }, 2)).toContain('2 misses')
  })
})

describe('prompt ribbon split', () => {
  test('fractions sum to one in read · write · fresh order', () => {
    const split = ribbonSplit({ read: 600, write: 300, fresh: 100 })!
    expect(split).toEqual({ read: 0.6, write: 0.3, fresh: 0.1 })
  })
  test('an empty prompt draws no ribbon', () => {
    expect(ribbonSplit({ read: 0, write: 0, fresh: 0 })).toBeNull()
  })
  test('a sliver of fresh input stays visible when asked, and only when there is any', () => {
    const split = ribbonSplit({ read: 999_999, write: 0, fresh: 1 }, 0.01)!
    expect(split.fresh).toBeGreaterThan(0.009)
    expect(split.read + split.write + split.fresh).toBeCloseTo(1, 10)
    expect(ribbonSplit({ read: 10, write: 0, fresh: 0 }, 0.01)!.fresh).toBe(0)
  })
  test('negative counts are treated as zero', () => {
    expect(ribbonSplit({ read: 10, write: -5, fresh: 0 })).toEqual({ read: 1, write: 0, fresh: 0 })
  })
})

describe('day strip', () => {
  const bucket = (start: number, read: number, write: number, input: number, requests: number, errors = 0): TimeseriesBucket => ({
    start, requests, errors, inputTokens: input, cacheReadTokens: read, cacheCreationTokens: write, outputTokens: 0, cacheHitRate: null, p50TotalMs: null, p50TtfbMs: null, costUsd: null,
  })
  test('future, empty and data columns, scaled to the tallest bucket', () => {
    const columns = stripColumns([bucket(0, 80, 10, 10, 4, 1), null, bucket(2, 40, 0, 10, 2), null], 3)
    expect(columns.map(c => c.state)).toEqual(['data', 'empty', 'data', 'future'])
    expect(columns[0]?.height).toBe(1)
    expect(columns[2]?.height).toBe(0.5)
    expect(columns[0]).toMatchObject({ okHeight: 0.75, failHeight: 0.25, failed: 1 })
    expect(columns[2]?.okHeight).toBe(0.5)
  })
  test('a bucket with no traffic is empty, not a zero-height column', () => {
    expect(stripColumns([bucket(0, 0, 0, 0, 0)])[0]?.state).toBe('empty')
  })
  test('today: the slot after the current hour is the first future one', () => {
    expect(firstFutureSlot('today', NOW)).toBe(11)
    expect(firstFutureSlot('24h', NOW)).toBe(Infinity)
  })
  test('bucket words for the strip label', () => {
    expect([bucketWord(5 * MIN), bucketWord(HOUR), bucketWord(6 * HOUR)]).toEqual(['5 minutes', 'hour', '6 hours'])
  })
})

describe('pace ticks', () => {
  const five = (utilization: number, left: number, stale = false) => ({ type: 'five_hour', utilization, resetsAt: NOW + left, stale })
  test('the tick sits at the elapsed share of the window', () => {
    // 3h left of a 5h window: 40% elapsed.
    expect(pace(five(0.4, 3 * HOUR), NOW)?.elapsed).toBeCloseTo(0.4, 10)
    expect(pace({ type: 'seven_day', utilization: 0.5, resetsAt: NOW + 3.5 * DAY, stale: false }, NOW)?.elapsed).toBeCloseTo(0.5, 10)
  })
  test('within ±5 points is on pace; beyond it ahead or under', () => {
    expect(pace(five(0.4 + PACE_BAND, 3 * HOUR), NOW)?.state).toBe('on')
    expect(pace(five(0.46, 3 * HOUR), NOW)).toMatchObject({ state: 'ahead', label: 'ahead of pace' })
    expect(pace(five(0.34, 3 * HOUR), NOW)).toMatchObject({ state: 'under', label: 'under pace' })
    expect(pace(five(1, 3 * HOUR), NOW)?.state).toBe('full')
  })
  test('omitted when the reading is stale or the window is unknown', () => {
    expect(pace(five(0.4, 3 * HOUR, true), NOW)).toBeNull()
    expect(pace({ type: 'five_hour', utilization: 0.4, resetsAt: null, stale: false }, NOW)).toBeNull()
    expect(pace({ type: 'five_hour', utilization: null, resetsAt: NOW + HOUR, stale: false }, NOW)).toBeNull()
    expect(pace({ type: 'mystery_window', utilization: 0.4, resetsAt: NOW + HOUR, stale: false }, NOW)).toBeNull()
    expect(pace(undefined, NOW)).toBeNull()
  })
  test('window spans: 5h, 7d (incl. model-specific weekly), 30d, else unknown', () => {
    expect(windowSpan('five_hour')).toBe(5 * HOUR)
    expect(windowSpan('gemini-5h')).toBe(5 * HOUR)
    expect(windowSpan('seven_day')).toBe(7 * DAY)
    expect(windowSpan('seven_day_fable')).toBe(7 * DAY)
    expect(windowSpan('3p-weekly')).toBe(7 * DAY)
    expect(windowSpan('30d')).toBe(30 * DAY)
    expect(windowSpan('other')).toBeNull()
  })
  test('reset and hold text', () => {
    expect(resetClock(new Date(2026, 9, 28, 14, 59).getTime(), NOW)).toBe('14:59')
    expect(resetText({ resetsAt: new Date(2026, 10, 1, 10, 0).getTime(), stale: false }, NOW)).toBe('resets Sun 10:00')
    expect(resetText({ resetsAt: null, stale: false }, NOW)).toBe('reset unknown')
    expect(resetText(undefined, NOW)).toBe('no reading')
    expect(resetText({ resetsAt: NOW - MIN, stale: true }, NOW)).toBe('reset passed')
    expect(untilText(new Date(2026, 9, 28, 10, 59).getTime(), NOW)).toBe('until 10:59')
    expect(untilText(new Date(2026, 9, 29, 9, 0).getTime() + DAY, NOW)).toBe('until Fri')
    expect(untilText(null, NOW)).toBe('limited')
  })
})

describe('list rows', () => {
  test('a failure replaces the ribbon with "HTTP 500 · api_error"', () => {
    const [failed, ok] = requestRows([
      { requestId: 'f', timestamp: NOW, status: 500, error: 'api_error', model: 'opus[1m]', inputTokens: 0 },
      { requestId: 'o', timestamp: NOW - 1, status: 200, error: null, model: 'opus[1m]', inputTokens: 2, cacheReadInputTokens: 900, cacheCreationInputTokens: 98 },
    ])
    expect(failureText(failed!)).toBe('HTTP 500 · api_error')
    expect(failureText(ok!)).toBe('')
    const feed = feedRows(requestRows([{ requestId: 'o', timestamp: NOW, status: 200, inputTokens: 2, cacheReadInputTokens: 900, cacheCreationInputTokens: 98, model: 'opus[1m]' }]))
    expect(feed[0]).toMatchObject({ cacheRead: 900, cacheWrite: 98, inputTokens: 2, longContext: true, failure: '' })
  })
})

describe('window shortcuts', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
  test('⌘1–⌘6 open the screens in sidebar order; ⌘R refreshes', () => {
    expect(shortcutFor(key('1', { metaKey: true }))).toEqual({ kind: 'page', page: 'today' })
    expect(shortcutFor(key('6', { metaKey: true }))).toEqual({ kind: 'page', page: 'service' })
    expect(shortcutFor(key('r', { metaKey: true }))).toEqual({ kind: 'refresh' })
  })
  test('other keys and modifiers are left alone', () => {
    expect(shortcutFor(key('7', { metaKey: true }))).toBeNull()
    expect(shortcutFor(key('1'))).toBeNull()
    expect(shortcutFor(key('r', { metaKey: true, shiftKey: true }))).toBeNull()
    expect(shortcutFor(key('1', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(key('1', { ctrlKey: true }), false)).toEqual({ kind: 'page', page: 'today' })
  })
})
