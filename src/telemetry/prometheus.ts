/**
 * Prometheus exposition format renderer.
 *
 * Generates text/plain output from ITelemetryStore data.
 * No dependencies — hand-rolled per the exposition format spec:
 * https://prometheus.io/docs/instrumenting/exposition_formats/
 */

import type { ITelemetryStore, RequestMetric } from "./types"

const DURATION_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000]

const PHASES: { key: string; extract: (m: RequestMetric) => number | null }[] = [
  { key: "queue_wait", extract: (m) => m.queueWaitMs },
  { key: "session_queue_wait", extract: (m) => m.sessionQueueWaitMs ?? 0 },
  { key: "sdk_queue_wait", extract: (m) => m.sdkQueueWaitMs ?? 0 },
  { key: "proxy_overhead", extract: (m) => m.proxyOverheadMs },
  { key: "ttfb", extract: (m) => m.ttfbMs },
  { key: "upstream", extract: (m) => m.upstreamDurationMs },
  { key: "total", extract: (m) => m.totalDurationMs },
]

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")
}

function formatLabels(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(",")
}

export function renderPrometheusMetrics(store: ITelemetryStore): string {
  const metrics = store.getRecent({ limit: 10000 })
  const lines: string[] = []

  // --- Counter: meridian_requests_total ---
  lines.push("# HELP meridian_requests_total Total proxy requests")
  lines.push("# TYPE meridian_requests_total counter")

  const counters = new Map<string, number>()
  for (const m of metrics) {
    const key = `${m.model}\0${m.mode}\0${m.status}`
    counters.set(key, (counters.get(key) ?? 0) + 1)
  }
  for (const [key, count] of counters) {
    const [model, mode, status] = key.split("\0")
    lines.push(`meridian_requests_total{${formatLabels({ model: model!, mode: mode!, status: status! })}} ${count}`)
  }

  // --- Histogram: meridian_request_duration_ms ---
  lines.push("")
  lines.push("# HELP meridian_request_duration_ms Request duration by phase in milliseconds")
  lines.push("# TYPE meridian_request_duration_ms histogram")

  for (const phase of PHASES) {
    const values: number[] = []
    for (const m of metrics) {
      const v = phase.extract(m)
      if (v !== null) values.push(v)
    }

    const phaseLabel = `phase="${escapeLabelValue(phase.key)}"`

    // Buckets (cumulative)
    for (const le of DURATION_BUCKETS) {
      const count = values.filter((v) => v <= le).length
      lines.push(`meridian_request_duration_ms_bucket{${phaseLabel},le="${le}"} ${count}`)
    }
    lines.push(`meridian_request_duration_ms_bucket{${phaseLabel},le="+Inf"} ${values.length}`)

    // Sum and count
    const sum = values.reduce((a, b) => a + b, 0)
    lines.push(`meridian_request_duration_ms_sum{${phaseLabel}} ${sum}`)
    lines.push(`meridian_request_duration_ms_count{${phaseLabel}} ${values.length}`)
  }

  lines.push("")
  return lines.join("\n")
}
