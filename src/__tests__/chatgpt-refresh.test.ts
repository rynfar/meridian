/**
 * Task 5 - exchanging a ChatGPT refresh token, as the only process allowed to.
 *
 * A refresh token is spent by being used. The replacement arrives in the
 * response and exists nowhere else, so the ONLY failure that matters here is
 * losing it: an account whose replacement was never written down is not
 * degraded, it is gone until a human logs in again.
 *
 * That shapes every test below. The exchange may not be dispatched unless this
 * process can already write the result. The result must be on disk before any
 * caller can act on it. And an exchange whose outcome cannot be established
 * must never be retried with the same token - a second attempt is what turns
 * "we may have lost the replacement" into `refresh_token_reused`.
 *
 * Every exchange here is a mock. Nothing in this file may reach
 * auth.openai.com, and no production account appears in it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireWriterLease } from "../proxy/chatgpt/lease"
import {
  createChatGptCredentialStore,
  type ChatGptAccount,
  type ChatGptCredentialStore,
} from "../proxy/chatgpt/credentials"
import { createChatGptRefresher, MAX_SEAT_RENEWALS, type RefreshOutcome } from "../proxy/chatgpt/refresh"

const LEASE_MODULE = join(import.meta.dir, "../proxy/chatgpt/lease.ts")
const STORE_MODULE = join(import.meta.dir, "../proxy/chatgpt/credentials.ts")
const REFRESH_MODULE = join(import.meta.dir, "../proxy/chatgpt/refresh.ts")

const SEAT = "seat-C0RSu9"
const STORED_REFRESH = "stored-refresh-token"

let dir: string
let lockPath: string
let storePath: string
let sentinelPath: string
const held: Array<{ release(): void }> = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meridian-chatgpt-refresh-"))
  lockPath = join(dir, "chatgpt.lock")
  storePath = join(dir, "chatgpt-accounts.json")
  sentinelPath = join(dir, "exchange-was-dispatched")
})

afterEach(() => {
  while (held.length > 0) {
    try { held.pop()?.release() } catch { /* already released by the test */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

function seat(overrides: Partial<ChatGptAccount> = {}): ChatGptAccount {
  return {
    accountUserId: SEAT,
    accountId: "05cd9f04-1111-2222-3333-444444989a40",
    email: "seat@example.test",
    refreshToken: STORED_REFRESH,
    accessToken: "stale-access-token",
    expiresAt: 1,
    tokenRotatedAt: null,
    exchangeStartedAt: null,
    ...overrides,
  }
}

async function seededStore(): Promise<ChatGptCredentialStore> {
  const lease = await acquireWriterLease({ lockPath, staleMs: 400, heartbeatMs: 80, waitMs: 0 })
  held.push(lease)
  const store = createChatGptCredentialStore({ path: storePath, lease })
  store.commitAccount(SEAT, () => seat())
  return store
}

function onDisk(): ChatGptAccount | undefined {
  return createChatGptCredentialStore({ path: storePath }).readAccount(SEAT)
}

interface RecordedCall {
  url: string
  init: RequestInit
}

/** A mock token endpoint that records every dispatch. `reply` sees the 1-based call number. */
function endpoint(reply: (call: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  return {
    calls,
    fetchImpl: async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return reply(calls.length)
    },
  }
}

function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function formFields(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(init.body)))
}

describe("ChatGPT refresh - the outbound exchange", () => {
  it("posts the form-encoded grant to the constant token endpoint and nothing else", async () => {
    const store = await seededStore()
    const mock = endpoint(() => tokenResponse({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }))

    await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl }).refreshAccount(SEAT)

    expect(mock.calls).toHaveLength(1)
    const [call] = mock.calls
    expect(call!.url).toBe("https://auth.openai.com/oauth/token")
    expect(call!.init.method).toBe("POST")
    expect(new Headers(call!.init.headers).get("content-type")).toBe("application/x-www-form-urlencoded")
    // A bearer credential must never be replayed to a redirect target.
    expect(call!.init.redirect).toBe("error")
    expect(formFields(call!.init)).toEqual({
      grant_type: "refresh_token",
      refresh_token: STORED_REFRESH,
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    })
    expect(new Headers(call!.init.headers).get("authorization")).toBeNull()
  })
})

describe("ChatGPT refresh - the replacement reaches disk before any caller", () => {
  it("has already committed the rotated token at the instant it resolves", async () => {
    const store = await seededStore()
    const mock = endpoint(() => tokenResponse({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }))

    // Read on the resolution itself, not after awaiting elsewhere. An
    // implementation that returned the access token and committed afterwards
    // hands a caller a credential whose replacement is still only in memory.
    let refreshTokenAtResolution: string | undefined
    const outcome = await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })
      .refreshAccount(SEAT)
      .then(settled => {
        refreshTokenAtResolution = onDisk()?.refreshToken
        return settled
      })

    expect(refreshTokenAtResolution).toBe("rotated-refresh")
    expect(outcome).toMatchObject({ status: "refreshed", accountUserId: SEAT, accessToken: "fresh-access" })
  })

  it("retains the previous refresh token when the provider rotates nothing", async () => {
    const store = await seededStore()
    const mock = endpoint(() => tokenResponse({ access_token: "fresh-access", expires_in: 3600 }))

    const outcome = await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl }).refreshAccount(SEAT)

    expect(outcome.status).toBe("refreshed")
    expect(onDisk()?.refreshToken).toBe(STORED_REFRESH)
    expect(onDisk()?.accessToken).toBe("fresh-access")
  })

  it("stamps the expiry from the provider's own lifetime", async () => {
    const store = await seededStore()
    const mock = endpoint(() => tokenResponse({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    }))

    const outcome = await createChatGptRefresher({
      store,
      fetchImpl: mock.fetchImpl,
      now: () => 1_000_000,
    }).refreshAccount(SEAT)

    expect(outcome).toMatchObject({ status: "refreshed", expiresAt: 1_000_000 + 3_600_000 })
    expect(onDisk()?.expiresAt).toBe(1_000_000 + 3_600_000)
  })
})

describe("ChatGPT refresh - exactly one writer", () => {
  it("collapses concurrent refreshes of one seat into a single exchange", async () => {
    const store = await seededStore()
    const mock = endpoint(async () => {
      await new Promise(resolve => setTimeout(resolve, 25))
      return tokenResponse({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    })
    const refresher = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })

    const outcomes = await Promise.all([
      refresher.refreshAccount(SEAT),
      refresher.refreshAccount(SEAT),
      refresher.refreshAccount(SEAT),
    ])

    // A second exchange would be a second use of a single-use token.
    expect(mock.calls).toHaveLength(1)
    expect(outcomes.map(o => o.status)).toEqual(["refreshed", "refreshed", "refreshed"])
    expect(onDisk()?.refreshToken).toBe("rotated-refresh")
  })

  it("keeps a sign-in that finished while a renewal was out, rather than writing the older chain over it", async () => {
    const store = await seededStore()
    let answer!: () => void
    const answered = new Promise<void>(resolve => { answer = resolve })
    const mock = endpoint(async () => {
      await answered
      return tokenResponse({ access_token: "old-chain-access", refresh_token: "old-chain-rotated", expires_in: 3600 })
    })
    const refresher = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })

    const renewing = refresher.refreshAccount(SEAT)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mock.calls).toHaveLength(1)
    store.commitAccount(SEAT, () => seat({ refreshToken: "signed-in-refresh", accessToken: "signed-in-access", expiresAt: 9_999_999_999_999 }))
    answer()

    expect(await renewing).toEqual({ status: "refreshed", accountUserId: SEAT, accessToken: "signed-in-access", expiresAt: 9_999_999_999_999 })
    expect(onDisk()).toMatchObject({ refreshToken: "signed-in-refresh", accessToken: "signed-in-access", exchangeStartedAt: null })
  })

  it("settles only once every exchange already dispatched has recorded its result", async () => {
    const store = await seededStore()
    let answer!: () => void
    const answered = new Promise<void>(resolve => { answer = resolve })
    const mock = endpoint(async () => {
      await answered
      return tokenResponse({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    })
    const refresher = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })
    void refresher.refreshAccount(SEAT)
    let settled = false
    const settling = refresher.settle().then(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(settled).toBe(false)
    answer()
    await settling
    expect(onDisk()?.refreshToken).toBe("rotated-refresh")
  })

  it("refuses without write authority BEFORE dispatching anything", async () => {
    const writable = await seededStore()
    expect(writable.readAccount(SEAT)).toBeDefined()

    const mock = endpoint(() => tokenResponse({ access_token: "x", expires_in: 3600 }))
    const readOnly = createChatGptCredentialStore({ path: storePath })

    const outcome = await createChatGptRefresher({ store: readOnly, fetchImpl: mock.fetchImpl })
      .refreshAccount(SEAT)

    // Dispatching first and discovering afterwards that the result cannot be
    // written is precisely how the replacement gets lost.
    expect(mock.calls).toEqual([])
    expect(outcome).toMatchObject({ status: "unavailable", reason: "no-write-authority" })
    expect(onDisk()?.refreshToken).toBe(STORED_REFRESH)
  })

  it("excludes a real second OS process, which then spends nothing", async () => {
    await seededStore()

    const child = Bun.spawn({
      cmd: [process.execPath, "-e", `
        import { acquireWriterLease, WriterLeaseUnavailableError } from ${JSON.stringify(LEASE_MODULE)}
        import { createChatGptCredentialStore } from ${JSON.stringify(STORE_MODULE)}
        import { createChatGptRefresher } from ${JSON.stringify(REFRESH_MODULE)}
        import { writeFileSync } from "node:fs"

        let lease
        try {
          lease = await acquireWriterLease({ lockPath: ${JSON.stringify(lockPath)}, staleMs: 400, heartbeatMs: 80, waitMs: 0 })
        } catch (error) {
          if (!(error instanceof WriterLeaseUnavailableError)) throw error
        }
        if (lease) { console.log("ACQUIRED-LEASE"); process.exit(1) }

        const store = createChatGptCredentialStore({ path: ${JSON.stringify(storePath)}, lease })
        const refresher = createChatGptRefresher({
          store,
          fetchImpl: async () => {
            writeFileSync(${JSON.stringify(sentinelPath)}, "dispatched")
            throw new Error("this exchange must never happen")
          },
        })
        const outcome = await refresher.refreshAccount(${JSON.stringify(SEAT)})
        console.log(JSON.stringify(outcome))
      `],
      stdout: "pipe",
      stderr: "pipe",
    })

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])

    expect(stderr).toBe("")
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.trim()) as RefreshOutcome)
      .toMatchObject({ status: "unavailable", reason: "no-write-authority" })
    expect(existsSync(sentinelPath)).toBe(false)
    expect(onDisk()?.refreshToken).toBe(STORED_REFRESH)
  })
})

describe("ChatGPT refresh - an exchange whose outcome was never recorded", () => {
  /** Any commit attempted once the exchange has been dispatched dies, which is the crash this guards. */
  function storeThatDiesAfterDispatch(
    inner: ChatGptCredentialStore,
    dispatched: () => boolean,
  ): ChatGptCredentialStore {
    return {
      path: inner.path,
      readAccounts: () => inner.readAccounts(),
      readAccount: id => inner.readAccount(id),
      commitAccount: (id, mutate) => {
        if (dispatched()) throw new Error("the process died before the write landed")
        return inner.commitAccount(id, mutate)
      },
      removeAccounts: ids => inner.removeAccounts(ids),
    }
  }

  it("reports REQUIRES-REAUTH on the next attempt and never re-spends the token", async () => {
    const store = await seededStore()
    let dispatched = false
    const mock = endpoint(() => {
      dispatched = true
      return tokenResponse({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    })

    const crashing = createChatGptRefresher({
      store: storeThatDiesAfterDispatch(store, () => dispatched),
      fetchImpl: mock.fetchImpl,
    })
    await crashing.refreshAccount(SEAT).catch(() => undefined)

    expect(mock.calls).toHaveLength(1)
    // The rotated token was never written down, so what is on disk is a token
    // the provider has already retired.
    expect(onDisk()?.refreshToken).toBe(STORED_REFRESH)

    // A fresh refresher on the same store is the restarted process.
    const outcome = await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl }).refreshAccount(SEAT)

    expect(outcome).toMatchObject({ status: "requires-reauth", accountUserId: SEAT })
    expect(mock.calls).toHaveLength(1)
  })

  it("reports REQUIRES-REAUTH when the exchange was dispatched and its result never arrived", async () => {
    const store = await seededStore()
    const mock = endpoint(() => { throw new Error("connection reset") })

    const outcome = await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl }).refreshAccount(SEAT)

    expect(mock.calls).toHaveLength(1)
    expect(outcome).toMatchObject({ status: "requires-reauth" })

    // Retrying is the move that turns "may have been spent" into certainly
    // spent twice, so the next attempt must not reach the provider at all.
    const again = await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl }).refreshAccount(SEAT)
    expect(again).toMatchObject({ status: "requires-reauth" })
    expect(mock.calls).toHaveLength(1)
  })

  it.each([429, 500, 502, 503])("does not replay a possibly consumed grant after HTTP %s", async (status) => {
    const store = await seededStore()
    const mock = endpoint(call => call === 1
      ? tokenResponse({ error: "upstream_fault" }, status)
      : tokenResponse({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 }))
    const refresher = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })

    const declined = await refresher.refreshAccount(SEAT)
    expect(declined).toMatchObject({ status: "requires-reauth", reason: "unverifiable" })
    expect(onDisk()?.exchangeStartedAt).not.toBeNull()

    const later = await refresher.refreshAccount(SEAT)
    expect(later).toMatchObject({ status: "requires-reauth", reason: "interrupted" })
    const restarted = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })
    expect(await restarted.refreshAccount(SEAT)).toMatchObject({ status: "requires-reauth", reason: "interrupted" })
    expect(mock.calls).toHaveLength(1)
  })

  it("treats an explicit rejection as needing a human, without a second attempt", async () => {
    const store = await seededStore()
    const mock = endpoint(() => tokenResponse({ error: "invalid_grant" }, 400))
    const refresher = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl })

    expect(await refresher.refreshAccount(SEAT)).toMatchObject({ status: "requires-reauth", reason: "rejected" })
    expect(await refresher.refreshAccount(SEAT)).toMatchObject({ status: "requires-reauth" })
    expect(mock.calls).toHaveLength(1)
  })
})

describe("ChatGPT refresh - nothing it says contains a credential", () => {
  it("keeps the token, the body and the provider's own wording out of everything it emits", async () => {
    const store = await seededStore()
    const detail = "the token ending 9f04 was already redeemed by another client"
    const mock = endpoint(() => tokenResponse({ error: "invalid_grant", detail }, 400))

    const written: string[] = []
    const original = { log: console.log, warn: console.warn, error: console.error }
    console.log = (...args: unknown[]) => { written.push(args.join(" ")) }
    console.warn = (...args: unknown[]) => { written.push(args.join(" ")) }
    console.error = (...args: unknown[]) => { written.push(args.join(" ")) }

    let outcome: RefreshOutcome
    try {
      outcome = await createChatGptRefresher({ store, fetchImpl: mock.fetchImpl }).refreshAccount(SEAT)
    } finally {
      console.log = original.log
      console.warn = original.warn
      console.error = original.error
    }

    // An account that has gone unrefreshable must be VISIBLE - a silent one is
    // how an instance serves plausible answers nobody can explain - so this
    // asserts what it says rather than that it stays quiet.
    expect(written.join("\n")).toContain(SEAT)
    for (const secret of [STORED_REFRESH, detail, "invalid_grant"]) {
      expect(written.join("\n")).not.toContain(secret)
      expect(JSON.stringify(outcome)).not.toContain(secret)
    }
  })
})

// Which refusal it was is what tells a login that aged out from one spent by a
// second process, and nothing kept it: the 2026-10-02 refusals could not be
// told apart afterwards. The three causes are the ones the Codex CLI itself
// distinguishes, recorded in this module's words, never the provider's.
describe("ChatGPT refresh - why a refresh was refused", () => {
  async function refuseWith(id: string, response: Response) {
    const store = await seededStore()
    store.commitAccount(id, () => seat({ accountUserId: id }))
    const written: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { written.push(args.join(" ")) }
    try {
      const outcome = await createChatGptRefresher({ store, fetchImpl: async () => response }).refreshAccount(id)
      return { outcome, written: written.join("\n") }
    } finally {
      console.error = original
    }
  }

  const causes: Array<[string, string]> = [
    ["refresh_token_expired", "refresh token expired"],
    ["refresh_token_reused", "refresh token already used"],
    ["refresh_token_invalidated", "refresh token revoked"],
  ]
  causes.forEach(([code, cause], index) => {
    it(`records ${code} as "${cause}", and nothing of the body`, async () => {
      const message = "the token ending 9f04 can no longer be used"
      const { outcome, written } = await refuseWith(`seat-cause-${index}`, tokenResponse({ error: { code, message } }, 401))
      expect(outcome).toMatchObject({ status: "requires-reauth", reason: "rejected", cause })
      expect(written).toContain(`(rejected: ${cause})`)
      for (const secret of [STORED_REFRESH, message, code]) {
        expect(written).not.toContain(secret)
        expect(JSON.stringify(outcome)).not.toContain(secret)
      }
    })
  })

  it("says only that it was refused when the provider names something else", async () => {
    const { outcome } = await refuseWith("seat-cause-other", tokenResponse({ error: { code: STORED_REFRESH } }, 401))
    expect(outcome).toEqual({ status: "requires-reauth", accountUserId: "seat-cause-other", reason: "rejected" })
  })

  it("records the status of a provider failure, which says nothing about the login", async () => {
    const { outcome } = await refuseWith("seat-cause-503", tokenResponse({ error: "overloaded" }, 503))
    expect(outcome).toMatchObject({ status: "requires-reauth", reason: "unverifiable", cause: "HTTP 503" })
  })
})

// A seat's renewal history is the evidence for how renewal frequency affects
// how long its sign-in lasts: one entry per exchange the provider saw, with
// what came back, kept on the seat's own record in the store.
describe("ChatGPT refresh - the seat's renewal history", () => {
  const AT = 1_700_000_000_000
  const DAY_MS = 24 * 3_600_000
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

  async function refreshOnce(reply: () => Response) {
    const store = await seededStore()
    const mock = endpoint(reply)
    const refresher = createChatGptRefresher({ store, fetchImpl: mock.fetchImpl, now: () => AT })
    const outcome = await refresher.refreshAccount(SEAT)
    return { store, refresher, mock, outcome }
  }

  it("records a renewal that rotated the refresh token, with the new token's issue and expiry times", async () => {
    const accessToken = `${part({ alg: "none" })}.${part({ iat: AT / 1000, exp: (AT + 10 * DAY_MS) / 1000 })}.sig`
    await refreshOnce(() => tokenResponse({ access_token: accessToken, refresh_token: "rotated", expires_in: 10 * DAY_MS / 1000 }))
    expect(onDisk()?.renewals).toEqual([{ at: AT, outcome: "rotated", issuedAt: AT, expiresAt: AT + 10 * DAY_MS }])
  })

  it("records a renewal that kept the refresh token", async () => {
    await refreshOnce(() => tokenResponse({ access_token: "opaque", expires_in: 3600 }))
    expect(onDisk()?.renewals).toEqual([{ at: AT, outcome: "kept", expiresAt: AT + 3_600_000 }])
  })

  it("records a refusal with its cause beside the stamp, and nothing for the attempts that never reached the provider", async () => {
    const { refresher, mock } = await refreshOnce(() => tokenResponse({ error: { code: "refresh_token_reused" } }, 401))
    expect(await refresher.refreshAccount(SEAT)).toMatchObject({ status: "requires-reauth", reason: "interrupted" })
    expect(mock.calls).toHaveLength(1)
    expect(onDisk()).toMatchObject({ exchangeStartedAt: AT, renewals: [{ at: AT, outcome: "refused", cause: "refresh token already used" }] })
  })

  it("records a provider failure as unverified, with its status", async () => {
    await refreshOnce(() => tokenResponse({ error: "overloaded" }, 503))
    expect(onDisk()).toMatchObject({ exchangeStartedAt: AT, renewals: [{ at: AT, outcome: "unverified", cause: "HTTP 503" }] })
  })

  it("keeps only the latest renewals, and drops a malformed entry it reads back", async () => {
    const store = await seededStore()
    const old = Array.from({ length: MAX_SEAT_RENEWALS }, (_, i) => ({ at: AT - (i + 1) * DAY_MS, outcome: "kept" as const }))
    store.commitAccount(SEAT, current => ({ ...current!, renewals: old }))
    await createChatGptRefresher({ store, fetchImpl: endpoint(() => tokenResponse({ access_token: "opaque", expires_in: 3600 })).fetchImpl, now: () => AT }).refreshAccount(SEAT)
    const renewals = onDisk()!.renewals!
    expect(renewals).toHaveLength(MAX_SEAT_RENEWALS)
    expect(renewals.at(-1)).toEqual({ at: AT, outcome: "kept", expiresAt: AT + 3_600_000 })

    const raw = JSON.parse(readFileSync(storePath, "utf8")) as { accounts: Array<Record<string, unknown>> }
    raw.accounts[0]!.renewals = [{ at: AT, outcome: "sideways" }, { outcome: "kept" }, { at: AT, outcome: "refused", cause: "x".repeat(65) }]
    writeFileSync(storePath, JSON.stringify(raw))
    expect(onDisk()?.renewals).toEqual([{ at: AT, outcome: "refused" }])
  })
})
