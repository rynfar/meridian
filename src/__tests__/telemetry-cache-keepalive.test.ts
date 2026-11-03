/**
 * Prompt-cache keepalive beats in telemetry.
 *
 * A beat answers no client, so request, error, cache-hit, cost, route and
 * Prometheus request figures exclude it in both stores; the summary totals
 * beats separately, and anomaly detection never compares a turn to a beat.
 */
import { describe, expect, it, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MemoryTelemetryStore } from "../telemetry/store"
import { createSqliteStores } from "../telemetry/sqlite"
import { computeSummary } from "../telemetry/percentiles"
import { renderPrometheusMetrics } from "../telemetry/prometheus"
import { collapseRouteChains, summarizeRoutes } from "../telemetry/routeChain"
import type { ITelemetryStore, RequestMetric } from "../telemetry/types"

function metric(overrides: Partial<RequestMetric> = {}): RequestMetric {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    model: "sonnet",
    mode: "stream",
    isResume: true,
    isPassthrough: true,
    status: 200,
    queueWaitMs: 5,
    proxyOverheadMs: 12,
    ttfbMs: 120,
    upstreamDurationMs: 800,
    totalDurationMs: 850,
    contentBlocks: 3,
    textEvents: 10,
    error: null,
    ...overrides,
  }
}

const turn = (overrides: Partial<RequestMetric> = {}) => metric({
  sdkSessionId: "s1",
  inputTokens: 10,
  outputTokens: 100,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 40_000,
  cacheHitRate: 0,
  ...overrides,
})

const beat = (overrides: Partial<RequestMetric> = {}) => metric({
  requestSource: "cache-keepalive",
  sdkSessionId: "s1",
  inputTokens: 3,
  outputTokens: 0,
  cacheReadInputTokens: 40_000,
  cacheCreationInputTokens: 0,
  cacheHitRate: 1,
  ...overrides,
})

describe("computeSummary with keepalive beats", () => {
  it("excludes beats from requests, errors, cache hit and cost, and totals them apart", () => {
    const now = Date.now()
    const summary = computeSummary([
      beat({ timestamp: now }),
      beat({ timestamp: now - 1, status: 0, error: "Cache keepalive ended before message_start", inputTokens: undefined, outputTokens: undefined, cacheReadInputTokens: undefined, cacheCreationInputTokens: undefined, cacheHitRate: undefined }),
      turn({ timestamp: now - 2 }),
    ], 3_600_000)
    expect(summary.totalRequests).toBe(1)
    expect(summary.errorCount).toBe(0)
    expect(summary.tokenUsage.totalCacheReadTokens).toBe(0)
    expect(summary.tokenUsage.totalCacheCreationTokens).toBe(40_000)
    expect(summary.tokenUsage.avgCacheHitRate).toBe(0)
    expect(summary.costEstimate.byModel.sonnet?.requests).toBe(1)
    expect(summary.cacheKeepalive).toMatchObject({
      beats: 2,
      reached: 1,
      notReached: 1,
      inputTokens: 3,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 0,
    })
    expect(summary.cacheKeepalive.estimatedUsd).toBeGreaterThan(0)
  })

  it("counts a beat that got usage back as reached even when joining its child failed", () => {
    const summary = computeSummary([beat({ error: "SDK child did not close" })], 3_600_000)
    expect(summary.cacheKeepalive).toMatchObject({ beats: 1, reached: 1, notReached: 0 })
  })

  it("reports beats even when the window holds no requests", () => {
    const summary = computeSummary([beat()], 3_600_000)
    expect(summary.totalRequests).toBe(0)
    expect(summary.cacheKeepalive.beats).toBe(1)
  })

  it("reports zero beats when there were none", () => {
    expect(computeSummary([], 3_600_000).cacheKeepalive.beats).toBe(0)
  })
})

describe("route summary and Prometheus with keepalive beats", () => {
  it("does not count a beat as a routed client request", () => {
    const routes = summarizeRoutes(collapseRouteChains([beat({ profileId: "work" }), turn({ profileId: "work" })]))
    expect(routes.requests).toBe(1)
    expect(routes.byProfile.work?.served).toBe(1)
  })

  it("keeps beats out of meridian_requests_total and counts them on their own", () => {
    const store = new MemoryTelemetryStore(100)
    store.record(turn())
    store.record(beat())
    store.record(beat({ status: 0, error: "skipped" }))
    const text = renderPrometheusMetrics(store)
    expect(text).toContain('meridian_requests_total{model="sonnet",mode="stream",status="200"} 1')
    expect(text).not.toContain('status="0"')
    expect(text).toContain('meridian_cache_keepalive_beats_total{outcome="reached"} 1')
    expect(text).toContain('meridian_cache_keepalive_beats_total{outcome="not_reached"} 1')
  })
})

function storeContract(name: string, open: () => { store: ITelemetryStore; close: () => void }) {
  describe(`${name} with keepalive beats`, () => {
    let close: (() => void) | undefined
    afterEach(() => close?.())

    it("summarizes beats apart and never compares a turn to a beat", () => {
      const opened = open()
      close = opened.close
      const now = Date.now()
      opened.store.record(turn({ requestId: "turn", timestamp: now - 2 }))
      opened.store.record(beat({ requestId: "beat", timestamp: now - 1 }))
      expect(opened.store.getLastForSession("s1")?.requestId).toBe("turn")
      const summary = opened.store.summarize(3_600_000)
      expect(summary.totalRequests).toBe(1)
      expect(summary.cacheKeepalive.beats).toBe(1)
    })
  })
}

storeContract("MemoryTelemetryStore", () => ({ store: new MemoryTelemetryStore(100), close: () => {} }))
storeContract("SqliteTelemetryStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-keepalive-telemetry-"))
  const stores = createSqliteStores(join(dir, "telemetry.db"), 7)
  return {
    store: stores.telemetry,
    close: () => {
      stores.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
})
