/**
 * Unit tests for authLifecycle.ts, and for the refresh and login paths that
 * feed it.
 *
 * The transitions are pure and asserted directly. Persistence goes through
 * the real module with MERIDIAN_CONFIG_DIR redirected by the preload, each
 * test on its own credential key so files written by one cannot satisfy
 * another.
 */
import { describe, test, expect, afterEach } from "bun:test"
import {
  MAX_AUTH_LIFECYCLE_EVENTS,
  NEW_GRANT_MIN_JUMP_MS,
  applyLogin,
  applyObservation,
  applyRefreshRejected,
  applyRefreshSucceeded,
  authLifecycleFor,
  describeAuthLifecycleEvent,
  formatSpan,
  noteAuthLogin,
  noteCredentialObserved,
  noteRefreshRejected,
  onAuthLifecycleTransition,
  readAuthLifecycles,
  renameAuthLifecycleKey,
  resetAuthLifecycleListenersForTesting,
  type AuthLifecycleRecord,
  type AuthLifecycleTransition,
} from "../proxy/authLifecycle"
import { ROTATION_SETTLE_MS, oauthErrorCode, refreshOAuthToken, resetInflightRefresh, type CredentialStore, type CredentialsFile } from "../proxy/tokenRefresh"
import { buildLoginCredentials } from "../proxy/profileCli"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = 1_790_000_000_000

let keySeq = 0
function uniqueKey(): string {
  return `test:${process.pid}:${Date.now()}:${keySeq++}`
}

afterEach(() => {
  resetAuthLifecycleListenersForTesting()
})

describe("applyLogin", () => {
  test("records when and how the login happened, with its deadline", () => {
    const { record, events } = applyLogin(undefined, { at: T0, refreshTokenExpiresAt: T0 + 30 * DAY })
    expect(record.authObtainedAt).toBe(T0)
    expect(record.authObtainedVia).toBe("login")
    expect(record.refreshTokenExpiresAt).toBe(T0 + 30 * DAY)
    expect(events.map(e => e.kind)).toEqual(["login"])
  })

  test("ends a recorded logout", () => {
    const loggedOut = applyRefreshRejected(undefined, { at: T0 }).record
    const { record } = applyLogin(loggedOut, { at: T0 + HOUR })
    expect(record.firstUnauthedAt).toBeUndefined()
    expect(record.unauthedReason).toBeUndefined()
  })

  test("forgets the previous login's deadline when the new one is not known yet", () => {
    const old: AuthLifecycleRecord = { refreshTokenExpiresAt: T0 + DAY, events: [] }
    expect(applyLogin(old, { at: T0 }).record.refreshTokenExpiresAt).toBeUndefined()
  })
})

describe("applyRefreshSucceeded", () => {
  test("stamps the refresh without an event while the deadline holds still", () => {
    const start: AuthLifecycleRecord = { refreshTokenExpiresAt: T0 + 20 * DAY, events: [] }
    // A refresh recomputes the deadline from a whole-second countdown.
    const { record, events } = applyRefreshSucceeded(start, { at: T0, refreshTokenExpiresAt: T0 + 20 * DAY + 900 })
    expect(record.lastRefreshAt).toBe(T0)
    expect(events).toEqual([])
  })

  test("a deadline that jumps forward is a login that happened elsewhere", () => {
    const start: AuthLifecycleRecord = { refreshTokenExpiresAt: T0 + DAY, events: [] }
    const later = T0 + DAY + NEW_GRANT_MIN_JUMP_MS + 30 * DAY
    const { record, events } = applyRefreshSucceeded(start, { at: T0, refreshTokenExpiresAt: later })
    expect(events.map(e => e.kind)).toEqual(["new_grant"])
    expect(events[0]!.previousRefreshTokenExpiresAt).toBe(T0 + DAY)
    expect(record.authObtainedAt).toBe(T0)
    expect(record.authObtainedVia).toBe("observed")
    expect(record.refreshTokenExpiresAt).toBe(later)
  })

  test("success after a recorded logout reports the recovery once", () => {
    const loggedOut = applyRefreshRejected({ refreshTokenExpiresAt: T0 + DAY, events: [] }, { at: T0 }).record
    const { record, events } = applyRefreshSucceeded(loggedOut, { at: T0 + HOUR, refreshTokenExpiresAt: T0 + DAY })
    expect(events.map(e => e.kind)).toEqual(["recovered"])
    expect(record.firstUnauthedAt).toBeUndefined()
  })
})

describe("applyRefreshRejected", () => {
  test("the first refusal marks the logout with the deadline it fell on", () => {
    const start: AuthLifecycleRecord = { refreshTokenExpiresAt: T0 - HOUR, events: [] }
    const { record, events } = applyRefreshRejected(start, { at: T0, detail: "invalid_grant" })
    expect(record.firstUnauthedAt).toBe(T0)
    expect(record.unauthedReason).toBe("refresh_rejected")
    expect(events).toEqual([{ at: T0, kind: "logged_out", reason: "refresh_rejected", refreshTokenExpiresAt: T0 - HOUR, detail: "invalid_grant" }])
  })

  test("refusals after the first leave the record alone", () => {
    const once = applyRefreshRejected(undefined, { at: T0 }).record
    const twice = applyRefreshRejected(once, { at: T0 + 45_000 })
    expect(twice.changed).toBe(false)
    expect(twice.record.firstUnauthedAt).toBe(T0)
  })
})

describe("applyObservation", () => {
  test("an unreadable credential never logs an account out", () => {
    expect(applyObservation(undefined, { at: T0, presence: "unknown" }).changed).toBe(false)
  })

  test("a deadline read a second off is the same login and is not rewritten", () => {
    const start: AuthLifecycleRecord = { refreshTokenExpiresAt: T0 + 20 * DAY, events: [] }
    const seen = applyObservation(start, { at: T0, presence: "present", refreshTokenExpiresAt: T0 + 20 * DAY - 700 })
    expect(seen.changed).toBe(false)
    expect(seen.record.refreshTokenExpiresAt).toBe(T0 + 20 * DAY)
  })

  test("a wiped credential is a logout, recorded once", () => {
    const first = applyObservation(undefined, { at: T0, presence: "absent" })
    expect(first.record.unauthedReason).toBe("credentials_cleared")
    expect(first.events.map(e => e.kind)).toEqual(["logged_out"])
    expect(applyObservation(first.record, { at: T0 + 10_000, presence: "absent" }).changed).toBe(false)
  })

  test("a wiped credential coming back is a login, even without a deadline", () => {
    const wiped = applyObservation(undefined, { at: T0, presence: "absent" }).record
    const { record, events } = applyObservation(wiped, { at: T0 + HOUR, presence: "present" })
    expect(events.map(e => e.kind)).toEqual(["new_grant"])
    expect(record.firstUnauthedAt).toBeUndefined()
    expect(record.authObtainedAt).toBe(T0 + HOUR)
    expect(record.authObtainedVia).toBe("observed")
  })

  test("a refused credential still on disk stays logged out until something renews", () => {
    // Its access token keeps working for hours after the refusal.
    const refused = applyRefreshRejected({ refreshTokenExpiresAt: T0 - HOUR, events: [] }, { at: T0 }).record
    const seen = applyObservation(refused, { at: T0 + 60_000, presence: "present", refreshTokenExpiresAt: T0 - HOUR })
    expect(seen.record.firstUnauthedAt).toBe(T0)
    expect(seen.events).toEqual([])
  })

  test("a refused credential replaced by a new login is logged in again", () => {
    const refused = applyRefreshRejected({ refreshTokenExpiresAt: T0 - HOUR, events: [] }, { at: T0 }).record
    const { record, events } = applyObservation(refused, { at: T0 + HOUR, presence: "present", refreshTokenExpiresAt: T0 + 29 * DAY })
    expect(events.map(e => e.kind)).toEqual(["new_grant"])
    expect(record.firstUnauthedAt).toBeUndefined()
  })
})

describe("readAuthLifecycles", () => {
  test("keeps what is usable and drops the rest", () => {
    const parsed = readAuthLifecycles({
      good: { authObtainedAt: T0, authObtainedVia: "login", unauthedReason: "nonsense", events: [{ at: T0, kind: "login" }, { at: "x", kind: "login" }, { at: T0, kind: "bogus" }] },
      bad: "not an object",
      "": { authObtainedAt: T0 },
    })
    expect(Object.keys(parsed)).toEqual(["good"])
    expect(parsed.good!.unauthedReason).toBeUndefined()
    expect(parsed.good!.events).toEqual([{ at: T0, kind: "login" }])
  })

  test("not a map at all reads as empty", () => {
    expect(readAuthLifecycles(null)).toEqual({})
    expect(readAuthLifecycles([])).toEqual({})
  })
})

describe("history", () => {
  test("keeps only the most recent events", () => {
    let record: AuthLifecycleRecord | undefined
    for (let i = 0; i < MAX_AUTH_LIFECYCLE_EVENTS + 5; i++) record = applyLogin(record, { at: T0 + i }).record
    expect(record!.events).toHaveLength(MAX_AUTH_LIFECYCLE_EVENTS)
    expect(record!.events.at(-1)!.at).toBe(T0 + MAX_AUTH_LIFECYCLE_EVENTS + 4)
  })
})

describe("describeAuthLifecycleEvent", () => {
  test("a logout names its deadline and how long the login had lasted", () => {
    const record: AuthLifecycleRecord = { authObtainedAt: T0 - 29 * DAY, refreshTokenExpiresAt: T0 - 3 * HOUR, events: [] }
    const { events } = applyRefreshRejected(record, { at: T0, detail: "invalid_grant" })
    const line = describeAuthLifecycleEvent(events[0]!, record)
    expect(line).toContain("refused (invalid_grant)")
    expect(line).toContain(`${new Date(T0 - 3 * HOUR).toISOString()} (3h 0m ago)`)
    expect(line).toContain("logged in 29d 0h earlier")
  })

  test("formatSpan uses the two largest units", () => {
    expect(formatSpan(29 * DAY + 6 * HOUR + 59_000)).toBe("29d 6h")
    expect(formatSpan(5 * HOUR + 12 * 60_000)).toBe("5h 12m")
    expect(formatSpan(42 * 60_000)).toBe("42m")
  })
})

describe("persistence", () => {
  test("a transition is written and announced; a repeat is neither", () => {
    const key = uniqueKey()
    const heard: AuthLifecycleTransition[] = []
    onAuthLifecycleTransition(t => heard.push(t))
    noteRefreshRejected(key, { at: T0, detail: "invalid_grant" })
    noteRefreshRejected(key, { at: T0 + 45_000, detail: "invalid_grant" })
    expect(authLifecycleFor(key)?.firstUnauthedAt).toBe(T0)
    expect(heard.map(t => t.event.kind)).toEqual(["logged_out"])
    expect(heard[0]!.key).toBe(key)
  })

  test("observing returns the record as it now stands", () => {
    const key = uniqueKey()
    noteAuthLogin(key, { at: T0, refreshTokenExpiresAt: T0 + 30 * DAY })
    const record = noteCredentialObserved(key, { at: T0 + HOUR, presence: "present", refreshTokenExpiresAt: T0 + 30 * DAY })
    expect(record?.authObtainedAt).toBe(T0)
    expect(record?.authObtainedVia).toBe("login")
  })

  test("a credential without an identity is never recorded", () => {
    expect(noteCredentialObserved(undefined, { presence: "absent" })).toBeUndefined()
  })

  test("a rename carries the record to the new key", () => {
    const from = uniqueKey()
    const to = uniqueKey()
    noteAuthLogin(from, { at: T0 })
    renameAuthLifecycleKey(from, to)
    expect(authLifecycleFor(from)).toBeUndefined()
    expect(authLifecycleFor(to)?.authObtainedAt).toBe(T0)
  })

  test("a listener that throws cannot fail the transition", () => {
    const key = uniqueKey()
    onAuthLifecycleTransition(() => { throw new Error("log sink down") })
    expect(() => noteRefreshRejected(key, { at: T0 })).not.toThrow()
    expect(authLifecycleFor(key)?.firstUnauthedAt).toBe(T0)
  })
})

// ---------------------------------------------------------------------------
// The refresh and login paths that feed it
// ---------------------------------------------------------------------------

function keyedStore(refreshToken: string, refreshTokenExpiresAt?: number) {
  let stored: CredentialsFile = {
    claudeAiOauth: {
      accessToken: "old-access",
      refreshToken,
      expiresAt: Date.now() - 1000,
      ...(refreshTokenExpiresAt ? { refreshTokenExpiresAt } : {}),
    },
  }
  const store: CredentialStore = {
    refreshKey: uniqueKey(),
    async read() { return JSON.parse(JSON.stringify(stored)) as CredentialsFile },
    async write(credentials) { stored = credentials; return true },
  }
  return { store, rotate: (next: string) => { stored.claudeAiOauth.refreshToken = next } }
}

describe("refreshOAuthToken feeds the record", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetInflightRefresh()
  })

  function respond(status: number, body: unknown, onCall?: () => void): void {
    globalThis.fetch = (async () => {
      onCall?.()
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch
  }

  test("a successful refresh is stamped with the deadline it reported", async () => {
    const { store } = keyedStore("rt-1")
    respond(200, { access_token: "a", refresh_token: "rt-2", expires_in: 28_800, refresh_token_expires_in: 10 * 86_400 })
    expect(await refreshOAuthToken(store)).toBe(true)
    const record = authLifecycleFor(store.refreshKey)!
    expect(record.lastRefreshAt).toBeGreaterThan(Date.now() - 5000)
    expect(record.refreshTokenExpiresAt! - Date.now()).toBeGreaterThan(10 * DAY - 5000)
  })

  test("invalid_grant is a logout", async () => {
    const { store } = keyedStore("rt-1", Date.now() - HOUR)
    respond(400, { error: "invalid_grant", error_description: "Refresh token expired" })
    expect(await refreshOAuthToken(store)).toBe(false)
    const record = authLifecycleFor(store.refreshKey)!
    expect(record.unauthedReason).toBe("refresh_rejected")
    expect(record.events.at(-1)!.detail).toBe("invalid_grant")
  })

  test("a refusal of a token rotated elsewhere meanwhile is not a logout", async () => {
    const { store, rotate } = keyedStore("rt-1")
    respond(400, { error: "invalid_grant" }, () => rotate("rt-rotated-by-claude-code"))
    expect(await refreshOAuthToken(store)).toBe(false)
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
  })

  test("nor is one whose rotation is written down only after the refusal arrives", async () => {
    const { store, rotate } = keyedStore("rt-1")
    respond(400, { error: "invalid_grant" }, () => { setTimeout(() => rotate("rt-written-late"), ROTATION_SETTLE_MS / 3) })
    expect(await refreshOAuthToken(store)).toBe(false)
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
  })

  test("only the first refusal waits to see whether the token was rotated", async () => {
    const { store } = keyedStore("rt-1", Date.now() - HOUR)
    respond(400, { error: "invalid_grant" })
    await refreshOAuthToken(store)
    const startedAt = Date.now()
    await refreshOAuthToken(store)
    expect(Date.now() - startedAt).toBeLessThan(ROTATION_SETTLE_MS)
    expect(authLifecycleFor(store.refreshKey)!.events.filter(e => e.kind === "logged_out")).toHaveLength(1)
  })

  test("an outage says nothing about the login", async () => {
    const { store } = keyedStore("rt-1")
    respond(503, { error: "overloaded" })
    expect(await refreshOAuthToken(store)).toBe(false)
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
  })
})

describe("oauthErrorCode", () => {
  test("reads both error shapes and nothing that is not a code", () => {
    expect(oauthErrorCode(JSON.stringify({ error: "invalid_grant" }))).toBe("invalid_grant")
    expect(oauthErrorCode(JSON.stringify({ error: { type: "invalid_grant", message: "x" } }))).toBe("invalid_grant")
    expect(oauthErrorCode(JSON.stringify({ error: "Bearer abc.def" }))).toBeUndefined()
    expect(oauthErrorCode("<html>")).toBeUndefined()
  })
})

describe("buildLoginCredentials", () => {
  const tokens = { access_token: "a", refresh_token: "r", expires_in: 28_800 }

  test("keeps the deadline the login came with", () => {
    const credentials = buildLoginCredentials({ ...tokens, refresh_token_expires_in: 30 * 86_400 }, {}, T0)
    expect(credentials.claudeAiOauth.refreshTokenExpiresAt).toBe(T0 + 30 * DAY)
  })

  test("writes no deadline rather than a wrong one", () => {
    expect(buildLoginCredentials(tokens, {}, T0).claudeAiOauth).not.toHaveProperty("refreshTokenExpiresAt")
    const past = buildLoginCredentials({ ...tokens, refresh_token_expires_at: T0 - 1 }, {}, T0)
    expect(past.claudeAiOauth).not.toHaveProperty("refreshTokenExpiresAt")
  })
})
