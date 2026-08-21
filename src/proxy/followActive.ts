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

// --- Pure: the roster -----------------------------------------------------

/** Longest plausible credential directory — a defence against a garbage body. */
const MAX_CREDENTIAL_DIR_LENGTH = 4_096

/** A profile the followed instance has, and where its credentials live. */
export interface FollowedProfile {
  id: string
  /** Absolute CLAUDE_CONFIG_DIR, on a filesystem both instances can read. */
  credentialDir: string
}

export interface FollowedRoster {
  /** Profiles this instance can serve by pointing at the same directory. */
  adoptable: FollowedProfile[]
  /** Profiles it cannot, because their credentials are an inline secret. */
  unadoptable: string[]
}

/**
 * Extract the profile roster from a `/profiles/list` body.
 *
 * Following one scalar is not enough. `MERIDIAN_CONFIG_DIR` gives a second
 * instance its own `profiles.json` — that is the whole point of it — so the
 * two rosters diverge the moment an account is added to either. The followed
 * value then names a profile this instance does not have, `decideFollowedProfile`
 * returns "unknown-profile", and the dev instance serves from an unrelated
 * account: exactly the divergence follow mode exists to prevent. Measured on
 * one box, a profile added to the primary was still absent from the follower
 * minutes later, and its traffic 429'd against the wrong account.
 *
 * Adoptability is decided by the SENDER, which is the only side that can. A
 * profile authenticated by a file both instances can read crosses as a path; a
 * profile authenticated by an inline API key or OAuth token cannot cross at
 * all, because the secret must not leave the process that holds it. The sender
 * reports the second kind by id alone so this instance can say why an account
 * it can see is one it cannot serve.
 *
 * Returns undefined — distinct from an empty roster — when the body carries no
 * roster information at all. `credentialDir` is emitted for EVERY profile, null
 * included, so its total absence means the followed instance predates this and
 * cannot answer the question. Guessing "nothing is adoptable" there would warn
 * about accounts that are merely unreported.
 */
export function readFollowedRoster(body: unknown): FollowedRoster | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const entries = (body as { profiles?: unknown }).profiles
  if (!Array.isArray(entries)) return undefined
  const adoptable: FollowedProfile[] = []
  const unadoptable: string[] = []
  let sawField = false
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as { id?: unknown; credentialDir?: unknown }
    if (typeof record.id !== "string") continue
    const id = record.id.trim()
    if (!id || id.length > MAX_PROFILE_ID_LENGTH) continue
    if (!("credentialDir" in record)) continue
    sawField = true
    const dir = record.credentialDir
    if (typeof dir === "string" && dir.trim() && dir.length <= MAX_CREDENTIAL_DIR_LENGTH) {
      adoptable.push({ id, credentialDir: dir.trim() })
    } else {
      unadoptable.push(id)
    }
  }
  return sawField ? { adoptable, unadoptable } : undefined
}

/** Whether two rosters name the same profiles at the same locations. */
function sameRoster(a: FollowedRoster | undefined, b: FollowedRoster | undefined): boolean {
  if (!a || !b) return a === b
  if (a.adoptable.length !== b.adoptable.length) return false
  if (a.unadoptable.length !== b.unadoptable.length) return false
  return (
    a.adoptable.every((p, i) => p.id === b.adoptable[i]!.id && p.credentialDir === b.adoptable[i]!.credentialDir) &&
    a.unadoptable.every((id, i) => id === b.unadoptable[i])
  )
}

/**
 * Report a roster change once, when it happens.
 *
 * Transitions only, matching the active-profile line beside it: a line per
 * poll would be 8,640 a day. An account appearing or disappearing is the
 * event worth a line, and a relocation is reported separately because the
 * roster is the same size and nothing else would show it.
 */
function logRosterChange(previous: FollowedRoster | undefined, next: FollowedRoster, url: string): void {
  const before = new Map((previous?.adoptable ?? []).map(p => [p.id, p.credentialDir]))
  const added = next.adoptable.filter(p => !before.has(p.id)).map(p => p.id)
  const moved = next.adoptable.filter(p => before.has(p.id) && before.get(p.id) !== p.credentialDir).map(p => p.id)
  const after = new Set(next.adoptable.map(p => p.id))
  const removed = [...before.keys()].filter(id => !after.has(id))
  if (added.length || removed.length || moved.length) {
    console.warn(
      `[PROXY] Profiles from ${url}: now serving ${next.adoptable.length}` +
      (added.length ? `; added ${added.join(", ")}` : "") +
      (removed.length ? `; withdrew ${removed.join(", ")}` : "") +
      (moved.length ? `; relocated ${moved.join(", ")}` : "") + "."
    )
  }
  const unadoptableChanged =
    next.unadoptable.length !== (previous?.unadoptable.length ?? 0) ||
    next.unadoptable.some((id, i) => id !== previous?.unadoptable[i])
  if (next.unadoptable.length && unadoptableChanged) {
    console.warn(
      `[PROXY] ${url} also has ${next.unadoptable.join(", ")}, which cannot be taken from it: ` +
      `their credentials are an inline key or token rather than a file on this machine, and a ` +
      `secret is never sent over this link. Configure them here to serve them here.`
    )
  }
}

// --- Pure: the decision ---------------------------------------------------

export interface FollowState {
  /** Last value successfully read, and when it was last CONFIRMED by a poll. */
  lastGood?: { profileId: string; at: number }
  /**
   * Last roster successfully read. Kept across a failed poll for the same
   * reason `lastGood` is: a followed instance that has gone quiet has not
   * withdrawn its accounts, and dropping them would strand every session
   * pinned to one.
   */
  lastRoster?: { roster: FollowedRoster; at: number }
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

/**
 * Profiles contributed by the followed instance. Called on the request path
 * through `getEffectiveProfiles` — synchronous, cache-only, no I/O.
 *
 * Empty until the first successful poll, so an instance whose followed peer is
 * down starts with its own profiles rather than none.
 */
export function adoptedProfiles(): readonly FollowedProfile[] {
  if (!isFollowEnabled()) return []
  return state.lastRoster?.roster.adoptable ?? []
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
  /** Profile ids taken from the followed instance and served here. */
  adoptedProfiles: string[]
  /** Profile ids it has that cannot be adopted, so a UI can say why. */
  unadoptableProfiles: string[]
  /** When the roster was last confirmed, or null if never read. */
  rosterSyncedAt: number | null
}

export function followStatus(availableIds: readonly string[]): FollowStatus | undefined {
  const target = followTarget()
  if (!target) return undefined
  const outcome = decideFollowedProfile(state, availableIds, Date.now())
  const roster = state.lastRoster
  return {
    url: target.url,
    activeProfile: outcome.follow ? outcome.profileId : null,
    followedValue: state.lastGood?.profileId ?? null,
    reason: outcome.follow ? null : outcome.reason,
    stale: outcome.follow ? outcome.stale : false,
    lastSyncedAt: state.lastGood?.at ?? null,
    lastError: state.lastError?.message ?? null,
    adoptedProfiles: (roster?.roster.adoptable ?? []).map(p => p.id),
    unadoptableProfiles: roster?.roster.unadoptable ?? [],
    rosterSyncedAt: roster?.at ?? null,
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
    const body = await res.json()
    const value = readActiveProfile(body)
    if (!value) throw new Error("response carried no usable activeProfile")
    const previous = state.lastGood?.profileId
    const roster = readFollowedRoster(body)
    const previousRoster = state.lastRoster?.roster
    state = {
      lastGood: { profileId: value, at: now },
      lastRoster: roster ? { roster, at: now } : state.lastRoster,
      lastPollAt: now,
    }
    if (roster && !sameRoster(roster, previousRoster)) logRosterChange(previousRoster, roster, target.url)
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
