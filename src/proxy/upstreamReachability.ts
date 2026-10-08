/**
 * Whether Anthropic can be reached from this host at all, learned passively
 * from the traffic Meridian already carries.
 *
 * The failure this exists for: a host whose resolver died while its network
 * stayed up. Meridian kept answering HTTP and `/readyz` stayed green, so a load
 * balancer in front of two instances kept sending this one half the traffic,
 * and every request spent the CLI's whole retry budget before failing with
 * "API Error: Can't reach the API server". The instance could not serve, and
 * nothing it published said so.
 *
 * Only CONNECTION-class failures count against reachability: DNS, refused,
 * reset, unroutable, connect timeouts, TLS and proxy tunnel failures. A 429,
 * an auth refusal, a billing cap or a model error never do, and one that
 * proves Anthropic answered - a quota or billing refusal, any API error that
 * carries an HTTP status - counts as reaching it, which is also why one
 * account succeeding keeps the instance reachable however many others fail.
 *
 * Nothing here sends a request of its own. The conclusion is drawn from real
 * requests, and the way back from it is a real request too: after a hold the
 * state turns to `probing`, readiness passes again, and the next request
 * either reaches Anthropic (back to `ok`) or fails the same way (straight back
 * to `unreachable`, without waiting out another detection window).
 */

import { env } from "../env"
import { loadSettings } from "../settings"

export type ConnectionFailureKind =
  | "dns"
  | "refused"
  | "reset"
  | "unroutable"
  | "timeout"
  | "tls"
  | "proxy"
  | "connection"

export type ReachabilityState = "ok" | "unreachable" | "probing"

export interface ReachabilityThresholds {
  /** Minimum span between the first and the latest failure of a run before
   *  the run counts as an outage rather than a blip. */
  readonly unreachableAfterMs: number
  /** How long `unreachable` holds after the latest failure before readiness
   *  passes again so a real request can test the way back. 0 never holds. */
  readonly holdMs: number
  /** Failures a run needs, however long it lasted. */
  readonly minFailures: number
}

export const DEFAULT_REACHABILITY_THRESHOLDS: ReachabilityThresholds = {
  unreachableAfterMs: 120_000,
  holdMs: 300_000,
  minFailures: 3,
}

/** Bounds for a forced state, so a forgotten test override expires. */
export const DEFAULT_OVERRIDE_TTL_MS = 600_000
export const MAX_OVERRIDE_TTL_MS = 86_400_000

const CODE_KINDS: Readonly<Record<string, ConnectionFailureKind>> = {
  enotfound: "dns",
  eai_again: "dns",
  failedtoopensocket: "dns",
  econnrefused: "refused",
  connectionrefused: "refused",
  econnreset: "reset",
  epipe: "reset",
  econnaborted: "reset",
  connectionclosed: "reset",
  err_socket_closed: "reset",
  und_err_socket: "reset",
  enetunreach: "unroutable",
  enetdown: "unroutable",
  ehostunreach: "unroutable",
  ehostdown: "unroutable",
  etimedout: "timeout",
  und_err_connect_timeout: "timeout",
  err_proxy_tunnel: "proxy",
}

/**
 * The CLI's connection errors, in the wording it actually prints.
 *
 * Every terminal API error the CLI reports starts with its own `API Error:`
 * prefix (verified against claude-code 2.1.284, whose formatter emits all the
 * phrases below, and the older wordings the bundled SDK CLI still uses). The
 * prefix is REQUIRED, at the start of a line after the known wrappers, because
 * this classification can take a whole instance out of a load balancer: an MCP
 * server's stderr saying "connection refused" about its own database, or an
 * assistant turn quoting the phrase, must not count. The same reason the quota
 * patterns in errors.ts are line-anchored.
 */
const API_ERROR_LINE = String.raw`(?:^|\n)[ \t]*(?:(?:error|claude code returned an error result|subprocess stderr):[ \t]*)*api error:[ \t]*`
/** The first `(CODE)` later on the same line, when there is one. */
const CODE = String.raw`(?:[^\n]*?\(([a-z0-9_]+)\))?`
const CONNECTION_PHRASES: ReadonlyArray<{ readonly pattern: RegExp; readonly kind: ConnectionFailureKind }> = [
  // 2.1.284: ENOTFOUND, EAI_AGAIN, FailedToOpenSocket.
  { pattern: new RegExp(API_ERROR_LINE + String.raw`can't reach the api server\b` + CODE), kind: "dns" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`connection refused\b` + CODE), kind: "refused" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`connection dropped\b` + CODE), kind: "reset" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`no internet route\b` + CODE), kind: "unroutable" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`couldn't connect through your proxy\b` + CODE), kind: "proxy" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`unable to connect to api: (?:ssl|self-signed)`), kind: "tls" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`request timed out\. check your internet connection`), kind: "timeout" },
  // The code-only fallback, and the older wordings without a code.
  { pattern: new RegExp(API_ERROR_LINE + String.raw`unable to connect to api` + CODE), kind: "connection" },
  { pattern: new RegExp(API_ERROR_LINE + String.raw`connection error\.?[ \t]*(?:\n|$)`), kind: "connection" },
]

/**
 * The kind of connection failure an SDK error or API error text reports, or
 * null when it reports anything else.
 *
 * A bare "Request timed out." is deliberately NOT here: the CLI says that when
 * a request got no answer in time, which is a slow upstream rather than an
 * unreachable one. Only its connect-timeout wording, which tells the user to
 * check their connection, counts.
 */
export function classifyConnectionFailure(text: string | null | undefined): ConnectionFailureKind | null {
  if (typeof text !== "string" || text.length === 0) return null
  const lower = text.toLowerCase().replace(/\u2019/g, "'")
  for (const { pattern, kind } of CONNECTION_PHRASES) {
    const match = pattern.exec(lower)
    if (!match) continue
    const code = match[1]
    return (code && CODE_KINDS[code]) || kind
  }
  return null
}

/** An `API Error:` line that opens with an HTTP status (`API Error: 400 ...`).
 *  Only a response carries one; a connection error never does. */
const HTTP_STATUS_LINE = new RegExp(API_ERROR_LINE + String.raw`[1-5]\d\d(?!\d)`)

/** Whether an SDK error or API error text reports an HTTP response, which
 *  means the API answered, whatever the answer was. */
export function answeredOverHttp(text: string | null | undefined): boolean {
  return typeof text === "string" && HTTP_STATUS_LINE.test(text.toLowerCase())
}

/**
 * SDK assistant-error tags that only an HTTP response can produce. Seeing one
 * proves Anthropic was reached, whatever it said. `invalid_request`,
 * `authentication_failed` and `unknown` are left out: the CLI also raises
 * those for problems it detects locally, before any request leaves the host.
 * When one of them did come from the API, its text carries the HTTP status,
 * which answeredOverHttp reads instead.
 */
const HTTP_BACKED_ASSISTANT_ERRORS: ReadonlySet<string> = new Set([
  "rate_limit",
  "billing_error",
  "server_error",
  "oauth_org_not_allowed",
])

/** What one SDK message says about reachability. */
export type ReachabilityEvidence =
  | { readonly kind: "reached" }
  | { readonly kind: "failure"; readonly failure: ConnectionFailureKind; readonly terminal: boolean }
  | null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function assistantText(message: Record<string, unknown>): string {
  const inner = message.message
  if (!isRecord(inner) || !Array.isArray(inner.content)) return ""
  return inner.content
    .map(block => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("\n")
}

/**
 * Read one message of the SDK stream for reachability evidence.
 *
 * - `system/api_retry` is the CLI announcing it will retry. With no HTTP status
 *   it is a connection error (the SDK documents `error_status: null` as
 *   exactly that); with one, Anthropic answered. It arrives on the first failed
 *   attempt, so an outage is visible within seconds instead of after the CLI
 *   has spent its whole retry budget on one request.
 * - `stream_event` `message_start` and a real assistant message are Anthropic
 *   answering. A long stream that started before an outage keeps sending
 *   deltas over its open connection, so deltas are not counted - only a
 *   response starting is.
 * - An assistant message carrying `error` is the CLI's terminal report. Its
 *   text says which connection failure it was; otherwise an HTTP status in
 *   the text, or an HTTP-backed tag, proves Anthropic answered.
 */
export function reachabilityEvidence(message: unknown): ReachabilityEvidence {
  if (!isRecord(message)) return null
  if (message.type === "system" && message.subtype === "api_retry") {
    if (typeof message.error_status === "number") return { kind: "reached" }
    if (message.error_status === null) return { kind: "failure", failure: "connection", terminal: false }
    return null
  }
  if (message.type === "stream_event") {
    return isRecord(message.event) && message.event.type === "message_start" ? { kind: "reached" } : null
  }
  if (message.type !== "assistant") return null
  if (typeof message.error === "string") {
    const text = assistantText(message)
    const failure = classifyConnectionFailure(text)
    if (failure) return { kind: "failure", failure, terminal: true }
    return answeredOverHttp(text) || HTTP_BACKED_ASSISTANT_ERRORS.has(message.error) ? { kind: "reached" } : null
  }
  const inner = message.message
  if (!isRecord(inner) || inner.model === "<synthetic>") return null
  return Array.isArray(inner.content) && inner.content.length > 0 ? { kind: "reached" } : null
}

export interface ReachabilitySnapshot {
  readonly state: ReachabilityState
  /** When the current state began. */
  readonly since: string
  /** First connection failure since Anthropic last answered; null when it
   *  answered most recently. */
  readonly failingSince: string | null
  readonly consecutiveFailures: number
  readonly lastReachedAt: string | null
  readonly lastFailureAt: string | null
  readonly lastErrorKind: ConnectionFailureKind | null
  /** While `unreachable`: when it turns to `probing` absent another failure. */
  readonly holdUntil: string | null
  readonly override: { readonly state: "unreachable" | "ok"; readonly until: string } | null
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString()
}

function nonNegativeInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined
}

/**
 * Thresholds from the environment, then settings.json, then the defaults. Read
 * per evaluation, like routing, so a changed setting applies without a restart.
 * A value that is not a non-negative integer is ignored rather than guessed at,
 * and a run always needs at least one failure.
 */
export function resolveReachabilityThresholds(
  readEnv: (suffix: string) => string | undefined = env,
  readSettings: () => Record<string, unknown> | null = () => loadSettings() as Record<string, unknown> | null,
): ReachabilityThresholds {
  // A settings.json holding `null` parses to null; /health must still answer.
  const settings = readSettings() ?? {}
  const pick = (envSuffix: string, settingKey: string, fallback: number) =>
    nonNegativeInt(readEnv(envSuffix)) ?? nonNegativeInt(settings[settingKey]) ?? fallback
  return {
    unreachableAfterMs: pick("UPSTREAM_UNREACHABLE_AFTER_MS", "upstreamUnreachableAfterMs", DEFAULT_REACHABILITY_THRESHOLDS.unreachableAfterMs),
    holdMs: pick("UPSTREAM_UNREACHABLE_HOLD_MS", "upstreamUnreachableHoldMs", DEFAULT_REACHABILITY_THRESHOLDS.holdMs),
    minFailures: Math.max(1, pick("UPSTREAM_UNREACHABLE_MIN_FAILURES", "upstreamUnreachableMinFailures", DEFAULT_REACHABILITY_THRESHOLDS.minFailures)),
  }
}

/**
 * One upstream's reachability. Every timestamp comes from the injected clock,
 * so the state machine is testable without waiting minutes.
 */
export class UpstreamReachability {
  private lastReachedAt: number | null = null
  private lastFailureAt: number | null = null
  private lastErrorKind: ConnectionFailureKind | null = null
  private failingSince: number | null = null
  private consecutiveFailures = 0
  /** When the current unreachable episode began; null outside one. */
  private unreachableSince: number | null = null
  private okSince: number
  private forced: { state: "unreachable" | "ok"; until: number } | null = null

  constructor(
    private clock: () => number = Date.now,
    private thresholds: () => ReachabilityThresholds = resolveReachabilityThresholds,
  ) {
    this.okSince = clock()
  }

  /** Anthropic answered something. Any state returns to `ok` at once. */
  recordReached(): void {
    const now = this.clock()
    if (this.failingSince !== null) this.okSince = now
    this.lastReachedAt = now
    this.failingSince = null
    this.consecutiveFailures = 0
    this.unreachableSince = null
  }

  recordFailure(kind: ConnectionFailureKind): void {
    const now = this.clock()
    const { unreachableAfterMs, holdMs, minFailures } = this.thresholds()
    const wasProbing = this.unreachableSince !== null
      && this.lastFailureAt !== null
      && now - this.lastFailureAt >= holdMs
    this.lastFailureAt = now
    this.lastErrorKind = kind
    this.failingSince ??= now
    this.consecutiveFailures += 1
    if (this.unreachableSince !== null) {
      // Still failing after the hold let traffic back in: the probe answered,
      // so the state flips back now rather than after another detection window.
      if (wasProbing) this.unreachableSince = now
      return
    }
    if (this.consecutiveFailures >= minFailures && now - this.failingSince >= unreachableAfterMs) {
      this.unreachableSince = now
    }
  }

  /** Force a state for testing a load balancer, for at most `ttlMs`. */
  force(state: "unreachable" | "ok", ttlMs: number = DEFAULT_OVERRIDE_TTL_MS): void {
    this.forced = { state, until: this.clock() + ttlMs }
  }

  clearOverride(): void {
    this.forced = null
  }

  snapshot(): ReachabilitySnapshot {
    const now = this.clock()
    if (this.forced && this.forced.until <= now) this.forced = null
    const { holdMs } = this.thresholds()
    let state: ReachabilityState = "ok"
    let since = this.okSince
    let holdUntil: number | null = null
    if (this.unreachableSince !== null && this.lastFailureAt !== null) {
      const holdEnds = this.lastFailureAt + holdMs
      if (now >= holdEnds) {
        state = "probing"
        since = Math.max(holdEnds, this.unreachableSince)
      } else {
        state = "unreachable"
        since = this.unreachableSince
        holdUntil = holdEnds
      }
    }
    if (this.forced) state = this.forced.state
    return {
      state,
      since: iso(since)!,
      failingSince: iso(this.failingSince),
      consecutiveFailures: this.consecutiveFailures,
      lastReachedAt: iso(this.lastReachedAt),
      lastFailureAt: iso(this.lastFailureAt),
      lastErrorKind: this.lastErrorKind,
      holdUntil: this.forced ? null : iso(holdUntil),
      override: this.forced ? { state: this.forced.state, until: iso(this.forced.until)! } : null,
    }
  }

  /** Test seam: a fresh tracker on another clock and thresholds. */
  resetForTests(clock: () => number = Date.now, thresholds: () => ReachabilityThresholds = resolveReachabilityThresholds): void {
    this.clock = clock
    this.thresholds = thresholds
    this.lastReachedAt = null
    this.lastFailureAt = null
    this.lastErrorKind = null
    this.failingSince = null
    this.consecutiveFailures = 0
    this.unreachableSince = null
    this.okSince = clock()
    this.forced = null
  }
}

/**
 * One SDK attempt's view of the tracker. The CLI reports a terminal connection
 * failure twice - as an assistant error message and again as the thrown error
 * that ends the attempt - so the thrown one is counted only when the message
 * never arrived.
 */
export function observeReachability(tracker: UpstreamReachability) {
  let terminalRecorded = false
  return {
    message(message: unknown): void {
      const evidence = reachabilityEvidence(message)
      if (!evidence) return
      if (evidence.kind === "reached") {
        tracker.recordReached()
        return
      }
      if (evidence.terminal) terminalRecorded = true
      tracker.recordFailure(evidence.failure)
    },
    error(error: unknown): void {
      const text = error instanceof Error ? error.message : String(error)
      if (answeredOverHttp(text)) {
        tracker.recordReached()
        return
      }
      if (terminalRecorded) return
      const failure = classifyConnectionFailure(text)
      if (failure) tracker.recordFailure(failure)
    },
  }
}

/** Pass an SDK stream through unchanged while the tracker reads it. */
export async function* withReachability<T>(source: AsyncIterable<T>, tracker: UpstreamReachability): AsyncGenerator<T> {
  const observer = observeReachability(tracker)
  try {
    for await (const message of source) {
      observer.message(message)
      yield message
    }
  } catch (error) {
    observer.error(error)
    throw error
  }
}

/**
 * The Claude upstream, process-wide: reachability is a property of the host,
 * so every server instance in the process reads and feeds the same one.
 */
export const claudeReachability = new UpstreamReachability()

/** The readiness line for an unreachable upstream; null when it may serve. */
export function unreachableDetail(snapshot: ReachabilitySnapshot): string | null {
  if (snapshot.state !== "unreachable") return null
  if (snapshot.override?.state === "unreachable") return `forced unreachable by override until ${snapshot.override.until}`
  const failures = `${snapshot.consecutiveFailures} connection failure${snapshot.consecutiveFailures === 1 ? "" : "s"}`
  return `Anthropic unreachable since ${snapshot.failingSince ?? snapshot.since} (last error: ${snapshot.lastErrorKind ?? "connection"}, ${failures}, last answered ${snapshot.lastReachedAt ?? "never"})`
}
