import { describe, expect, it, beforeEach } from "bun:test"
import { MemoryTelemetryStore } from "../telemetry/store"
import { renderPrometheusMetrics } from "../telemetry/prometheus"
import type { RequestMetric } from "../telemetry/types"

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
    ...overrides,
  }
}

describe("renderPrometheusMetrics", () => {
  let store: MemoryTelemetryStore

  beforeEach(() => {
    store = new MemoryTelemetryStore(100)
  })

  it("returns valid output for empty store", () => {
    const output = renderPrometheusMetrics(store)
    expect(output).toContain("# HELP meridian_requests_total")
    expect(output).toContain("# TYPE meridian_requests_total counter")
    expect(output).toContain("# HELP meridian_request_duration_ms")
    expect(output).toContain("# TYPE meridian_request_duration_ms histogram")
    // Must be valid (no NaN, no undefined)
    expect(output).not.toContain("NaN")
    expect(output).not.toContain("undefined")
  })

  it("counts requests by model, mode, status", () => {
    store.record(makeMetric({ model: "sonnet", mode: "stream", status: 200 }))
    store.record(makeMetric({ model: "sonnet", mode: "stream", status: 200 }))
    store.record(makeMetric({ model: "opus", mode: "non-stream", status: 200 }))
    store.record(makeMetric({ model: "sonnet", mode: "stream", status: 500, error: "api_error" }))

    const output = renderPrometheusMetrics(store)
    expect(output).toContain('meridian_requests_total{model="sonnet",mode="stream",status="200"} 2')
    expect(output).toContain('meridian_requests_total{model="opus",mode="non-stream",status="200"} 1')
    expect(output).toContain('meridian_requests_total{model="sonnet",mode="stream",status="500"} 1')
  })

  it("produces valid histogram buckets with +Inf, _count, _sum", () => {
    store.record(makeMetric({ totalDurationMs: 50 }))
    store.record(makeMetric({ totalDurationMs: 150 }))

    const output = renderPrometheusMetrics(store)

    // Must have +Inf bucket
    expect(output).toContain('meridian_request_duration_ms_bucket{phase="total",le="+Inf"} 2')
    // Must have _count and _sum
    expect(output).toContain('meridian_request_duration_ms_count{phase="total"} 2')
    expect(output).toContain('meridian_request_duration_ms_sum{phase="total"} 200')

    // Bucket boundaries: 50ms falls in le="50" and above
    expect(output).toContain('meridian_request_duration_ms_bucket{phase="total",le="50"} 1')
    expect(output).toContain('meridian_request_duration_ms_bucket{phase="total",le="250"} 2')
  })

  it("includes all five phases in histogram", () => {
    store.record(makeMetric())

    const output = renderPrometheusMetrics(store)
    for (const phase of ["queue_wait", "session_queue_wait", "sdk_queue_wait", "proxy_overhead", "ttfb", "upstream", "total"]) {
      expect(output).toContain(`phase="${phase}"`)
    }
  })

  it("skips null ttfb values in histogram", () => {
    store.record(makeMetric({ ttfbMs: null }))
    store.record(makeMetric({ ttfbMs: 100 }))

    const output = renderPrometheusMetrics(store)
    // ttfb count should be 1 (only the non-null one)
    expect(output).toContain('meridian_request_duration_ms_count{phase="ttfb"} 1')
    expect(output).toContain('meridian_request_duration_ms_sum{phase="ttfb"} 100')
  })

  it("escapes label values correctly", () => {
    store.record(makeMetric({ model: 'sonnet"special' }))

    const output = renderPrometheusMetrics(store)
    // Quotes in label values must be escaped
    expect(output).toContain('model="sonnet\\"special"')
  })

  it("each metric family has exactly one HELP and TYPE line", () => {
    store.record(makeMetric())
    store.record(makeMetric({ model: "opus" }))

    const output = renderPrometheusMetrics(store)
    const helpLines = output.split("\n").filter(l => l.startsWith("# HELP"))
    const typeLines = output.split("\n").filter(l => l.startsWith("# TYPE"))

    // Two families: meridian_requests_total, meridian_request_duration_ms
    expect(helpLines.length).toBe(2)
    expect(typeLines.length).toBe(2)
  })
})
