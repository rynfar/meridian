/**
 * Token health anomaly detection.
 *
 * Pure functions that compare consecutive turn token snapshots
 * and classify abnormal patterns. No I/O, no imports from server.ts.
 */

export interface TokenSnapshot {
  requestId: string
  turnNumber: number
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cacheHitRate: number
  isResume: boolean
  isPassthrough: boolean
}

export interface TokenAnomaly {
  type: "context_spike" | "cache_miss" | "output_explosion"
  severity: "warn" | "critical"
  detail: string
}

/** Input token growth threshold (fraction) above which we flag a context spike. */
const CONTEXT_SPIKE_THRESHOLD = 0.6  // >60% growth

/**
 * Minimum baseline input tokens before percentage growth is meaningful. In
 * passthrough, nearly all input is cache-read, so raw inputTokens routinely
 * sits at 1-2 and any jitter reads as huge % growth ("grew 100% (1 -> 2)").
 * Only a baseline above this floor can trip the context-spike alert (#496).
 */
const CONTEXT_SPIKE_MIN_BASELINE = 1000

/** Cache hit rate below which we flag a cache miss on resume requests. */
const CACHE_MISS_THRESHOLD = 0.05

/** Output token ratio (output/input) above which we flag an output explosion. */
const OUTPUT_EXPLOSION_RATIO = 2.0

const fmt = (n: number) => n > 1000 ? `${Math.round(n / 1000)}k` : String(n)

/**
 * Compare a current turn's token snapshot against the previous turn.
 * Returns an array of detected anomalies (empty if everything looks normal).
 */
export function detectTokenAnomalies(
  current: TokenSnapshot,
  previous: TokenSnapshot | undefined
): TokenAnomaly[] {
  const anomalies: TokenAnomaly[] = []

  // Context spike: input tokens grew more than CONTEXT_SPIKE_THRESHOLD from a
  // baseline large enough for the percentage to be meaningful.
  if (previous && previous.inputTokens >= CONTEXT_SPIKE_MIN_BASELINE) {
    const growth = (current.inputTokens - previous.inputTokens) / previous.inputTokens
    if (growth > CONTEXT_SPIKE_THRESHOLD) {
      const pct = Math.round(growth * 100)
      anomalies.push({
        type: "context_spike",
        severity: growth > 2.0 ? "critical" : "warn",
        detail: `Input tokens grew ${pct}% in one turn (${fmt(previous.inputTokens)} -> ${fmt(current.inputTokens)}). Possible context leak or full replay.`,
      })
    }
  }

  // Cache miss: resume request with no cache reads
  if (current.isResume && current.cacheHitRate <= CACHE_MISS_THRESHOLD && current.inputTokens > 0) {
    // No previous metric for this session = first request after proxy restart.
    // SDK cache is in-memory and doesn't survive restarts, so a one-time
    // cache miss is expected. Only flag as critical if we have a previous
    // metric (meaning the cache should have been warm).
    const isFirstAfterRestart = !previous
    anomalies.push({
      type: "cache_miss",
      severity: isFirstAfterRestart ? "warn" : "critical",
      detail: isFirstAfterRestart
        ? `Cache hit rate ${Math.round(current.cacheHitRate * 100)}% on resume — normal after proxy restart, cache will re-prime on next turn.`
        : `Cache hit rate ${Math.round(current.cacheHitRate * 100)}% on resume (expected >50%). Prompt caching likely invalidated — check tool ordering or system prompt changes.`,
    })
  }

  // Output explosion: output tokens much larger than previous turn (unusual)
  if (previous && previous.outputTokens > 0 && current.outputTokens > 0) {
    const ratio = current.outputTokens / previous.outputTokens
    if (ratio > OUTPUT_EXPLOSION_RATIO && current.outputTokens > 2000) {
      anomalies.push({
        type: "output_explosion",
        severity: "warn",
        detail: `Output tokens ${fmt(current.outputTokens)} are ${ratio.toFixed(1)}x the previous turn (${fmt(previous.outputTokens)}).`,
      })
    }
  }

  return anomalies
}

/**
 * Format anomalies as stderr log lines.
 */
export function formatAnomalyAlerts(requestId: string, anomalies: TokenAnomaly[]): string[] {
  return anomalies.map(a => {
    const icon = a.severity === "critical" ? "TOKEN ALERT" : "TOKEN WARN"
    return `[PROXY] ${requestId} ${icon}: ${a.detail}`
  })
}
