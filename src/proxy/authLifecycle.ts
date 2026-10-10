/**
 * When each account was logged in, when it was last renewed, and when it was
 * first found logged out.
 *
 * A Claude login has a deadline. The token endpoint states it with every
 * refresh as `refresh_token_expires_in`, and it counts DOWN: refreshing renews
 * the access token, never the deadline. Once the deadline passes the next
 * refresh is refused and the account stops working when its current access
 * token runs out, at most one access-token lifetime later. Measured on a live
 * fleet: deadlines read off disk weeks in advance predicted every drop that
 * followed to within those few hours.
 *
 * `.credentials.json` holds the deadline and nothing else about the login, and
 * Claude Code wipes the file the moment a refresh is refused. So after the
 * fact there was no record of when the account had been logged in, when it was
 * last renewed, or when it stopped — the questions that tell a fixed lifetime
 * from an early revocation. This module is that record.
 *
 * WHERE IT IS KEPT. Meridian's own file beside settings.json, for the reason
 * organizations.json lives there: Claude Code owns `.credentials.json`,
 * rewrites it on every refresh, and would drop any key Meridian added.
 *
 * WHAT IT IS KEYED BY. The credential store's `refreshKey`, the identity
 * tokenRefresh already dedupes refreshes on. A login belongs to a credential,
 * not to whatever the profile pointing at it happens to be called.
 *
 * Leaf module — no imports from server.ts or session/.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { configPath } from "../configDir"

/** How far a deadline must move forward before it means a different login. */
export const NEW_GRANT_MIN_JUMP_MS = 60 * 60 * 1000

/** Deadlines are recomputed from a whole-second countdown on every refresh, so
 *  the same login reads a little differently each time. */
const DEADLINE_TOLERANCE_MS = 5 * 60 * 1000

/** Events kept per credential — years of logins at one a month. */
export const MAX_AUTH_LIFECYCLE_EVENTS = 24

export type UnauthedReason =
  /** The token endpoint refused the refresh token. */
  | "refresh_rejected"
  /** The credential on disk no longer carries an access token — what Claude
   *  Code leaves behind after it is refused. */
  | "credentials_cleared"

export type AuthLifecycleEventKind =
  /** Meridian completed an interactive login. */
  | "login"
  /** A credential with a later deadline appeared without Meridian logging in:
   *  somebody ran a login elsewhere against the same directory. */
  | "new_grant"
  /** The deadline moved without a new login. Not expected; kept as evidence. */
  | "deadline_moved"
  | "logged_out"
  /** Authentication worked again without a recorded login. */
  | "recovered"

export interface AuthLifecycleEvent {
  at: number
  kind: AuthLifecycleEventKind
  /** The login deadline in force when it happened. */
  refreshTokenExpiresAt?: number
  /** For `new_grant` and `deadline_moved`: the deadline it replaced. */
  previousRefreshTokenExpiresAt?: number
  reason?: UnauthedReason
  /** Short and never secret: an OAuth error code or an HTTP status. */
  detail?: string
}

export interface AuthLifecycleRecord {
  /** When the login behind the current credential happened. */
  authObtainedAt?: number
  /** `login` when Meridian performed it, `observed` when a new credential was
   *  found on disk — then this is when it was noticed, not when it happened. */
  authObtainedVia?: "login" | "observed"
  /** Last successful token refresh. */
  lastRefreshAt?: number
  /** Last login deadline seen. Kept after Claude Code wipes the credential, so a
   *  drop can be compared with the deadline it fell on. */
  refreshTokenExpiresAt?: number
  /** Set once, when authentication is first found failing; cleared by a login
   *  or by authentication working again. */
  firstUnauthedAt?: number
  unauthedReason?: UnauthedReason
  events: AuthLifecycleEvent[]
}

export interface AuthLifecycleUpdate {
  record: AuthLifecycleRecord
  events: AuthLifecycleEvent[]
  changed: boolean
}

// --- Pure ------------------------------------------------------------------

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

const EVENT_KINDS: ReadonlySet<string> = new Set(["login", "new_grant", "deadline_moved", "logged_out", "recovered"])
const REASONS: ReadonlySet<string> = new Set(["refresh_rejected", "credentials_cleared"])

function readEvent(raw: unknown): AuthLifecycleEvent | null {
  if (typeof raw !== "object" || raw === null) return null
  const e = raw as Record<string, unknown>
  const at = finiteTime(e.at)
  if (!at || typeof e.kind !== "string" || !EVENT_KINDS.has(e.kind)) return null
  const event: AuthLifecycleEvent = { at, kind: e.kind as AuthLifecycleEventKind }
  const deadline = finiteTime(e.refreshTokenExpiresAt)
  if (deadline) event.refreshTokenExpiresAt = deadline
  const previous = finiteTime(e.previousRefreshTokenExpiresAt)
  if (previous) event.previousRefreshTokenExpiresAt = previous
  if (typeof e.reason === "string" && REASONS.has(e.reason)) event.reason = e.reason as UnauthedReason
  if (typeof e.detail === "string" && e.detail.length <= 64) event.detail = e.detail
  return event
}

/**
 * Read a record map out of whatever the file holds. Hand-editable and written
 * by other versions, so anything malformed is dropped field by field rather
 * than failing the whole file.
 */
export function readAuthLifecycles(raw: unknown): Record<string, AuthLifecycleRecord> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {}
  const out: Record<string, AuthLifecycleRecord> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!key || typeof value !== "object" || value === null || Array.isArray(value)) continue
    const r = value as Record<string, unknown>
    const record: AuthLifecycleRecord = { events: [] }
    const obtained = finiteTime(r.authObtainedAt)
    if (obtained) record.authObtainedAt = obtained
    if (r.authObtainedVia === "login" || r.authObtainedVia === "observed") record.authObtainedVia = r.authObtainedVia
    const refreshed = finiteTime(r.lastRefreshAt)
    if (refreshed) record.lastRefreshAt = refreshed
    const deadline = finiteTime(r.refreshTokenExpiresAt)
    if (deadline) record.refreshTokenExpiresAt = deadline
    const unauthed = finiteTime(r.firstUnauthedAt)
    if (unauthed) record.firstUnauthedAt = unauthed
    if (typeof r.unauthedReason === "string" && REASONS.has(r.unauthedReason)) {
      record.unauthedReason = r.unauthedReason as UnauthedReason
    }
    if (Array.isArray(r.events)) {
      for (const e of r.events) {
        const event = readEvent(e)
        if (event) record.events.push(event)
      }
      record.events = record.events.slice(-MAX_AUTH_LIFECYCLE_EVENTS)
    }
    out[key] = record
  }
  return out
}

function emptyRecord(): AuthLifecycleRecord {
  return { events: [] }
}

function withEvents(record: AuthLifecycleRecord, events: AuthLifecycleEvent[]): AuthLifecycleRecord {
  if (events.length === 0) return record
  return { ...record, events: [...record.events, ...events].slice(-MAX_AUTH_LIFECYCLE_EVENTS) }
}

function markLoggedIn(record: AuthLifecycleRecord): AuthLifecycleRecord {
  const next = { ...record }
  delete next.firstUnauthedAt
  delete next.unauthedReason
  return next
}

/**
 * Fold a newly read deadline into the record.
 *
 * A deadline that jumps forward is a different login: refreshing never moves
 * it. Unless Meridian recorded that login itself, whoever ran it did so
 * elsewhere, and the record learns about it here — late, which is what
 * `authObtainedVia: "observed"` says.
 */
function applyDeadline(record: AuthLifecycleRecord, deadline: number | undefined, at: number): AuthLifecycleUpdate {
  if (!deadline || deadline === record.refreshTokenExpiresAt) return { record, events: [], changed: false }
  const previous = record.refreshTokenExpiresAt
  if (!previous) return { record: { ...record, refreshTokenExpiresAt: deadline }, events: [], changed: true }
  // The same login, read a second apart through a cached and a fresh path.
  if (Math.abs(deadline - previous) <= DEADLINE_TOLERANCE_MS) return { record, events: [], changed: false }
  if (deadline - previous >= NEW_GRANT_MIN_JUMP_MS) {
    const event: AuthLifecycleEvent = { at, kind: "new_grant", refreshTokenExpiresAt: deadline, previousRefreshTokenExpiresAt: previous }
    const next: AuthLifecycleRecord = {
      ...markLoggedIn(record),
      refreshTokenExpiresAt: deadline,
      authObtainedAt: at,
      authObtainedVia: "observed",
    }
    return { record: withEvents(next, [event]), events: [event], changed: true }
  }
  const event: AuthLifecycleEvent = { at, kind: "deadline_moved", refreshTokenExpiresAt: deadline, previousRefreshTokenExpiresAt: previous }
  return { record: withEvents({ ...record, refreshTokenExpiresAt: deadline }, [event]), events: [event], changed: true }
}

/** Meridian completed an interactive login. */
export function applyLogin(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; refreshTokenExpiresAt?: number },
): AuthLifecycleUpdate {
  const event: AuthLifecycleEvent = { at: input.at, kind: "login" }
  if (input.refreshTokenExpiresAt) event.refreshTokenExpiresAt = input.refreshTokenExpiresAt
  const next: AuthLifecycleRecord = {
    ...markLoggedIn(prev ?? emptyRecord()),
    authObtainedAt: input.at,
    authObtainedVia: "login",
  }
  // The old deadline belongs to the old login. Unknown beats wrong: the first
  // refresh reports the new one.
  if (input.refreshTokenExpiresAt) next.refreshTokenExpiresAt = input.refreshTokenExpiresAt
  else delete next.refreshTokenExpiresAt
  return { record: withEvents(next, [event]), events: [event], changed: true }
}

/** A refresh succeeded; `refreshTokenExpiresAt` is what it reported, if anything. */
export function applyRefreshSucceeded(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; refreshTokenExpiresAt?: number },
): AuthLifecycleUpdate {
  const base = prev ?? emptyRecord()
  const deadline = applyDeadline({ ...base, lastRefreshAt: input.at }, input.refreshTokenExpiresAt, input.at)
  let record = deadline.record
  const events = [...deadline.events]
  // A refused refresh token never works again, so success after a recorded
  // logout means a login nobody recorded — or that the refusal was not one.
  if (record.firstUnauthedAt) {
    const event: AuthLifecycleEvent = { at: input.at, kind: "recovered" }
    if (record.refreshTokenExpiresAt) event.refreshTokenExpiresAt = record.refreshTokenExpiresAt
    record = withEvents(markLoggedIn(record), [event])
    events.push(event)
  }
  return { record, events, changed: true }
}

/** The token endpoint refused the refresh token. Recorded once per logout. */
export function applyRefreshRejected(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; detail?: string },
): AuthLifecycleUpdate {
  const base = prev ?? emptyRecord()
  if (base.firstUnauthedAt) return { record: base, events: [], changed: false }
  return markLoggedOut(base, input.at, "refresh_rejected", input.detail)
}

function markLoggedOut(record: AuthLifecycleRecord, at: number, reason: UnauthedReason, detail?: string): AuthLifecycleUpdate {
  const event: AuthLifecycleEvent = { at, kind: "logged_out", reason }
  if (record.refreshTokenExpiresAt) event.refreshTokenExpiresAt = record.refreshTokenExpiresAt
  if (detail) event.detail = detail
  const next = withEvents({ ...record, firstUnauthedAt: at, unauthedReason: reason }, [event])
  return { record: next, events: [event], changed: true }
}

/**
 * What a read of the credential showed.
 *
 * `presence` is tokenRefresh's three-way answer, and only `absent` — read fine,
 * no access token — counts as a logout. `unknown` is a read that failed, which
 * must never log out an account that is working.
 */
export function applyObservation(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; presence: "present" | "absent" | "unknown"; refreshTokenExpiresAt?: number },
): AuthLifecycleUpdate {
  const base = prev ?? emptyRecord()
  if (input.presence === "unknown") return { record: base, events: [], changed: false }
  if (input.presence === "absent") {
    if (base.firstUnauthedAt) return { record: base, events: [], changed: false }
    return markLoggedOut(base, input.at, "credentials_cleared")
  }
  const deadline = applyDeadline(base, input.refreshTokenExpiresAt, input.at)
  // A wiped credential only comes back through a login. A refused one can sit
  // on disk with a working access token for hours, so that case waits for a
  // refresh or a new deadline instead.
  if (deadline.record.firstUnauthedAt && deadline.record.unauthedReason === "credentials_cleared") {
    const event: AuthLifecycleEvent = { at: input.at, kind: "new_grant" }
    if (deadline.record.refreshTokenExpiresAt) event.refreshTokenExpiresAt = deadline.record.refreshTokenExpiresAt
    const record = withEvents(
      { ...markLoggedIn(deadline.record), authObtainedAt: input.at, authObtainedVia: "observed" },
      [event],
    )
    return { record, events: [...deadline.events, event], changed: true }
  }
  return deadline
}

// --- Describing -------------------------------------------------------------

function iso(ms: number | undefined): string {
  return ms ? new Date(ms).toISOString() : "unknown"
}

/** "29d 6h", "5h 12m", "42m" — the two largest units, for a log line. */
export function formatSpan(ms: number): string {
  const sign = ms < 0 ? "-" : ""
  let rest = Math.floor(Math.abs(ms) / 60_000)
  const days = Math.floor(rest / 1440)
  rest -= days * 1440
  const hours = Math.floor(rest / 60)
  const minutes = rest - hours * 60
  if (days > 0) return `${sign}${days}d ${hours}h`
  if (hours > 0) return `${sign}${hours}h ${minutes}m`
  return `${sign}${minutes}m`
}

/** One log line per transition, naming everything the analysis needs. */
export function describeAuthLifecycleEvent(event: AuthLifecycleEvent, record: AuthLifecycleRecord): string {
  const deadline = event.refreshTokenExpiresAt
  switch (event.kind) {
    case "login":
      return deadline
        ? `logged in; the login lasts until ${iso(deadline)} (${formatSpan(deadline - event.at)})`
        : "logged in; the login deadline arrives with the first refresh"
    case "new_grant":
      return `found a new login on disk; it lasts until ${iso(deadline)}`
        + (event.previousRefreshTokenExpiresAt ? ` (the previous one ended ${iso(event.previousRefreshTokenExpiresAt)})` : "")
    case "deadline_moved":
      return `login deadline moved from ${iso(event.previousRefreshTokenExpiresAt)} to ${iso(deadline)} without a new login`
    case "recovered":
      return "authenticating again"
    case "logged_out": {
      const why = event.reason === "credentials_cleared"
        ? "the credential was wiped"
        : `the refresh was refused${event.detail ? ` (${event.detail})` : ""}`
      const parts = [`logged out: ${why}`]
      parts.push(deadline
        ? `login deadline ${iso(deadline)} (${deadline <= event.at ? `${formatSpan(event.at - deadline)} ago` : `${formatSpan(deadline - event.at)} early`})`
        : "login deadline unknown")
      if (record.authObtainedAt) parts.push(`logged in ${formatSpan(event.at - record.authObtainedAt)} earlier`)
      return parts.join("; ")
    }
  }
}

// --- Persistence -------------------------------------------------------------

function lifecycleFile(): string {
  return configPath("auth-lifecycle.json")
}

/** Every record on file, keyed by credential identity. */
export function authLifecycles(): Record<string, AuthLifecycleRecord> {
  const file = lifecycleFile()
  try {
    if (!existsSync(file)) return {}
    return readAuthLifecycles(JSON.parse(readFileSync(file, "utf-8")))
  } catch {
    return {}
  }
}

export function authLifecycleFor(key: string | undefined): AuthLifecycleRecord | undefined {
  return key ? authLifecycles()[key] : undefined
}

function writeAuthLifecycles(records: Record<string, AuthLifecycleRecord>): void {
  const file = lifecycleFile()
  // Written whole and renamed into place: the server and a `meridian profile
  // login` in another process both write it, and neither may read half a file.
  const tmp = `${file}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(records, null, 2) + "\n", { mode: 0o600 })
    renameSync(tmp, file)
  } catch (err) {
    console.warn(`[meridian] Failed to write ${file}: ${err instanceof Error ? err.message : err}`)
  }
}

export interface AuthLifecycleTransition {
  key: string
  event: AuthLifecycleEvent
  record: AuthLifecycleRecord
}

type TransitionListener = (transition: AuthLifecycleTransition) => void
const listeners = new Set<TransitionListener>()

/** Hear about every transition this process records. Returns an unsubscribe. */
export function onAuthLifecycleTransition(listener: TransitionListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function update(
  key: string | undefined,
  apply: (prev: AuthLifecycleRecord | undefined) => AuthLifecycleUpdate,
): AuthLifecycleRecord | undefined {
  if (!key) return undefined
  const records = authLifecycles()
  const result = apply(records[key])
  if (!result.changed) return records[key]
  records[key] = result.record
  writeAuthLifecycles(records)
  for (const event of result.events) {
    for (const listener of listeners) {
      try {
        listener({ key, event, record: result.record })
      } catch {
        // A listener is a log line; it must never fail the refresh it reports.
      }
    }
  }
  return result.record
}

export function noteAuthLogin(key: string | undefined, input: { refreshTokenExpiresAt?: number; at?: number } = {}): void {
  update(key, prev => applyLogin(prev, { at: input.at ?? Date.now(), refreshTokenExpiresAt: input.refreshTokenExpiresAt }))
}

export function noteRefreshSucceeded(key: string | undefined, input: { refreshTokenExpiresAt?: number; at?: number } = {}): void {
  update(key, prev => applyRefreshSucceeded(prev, { at: input.at ?? Date.now(), refreshTokenExpiresAt: input.refreshTokenExpiresAt }))
}

export function noteRefreshRejected(key: string | undefined, input: { detail?: string; at?: number } = {}): void {
  update(key, prev => applyRefreshRejected(prev, { at: input.at ?? Date.now(), detail: input.detail }))
}

/** Returns the record as it stands after the observation. */
export function noteCredentialObserved(
  key: string | undefined,
  input: { presence: "present" | "absent" | "unknown"; refreshTokenExpiresAt?: number; at?: number },
): AuthLifecycleRecord | undefined {
  return update(key, prev => applyObservation(prev, {
    at: input.at ?? Date.now(),
    presence: input.presence,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
  }))
}

/** Carry a record across a profile rename that moved its credentials. */
export function renameAuthLifecycleKey(from: string | undefined, to: string | undefined): void {
  if (!from || !to || from === to) return
  const records = authLifecycles()
  const record = records[from]
  if (!record) return
  delete records[from]
  records[to] = record
  writeAuthLifecycles(records)
}

/** Drop every listener — for tests. */
export function resetAuthLifecycleListenersForTesting(): void {
  listeners.clear()
}
