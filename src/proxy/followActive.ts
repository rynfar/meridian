/**
 * Follow-the-active-profile mode — `MERIDIAN_FOLLOW_ACTIVE`.
 *
 * Makes a development instance take its active profile from ANOTHER Meridian
 * instance instead of from its own `settings.json`, so the two serve from the
 * same account and a side-by-side comparison is like-for-like.
 *
 * The problem it solves: `MERIDIAN_CONFIG_DIR` relocates `settings.json` and
 * nothing else, so a second instance keeps its own `activeProfile`. Whatever
 * moves the primary's active profile — a UI click, the CLI, an external fleet
 * scheduler — has no effect on the second instance, which quietly serves from
 * a different account. Measured on one box: the primary was on one profile
 * while the dev instance served the same instant from another.
 *
 * What this changes: exactly ONE input to `resolveProfile` — the active
 * profile. The precedence chain around it is untouched, so an explicit
 * `x-meridian-profile` header still wins, and sticky/priority routing behave
 * as they always did (priority mode does not consult the active profile at
 * all for unpinned requests, so follow mode is a no-op there).
 *
 * Degradation is the design constraint, not an afterthought. The followed
 * instance is polled in the background and the last good value is cached; the
 * request path never waits on the network. If the followed instance is down,
 * slow, or answers rubbish, the last known value keeps being served — and if
 * there has never been a good value, the local active profile is used. A dev
 * convenience must not be able to take an instance offline.
 *
 * Leaf module — no imports from server.ts, session/ or profiles.ts.
 */

import { env } from "../env"

/**
 * Poll cadence. The followed value changes on the order of minutes (a human
 * clicking, or a scheduler rotating accounts), so a fetch per request would be
 * absurd; 10s bounds the divergence window without making the followed
 * instance do meaningful work — `/profiles/list` serves its auth status from a
 * 60s cache that the instance's own 45s keepalive already keeps warm.
 */
export const FOLLOW_POLL_INTERVAL_MS = 10_000

/** Per-poll timeout. Short: a slow followed instance must not accumulate polls. */
export const FOLLOW_FETCH_TIMEOUT_MS = 2_000

/**
 * How long a value may go unconfirmed before it is REPORTED stale.
 *
 * Staleness deliberately does not change routing. Falling back to the local
 * value after a timeout would silently split the comparison exactly when you
 * are least likely to notice, and the local value is not more correct — it is
 * just different. A stale-but-known followed value remains the best available
 * answer to "what is the primary on?"; the dev instance's own `activeProfile`
 * is arbitrary. So a stale value is still followed, and is flagged as stale
 * everywhere the mode is surfaced.
 */
export const FOLLOW_STALE_AFTER_MS = 120_000

/** Longest plausible profile id — a defence against a garbage response body. */
const MAX_PROFILE_ID_LENGTH = 128

// --- Pure: configuration parsing ------------------------------------------

export type FollowTarget =
  | { kind: "off" }
  | { kind: "on"; url: string }
  | { kind: "invalid"; raw: string; message: string }

/**
 * Parse the env var value into a normalized base URL.
 *
 * A bare `host:port` is accepted and assumed to be http, because that is what
 * anyone types first and `new URL()` would otherwise read `127.0.0.1` as a
 * scheme. Trailing slashes are stripped so callers can concatenate paths.
 *
 * A malformed value yields "invalid" rather than throwing: the caller warns
 * and runs without follow mode. Refusing to start on a typo would take an
 * instance offline, which is the one outcome this feature must never cause.
 */
export function parseFollowTarget(raw: string | undefined): FollowTarget {
  const trimmed = raw?.trim()
  if (!trimmed) return { kind: "off" }
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withScheme)
  } catch {
    return { kind: "invalid", raw: trimmed, message: "not a URL" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { kind: "invalid", raw: trimmed, message: `unsupported scheme "${parsed.protocol}"` }
  }
  if (!parsed.hostname) {
    return { kind: "invalid", raw: trimmed, message: "no host" }
  }
  return { kind: "on", url: `${parsed.protocol}//${parsed.host}` }
}

/** Loopback spellings that all mean "this machine". */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "[::]"])

/**
 * Whether a follow target addresses the instance doing the following.
 *
 * Self-follow is a deadlock, not a harmless no-op: the instance would follow
 * its own active profile (so the value never changes) while refusing local
 * writes (so nothing can change it), leaving the profile frozen forever. It is
 * also the realistic typo — copying the wrong port out of a unit file.
 */
export function isSelfTarget(url: string, selfHost: string, selfPort: number): boolean {
  const target = parseFollowTarget(url)
  if (target.kind !== "on") return false
  const parsed = new URL(target.url)
  const targetPort = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80
  if (targetPort !== selfPort) return false
  const targetHost = parsed.hostname.toLowerCase()
  const ownHost = selfHost.toLowerCase()
  if (targetHost === ownHost) return true
  return LOOPBACK_HOSTS.has(targetHost) && LOOPBACK_HOSTS.has(ownHost)
}

// --- Pure: response reading -----------------------------------------------

/**
 * Extract `activeProfile` from a `/profiles/list` body.
 *
 * Deliberately paranoid about the shape. The followed instance may be a
 * different version, a different program listening on a recycled port, or an
 * error page — "answers rubbish" is one of the failure modes this must
 * survive, and a non-string or absurdly long value must be treated as no
 * value at all rather than routed to.
 */
export function readActiveProfile(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const value = (body as { activeProfile?: unknown }).activeProfile
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PROFILE_ID_LENGTH) return undefined
  return trimmed
}

// --- Pure: the decision ---------------------------------------------------

export interface FollowState {
  /** Last value successfully read, and when it was last CONFIRMED by a poll. */
  lastGood?: { profileId: string; at: number }
  /** When the most recent poll completed, successful or not. */
  lastPollAt?: number
  /** Most recent poll failure. Cleared on the next success. */
  lastError?: { message: string; at: number }
}

export type FollowOutcome =
  | { follow: true; profileId: string; stale: boolean }
  | { follow: false; reason: "no-value" | "unknown-profile"; followedValue?: string }

/**
 * Decide whether the followed value should be used, given what this instance
 * actually has. Pure — the whole point is that every branch is testable
 * without a second instance running.
 *
 * `unknown-profile` is a fallback, not a resolution: routing to a profile this
 * instance does not have would resolve to "first configured profile" deeper in
 * `resolveProfile` and silently serve from an unrelated account. Using the
 * local choice and saying so is the smaller surprise.
 */
export function decideFollowedProfile(
  state: FollowState,
  availableIds: readonly string[],
  now: number,
  staleAfterMs: number = FOLLOW_STALE_AFTER_MS,
): FollowOutcome {
  const good = state.lastGood
  // No good value yet — the followed instance has been unreachable (or has
  // answered rubbish) for this instance's entire lifetime.
  if (!good) return { follow: false, reason: "no-value" }
  if (!availableIds.includes(good.profileId)) {
    return { follow: false, reason: "unknown-profile", followedValue: good.profileId }
  }
  return { follow: true, profileId: good.profileId, stale: now - good.at >= staleAfterMs }
}

// --- Stateful: configuration, cache, polling ------------------------------

let cachedRaw: string | undefined
let cachedTarget: FollowTarget = { kind: "off" }
let warnedInvalid: string | undefined
let disabledReason: string | undefined
let state: FollowState = {}
let pollTimer: ReturnType<typeof setInterval> | undefined
let bannerLogged = false
let errorLogged = false

/**
 * The followed instance's base URL, or undefined when not following.
 *
 * Resolved per call rather than frozen at import time, matching `settings.ts`'s
 * treatment of MERIDIAN_CONFIG_DIR — a value captured at import would be fixed
 * before any test (or embedding host) could set it. Parsing is memoized on the
 * raw string so the request path does not build a URL object per call.
 */
export function followTarget(): { url: string } | undefined {
  if (disabledReason) return undefined
  const raw = env("FOLLOW_ACTIVE")
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cachedTarget = parseFollowTarget(raw)
  }
  if (cachedTarget.kind === "invalid") {
    if (warnedInvalid !== cachedTarget.raw) {
      warnedInvalid = cachedTarget.raw
      console.warn(
        `[PROXY] MERIDIAN_FOLLOW_ACTIVE="${cachedTarget.raw}" is not usable (${cachedTarget.message}). ` +
        `Expected a Meridian base URL, e.g. http://127.0.0.1:3456. Follow mode is OFF; ` +
        `this instance uses its own active profile.`
      )
    }
    return undefined
  }
  return cachedTarget.kind === "on" ? { url: cachedTarget.url } : undefined
}

/** Whether this instance takes its active profile from another one. */
export function isFollowEnabled(): boolean {
  return followTarget() !== undefined
}

/**
 * The follow decision for a given profile list, or undefined when not
 * following. Called on the request path — synchronous, cache-only, no I/O.
 */
export function followedActiveProfile(availableIds: readonly string[]): FollowOutcome | undefined {
  if (!isFollowEnabled()) return undefined
  return decideFollowedProfile(state, availableIds, Date.now())
}

/** Follow state as surfaced by `/profiles/list`. Undefined when not following. */
export interface FollowStatus {
  /** Base URL of the followed instance. */
  url: string
  /** Value actually in effect, or null when falling back to the local one. */
  activeProfile: string | null
  /** Last value read from the followed instance, even if unusable here. */
  followedValue: string | null
  /** Why the followed value is not in effect, when it isn't. */
  reason: "no-value" | "unknown-profile" | null
  /** Followed value has not been confirmed recently — still in effect. */
  stale: boolean
  /** When the followed value was last confirmed. */
  lastSyncedAt: number | null
  /** Most recent poll failure, if the last poll failed. */
  lastError: string | null
}

export function followStatus(availableIds: readonly string[]): FollowStatus | undefined {
  const target = followTarget()
  if (!target) return undefined
  const outcome = decideFollowedProfile(state, availableIds, Date.now())
  return {
    url: target.url,
    activeProfile: outcome.follow ? outcome.profileId : null,
    followedValue: state.lastGood?.profileId ?? null,
    reason: outcome.follow ? null : outcome.reason,
    stale: outcome.follow ? outcome.stale : false,
    lastSyncedAt: state.lastGood?.at ?? null,
    lastError: state.lastError?.message ?? null,
  }
}

/**
 * Read the followed instance's active profile once and update the cache.
 *
 * Never throws and never clears a good value on failure: a failed poll leaves
 * the last known value in place, which is what "degrade, never fail" means
 * here. Exported so tests can drive it without a timer.
 */
export async function pollFollowedActiveProfile(): Promise<void> {
  const target = followTarget()
  if (!target) return
  const now = Date.now()
  try {
    const res = await fetch(`${target.url}/profiles/list`, {
      signal: AbortSignal.timeout(FOLLOW_FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const value = readActiveProfile(await res.json())
    if (!value) throw new Error("response carried no usable activeProfile")
    const previous = state.lastGood?.profileId
    state = { lastGood: { profileId: value, at: now }, lastPollAt: now }
    // Log transitions only. A line per poll would be 8,640 lines a day; the
    // interesting events are "we picked up a change" and "we recovered".
    if (previous !== value) {
      console.warn(
        `[PROXY] Active profile now following "${value}" from ${target.url}` +
        (previous ? ` (was "${previous}")` : "")
      )
    } else if (errorLogged) {
      console.warn(`[PROXY] Recovered contact with ${target.url}; still following "${value}".`)
    }
    errorLogged = false
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state = { ...state, lastPollAt: now, lastError: { message, at: now } }
    if (!errorLogged) {
      errorLogged = true
      console.warn(
        `[PROXY] Could not read the active profile from ${target.url} (${message}). ` +
        (state.lastGood
          ? `Continuing on the last known value "${state.lastGood.profileId}".`
          : `No value has ever been read; using this instance's own active profile.`)
      )
    }
  }
}

/**
 * Arm the background poll. Idempotent.
 *
 * `self` is the address this instance actually bound (the configured port may
 * be 0), used only for the self-follow guard.
 */
export function startFollowPolling(self?: { host: string; port: number }): void {
  if (pollTimer) return
  const target = followTarget()
  if (!target) return
  if (self && isSelfTarget(target.url, self.host, self.port)) {
    disabledReason =
      `MERIDIAN_FOLLOW_ACTIVE (${target.url}) points at this instance's own address. ` +
      `Following yourself would freeze the active profile permanently — the followed value ` +
      `could never change and local switching would be refused. Follow mode is OFF.`
    console.warn(`[PROXY] ${disabledReason}`)
    return
  }
  void pollFollowedActiveProfile()
  pollTimer = setInterval(() => { void pollFollowedActiveProfile() }, FOLLOW_POLL_INTERVAL_MS)
  if (pollTimer.unref) pollTimer.unref()
}

/** Stop the background poll. Idempotent. */
export function stopFollowPolling(): void {
  if (!pollTimer) return
  clearInterval(pollTimer)
  pollTimer = undefined
}

/**
 * Announce the mode once at startup.
 *
 * Not gated on `silent`, matching the treatment of other non-default operating
 * modes: MERIDIAN_SILENT suppresses routine chatter, and this is not routine —
 * it changes where a core piece of this instance's state comes from. An
 * instance silently following another is exactly the hour-long confusion this
 * line exists to prevent.
 *
 * @param routingMode current routing mode, so the one combination where follow
 *   mode does nothing useful says so instead of being discovered the hard way.
 */
export function logFollowBanner(routingMode?: string): void {
  if (bannerLogged) return
  const target = followTarget()
  if (!target) return
  bannerLogged = true
  console.warn(
    `[PROXY] FOLLOWING ACTIVE PROFILE (MERIDIAN_FOLLOW_ACTIVE=${target.url}): ` +
    `this instance takes its active profile from ${target.url}, not from its own settings. ` +
    `Local switching is refused; the x-meridian-profile header still overrides per request.`
  )
  if (routingMode === "priority") {
    console.warn(
      `[PROXY] Routing is "priority", which dispatches unpinned requests across the pool ` +
      `without consulting the active profile — follow mode will have no visible effect on them.`
    )
  }
}

/** Reset all module state — for testing only. */
export function resetFollowActive(): void {
  stopFollowPolling()
  cachedRaw = undefined
  cachedTarget = { kind: "off" }
  warnedInvalid = undefined
  disabledReason = undefined
  state = {}
  bannerLogged = false
  errorLogged = false
}

/** Seed the cache directly — for testing only. */
export function setFollowStateForTesting(next: FollowState): void {
  state = next
}
