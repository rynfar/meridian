/**
 * Telemetry types for request performance tracking.
 *
 * Each proxy request produces a RequestMetric capturing timing for every phase:
 *
 *   queueEnter → queueStart → requestStart ──→ upstreamStart → firstChunk → done
 *   ├─ queueWait ─┤           ├─ proxyOverhead ─┤              │            │
 *   │                                            ├──── TTFB ────┤            │
 *   │                                            ├── upstream duration ──────┤
 *   ├──────────────────── total duration ────────────────────────────────────┤
 */

/**
 * How a request's account was chosen, as rendered in /telemetry's Route column.
 *
 * Lives here rather than in proxy/routing.ts because it is part of the
 * RequestMetric wire shape, and telemetry may never import from proxy —
 * dependencies flow proxy → telemetry only. `classifyRouteKind` produces it.
 *
 * The `-hop` kinds are one INTERNAL attempt of a pool dispatch. They are
 * separate kinds rather than a flag because the collapsed row has to name the
 * MODE that produced it: `priority` drains the pool in configured order,
 * `active+priority` puts the selected account at its head, and those are
 * different answers to "why this account" even when the chain looks alike.
 */
export type RouteKind =
  | "pinned"
  | "active"
  | "sticky"
  | "priority"
  | "active+priority"
  | "priority-hop"
  | "active+priority-hop"

/** One account attempt within a client request's route. */
export interface RouteHop {
  profileId: string
  /** Whether this attempt succeeded. The LAST hop answered the client
   *  whether or not it did — a chain ending `ok: false` means the pool ran out. */
  ok: boolean
  status: number
  error: string | null
  /** Which allowance the account refused on ("five_hour", "seven_day_opus", …)
   *  when the refusal named one. Absent on hops that did not refuse, and on
   *  refusals Anthropic never attributed to a window. */
  refusedBucket?: string
}

export interface RequestMetric {
  /** Unique request identifier */
  requestId: string

  /** When this metric was recorded */
  timestamp: number

  /** Which agent adapter handled this request */
  adapter?: string

  /** Optional client-stamped source tag (x-meridian-source) for distinguishing
   *  concurrent flows within the same conversation (e.g. main chat vs.
   *  memory-extract fork vs. subagent-scout). Truncated to 64 chars. */
  requestSource?: string

  /** Model used for SDK query (sonnet, opus, haiku, sonnet[1m], etc.) */
  model: string

  /** Original model string from the client request (e.g. "claude-sonnet-4-6-20250312") */
  requestModel?: string

  /** Profile that served the request (multi-account). On records written
   *  before profile resolution ran this falls back to the pinned profile
   *  header, and is absent only when there was no pin either. */
  profileId?: string

  /** How that profile was chosen — see proxy/routing.ts classifyRouteKind.
   *  Absent when the record was written before routing resolved. */
  routeKind?: RouteKind

  /** Which allowance the serving account refused on, when this request was
   *  refused and Anthropic's wording or the SDK named a window. Recorded from
   *  the diagnosis the refusal bookkeeping already produced — nothing extra is
   *  computed for it. */
  routeRefusedBucket?: string

  /** Correlates the internal hops of ONE client request. Priority routing
   *  re-enters the proxy once per candidate account, so a failover writes
   *  several rows; they share this id (the outer request's id). Absent on
   *  requests that were never dispatched through the pool. */
  routeGroupId?: string

  /** 1-based position of this hop within its routeGroupId. */
  routeAttempt?: number

  /** The full account chain for this client request, oldest attempt first,
   *  ending with the account that answered. DERIVED at read time by folding
   *  a routeGroupId's hops together — never stored, never computed on the
   *  request path. Absent on rows that were not part of a dispatch group. */
  routeChain?: RouteHop[]

  /** Streaming or non-streaming */
  mode: "stream" | "non-stream"

  /** Envelope-integrity violations detected on this response (dangling_block,
   *  undelivered_tool_use, empty_tool_input). Absent when the envelope was
   *  clean — the overwhelmingly common case. See proxy/envelopeIntegrity.ts. */
  envelopeViolations?: string[]

  /** Whether the request used session resume */
  isResume: boolean

  /** Whether passthrough mode was active */
  isPassthrough: boolean

  /** Session lineage classification: how the incoming messages related to the stored session.
   *  - continuation: normal follow-up (prefix matched)
   *  - compaction:   older messages rewritten, recent preserved (suffix matched)
   *  - undo:         user undid recent messages (prefix preserved, suffix changed) → SDK fork
   *  - diverged:     no overlap with stored session → fresh start
   *  - new:          first request, no stored session to compare */
  lineageType?: "continuation" | "compaction" | "undo" | "diverged" | "new"

  /** Whether deferred tool loading was active (auto-defer or client defer_loading) */
  hasDeferredTools?: boolean

  /** Number of tools deferred (not in prompt, discoverable via ToolSearch) */
  deferredToolCount?: number

  /** Total number of tools in the request */
  toolCount?: number

  /** Tool names discovered via ToolSearch this request (deferred tools that got called) */
  discoveredTools?: string[]

  /** Cumulative count of tools discovered via ToolSearch across the entire session */
  sessionDiscoveredCount?: number

  /** Number of messages in the request */
  messageCount?: number

  /** SDK session ID used for this request (for correlating across turns) */
  sdkSessionId?: string

  /** HTTP status code returned to the client */
  status: number

  /** Time spent waiting in the concurrency queue (ms) */
  queueWaitMs: number

  /** Time spent waiting for the logical Session turn lease (ms). */
  sessionQueueWaitMs?: number

  /** Cumulative time spent waiting for SDK query permits across attempts (ms). */
  sdkQueueWaitMs?: number

  /** Time spent in proxy processing before SDK call — request parsing,
   *  session lookup, prompt building (ms). If this is high, the proxy
   *  is the bottleneck. Typically <50ms. */
  proxyOverheadMs: number

  /** Time from SDK query start to first content chunk (ms) */
  ttfbMs: number | null

  /** Total time the SDK query took (ms) */
  upstreamDurationMs: number

  /** Total time from request received to response sent (ms) */
  totalDurationMs: number

  /** Number of content blocks in the response */
  contentBlocks: number

  /** Number of text stream events forwarded (streaming only) */
  textEvents: number

  /** Error type if the request failed, null if successful */
  error: string | null

  /** Input tokens consumed (from SDK usage) */
  inputTokens?: number

  /** Output tokens generated */
  outputTokens?: number

  /** Input tokens read from prompt cache (lower cost) */
  cacheReadInputTokens?: number

  /** Input tokens written to prompt cache (one-time cost) */
  cacheCreationInputTokens?: number

  /** Cache hit ratio: cacheRead / (cacheRead + cacheCreation + uncached).
   *  1.0 = perfect caching, 0.0 = no caching. undefined when no token data. */
  cacheHitRate?: number
}

export interface PhaseTiming {
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  avg: number
}

/** Per-model token totals and estimated cost at static API list prices. */
export interface ModelCostBreakdown {
  requests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Estimated USD for this model's requests; null when the model has no pricing entry */
  estimatedUsd: number | null
}

/** Aggregate cost estimate across a window. Estimates only: Claude Max
 *  usage is covered by the subscription; this is the equivalent API cost. */
export interface CostEstimate {
  /** Sum across all priced models (unpriced models excluded) */
  totalUsd: number
  /** Keyed by requestModel || model, matching TelemetrySummary.byModel */
  byModel: Record<string, ModelCostBreakdown>
  /** Requests whose model had no pricing entry, excluded from totalUsd */
  unpricedRequestCount: number
  /** Per-profile rollup (multi-account): estimated USD + request count.
   *  Keyed by RequestMetric.profileId, "default" when absent. */
  byProfile: Record<string, { requests: number; estimatedUsd: number }>
}

/** What one account did in a window. */
export interface RouteProfileTally {
  /** Requests this account answered. */
  served: number
  /** Attempts this account refused, including the ones a failover hid from
   *  the client — those never reach it as an error, so nothing else counts them. */
  refused: number
  /** Refusals by allowance ("five_hour", "seven_day_opus", …), for the ones
   *  Anthropic attributed to a window. Sums to at most `refused`. */
  refusedBuckets: Record<string, number>
}

/**
 * Where a window's requests went and which accounts refused them.
 *
 * DERIVED at read time from collapsed rows (telemetry/routeChain.ts) — nothing
 * here is stored, and nothing is computed for it on the request path.
 */
export interface RouteSummary {
  /** Client requests in the window. A failover counts ONCE, not once per hop. */
  requests: number
  /** Requests that touched more than one account before being answered. */
  failedOver: number
  /** Requests no account answered — the client received the refusal. */
  unserved: number
  /** How the account was chosen, keyed by RouteKind. */
  byKind: Record<string, number>
  /** Per-account tally, keyed by profileId ("default" when a row carried none). */
  byProfile: Record<string, RouteProfileTally>
}

export interface TelemetrySummary {
  /** Time window these stats cover */
  windowMs: number
  /** Total requests in the window */
  totalRequests: number
  /** Requests that returned an error */
  errorCount: number
  /** Total envelope-integrity violations across the window (dangling blocks,
   *  undelivered tool calls, empty required inputs). 0 = wire contract clean. */
  envelopeViolationCount: number
  /** Requests per minute */
  requestsPerMinute: number

  /** Timing breakdowns by phase */
  queueWait: PhaseTiming
  sessionQueueWait: PhaseTiming
  sdkQueueWait: PhaseTiming
  proxyOverhead: PhaseTiming
  ttfb: PhaseTiming
  upstreamDuration: PhaseTiming
  totalDuration: PhaseTiming

  /** Breakdown by model */
  byModel: Record<string, { count: number; avgTotalMs: number }>
  /** Breakdown by mode */
  byMode: Record<string, { count: number; avgTotalMs: number }>

  /** Aggregate token usage across all requests in the window */
  tokenUsage: {
    totalInputTokens: number
    totalOutputTokens: number
    totalCacheReadTokens: number
    totalCacheCreationTokens: number
    avgCacheHitRate: number
    /** Requests where cache hit rate was 0 despite being a resume */
    cacheMissOnResumeCount: number
  }

  /** Estimated cost of the window's usage at static API list prices */
  costEstimate: CostEstimate
}

/**
 * The telemetry configuration that WOULD be used if the proxy started now.
 *
 * Distinct from TelemetryRetention, which describes the store that is actually
 * running, and the pair only agrees until somebody edits a setting: the stores
 * are built once at startup, so this is the intent and that is the fact.
 * Comparing the two is how a settings page knows to say "restart to apply"
 * instead of implying a change already took effect.
 */
export interface ResolvedTelemetryConfig {
  persist: boolean
  /** Where SQLite would write. Meaningful only when `persist`. */
  dbPath: string
  /** Days before a persisted row is deleted. Meaningful only when `persist`. */
  retentionDays: number
  /** Rows the metric ring would hold. Meaningful only when NOT `persist`. */
  telemetrySize: number
  /** Entries the diagnostic ring would hold. Meaningful only when NOT `persist`. */
  diagnosticLogSize: number
}

/**
 * What the store actually holds, so a page can say so instead of implying it
 * holds everything.
 *
 * The dashboard offers a 24-hour window against a ring buffer that is under an
 * hour of traffic at a working pace, and shows the difference nowhere: the page
 * looks the same whether a window is empty because nothing happened or because
 * the rows were overwritten. Reading the source is not an acceptable way to
 * learn which.
 */
export interface TelemetryRetention {
  /** "memory" is lost on restart; "sqlite" survives it. */
  kind: "memory" | "sqlite"
  /** Rows held right now. */
  held: number
  /** Ring capacity — the oldest row is dropped past this (memory only). */
  capacity?: number
  /** Days before cleanup deletes a row (sqlite only). */
  retentionDays?: number
  /** Database file and its size on disk, WAL included (sqlite only). */
  dbPath?: string
  dbBytes?: number
  /**
   * Timestamp of the oldest row held, null when empty.
   *
   * This is the honest bound on every window the page offers: a window
   * reaching further back than this shows less than it names, whether because
   * rows were evicted or because the proxy has not been up that long.
   */
  oldestTimestamp: number | null
}

/** Storage backend for request metrics. */
export interface ITelemetryStore {
  /** Record a completed request metric. */
  record(metric: RequestMetric): void
  /** Number of stored metrics. */
  readonly size: number
  /** What this store holds and for how long — see TelemetryRetention. */
  describe(): TelemetryRetention
  /** Retrieve recent metrics, newest first. */
  getRecent(options?: {
    limit?: number
    since?: number
    model?: string
  }): RequestMetric[]
  /** Find the latest successful metric for a given SDK session. */
  getLastForSession(sdkSessionId: string): RequestMetric | undefined
  /** Compute aggregate statistics over a time window. */
  summarize(windowMs?: number): TelemetrySummary
  /** Clear all stored metrics. */
  clear(): void
}

/** Diagnostic log entry. */
export interface DiagnosticLog {
  /** Unix timestamp */
  timestamp: number
  /** Log level */
  level: "info" | "warn" | "error"
  /** Log category for filtering */
  category: "session" | "lineage" | "error" | "lifecycle" | "token"
  /** Request ID (if associated with a request) */
  requestId?: string
  /** Human-readable message */
  message: string
}

/** Storage backend for diagnostic logs. */
export interface IDiagnosticLogStore {
  /** Append a log entry (timestamp is added automatically). */
  log(entry: Omit<DiagnosticLog, "timestamp">): void
  /** Log a session event. */
  session(message: string, requestId?: string): void
  /** Log a lineage event (compaction, undo, diverged). */
  lineage(message: string, requestId?: string): void
  /** Log an error. */
  error(message: string, requestId?: string): void
  /** Retrieve recent logs, newest first. */
  getRecent(options?: {
    limit?: number
    since?: number
    category?: string
  }): DiagnosticLog[]
  /** Clear all stored logs. */
  clear(): void
}
