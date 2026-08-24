import { describe, expect, it, beforeEach } from "bun:test"
import { Hono } from "hono"
import { telemetryStore, createTelemetryRoutes, renderPrometheusMetrics } from "../telemetry"
import type { RequestMetric } from "../telemetry"

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

describe("Telemetry routes", () => {
  let app: Hono

  beforeEach(() => {
    telemetryStore.clear()
    app = new Hono()
    app.route("/telemetry", createTelemetryRoutes())
    app.get("/metrics", (c) => {
      const body = renderPrometheusMetrics(telemetryStore)
      return c.body(body, 200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      })
    })
  })

  it("GET /telemetry returns HTML dashboard", async () => {
    const res = await app.fetch(new Request("http://localhost/telemetry"))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("<!DOCTYPE html>")
    expect(html).toContain("Meridian")
    expect(html).toContain("Telemetry")
  })

  it("GET /telemetry/requests returns recent metrics as JSON", async () => {
    telemetryStore.record(makeMetric({ requestId: "r1" }))
    telemetryStore.record(makeMetric({ requestId: "r2" }))

    const res = await app.fetch(new Request("http://localhost/telemetry/requests"))
    expect(res.status).toBe(200)
    const body = await res.json() as RequestMetric[]

    expect(body.length).toBe(2)
    expect(body[0]!.requestId).toBe("r2") // newest first
    expect(body[1]!.requestId).toBe("r1")
  })

  it("GET /telemetry/requests respects limit param", async () => {
    for (let i = 0; i < 10; i++) {
      telemetryStore.record(makeMetric())
    }

    const res = await app.fetch(new Request("http://localhost/telemetry/requests?limit=3"))
    const body = await res.json() as RequestMetric[]
    expect(body.length).toBe(3)
  })

  it("GET /telemetry/requests filters by model", async () => {
    telemetryStore.record(makeMetric({ model: "sonnet" }))
    telemetryStore.record(makeMetric({ model: "opus" }))

    const res = await app.fetch(new Request("http://localhost/telemetry/requests?model=opus"))
    const body = await res.json() as RequestMetric[]
    expect(body.length).toBe(1)
    expect(body[0]!.model).toBe("opus")
  })

  it("GET /telemetry/requests folds a failover's hops into one row with its chain", async () => {
    telemetryStore.record(makeMetric({
      requestId: "hop1", profileId: "corp1", routeKind: "priority-hop",
      routeGroupId: "g1", routeAttempt: 1, status: 429, error: "rate_limit_error",
    }))
    telemetryStore.record(makeMetric({
      requestId: "hop2", profileId: "corp2", routeKind: "priority-hop",
      routeGroupId: "g1", routeAttempt: 2,
    }))

    const res = await app.fetch(new Request("http://localhost/telemetry/requests"))
    const body = await res.json() as RequestMetric[]

    expect(body).toHaveLength(1)
    expect(body[0]!.requestId).toBe("hop2")
    expect(body[0]!.routeKind).toBe("priority")
    expect(body[0]!.routeChain).toEqual([
      { profileId: "corp1", ok: false, status: 429, error: "rate_limit_error" },
      { profileId: "corp2", ok: true, status: 200, error: null },
    ])
  })

  it("GET /telemetry/requests?hops=1 returns the raw per-account attempts", async () => {
    telemetryStore.record(makeMetric({
      requestId: "hop1", profileId: "corp1", routeKind: "priority-hop",
      routeGroupId: "g1", routeAttempt: 1, status: 429, error: "rate_limit_error",
    }))
    telemetryStore.record(makeMetric({
      requestId: "hop2", profileId: "corp2", routeKind: "priority-hop",
      routeGroupId: "g1", routeAttempt: 2,
    }))

    const res = await app.fetch(new Request("http://localhost/telemetry/requests?hops=1"))
    const body = await res.json() as RequestMetric[]

    expect(body.map((r) => r.requestId)).toEqual(["hop2", "hop1"])
    expect(body.every((r) => r.routeKind === "priority-hop")).toBe(true)
    expect(body.every((r) => r.routeChain === undefined)).toBe(true)
  })

  it("GET /telemetry/routes tallies a failover as one request across two accounts", async () => {
    telemetryStore.record(makeMetric({
      requestId: "hop1", profileId: "corp1", routeKind: "priority-hop",
      routeGroupId: "g1", routeAttempt: 1, status: 429, error: "rate_limit_error",
      routeRefusedBucket: "five_hour",
    }))
    telemetryStore.record(makeMetric({
      requestId: "hop2", profileId: "corp2", routeKind: "priority-hop",
      routeGroupId: "g1", routeAttempt: 2,
    }))
    telemetryStore.record(makeMetric({ requestId: "plain", profileId: "corp2", routeKind: "active" }))

    const res = await app.fetch(new Request("http://localhost/telemetry/routes"))
    expect(res.status).toBe(200)
    const body = await res.json() as import("../telemetry").RouteSummary & { windowMs: number }

    expect(body.requests).toBe(2)
    expect(body.failedOver).toBe(1)
    expect(body.unserved).toBe(0)
    expect(body.byKind).toEqual({ priority: 1, active: 1 })
    expect(body.byProfile.corp1).toEqual({ served: 0, refused: 1, refusedBuckets: { five_hour: 1 } })
    expect(body.byProfile.corp2).toEqual({ served: 2, refused: 0, refusedBuckets: {} })
  })

  it("GET /telemetry/routes honours the window and is empty when nothing is in it", async () => {
    telemetryStore.record(makeMetric({ timestamp: Date.now() - 7_200_000, profileId: "corp1" }))

    const res = await app.fetch(new Request("http://localhost/telemetry/routes?window=60000"))
    const body = await res.json() as import("../telemetry").RouteSummary & { windowMs: number }

    expect(body.windowMs).toBe(60000)
    expect(body.requests).toBe(0)
    expect(body.byProfile).toEqual({})
  })

  it("GET /telemetry/retention says what the store actually holds", async () => {
    telemetryStore.record(makeMetric({ timestamp: 1_000 }))
    telemetryStore.record(makeMetric({ timestamp: 2_000 }))

    const res = await app.fetch(new Request("http://localhost/telemetry/retention"))
    expect(res.status).toBe(200)
    const body = await res.json() as {
      kind: string; held: number; capacity?: number; oldestTimestamp: number | null
    }

    expect(body.kind).toBe("memory")
    expect(body.held).toBe(2)
    expect(body.capacity).toBeGreaterThan(0)
    expect(body.oldestTimestamp).toBe(1_000)
  })

  it("GET /telemetry/retention reports an empty store as bounding nothing", async () => {
    const res = await app.fetch(new Request("http://localhost/telemetry/retention"))
    const body = await res.json() as { held: number; oldestTimestamp: number | null }

    expect(body.held).toBe(0)
    expect(body.oldestTimestamp).toBeNull()
  })

  it("GET /telemetry/summary returns aggregate stats", async () => {
    telemetryStore.record(makeMetric({ totalDurationMs: 100 }))
    telemetryStore.record(makeMetric({ totalDurationMs: 200 }))
    telemetryStore.record(makeMetric({ totalDurationMs: 300, error: "api_error" }))

    const res = await app.fetch(new Request("http://localhost/telemetry/summary"))
    expect(res.status).toBe(200)
    const body = await res.json() as any

    expect(body.totalRequests).toBe(3)
    expect(body.errorCount).toBe(1)
    expect(body.totalDuration.min).toBe(100)
    expect(body.totalDuration.max).toBe(300)
    expect(body.byModel).toBeDefined()
    expect(body.byMode).toBeDefined()
  })

  it("GET /telemetry/summary respects window param", async () => {
    telemetryStore.record(makeMetric({ timestamp: Date.now() - 120_000 })) // 2 min ago
    telemetryStore.record(makeMetric({ timestamp: Date.now() }))

    const res = await app.fetch(new Request("http://localhost/telemetry/summary?window=60000"))
    const body = await res.json() as any
    expect(body.totalRequests).toBe(1) // only the recent one
  })

  it("caps limit at 500", async () => {
    const res = await app.fetch(new Request("http://localhost/telemetry/requests?limit=9999"))
    expect(res.status).toBe(200)
    // Should not crash, just caps internally
  })

  it("GET /telemetry/logs filters by token category", async () => {
    const { diagnosticLog } = await import("../telemetry")
    diagnosticLog.clear()

    diagnosticLog.log({ level: "warn", category: "token", message: "cache miss detected", requestId: "r1" })
    diagnosticLog.log({ level: "info", category: "session", message: "session resumed", requestId: "r2" })

    const res = await app.fetch(new Request("http://localhost/telemetry/logs?category=token"))
    const body = await res.json() as any[]
    expect(body.length).toBe(1)
    expect(body[0].category).toBe("token")
  })

  it("GET /telemetry/requests includes token fields when recorded", async () => {
    telemetryStore.record(makeMetric({
      requestId: "tok-1",
      inputTokens: 12000,
      outputTokens: 800,
      cacheReadInputTokens: 10000,
      cacheCreationInputTokens: 500,
      cacheHitRate: 0.83,
    }))

    const res = await app.fetch(new Request("http://localhost/telemetry/requests"))
    const body = await res.json() as any[]
    const metric = body[0]

    expect(metric.inputTokens).toBe(12000)
    expect(metric.outputTokens).toBe(800)
    expect(metric.cacheReadInputTokens).toBe(10000)
    expect(metric.cacheCreationInputTokens).toBe(500)
    expect(metric.cacheHitRate).toBeCloseTo(0.83, 2)
  })

  it("GET /telemetry/summary includes token usage stats", async () => {
    telemetryStore.record(makeMetric({
      inputTokens: 1000, outputTokens: 200,
      cacheReadInputTokens: 800, cacheCreationInputTokens: 100,
      cacheHitRate: 0.8, isResume: true,
    }))
    telemetryStore.record(makeMetric({
      inputTokens: 2000, outputTokens: 400,
      cacheReadInputTokens: 0, cacheCreationInputTokens: 1500,
      cacheHitRate: 0, isResume: true,
    }))
    telemetryStore.record(makeMetric({
      inputTokens: 1500, outputTokens: 300,
      cacheReadInputTokens: 1200, cacheCreationInputTokens: 50,
      cacheHitRate: 0.8, isResume: false,
    }))

    const res = await app.fetch(new Request("http://localhost/telemetry/summary"))
    const body = await res.json() as any

    expect(body.tokenUsage).toBeDefined()
    expect(body.tokenUsage.totalInputTokens).toBe(4500)
    expect(body.tokenUsage.totalOutputTokens).toBe(900)
    expect(body.tokenUsage.totalCacheReadTokens).toBe(2000)
    expect(body.tokenUsage.totalCacheCreationTokens).toBe(1650)
    expect(body.tokenUsage.cacheMissOnResumeCount).toBe(1)
    expect(body.tokenUsage.avgCacheHitRate).toBeCloseTo(0.53, 1)
  })

  it("GET /metrics returns Prometheus format with correct content type", async () => {
    telemetryStore.record(makeMetric())

    const res = await app.fetch(new Request("http://localhost/metrics"))
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/plain")
    const body = await res.text()
    expect(body).toContain("# TYPE meridian_requests_total counter")
    expect(body).toContain("# TYPE meridian_request_duration_ms histogram")
  })

  it("GET /metrics returns 200 with valid output when store is empty", async () => {
    const res = await app.fetch(new Request("http://localhost/metrics"))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).toContain("# HELP meridian_requests_total")
    expect(body).not.toContain("NaN")
    expect(body).not.toContain("undefined")
  })
})
