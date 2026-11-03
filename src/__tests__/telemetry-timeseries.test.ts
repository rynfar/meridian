import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Hono } from "hono"
import { telemetryStore, createTelemetryRoutes, MemoryTelemetryStore } from "../telemetry"
import type { RequestMetric, TelemetryRetention, TelemetrySummary } from "../telemetry"
import { createSqliteStores } from "../telemetry/sqlite"
import { computeCostEstimate } from "../telemetry/pricing"
import {
  buildTimeseries,
  parseTimeseriesQuery,
  retentionTruncates,
  type TimeseriesRange,
  type TimeseriesResponse,
} from "../telemetry/timeseries"

const HOUR = 3_600_000
const MINUTE = 60_000
const DAY = 86_400_000

function makeMetric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    model: "sonnet",
    mode: "stream",
    isResume: false,
    isPassthrough: false,
    status: 200,
    queueWaitMs: 5,
    proxyOverheadMs: 12,
    ttfbMs: 120,
    upstreamDurationMs: 800,
    totalDurationMs: 850,
    contentBlocks: 3,
    textEvents: 10,
    error: null,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadInputTokens: 800,
    cacheCreationInputTokens: 100,
    cacheHitRate: 0.89,
    ...overrides,
  }
}

// 2026-10-27T00:17:00Z: deliberately not on an hour.
const T0 = Date.UTC(2026, 9, 27, 0, 17)

describe("buildTimeseries", () => {
  it("returns every bucket of an empty range, zeroed with null rates", () => {
    const series = buildTimeseries([], { start: T0, end: T0 + 3 * HOUR, bucketMs: HOUR })
    expect(series).toMatchObject({ start: T0, end: T0 + 3 * HOUR, bucketMs: HOUR, truncated: false })
    expect(series.buckets.map(b => b.start)).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR])
    for (const bucket of series.buckets) {
      expect(bucket).toEqual({
        start: bucket.start,
        requests: 0,
        errors: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        cacheHitRate: null,
        p50TotalMs: null,
        p50TtfbMs: null,
        costUsd: 0,
        unpricedRequests: 0,
      })
    }
  })

  it("aligns buckets to a non-hour start and cuts the last one short at end", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + 2 * HOUR + 30 * MINUTE, bucketMs: HOUR }
    const series = buildTimeseries([
      makeMetric({ timestamp: T0 + 59 * MINUTE }),
      makeMetric({ timestamp: T0 + 2 * HOUR + 10 * MINUTE }),
    ], range)
    expect(series.buckets.map(b => b.start)).toEqual([T0, T0 + HOUR, T0 + 2 * HOUR])
    expect(series.buckets.map(b => b.requests)).toEqual([1, 0, 1])
  })

  it("puts a row on a bucket edge in the later bucket and drops one at end or before start", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + 2 * HOUR, bucketMs: HOUR }
    const series = buildTimeseries([
      makeMetric({ timestamp: T0 - 1 }),
      makeMetric({ timestamp: T0 }),
      makeMetric({ timestamp: T0 + HOUR }),
      makeMetric({ timestamp: T0 + 2 * HOUR }),
    ], range)
    expect(series.buckets.map(b => b.requests)).toEqual([1, 1])
  })

  it("counts errors and sums tokens, leaving keepalive beats out as summarize does", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + HOUR, bucketMs: HOUR }
    const [bucket] = buildTimeseries([
      makeMetric({ timestamp: T0 + 1, error: "overloaded_error", status: 529, inputTokens: undefined, outputTokens: undefined, cacheReadInputTokens: undefined, cacheCreationInputTokens: undefined, cacheHitRate: undefined }),
      makeMetric({ timestamp: T0 + 2, inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 }),
      makeMetric({ timestamp: T0 + 3, requestSource: "cache-keepalive", error: "skipped", status: 0 }),
    ], range).buckets
    expect(bucket).toMatchObject({
      requests: 2,
      errors: 1,
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 30,
      cacheCreationTokens: 40,
    })
  })

  it("reports a hit rate only where a request recorded one, averaged and rounded like summarize", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + 2 * HOUR, bucketMs: HOUR }
    const series = buildTimeseries([
      makeMetric({ timestamp: T0 + 1, cacheHitRate: 0.5 }),
      makeMetric({ timestamp: T0 + 2, cacheHitRate: 0.333 }),
      makeMetric({ timestamp: T0 + 3, cacheHitRate: undefined }),
      makeMetric({ timestamp: T0 + HOUR + 1, cacheHitRate: undefined }),
    ], range)
    expect(series.buckets[0]!.cacheHitRate).toBe(0.42)
    expect(series.buckets[1]!.cacheHitRate).toBeNull()
  })

  it("takes p50 latencies with computePercentiles' index rule, null TTFB when none was recorded", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + 2 * HOUR, bucketMs: HOUR }
    const series = buildTimeseries([
      makeMetric({ timestamp: T0 + 1, totalDurationMs: 300, ttfbMs: 30 }),
      makeMetric({ timestamp: T0 + 2, totalDurationMs: 100, ttfbMs: 10 }),
      makeMetric({ timestamp: T0 + 3, totalDurationMs: 200, ttfbMs: null }),
      makeMetric({ timestamp: T0 + 4, totalDurationMs: 400, ttfbMs: 40 }),
      makeMetric({ timestamp: T0 + HOUR + 1, totalDurationMs: 700, ttfbMs: null }),
    ], range)
    // sorted[floor(n * 0.5)]: [100,200,300,400] -> 300; [10,30,40] -> 30
    expect(series.buckets[0]!.p50TotalMs).toBe(300)
    expect(series.buckets[0]!.p50TtfbMs).toBe(30)
    expect(series.buckets[1]!.p50TotalMs).toBe(700)
    expect(series.buckets[1]!.p50TtfbMs).toBeNull()
  })

  it("prices like computeCostEstimate, null only when nothing in the bucket is priced", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + 3 * HOUR, bucketMs: HOUR }
    const priced = makeMetric({ timestamp: T0 + 1, model: "sonnet" })
    const unpricedA = makeMetric({ timestamp: T0 + 2, model: "gpt-7-nova" })
    const unpricedB = makeMetric({ timestamp: T0 + HOUR + 1, model: "gpt-7-nova" })
    const series = buildTimeseries([priced, unpricedA, unpricedB], range)

    const expected = computeCostEstimate([priced]).totalUsd
    expect(expected).toBeGreaterThan(0)
    expect(series.buckets[0]!.costUsd).toBe(expected)
    expect(series.buckets[0]!.unpricedRequests).toBe(1)
    expect(series.buckets[1]!.costUsd).toBeNull()
    expect(series.buckets[1]!.unpricedRequests).toBe(1)
    expect(series.buckets[2]!.costUsd).toBe(0)
  })

  it("applies pricing overrides", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + HOUR, bucketMs: HOUR }
    const row = makeMetric({ timestamp: T0 + 1, model: "gpt-7-nova", inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    const overrides = { "gpt-7-nova": { inputPerMTok: 2, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } }
    expect(buildTimeseries([row], range, {}, overrides).buckets[0]!.costUsd).toBe(computeCostEstimate([row], overrides).totalUsd)
  })

  it("flags truncation when the read hit its bound or the store dropped rows in range", () => {
    const range: TimeseriesRange = { start: T0, end: T0 + HOUR, bucketMs: HOUR }
    expect(buildTimeseries([], range, { limitReached: true }).truncated).toBe(true)
    const fullRing: TelemetryRetention = { kind: "memory", held: 10, capacity: 10, oldestTimestamp: T0 + 1 }
    expect(buildTimeseries([], range, { retention: fullRing, now: T0 + HOUR }).truncated).toBe(true)
    expect(buildTimeseries([], range, { limitReached: false, retention: { ...fullRing, oldestTimestamp: T0 }, now: T0 + HOUR }).truncated).toBe(false)
  })
})

describe("retentionTruncates", () => {
  const now = T0 + 10 * DAY

  it("treats a ring that is not full as having dropped nothing", () => {
    expect(retentionTruncates({ kind: "memory", held: 3, capacity: 10, oldestTimestamp: now - 1 }, T0, now)).toBe(false)
  })

  it("treats a full ring as covering only back to its oldest row", () => {
    const ring: TelemetryRetention = { kind: "memory", held: 10, capacity: 10, oldestTimestamp: T0 + 1 }
    expect(retentionTruncates(ring, T0, now)).toBe(true)
    expect(retentionTruncates(ring, T0 + 1, now)).toBe(false)
  })

  it("treats SQLite as truncated only for a range reaching past retention that it no longer holds", () => {
    const db: TelemetryRetention = { kind: "sqlite", held: 5, retentionDays: 7, oldestTimestamp: now - 7 * DAY + 1 }
    expect(retentionTruncates(db, now - 2 * DAY, now)).toBe(false)
    expect(retentionTruncates(db, now - 8 * DAY, now)).toBe(true)
    expect(retentionTruncates({ ...db, oldestTimestamp: now - 9 * DAY }, now - 8 * DAY, now)).toBe(false)
  })
})

describe("parseTimeseriesQuery", () => {
  const now = T0 + DAY

  it("defaults to the last 24 hours in hour buckets", () => {
    expect(parseTimeseriesQuery({}, now)).toEqual({ ok: true, range: { start: now - DAY, end: now, bucketMs: HOUR } })
  })

  it("accepts window instead of start, and start wins when both are given", () => {
    expect(parseTimeseriesQuery({ window: String(2 * HOUR), bucket: String(MINUTE) }, now))
      .toEqual({ ok: true, range: { start: now - 2 * HOUR, end: now, bucketMs: MINUTE } })
    expect(parseTimeseriesQuery({ start: String(T0), window: String(HOUR), end: String(T0 + 3 * HOUR) }, now))
      .toEqual({ ok: true, range: { start: T0, end: T0 + 3 * HOUR, bucketMs: HOUR } })
  })

  it("rejects bad ranges", () => {
    const cases: Array<Record<string, string>> = [
      { start: String(T0), end: String(T0) },
      { start: String(T0 + 1), end: String(T0) },
      { start: "abc" },
      { end: "Infinity" },
      { bucket: "" },
      { window: "NaN" },
      { bucket: String(MINUTE - 1) },
      { start: String(now - 32 * DAY) },
      { window: String(DAY), bucket: String(MINUTE) }, // 1440 buckets
    ]
    for (const query of cases) {
      const result = parseTimeseriesQuery(query, now)
      expect(result.ok).toBe(false)
    }
  })

  it("allows exactly 1000 buckets and exactly 31 days", () => {
    expect(parseTimeseriesQuery({ window: String(1000 * MINUTE), bucket: String(MINUTE) }, now).ok).toBe(true)
    expect(parseTimeseriesQuery({ window: String(31 * DAY), bucket: String(DAY) }, now).ok).toBe(true)
  })
})

describe("getRecent until", () => {
  it("memory store excludes rows at or after until without spending the limit on them", () => {
    const store = new MemoryTelemetryStore(10)
    store.record(makeMetric({ requestId: "a", timestamp: T0 }))
    store.record(makeMetric({ requestId: "b", timestamp: T0 + 1 }))
    store.record(makeMetric({ requestId: "c", timestamp: T0 + 2 }))
    store.record(makeMetric({ requestId: "d", timestamp: T0 + 3 }))
    expect(store.getRecent({ limit: 2, since: T0, until: T0 + 2 }).map(m => m.requestId)).toEqual(["b", "a"])
  })

  describe("SQLite store", () => {
    let tmpDir: string
    let close: () => void

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "meridian-timeseries-"))
    })

    afterEach(() => {
      close?.()
      rmSync(tmpDir, { recursive: true, force: true })
    })

    it("excludes rows at or after until and buckets the same as memory", () => {
      const stores = createSqliteStores(join(tmpDir, "t.db"), 7)
      close = stores.close
      const memory = new MemoryTelemetryStore(10)
      const rows = [
        makeMetric({ requestId: "a", timestamp: T0 }),
        makeMetric({ requestId: "b", timestamp: T0 + HOUR }),
        makeMetric({ requestId: "c", timestamp: T0 + 2 * HOUR, error: "api_error", status: 500 }),
        makeMetric({ requestId: "d", timestamp: T0 + 3 * HOUR }),
      ]
      for (const row of rows) {
        stores.telemetry.record(row)
        memory.record(row)
      }
      const read = { limit: 100, since: T0, until: T0 + 3 * HOUR }
      expect(stores.telemetry.getRecent(read).map(m => m.requestId)).toEqual(["c", "b", "a"])
      const range: TimeseriesRange = { start: T0, end: T0 + 3 * HOUR, bucketMs: HOUR }
      expect(buildTimeseries(stores.telemetry.getRecent(read), range))
        .toEqual(buildTimeseries(memory.getRecent(read), range))
    })
  })
})

describe("GET /telemetry/timeseries", () => {
  let app: Hono

  beforeEach(() => {
    telemetryStore.clear()
    app = new Hono()
    app.route("/telemetry", createTelemetryRoutes())
  })

  async function get(query: string): Promise<Response> {
    return app.fetch(new Request(`http://localhost/telemetry/timeseries${query}`))
  }

  it("answers 400 with an error for a bad range", async () => {
    const now = Date.now()
    for (const query of [
      `?start=${now}&end=${now - 1}`,
      "?start=nope",
      `?bucket=${MINUTE - 1}`,
      `?window=${32 * DAY}&bucket=${DAY}`,
      `?window=${DAY}&bucket=${MINUTE}`,
    ]) {
      const res = await get(query)
      expect(res.status).toBe(400)
      const body = await res.json() as { error: string }
      expect(typeof body.error).toBe("string")
    }
  })

  it("returns the requested buckets aligned to start", async () => {
    const start = Date.now() - 3 * HOUR - 17 * MINUTE
    const end = start + 3 * HOUR
    telemetryStore.record(makeMetric({ timestamp: start + HOUR }))
    const res = await get(`?start=${start}&end=${end}&bucket=${HOUR}`)
    expect(res.status).toBe(200)
    const body = await res.json() as TimeseriesResponse
    expect(body).toMatchObject({ start, end, bucketMs: HOUR, truncated: false })
    expect(body.buckets.map(b => b.start)).toEqual([start, start + HOUR, start + 2 * HOUR])
    expect(body.buckets.map(b => b.requests)).toEqual([0, 1, 0])
  })

  it("sums to /telemetry/summary's totals for the same window", async () => {
    const now = Date.now()
    const ago = (ms: number) => now - ms
    telemetryStore.record(makeMetric({ timestamp: ago(25 * HOUR) })) // outside the window
    telemetryStore.record(makeMetric({ timestamp: ago(20 * HOUR), inputTokens: 7, outputTokens: 3 }))
    telemetryStore.record(makeMetric({ timestamp: ago(5 * HOUR), error: "api_error", status: 500, inputTokens: undefined, outputTokens: undefined }))
    // A failover: two hops sharing a group, counted per row as summary does.
    telemetryStore.record(makeMetric({ timestamp: ago(2 * HOUR), routeGroupId: "g1", routeAttempt: 1, error: "rate_limit_error", status: 429, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }))
    telemetryStore.record(makeMetric({ timestamp: ago(2 * HOUR) + 5, routeGroupId: "g1", routeAttempt: 2 }))
    telemetryStore.record(makeMetric({ timestamp: ago(HOUR), requestSource: "cache-keepalive", inputTokens: 999 }))
    telemetryStore.record(makeMetric({ timestamp: ago(10 * MINUTE), model: "gpt-7-nova" }))

    const [seriesRes, summaryRes] = await Promise.all([
      get(`?window=${DAY}&bucket=${HOUR}`),
      app.fetch(new Request(`http://localhost/telemetry/summary?window=${DAY}`)),
    ])
    const series = await seriesRes.json() as TimeseriesResponse
    const summary = await summaryRes.json() as TelemetrySummary
    const sum = (pick: (b: TimeseriesResponse["buckets"][number]) => number) =>
      series.buckets.reduce((total, b) => total + pick(b), 0)

    expect(series.buckets.length).toBe(24)
    expect(sum(b => b.requests)).toBe(summary.totalRequests)
    expect(summary.totalRequests).toBe(5)
    expect(sum(b => b.errors)).toBe(summary.errorCount)
    expect(sum(b => b.inputTokens)).toBe(summary.tokenUsage.totalInputTokens)
    expect(sum(b => b.outputTokens)).toBe(summary.tokenUsage.totalOutputTokens)
    expect(sum(b => b.cacheReadTokens)).toBe(summary.tokenUsage.totalCacheReadTokens)
    expect(sum(b => b.cacheCreationTokens)).toBe(summary.tokenUsage.totalCacheCreationTokens)
    expect(sum(b => b.unpricedRequests)).toBe(summary.costEstimate.unpricedRequestCount)
    expect(sum(b => b.costUsd ?? 0)).toBeCloseTo(summary.costEstimate.totalUsd, 6)
  })
})
