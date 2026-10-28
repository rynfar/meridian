/**
 * In-memory ring buffer for telemetry metrics.
 *
 * Append-only, fixed capacity, oldest entries overwritten.
 * No disk I/O in the hot path. Data resets on proxy restart.
 */

import type { RequestMetric, TelemetrySummary, ITelemetryStore, TelemetryRetention } from "./types"
import { computeSummary, isCacheKeepaliveMetric } from "./percentiles"
import { getPricingOverrides } from "./pricingStore"
import { getSetting } from "../settings"

const DEFAULT_CAPACITY = 1000

/** Env beats the saved setting, which beats the default — the chain `routing`
 *  uses. A value that is not a positive integer is discarded at each step
 *  rather than falling through, so a typo cannot produce a zero-length ring. */
export function resolveTelemetryCapacity(): number {
  const fromEnv = telemetryCapacityFromEnv()
  if (fromEnv !== undefined) return fromEnv ?? DEFAULT_CAPACITY
  const saved = getSetting("telemetrySize")
  if (typeof saved === "number" && Number.isFinite(saved) && saved > 0) return Math.floor(saved)
  return DEFAULT_CAPACITY
}

/**
 * What MERIDIAN_TELEMETRY_SIZE (else CLAUDE_PROXY_TELEMETRY_SIZE) contributes
 * to resolveTelemetryCapacity: the size it sets; null when it is set but not a
 * positive integer, so the default applies; undefined when it is unset or
 * empty, so the saved setting is consulted.
 */
export function telemetryCapacityFromEnv(): number | null | undefined {
  const raw = process.env.MERIDIAN_TELEMETRY_SIZE ?? process.env.CLAUDE_PROXY_TELEMETRY_SIZE
  if (!raw) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export class MemoryTelemetryStore implements ITelemetryStore {
  private buffer: (RequestMetric | null)[]
  private head = 0 // next write position
  private count = 0
  private readonly capacity: number

  constructor(capacity?: number) {
    this.capacity = capacity ?? resolveTelemetryCapacity()
    this.buffer = new Array(this.capacity).fill(null)
  }

  /** Record a completed request metric. */
  record(metric: RequestMetric): void {
    this.buffer[this.head] = metric
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  /** Get the total number of stored metrics. */
  get size(): number {
    return this.count
  }

  describe(): TelemetryRetention {
    // The oldest live entry sits `count` slots behind the write head, so this
    // is O(1) rather than a scan of the ring for a minimum timestamp.
    const oldest = this.count === 0
      ? null
      : this.buffer[(this.head - this.count + this.capacity) % this.capacity]
    return {
      kind: "memory",
      held: this.count,
      capacity: this.capacity,
      oldestTimestamp: oldest?.timestamp ?? null,
    }
  }

  /**
   * Retrieve recent metrics, newest first.
   * @param options.limit - Max entries to return (default: 50)
   * @param options.since - Only entries at or after this timestamp
   * @param options.until - Only entries before this timestamp
   * @param options.model - Filter by model name
   */
  getRecent(options: { limit?: number; since?: number; until?: number; model?: string } = {}): RequestMetric[] {
    const { limit = 50, since, until, model } = options
    const results: RequestMetric[] = []

    // Walk backwards from most recent entry
    for (let i = 0; i < this.count && results.length < limit; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity
      const metric = this.buffer[idx]
      if (!metric) continue
      if (since && metric.timestamp < since) break // ring buffer is time-ordered
      if (until !== undefined && metric.timestamp >= until) continue
      if (model && metric.model !== model) continue
      results.push(metric)
    }

    return results
  }

  /** Find the most recent successful metric for a given SDK session ID.
   *  Used by anomaly detection to compare consecutive turns, so a keepalive
   *  beat, which is not a turn, is skipped. */
  getLastForSession(sdkSessionId: string): RequestMetric | undefined {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity
      const metric = this.buffer[idx]
      if (metric && metric.sdkSessionId === sdkSessionId && metric.error === null && !isCacheKeepaliveMetric(metric)) {
        return metric
      }
    }
    return undefined
  }

  /**
   * Compute aggregate statistics over a time window.
   * @param windowMs - Time window in ms (default: 1 hour)
   */
  summarize(windowMs: number = 60 * 60 * 1000): TelemetrySummary {
    const since = Date.now() - windowMs
    const metrics = this.getRecent({ limit: this.capacity, since })
    return computeSummary(metrics, windowMs, getPricingOverrides())
  }

  /** Clear all stored metrics. */
  clear(): void {
    this.buffer = new Array(this.capacity).fill(null)
    this.head = 0
    this.count = 0
  }
}

/** Singleton store instance used by the proxy. */
export const telemetryStore = new MemoryTelemetryStore()
