/**
 * Login history (authLifecycle.ts) and the refresh and login paths that feed
 * it. Transitions are pure and asserted directly; persistence goes through the
 * real module with MERIDIAN_CONFIG_DIR redirected by the preload, each test on
 * its own credential key. The concurrent-writer control runs two real
 * processes against one file.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configPath } from "../configDir"
import {
  MAX_AUTH_LIFECYCLE_EVENTS,
  applyLogin,
  applyObservation,
  applyRefreshRejected,
  applyRefreshSucceeded,
  authLifecycleFor,
  authLifecycleLoggedOut,
  authLifecycles,
  describeAuthLifecycleEvent,
  formatSpan,
  noteAuthLogin,
  noteCredentialObserved,
  observeCredentialInBackground,
  noteRefreshRejected,
  noteRefreshSucceeded,
  onAuthLifecycleTransition,
  readAuthLifecycles,
  refreshTokenId,
  renameAuthLifecycleKey,
  resetAuthLifecycleListenersForTesting,
  settleAuthLifecycleWrites,
  type AuthLifecycleRecord,
  type AuthLifecycleTransition,
} from "../proxy/authLifecycle"
import { ROTATION_SETTLE_MS, oauthErrorCode, refreshOAuthToken, resetInflightRefresh, type CredentialStore, type CredentialsFile } from "../proxy/tokenRefresh"
import { exchangeAuthorizationCodeForCredentials } from "../proxy/profileCli"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const T0 = 1_790_000_000_000
const OLD = refreshTokenId("rt-old")!
const NEW = refreshTokenId("rt-new")!

let keySeq = 0
function uniqueKey(): string {
  return `test:${process.pid}:${Date.now()}:${keySeq++}`
}

afterEach(() => {
  resetAuthLifecycleListenersForTesting()
})

/** A login on record, renewed once by Meridian, then refused. */
function refusedGrant(deadline = T0 + 29 * DAY): AuthLifecycleRecord {
  let record = applyLogin(undefined, { at: T0 - DAY, refreshTokenExpiresAt: deadline, refreshTokenId: OLD }).record
  record = applyRefreshSucceeded(record, { at: T0 - HOUR, refreshTokenExpiresAt: deadline, refreshTokenId: OLD }).record
  return applyRefreshRejected(record, { at: T0 - 1000, detail: "invalid_grant", refreshTokenId: OLD }).record
}

describe("applyLogin", () => {
  test("records when and how the login happened, with its deadline and token", () => {
    const { record, events } = applyLogin(undefined, { at: T0, refreshTokenExpiresAt: T0 + 30 * DAY, refreshTokenId: NEW })
    expect(record).toMatchObject({ authObtainedAt: T0, authObtainedVia: "login", refreshTokenExpiresAt: T0 + 30 * DAY, refreshTokenId: NEW })
    expect(events.map(e => e.kind)).toEqual(["login"])
  })

  // Review finding 6: the previous grant's renewal is not this grant's.
  test("keeps nothing of the previous grant: no last refresh, no logout, no deadline", () => {
    const { record } = applyLogin(refusedGrant(), { at: T0, refreshTokenId: NEW })
    expect(record.lastRefreshAt).toBeUndefined()
    expect(record.firstUnauthedAt).toBeUndefined()
    expect(record.unauthedReason).toBeUndefined()
    expect(record.refreshTokenExpiresAt).toBeUndefined()
    expect(record.events.map(e => e.kind)).toEqual(["login", "logged_out", "login"])
  })
})

describe("applyObservation", () => {
  test("an unreadable credential changes nothing", () => {
    expect(applyObservation(refusedGrant(), { at: T0, presence: "unknown" }).changed).toBe(false)
  })

  test("the same token with its deadline read a second off is not rewritten", () => {
    const start: AuthLifecycleRecord = { refreshTokenExpiresAt: T0 + 20 * DAY, refreshTokenId: OLD, events: [] }
    expect(applyObservation(start, { at: T0, presence: "present", refreshTokenExpiresAt: T0 + 20 * DAY - 700, refreshTokenId: OLD }).changed).toBe(false)
  })

  test("a credential with no access token is a logout, recorded once", () => {
    const first = applyObservation(undefined, { at: T0, presence: "absent" })
    expect(first.record.unauthedReason).toBe("credentials_cleared")
    expect(applyObservation(first.record, { at: T0 + 10_000, presence: "absent" }).changed).toBe(false)
  })

  test("a refused token still on disk stays refused", () => {
    const seen = applyObservation(refusedGrant(), { at: T0, presence: "present", refreshTokenExpiresAt: T0 + 29 * DAY, refreshTokenId: OLD })
    expect(seen.changed).toBe(false)
    expect(seen.record.unauthedReason).toBe("refresh_rejected")
  })

  // Review finding 4: any new grant replaces the record, whichever way its
  // deadline moved.
  for (const [name, deadline] of [
    ["an earlier deadline", T0 + 28 * DAY],
    ["a later deadline", T0 + 30 * DAY],
    ["a deadline ten minutes later", T0 + 29 * DAY + 10 * 60_000],
  ] as const) {
    test(`a different token with ${name} is a new login, and the refused grant's state is gone`, () => {
      const { record, events } = applyObservation(refusedGrant(), { at: T0, presence: "present", refreshTokenExpiresAt: deadline, refreshTokenId: NEW })
      expect(events.map(e => e.kind)).toEqual(["new_grant"])
      expect(record).toMatchObject({ authObtainedAt: T0, authObtainedVia: "observed", refreshTokenExpiresAt: deadline, refreshTokenId: NEW })
      expect(record.firstUnauthedAt).toBeUndefined()
      expect(record.lastRefreshAt).toBeUndefined()
    })
  }

  test("a different token on the same deadline is the grant rotated elsewhere: its login is kept and it serves again", () => {
    const { record, events } = applyObservation(refusedGrant(), { at: T0, presence: "present", refreshTokenExpiresAt: T0 + 29 * DAY + 1000, refreshTokenId: NEW })
    expect(events.map(e => e.kind)).toEqual(["recovered"])
    expect(record).toMatchObject({ authObtainedAt: T0 - DAY, authObtainedVia: "login", refreshTokenId: NEW })
    expect(record.firstUnauthedAt).toBeUndefined()
  })

  test("a different token without a deadline cannot be dated: login time unknown, nothing of the old grant kept", () => {
    const { record, events } = applyObservation(refusedGrant(), { at: T0, presence: "present", refreshTokenId: NEW })
    expect(events.map(e => e.kind)).toEqual(["credential_replaced"])
    expect(record.authObtainedAt).toBeUndefined()
    expect(record.authObtainedVia).toBeUndefined()
    expect(record.lastRefreshAt).toBeUndefined()
    expect(record.firstUnauthedAt).toBeUndefined()
    expect(record.refreshTokenId).toBe(NEW)
  })

  test("a changed deadline with no token to compare is just as uncertain", () => {
    const legacy: AuthLifecycleRecord = { authObtainedAt: T0 - DAY, authObtainedVia: "login", refreshTokenExpiresAt: T0 + 29 * DAY, firstUnauthedAt: T0 - 1000, unauthedReason: "refresh_rejected", events: [] }
    const { record, events } = applyObservation(legacy, { at: T0, presence: "present", refreshTokenExpiresAt: T0 + 28 * DAY, refreshTokenId: NEW })
    expect(events.map(e => e.kind)).toEqual(["credential_replaced"])
    expect(record.authObtainedAt).toBeUndefined()
    expect(record.firstUnauthedAt).toBeUndefined()
  })

  test("the same token with a moved deadline is evidence, not a login", () => {
    const start = applyLogin(undefined, { at: T0 - DAY, refreshTokenExpiresAt: T0 + 29 * DAY, refreshTokenId: OLD }).record
    const { record, events } = applyObservation(start, { at: T0, presence: "present", refreshTokenExpiresAt: T0 + 20 * DAY, refreshTokenId: OLD })
    expect(events.map(e => e.kind)).toEqual(["deadline_moved"])
    expect(record.authObtainedAt).toBe(T0 - DAY)
  })

  test("a credential back on disk after being cleared authenticates again", () => {
    const wiped = applyObservation({ refreshTokenId: OLD, events: [] }, { at: T0, presence: "absent" }).record
    const { record, events } = applyObservation(wiped, { at: T0 + HOUR, presence: "present", refreshTokenId: OLD })
    expect(events.map(e => e.kind)).toEqual(["recovered"])
    expect(record.firstUnauthedAt).toBeUndefined()
  })
})

describe("applyRefreshSucceeded and applyRefreshRejected", () => {
  test("a renewal stamps the refresh and adopts the rotated token", () => {
    const start = applyLogin(undefined, { at: T0 - DAY, refreshTokenExpiresAt: T0 + 20 * DAY, refreshTokenId: OLD }).record
    const { record, events } = applyRefreshSucceeded(start, { at: T0, refreshTokenExpiresAt: T0 + 20 * DAY + 900, refreshTokenId: NEW })
    expect(record).toMatchObject({ lastRefreshAt: T0, refreshTokenId: NEW, authObtainedAt: T0 - DAY })
    expect(events).toEqual([])
  })

  test("a renewal after a recorded refusal reports the recovery", () => {
    const { record, events } = applyRefreshSucceeded(refusedGrant(), { at: T0, refreshTokenId: NEW })
    expect(events.map(e => e.kind)).toEqual(["recovered"])
    expect(record.firstUnauthedAt).toBeUndefined()
  })

  test("the first refusal marks the logout; later ones and refusals of another token change nothing", () => {
    const start = applyLogin(undefined, { at: T0 - DAY, refreshTokenExpiresAt: T0 - HOUR, refreshTokenId: OLD }).record
    const first = applyRefreshRejected(start, { at: T0, detail: "invalid_grant", refreshTokenId: OLD })
    expect(first.record).toMatchObject({ firstUnauthedAt: T0, unauthedReason: "refresh_rejected" })
    expect(first.events).toEqual([{ at: T0, kind: "logged_out", reason: "refresh_rejected", refreshTokenExpiresAt: T0 - HOUR, detail: "invalid_grant" }])
    expect(applyRefreshRejected(first.record, { at: T0 + 45_000, refreshTokenId: OLD }).changed).toBe(false)
    expect(applyRefreshRejected(start, { at: T0, refreshTokenId: NEW }).changed).toBe(false)
  })
})

// Review finding 5: a refused renewal is a countdown while the access token works.
describe("authLifecycleLoggedOut", () => {
  test("a refused renewal is not logged out while its access token still works", () => {
    expect(authLifecycleLoggedOut(refusedGrant(), T0 + 3 * HOUR, T0)).toBe(false)
  })

  test("it is once the access token has run out, or when its expiry is unknown", () => {
    expect(authLifecycleLoggedOut(refusedGrant(), T0 - 1, T0)).toBe(true)
    expect(authLifecycleLoggedOut(refusedGrant(), undefined, T0)).toBe(true)
  })

  test("a cleared credential is logged out whatever its stored expiry says", () => {
    const wiped = applyObservation(undefined, { at: T0, presence: "absent" }).record
    expect(authLifecycleLoggedOut(wiped, T0 + HOUR, T0)).toBe(true)
    expect(authLifecycleLoggedOut(undefined, undefined, T0)).toBe(false)
  })
})

describe("readAuthLifecycles", () => {
  test("keeps what is usable and drops the rest", () => {
    const parsed = readAuthLifecycles({
      good: { authObtainedAt: T0, authObtainedVia: "login", refreshTokenId: "not-a-hash", firstUnauthedAt: T0, unauthedReason: "nonsense", events: [{ at: T0, kind: "login" }, { at: "x", kind: "login" }, { at: T0, kind: "bogus" }, { at: T0, kind: "logged_out", detail: "Bearer abc" }] },
      bad: "not an object",
      "": { authObtainedAt: T0 },
    })
    expect(Object.keys(parsed)).toEqual(["good"])
    expect(parsed.good).toEqual({ authObtainedAt: T0, authObtainedVia: "login", events: [{ at: T0, kind: "login" }, { at: T0, kind: "logged_out" }] })
    expect(readAuthLifecycles(null)).toEqual({})
    expect(readAuthLifecycles([])).toEqual({})
  })

  test("keeps only the most recent events", () => {
    let record: AuthLifecycleRecord | undefined
    for (let i = 0; i < MAX_AUTH_LIFECYCLE_EVENTS + 5; i++) record = applyLogin(record, { at: T0 + i }).record
    expect(record!.events).toHaveLength(MAX_AUTH_LIFECYCLE_EVENTS)
    expect(record!.events.at(-1)!.at).toBe(T0 + MAX_AUTH_LIFECYCLE_EVENTS + 4)
  })

  test("stores a token's identity, never the token", () => {
    expect(refreshTokenId("rt-secret")).toMatch(/^[0-9a-f]{16}$/)
    expect(refreshTokenId("rt-secret")).not.toContain("secret")
    expect(refreshTokenId(undefined)).toBeUndefined()
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
  test("a transition is written and announced; a repeat is neither", async () => {
    const key = uniqueKey()
    const heard: AuthLifecycleTransition[] = []
    onAuthLifecycleTransition(t => heard.push(t))
    await noteRefreshRejected(key, { at: T0, detail: "invalid_grant" })
    await noteRefreshRejected(key, { at: T0 + 45_000, detail: "invalid_grant" })
    expect(authLifecycleFor(key)?.firstUnauthedAt).toBe(T0)
    expect(heard.map(t => t.event.kind)).toEqual(["logged_out"])
    expect(heard[0]!.key).toBe(key)
  })

  test("observing returns the record as it now stands; an unreadable store returns it unchanged", async () => {
    const key = uniqueKey()
    await noteAuthLogin(key, { at: T0, refreshTokenExpiresAt: T0 + 30 * DAY, refreshToken: "rt-old" })
    const record = await noteCredentialObserved(key, { at: T0 + HOUR, presence: "present", refreshTokenExpiresAt: T0 + 30 * DAY, refreshTokenId: OLD })
    expect(record).toMatchObject({ authObtainedAt: T0, authObtainedVia: "login" })
    expect(await noteCredentialObserved(key, { presence: "unknown" })).toEqual(record!)
    expect(await noteCredentialObserved(undefined, { presence: "absent" })).toBeUndefined()
  })

  test("a rename carries the record to the new key", async () => {
    const from = uniqueKey()
    const to = uniqueKey()
    await noteAuthLogin(from, { at: T0 })
    renameAuthLifecycleKey(from, to)
    expect(authLifecycleFor(from)).toBeUndefined()
    expect(authLifecycleFor(to)?.authObtainedAt).toBe(T0)
  })

  test("a listener that throws cannot fail the transition", async () => {
    const key = uniqueKey()
    onAuthLifecycleTransition(() => { throw new Error("log sink down") })
    await noteRefreshRejected(key, { at: T0 })
    expect(authLifecycleFor(key)?.firstUnauthedAt).toBe(T0)
  })

  // Review finding 1: a writer that cannot read the history never replaces it.
  test("a history that cannot be parsed is left as it is, not overwritten", async () => {
    const file = configPath("auth-lifecycle.json")
    const saved = existsSync(file) ? await Bun.file(file).text() : undefined
    writeFileSync(file, "{ half a file")
    try {
      await noteAuthLogin(uniqueKey(), { at: T0 })
      renameAuthLifecycleKey(uniqueKey(), uniqueKey())
      expect(await Bun.file(file).text()).toBe("{ half a file")
    } finally {
      if (saved === undefined) rmSync(file, { force: true })
      else writeFileSync(file, saved)
    }
  })
})

// Review finding 1: two processes writing at once. The first writer pauses
// between reading the file and publishing its copy, and is released only once
// the second has tried to write. Without cross-process exclusion the second
// writes in that gap and the first then publishes over it, losing its record.
describe("concurrent writers in two processes", () => {
  const WORKER = `
import { mock } from "bun:test"
import * as fs from "node:fs"
const real = { ...fs }
const target = process.env.RACE_TARGET
const say = line => real.writeSync(1, line + "\\n")
mock.module("node:fs", () => ({
  ...real,
  renameSync(from, to) {
    if (process.env.RACE_ROLE === "first" && String(to) === target) {
      say("paused")
      real.readSync(0, Buffer.alloc(1))
    }
    return real.renameSync(from, to)
  },
  openSync(path, ...rest) {
    try { return real.openSync(path, ...rest) }
    catch (error) {
      if (process.env.RACE_ROLE === "second" && String(path) === target + ".lock" && error.code === "EEXIST") say("blocked")
      throw error
    }
  },
}))
const { noteAuthLogin } = await import(process.env.RACE_MODULE)
await noteAuthLogin(process.env.RACE_KEY, { at: 1790000000000, refreshToken: "rt-" + process.env.RACE_KEY })
say("done")
`

  async function untilLine(child: { stdout: ReadableStream<Uint8Array> }, wanted: string[]): Promise<string> {
    const reader = child.stdout.getReader()
    let seen = ""
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return "exited"
        seen += new TextDecoder().decode(value)
        const hit = wanted.find(line => seen.split("\n").includes(line))
        if (hit) return hit
      }
    } finally {
      reader.releaseLock()
    }
  }

  test("both writers' records survive", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-auth-race-"))
    const worker = join(root, "race-worker.mjs")
    writeFileSync(worker, WORKER)
    const configDir = join(root, "config")
    const env = {
      ...process.env,
      MERIDIAN_CONFIG_DIR: configDir,
      RACE_TARGET: join(configDir, "auth-lifecycle.json"),
      RACE_MODULE: process.env.AUTH_LIFECYCLE_RACE_MODULE ?? join(import.meta.dir, "../proxy/authLifecycle.ts"),
    }
    const spawn = (role: string, key: string) => Bun.spawn([process.execPath, worker], {
      env: { ...env, RACE_ROLE: role, RACE_KEY: key }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    })
    const first = spawn("first", "server")
    let second: ReturnType<typeof spawn> | undefined
    try {
      expect(await untilLine(first, ["paused"])).toBe("paused")
      second = spawn("second", "cli")
      second.stdin.end()
      const secondState = await untilLine(second, ["blocked", "done"])
      first.stdin.write("g")
      first.stdin.end()
      expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0])
      expect(Object.keys(JSON.parse(await Bun.file(env.RACE_TARGET).text())).sort()).toEqual(["cli", "server"])
      expect(secondState).toBe("blocked")
    } finally {
      first.kill()
      second?.kill()
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
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
  let reads = 0
  let readAfterFirst: (() => CredentialsFile | null) | undefined
  const store: CredentialStore = {
    refreshKey: uniqueKey(),
    async read() {
      reads++
      if (reads > 1 && readAfterFirst) return readAfterFirst()
      return JSON.parse(JSON.stringify(stored)) as CredentialsFile
    },
    async write(credentials) { stored = credentials; return true },
  }
  return {
    store,
    rotate: (next: string) => { stored.claudeAiOauth.refreshToken = next },
    /** Every read after the refresh's own returns this instead. */
    afterFirstRead: (read: () => CredentialsFile | null) => { readAfterFirst = read },
  }
}

describe("refreshOAuthToken feeds the record", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetInflightRefresh()
  })

  function respond(status: number, body: string, onCall?: () => void): void {
    globalThis.fetch = (async () => {
      onCall?.()
      return new Response(body, { status, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch
  }

  test("a successful refresh is stamped with its deadline and the rotated token", async () => {
    const { store } = keyedStore("rt-1")
    respond(200, JSON.stringify({ access_token: "a", refresh_token: "rt-2", expires_in: 28_800, refresh_token_expires_in: 10 * 86_400 }))
    expect(await refreshOAuthToken(store)).toBe(true)
    await settleAuthLifecycleWrites()
    const record = authLifecycleFor(store.refreshKey)!
    expect(record.lastRefreshAt).toBeGreaterThan(Date.now() - 5000)
    expect(record.refreshTokenExpiresAt! - Date.now()).toBeGreaterThan(10 * DAY - 5000)
    expect(record.refreshTokenId).toBe(refreshTokenId("rt-2")!)
  })

  test("invalid_grant for the stored token is a logout", async () => {
    const { store } = keyedStore("rt-1", Date.now() - HOUR)
    respond(400, JSON.stringify({ error: "invalid_grant", error_description: "Refresh token expired" }))
    expect(await refreshOAuthToken(store)).toBe(false)
    await settleAuthLifecycleWrites()
    const record = authLifecycleFor(store.refreshKey)!
    expect(record.unauthedReason).toBe("refresh_rejected")
    expect(record.events.at(-1)!.detail).toBe("invalid_grant")
  })

  // Review finding 2: only a grant rejection is a logout.
  for (const [status, body] of [
    [400, JSON.stringify({ error: "invalid_request" })],
    [401, JSON.stringify({ error: "invalid_client" })],
    [400, JSON.stringify({ error: "unsupported_grant_type" })],
    [401, ""],
    [400, "<html>Bad Request</html>"],
    [503, JSON.stringify({ error: "overloaded" })],
  ] as const) {
    test(`${status} ${body || "with no body"} says nothing about the login`, async () => {
      const { store } = keyedStore("rt-1")
      respond(status, body)
      expect(await refreshOAuthToken(store)).toBe(false)
      await settleAuthLifecycleWrites()
      expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
    })
  }

  // Review finding 3: a check that cannot read the store proves nothing.
  test("a refusal whose re-read finds no credential stays unknown", async () => {
    const { store, afterFirstRead } = keyedStore("rt-1")
    afterFirstRead(() => null)
    respond(400, JSON.stringify({ error: "invalid_grant" }))
    expect(await refreshOAuthToken(store)).toBe(false)
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
  })

  test("so does one whose re-read throws, or whose confirming read fails", async () => {
    const failing = keyedStore("rt-1")
    failing.afterFirstRead(() => { throw new Error("keychain locked") })
    respond(400, JSON.stringify({ error: "invalid_grant" }))
    await refreshOAuthToken(failing.store)
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(failing.store.refreshKey)).toBeUndefined()

    const late = keyedStore("rt-1")
    let reads = 0
    late.afterFirstRead(() => (++reads === 1 ? { claudeAiOauth: { accessToken: "a", refreshToken: "rt-1", expiresAt: Date.now() } } : null))
    await refreshOAuthToken(late.store)
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(late.store.refreshKey)).toBeUndefined()
  })

  test("a refusal of a token rotated elsewhere meanwhile is not a logout", async () => {
    const { store, rotate } = keyedStore("rt-1")
    respond(400, JSON.stringify({ error: "invalid_grant" }), () => rotate("rt-rotated-by-claude-code"))
    expect(await refreshOAuthToken(store)).toBe(false)
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
  })

  test("nor is one whose rotation is written down only after the refusal arrives", async () => {
    const { store, rotate } = keyedStore("rt-1")
    respond(400, JSON.stringify({ error: "invalid_grant" }), () => { setTimeout(() => rotate("rt-written-late"), ROTATION_SETTLE_MS / 3) })
    expect(await refreshOAuthToken(store)).toBe(false)
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()
  })
})

// A lock left by an interrupted writer is never cleared automatically, so a
// request that awaited the history would wait out the whole lock timeout.
describe("the history never holds up a request", () => {
  const lock = () => configPath("auth-lifecycle.json") + ".lock"
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
    resetInflightRefresh()
    rmSync(lock(), { force: true })
  })

  test("a refresh returns at once while the history file is locked, and its entry is written once the lock clears", async () => {
    const { store } = keyedStore("rt-1")
    globalThis.fetch = (async () => new Response(JSON.stringify({ access_token: "a", refresh_token: "rt-2", expires_in: 28_800 }), { status: 200 })) as unknown as typeof fetch
    writeFileSync(lock(), "")
    const started = Date.now()
    expect(await refreshOAuthToken(store)).toBe(true)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(authLifecycleFor(store.refreshKey)).toBeUndefined()

    rmSync(lock())
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(store.refreshKey)?.refreshTokenId).toBe(refreshTokenId("rt-2")!)
  })

  test("an observation shows its record before it is written, and repeating it queues no second write", async () => {
    const key = uniqueKey()
    const seen = { presence: "present" as const, refreshTokenExpiresAt: Date.now() + 20 * DAY, refreshTokenId: refreshTokenId("rt-seen")! }
    writeFileSync(lock(), "")
    const started = Date.now()
    const shown = observeCredentialInBackground(key, seen)
    expect(shown?.refreshTokenId).toBe(seen.refreshTokenId)
    expect(observeCredentialInBackground(key, seen)).toEqual(shown)
    expect(Date.now() - started).toBeLessThan(1000)
    expect(authLifecycleFor(key)).toBeUndefined()

    rmSync(lock())
    await settleAuthLifecycleWrites()
    expect(authLifecycleFor(key)).toEqual(shown)
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

describe("a Meridian login", () => {
  test.skipIf(process.platform === "darwin")("records a fresh grant: the previous one's renewal and logout are gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "meridian-login-history-"))
    try {
      const fetchFn = (async (url: string | URL | Request) => String(url).includes("/oauth/token")
        ? new Response(JSON.stringify({ access_token: "a", refresh_token: "rt-login", expires_in: 28_800, refresh_token_expires_in: 30 * 86_400 }))
        : new Response("{}", { status: 404 })) as unknown as typeof fetch
      const first = await exchangeAuthorizationCodeForCredentials({ code: "c", codeVerifier: "v", sessionState: "s", claudeConfigDir: dir, fetchFn })
      expect(first.ok).toBe(true)
      const key = Object.entries(authLifecycles()).find(([, record]) => record.refreshTokenId === refreshTokenId("rt-login"))![0]
      await noteRefreshSucceeded(key, { at: Date.now(), refreshToken: "rt-login" })
      await noteRefreshRejected(key, { at: Date.now(), refreshToken: "rt-login", detail: "invalid_grant" })

      expect((await exchangeAuthorizationCodeForCredentials({ code: "c", codeVerifier: "v", sessionState: "s", claudeConfigDir: dir, fetchFn })).ok).toBe(true)
      const record = authLifecycleFor(key)!
      expect(record.authObtainedVia).toBe("login")
      expect(record.lastRefreshAt).toBeUndefined()
      expect(record.firstUnauthedAt).toBeUndefined()
      expect(record.refreshTokenExpiresAt! - Date.now()).toBeGreaterThan(30 * DAY - 60_000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
