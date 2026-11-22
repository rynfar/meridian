/**
 * When each Claude login happened, when Meridian last renewed it, and when it
 * was first found logged out.
 *
 * `.credentials.json` holds the current grant and nothing about its history,
 * and Claude Code wipes it once a refresh is refused. This record is what is
 * left afterwards to tell a login that reached its deadline from one that was
 * revoked early. Design and rules: profiles-routing.spec.md, *Login history*.
 *
 * Kept beside settings.json because Claude Code owns the credential file and
 * would drop any key Meridian added. Keyed by the credential store's
 * `refreshKey`: a login belongs to a credential, not to a profile name.
 *
 * Leaf module — no imports from server.ts or session/.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { configPath } from "../configDir"
import { publishFileSnapshot, withFileLock, withFileLockSync } from "./lockedFile"

/** One login's deadline, read twice, differs by a whole-second recount. */
export const DEADLINE_TOLERANCE_MS = 5 * 60 * 1000

/** Events kept per credential. */
export const MAX_AUTH_LIFECYCLE_EVENTS = 24

export type UnauthedReason =
  /** The token endpoint answered `invalid_grant` for the stored refresh token. */
  | "refresh_rejected"
  /** The credential was read and carries no access token. */
  | "credentials_cleared"

export type AuthLifecycleEventKind =
  /** Meridian completed an interactive login. */
  | "login"
  /** A refresh token Meridian did not issue appeared with a different
   *  deadline: a login performed elsewhere. */
  | "new_grant"
  /** A refresh token Meridian did not issue appeared and its deadline cannot
   *  say whether it is a new login or a rotation of the old one. */
  | "credential_replaced"
  /** The deadline moved while the refresh token stayed the same. */
  | "deadline_moved"
  | "logged_out"
  /** Authentication works again for the same grant. */
  | "recovered"

export interface AuthLifecycleEvent {
  at: number
  kind: AuthLifecycleEventKind
  /** The deadline in force when it happened. */
  refreshTokenExpiresAt?: number
  /** For `new_grant` and `deadline_moved`: the deadline it replaced. */
  previousRefreshTokenExpiresAt?: number
  reason?: UnauthedReason
  /** Short and never secret: an OAuth error code. */
  detail?: string
}

export interface AuthLifecycleRecord {
  /** When the current grant was obtained; unknown after `credential_replaced`. */
  authObtainedAt?: number
  /** `login` when Meridian performed it, `observed` when it was found on disk
   *  (then `authObtainedAt` is when it was noticed). */
  authObtainedVia?: "login" | "observed"
  /** Last refresh of the current grant that Meridian performed. */
  lastRefreshAt?: number
  /** Last deadline seen; kept after the credential is wiped. */
  refreshTokenExpiresAt?: number
  /** Which refresh token the record describes: a truncated SHA-256, never the
   *  token. A different one on disk means the credential changed hands. */
  refreshTokenId?: string
  /** When authentication was first found failing; cleared by a new grant or a
   *  renewal that works. */
  firstUnauthedAt?: number
  unauthedReason?: UnauthedReason
  events: AuthLifecycleEvent[]
}

export interface AuthLifecycleUpdate {
  record: AuthLifecycleRecord
  events: AuthLifecycleEvent[]
  changed: boolean
}

/** Identifies a refresh token without storing anything that could be used as one. */
export function refreshTokenId(token: string | undefined): string | undefined {
  return token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : undefined
}

// --- Pure ------------------------------------------------------------------

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8.64e15 ? value : undefined
}

const EVENT_KINDS: ReadonlySet<string> = new Set(["login", "new_grant", "credential_replaced", "deadline_moved", "logged_out", "recovered"])
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
  if (typeof e.detail === "string" && /^[a-z_]{1,40}$/.test(e.detail)) event.detail = e.detail
  return event
}

/** Hand-editable and written by other versions: malformed fields are dropped one by one. */
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
    if (typeof r.refreshTokenId === "string" && /^[0-9a-f]{16}$/.test(r.refreshTokenId)) record.refreshTokenId = r.refreshTokenId
    const unauthed = finiteTime(r.firstUnauthedAt)
    if (unauthed && typeof r.unauthedReason === "string" && REASONS.has(r.unauthedReason)) {
      record.firstUnauthedAt = unauthed
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

const unchanged = (record: AuthLifecycleRecord): AuthLifecycleUpdate => ({ record, events: [], changed: false })

function withEvent(record: AuthLifecycleRecord, event: AuthLifecycleEvent): AuthLifecycleUpdate {
  return { record: { ...record, events: [...record.events, event].slice(-MAX_AUTH_LIFECYCLE_EVENTS) }, events: [event], changed: true }
}

function withoutLogout(record: AuthLifecycleRecord): AuthLifecycleRecord {
  const next = { ...record }
  delete next.firstUnauthedAt
  delete next.unauthedReason
  return next
}

/**
 * A different grant from the one on record: everything that described the
 * old one goes, history excepted. Fields left out stay unknown.
 */
function startGrant(
  record: AuthLifecycleRecord,
  grant: Pick<AuthLifecycleRecord, "authObtainedAt" | "authObtainedVia" | "refreshTokenExpiresAt" | "refreshTokenId">,
): AuthLifecycleRecord {
  const next: AuthLifecycleRecord = { events: record.events }
  if (grant.authObtainedAt) next.authObtainedAt = grant.authObtainedAt
  if (grant.authObtainedVia) next.authObtainedVia = grant.authObtainedVia
  if (grant.refreshTokenExpiresAt) next.refreshTokenExpiresAt = grant.refreshTokenExpiresAt
  if (grant.refreshTokenId) next.refreshTokenId = grant.refreshTokenId
  return next
}

function sameDeadline(a: number | undefined, b: number | undefined): boolean {
  return a !== undefined && b !== undefined && Math.abs(a - b) <= DEADLINE_TOLERANCE_MS
}

function markLoggedOut(record: AuthLifecycleRecord, at: number, reason: UnauthedReason, detail?: string): AuthLifecycleUpdate {
  const event: AuthLifecycleEvent = { at, kind: "logged_out", reason }
  if (record.refreshTokenExpiresAt) event.refreshTokenExpiresAt = record.refreshTokenExpiresAt
  if (detail) event.detail = detail
  return withEvent({ ...record, firstUnauthedAt: at, unauthedReason: reason }, event)
}

function markRecovered(record: AuthLifecycleRecord, at: number): AuthLifecycleUpdate {
  const event: AuthLifecycleEvent = { at, kind: "recovered" }
  if (record.refreshTokenExpiresAt) event.refreshTokenExpiresAt = record.refreshTokenExpiresAt
  return withEvent(withoutLogout(record), event)
}

/** Meridian completed an interactive login: a new grant, nothing of the old one kept. */
export function applyLogin(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; refreshTokenExpiresAt?: number; refreshTokenId?: string },
): AuthLifecycleUpdate {
  const record = startGrant(prev ?? { events: [] }, {
    authObtainedAt: input.at,
    authObtainedVia: "login",
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    refreshTokenId: input.refreshTokenId,
  })
  const event: AuthLifecycleEvent = { at: input.at, kind: "login" }
  if (input.refreshTokenExpiresAt) event.refreshTokenExpiresAt = input.refreshTokenExpiresAt
  return withEvent(record, event)
}

/**
 * What a successful read of the stored credential showed. Callers pass
 * `unknown` for a read that failed, which changes nothing.
 *
 * The refresh token tells the cases apart. The same one is the same grant. A
 * different one with the same deadline is the same grant rotated by another
 * process (two logins land on one deadline only when they happen within the
 * tolerance of each other). A different one with a different deadline, in
 * either direction, is a new login. Where the token or a deadline is unknown
 * on one side and what is known differs, it could be either: the old grant's
 * facts are dropped and its login time stays unknown rather than wrong.
 */
export function applyObservation(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; presence: "present" | "absent" | "unknown"; refreshTokenExpiresAt?: number; refreshTokenId?: string },
): AuthLifecycleUpdate {
  const base = prev ?? { events: [] }
  if (input.presence === "unknown") return unchanged(base)
  if (input.presence === "absent") {
    return base.firstUnauthedAt ? unchanged(base) : markLoggedOut(base, input.at, "credentials_cleared")
  }

  const id = input.refreshTokenId
  const previousId = base.refreshTokenId
  const deadline = input.refreshTokenExpiresAt
  const previousDeadline = base.refreshTokenExpiresAt
  const tokenChanged = Boolean(id && previousId && id !== previousId)
  const tokenSame = Boolean(id && id === previousId)
  const deadlineKept = sameDeadline(deadline, previousDeadline)
  const deadlineChanged = Boolean(deadline && previousDeadline && !deadlineKept)

  if (tokenChanged && deadlineChanged) {
    const event: AuthLifecycleEvent = { at: input.at, kind: "new_grant", refreshTokenExpiresAt: deadline, previousRefreshTokenExpiresAt: previousDeadline }
    return withEvent(startGrant(base, { authObtainedAt: input.at, authObtainedVia: "observed", refreshTokenExpiresAt: deadline, refreshTokenId: id }), event)
  }
  if ((tokenChanged && !deadlineKept) || (!tokenSame && deadlineChanged)) {
    const event: AuthLifecycleEvent = { at: input.at, kind: "credential_replaced" }
    if (deadline) event.refreshTokenExpiresAt = deadline
    return withEvent(startGrant(base, { refreshTokenExpiresAt: deadline, refreshTokenId: id }), event)
  }

  // The same grant: the same token, a rotation of it, or nothing known that differs.
  let record = base
  const events: AuthLifecycleEvent[] = []
  let changed = false
  if (id && id !== previousId) {
    record = { ...record, refreshTokenId: id }
    changed = true
  }
  if (deadline && !deadlineKept) {
    if (previousDeadline) {
      events.push({ at: input.at, kind: "deadline_moved", refreshTokenExpiresAt: deadline, previousRefreshTokenExpiresAt: previousDeadline })
    }
    record = { ...record, refreshTokenExpiresAt: deadline, events: [...record.events, ...events].slice(-MAX_AUTH_LIFECYCLE_EVENTS) }
    changed = true
  }
  // A wiped credential back on disk, or a refused refresh token rotated into a
  // working one, can authenticate again. A refused token still on disk stays
  // refused: its access token can keep serving for hours after the refusal.
  if (record.unauthedReason === "credentials_cleared" || (record.unauthedReason === "refresh_rejected" && tokenChanged)) {
    const recovered = markRecovered(record, input.at)
    return { record: recovered.record, events: [...events, ...recovered.events], changed: true }
  }
  return { record, events, changed }
}

/** Meridian renewed the grant it holds. */
export function applyRefreshSucceeded(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; refreshTokenExpiresAt?: number; refreshTokenId?: string },
): AuthLifecycleUpdate {
  const base = prev ?? { events: [] }
  let record: AuthLifecycleRecord = { ...base, lastRefreshAt: input.at }
  if (input.refreshTokenId) record.refreshTokenId = input.refreshTokenId
  const events: AuthLifecycleEvent[] = []
  const deadline = input.refreshTokenExpiresAt
  if (deadline && !sameDeadline(deadline, base.refreshTokenExpiresAt)) {
    if (base.refreshTokenExpiresAt) {
      const event: AuthLifecycleEvent = { at: input.at, kind: "deadline_moved", refreshTokenExpiresAt: deadline, previousRefreshTokenExpiresAt: base.refreshTokenExpiresAt }
      record = { ...record, events: [...record.events, event].slice(-MAX_AUTH_LIFECYCLE_EVENTS) }
      events.push(event)
    }
    record.refreshTokenExpiresAt = deadline
  }
  // A refused refresh token never works again, so this one was not refused.
  if (record.firstUnauthedAt) {
    const recovered = markRecovered(record, input.at)
    return { record: recovered.record, events: [...events, ...recovered.events], changed: true }
  }
  return { record, events, changed: true }
}

/** The token endpoint answered `invalid_grant` for the refresh token on record. */
export function applyRefreshRejected(
  prev: AuthLifecycleRecord | undefined,
  input: { at: number; detail?: string; refreshTokenId?: string },
): AuthLifecycleUpdate {
  const base = prev ?? { events: [] }
  if (input.refreshTokenId && base.refreshTokenId && input.refreshTokenId !== base.refreshTokenId) return unchanged(base)
  if (base.firstUnauthedAt) return unchanged(base)
  return markLoggedOut(base, input.at, "refresh_rejected", input.detail)
}

/**
 * Whether the record says this account can no longer authenticate. A refused
 * refresh only ends service when the access token it left behind runs out;
 * until then the account serves and the refusal is a countdown.
 */
export function authLifecycleLoggedOut(
  record: AuthLifecycleRecord | undefined,
  accessTokenExpiresAt: number | undefined,
  now: number,
): boolean {
  if (!record?.firstUnauthedAt) return false
  if (record.unauthedReason !== "refresh_rejected") return true
  return !accessTokenExpiresAt || accessTokenExpiresAt <= now
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

/** One log line per transition. `record` is the state before it. */
export function describeAuthLifecycleEvent(event: AuthLifecycleEvent, record: AuthLifecycleRecord | undefined): string {
  const deadline = event.refreshTokenExpiresAt
  switch (event.kind) {
    case "login":
      return deadline
        ? `logged in; the refresh deadline is ${iso(deadline)} (in ${formatSpan(deadline - event.at)})`
        : "logged in; the refresh deadline arrives with the first refresh"
    case "new_grant":
      return `found a new login on disk; its refresh deadline is ${iso(deadline)}`
        + (event.previousRefreshTokenExpiresAt ? ` (the previous one was ${iso(event.previousRefreshTokenExpiresAt)})` : "")
    case "credential_replaced":
      return "found a different credential on disk; when its login happened is unknown"
    case "deadline_moved":
      return `refresh deadline moved from ${iso(event.previousRefreshTokenExpiresAt)} to ${iso(deadline)} without a new login`
    case "recovered":
      return "authenticating again"
    case "logged_out": {
      const why = event.reason === "credentials_cleared"
        ? "the stored credential has no access token"
        : `the refresh was refused${event.detail ? ` (${event.detail})` : ""}`
      const parts = [`logged out: ${why}`]
      parts.push(deadline
        ? `refresh deadline ${iso(deadline)} (${deadline <= event.at ? `${formatSpan(event.at - deadline)} ago` : `${formatSpan(deadline - event.at)} early`})`
        : "refresh deadline unknown")
      if (record?.authObtainedAt) parts.push(`logged in ${formatSpan(event.at - record.authObtainedAt)} earlier`)
      return parts.join("; ")
    }
  }
}

// --- Persistence -------------------------------------------------------------

function lifecycleFile(): string {
  return configPath("auth-lifecycle.json")
}

const BUSY = "auth-lifecycle.json is locked by another writer. An interrupted writer's lock requires cleanup while all Meridian processes are stopped."

/** Every record on file, for display. Never used to write. */
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

/** Under the writer lock. A file that cannot be parsed throws, so a writer never replaces history it could not read. */
function readForUpdate(file: string): Record<string, AuthLifecycleRecord> {
  if (!existsSync(file)) return {}
  return readAuthLifecycles(JSON.parse(readFileSync(file, "utf-8")))
}

function publish(file: string, records: Record<string, AuthLifecycleRecord>): void {
  publishFileSnapshot(file, JSON.stringify(records, null, 2) + "\n")
}

export interface AuthLifecycleTransition {
  key: string
  event: AuthLifecycleEvent
  /** The record before the transition. */
  previous: AuthLifecycleRecord | undefined
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

function announce(key: string, previous: AuthLifecycleRecord | undefined, result: AuthLifecycleUpdate): void {
  for (const event of result.events) {
    for (const listener of listeners) {
      try {
        listener({ key, event, previous, record: result.record })
      } catch (err) {
        // A listener is a log line; it must never fail the refresh it reports.
        console.warn(`[meridian] Auth lifecycle listener failed: ${err instanceof Error ? err.message : err}`)
      }
    }
  }
}

function warnUnwritten(err: unknown): void {
  console.warn(`[meridian] Login history not updated: ${err instanceof Error ? err.message : err}`)
}

/**
 * Read, apply and publish under one cross-process lock, so a transition
 * another process (the server, `meridian profile login`) wrote in the meantime
 * is never overwritten with a stale copy. A failed lock or read leaves the file
 * as it was and returns the record as last read. Never rejects.
 */
async function update(
  key: string | undefined,
  apply: (prev: AuthLifecycleRecord | undefined) => AuthLifecycleUpdate,
): Promise<AuthLifecycleRecord | undefined> {
  if (!key) return undefined
  const file = lifecycleFile()
  let previous: AuthLifecycleRecord | undefined
  let result: AuthLifecycleUpdate
  try {
    // Most reads change nothing (every page poll observes every profile), and
    // they need no lock: nothing is written, so nothing can be lost.
    const seen = authLifecycleFor(key)
    if (!apply(seen).changed) return seen
    result = await withFileLock(file, BUSY, () => {
      const records = readForUpdate(file)
      previous = records[key]
      const next = apply(previous)
      if (next.changed) publish(file, { ...records, [key]: next.record })
      return next
    })
  } catch (err) {
    warnUnwritten(err)
    return authLifecycleFor(key)
  }
  announce(key, previous, result)
  return result.record
}

// Request paths (a token refresh, a /profiles/list read) hand their history
// writes to this queue instead of awaiting them: the file lock fails closed,
// so a lock left by an interrupted writer would otherwise stall every one of
// them for the full lock wait. One write at a time, in order.
let queue: Promise<unknown> = Promise.resolve()
const queuedObservations = new Set<string>()

function enqueue(write: () => Promise<unknown>): void {
  queue = queue.then(write).catch(warnUnwritten)
}

/** Resolves once every queued history write has finished. */
export async function settleAuthLifecycleWrites(): Promise<void> {
  await queue
}

/** Queue `write` without awaiting it; the history is best-effort. */
export function recordInBackground(write: () => Promise<unknown>): void {
  enqueue(write)
}

export function noteAuthLogin(
  key: string | undefined,
  input: { refreshTokenExpiresAt?: number; refreshToken?: string; at?: number } = {},
): Promise<AuthLifecycleRecord | undefined> {
  return update(key, prev => applyLogin(prev, {
    at: input.at ?? Date.now(),
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    refreshTokenId: refreshTokenId(input.refreshToken),
  }))
}

export function noteRefreshSucceeded(
  key: string | undefined,
  input: { refreshTokenExpiresAt?: number; refreshToken?: string; at?: number } = {},
): Promise<AuthLifecycleRecord | undefined> {
  return update(key, prev => applyRefreshSucceeded(prev, {
    at: input.at ?? Date.now(),
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    refreshTokenId: refreshTokenId(input.refreshToken),
  }))
}

export function noteRefreshRejected(
  key: string | undefined,
  input: { detail?: string; refreshToken?: string; at?: number } = {},
): Promise<AuthLifecycleRecord | undefined> {
  return update(key, prev => applyRefreshRejected(prev, {
    at: input.at ?? Date.now(),
    detail: input.detail,
    refreshTokenId: refreshTokenId(input.refreshToken),
  }))
}

/** Returns the record as it stands after the observation. */
export function noteCredentialObserved(
  key: string | undefined,
  input: { presence: "present" | "absent" | "unknown"; refreshTokenExpiresAt?: number; refreshTokenId?: string; at?: number },
): Promise<AuthLifecycleRecord | undefined> {
  if (input.presence === "unknown") return Promise.resolve(authLifecycleFor(key))
  return update(key, observation({ ...input, presence: input.presence }))
}

function observation(
  input: { presence: "present" | "absent"; refreshTokenExpiresAt?: number; refreshTokenId?: string; at?: number },
): (prev: AuthLifecycleRecord | undefined) => AuthLifecycleUpdate {
  const at = input.at ?? Date.now()
  return prev => applyObservation(prev, {
    at,
    presence: input.presence,
    refreshTokenExpiresAt: input.refreshTokenExpiresAt,
    refreshTokenId: input.refreshTokenId,
  })
}

/**
 * The record this observation leads to, without waiting for it to be written:
 * the write is queued. A request that reads the history must not wait on the
 * history file's lock.
 */
export function observeCredentialInBackground(
  key: string | undefined,
  input: { presence: "present" | "absent" | "unknown"; refreshTokenExpiresAt?: number; refreshTokenId?: string; at?: number },
): AuthLifecycleRecord | undefined {
  if (!key) return undefined
  const seen = authLifecycleFor(key)
  if (input.presence === "unknown") return seen
  const apply = observation({ ...input, presence: input.presence })
  let next: AuthLifecycleUpdate
  try {
    next = apply(seen)
  } catch (err) {
    warnUnwritten(err)
    return seen
  }
  if (!next.changed) return seen
  // Every poll repeats the same observation while a write is pending.
  if (!queuedObservations.has(key)) {
    queuedObservations.add(key)
    enqueue(async () => {
      try { await update(key, apply) }
      finally { queuedObservations.delete(key) }
    })
  }
  return next.record
}

/**
 * Carry a record across a profile rename that moved its credentials. Runs
 * inside the synchronous rename, so it waits for the lock synchronously.
 */
export function renameAuthLifecycleKey(from: string | undefined, to: string | undefined): void {
  if (!from || !to || from === to) return
  const file = lifecycleFile()
  try {
    withFileLockSync(file, BUSY, () => {
      const records = readForUpdate(file)
      const record = records[from]
      if (!record) return
      delete records[from]
      records[to] = record
      publish(file, records)
    })
  } catch (err) {
    warnUnwritten(err)
  }
}

/**
 * Forget the records of credentials that no longer exist, such as a removed
 * profile's. Runs inside the synchronous removal, so it waits for the lock
 * synchronously; a busy lock leaves the records for the next removal.
 */
export function removeAuthLifecycleKeys(keys: readonly (string | undefined)[]): void {
  const doomed = keys.filter((key): key is string => typeof key === "string" && key.length > 0)
  if (doomed.length === 0) return
  const file = lifecycleFile()
  try {
    if (!existsSync(file)) return
    withFileLockSync(file, BUSY, () => {
      const records = readForUpdate(file)
      const present = doomed.filter(key => key in records)
      if (present.length === 0) return
      for (const key of present) delete records[key]
      publish(file, records)
    })
  } catch (err) {
    warnUnwritten(err)
  }
}

/** Drop every listener — for tests. */
export function resetAuthLifecycleListenersForTesting(): void {
  listeners.clear()
}
