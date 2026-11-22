/**
 * Renewing owned ChatGPT seats ahead of expiry, whether or not work is sent
 * to them.
 *
 * A request renews only the seat it is routed to, and only in the last five
 * minutes of that seat's access token. A seat no work went to therefore ran
 * out ten days after its last renewal and was listed as logged out, though
 * nothing had refused it: four seats renewed together on 2026-09-29 ran out
 * within a minute of each other on 2026-10-09.
 *
 * Each pass renews one seat, the most overdue, 80% into its token's life: the
 * eighth of ChatGPT's ten days, the age at which the Codex CLI renews its own.
 * It makes no exchange for a younger token, none for a seat already waiting
 * for a sign-in, none without the lease, and none for six hours after the
 * provider failed one, since a failed exchange leaves its seat needing a
 * sign-in.
 *
 * A running server looks once a minute. Shutting down, it waits for a renewal
 * still out before giving up the lease: that renewal may have spent its seat's
 * refresh token, and only the lease can record the one that replaced it.
 *
 * Every exchange is a mock. Nothing here reaches auth.openai.com.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatGptCredentialStore, type ChatGptAccount } from "../proxy/chatgpt/credentials"
import { acquireWriterLease } from "../proxy/chatgpt/lease"
import { createOwnedCredentialSource, renewalDueAt, startRenewalSchedule } from "../proxy/chatgpt/owned"
import { chatGptLockPath } from "../proxy/chatgpt/paths"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
const token = (issuedAt: number, expiresAt: number) =>
  `${part({ alg: "none" })}.${part({ iat: issuedAt / 1000, exp: expiresAt / 1000 })}.sig`

/** A seat whose current ten-day access token was issued at `issuedAt`. */
function account(id: string, issuedAt: number, overrides: Partial<ChatGptAccount> = {}): ChatGptAccount {
  return {
    accountUserId: id,
    accountId: `workspace-${id}`,
    email: null,
    refreshToken: `refresh-${id}`,
    accessToken: token(issuedAt, issuedAt + 10 * DAY),
    expiresAt: issuedAt + 10 * DAY,
    tokenRotatedAt: issuedAt,
    exchangeStartedAt: null,
    ...overrides,
  }
}

let clock = NOW

const renewed = (refreshToken: string) => new Response(JSON.stringify({
  access_token: token(clock, clock + 10 * DAY),
  refresh_token: `rotated-${refreshToken}`,
  expires_in: 10 * DAY / 1000,
}), { status: 200, headers: { "content-type": "application/json" } })

const refused = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

let dir: string
let storePath: string
const held: Array<{ release(): void }> = []

beforeEach(() => {
  clock = NOW
  dir = mkdtempSync(join(tmpdir(), "meridian-chatgpt-renewal-"))
  storePath = join(dir, "chatgpt-accounts.json")
})

afterEach(() => {
  while (held.length > 0) held.pop()?.release()
  rmSync(dir, { recursive: true, force: true })
})

async function seed(accounts: ChatGptAccount[]): Promise<void> {
  const lease = await acquireWriterLease({ lockPath: chatGptLockPath(storePath), staleMs: 400, heartbeatMs: 80, waitMs: 0 })
  try {
    const store = createChatGptCredentialStore({ path: storePath, lease })
    for (const seat of accounts) store.commitAccount(seat.accountUserId, () => seat)
  } finally {
    lease.release()
  }
}

/** An owned source over the seeded store, with a mock token endpoint that records which refresh tokens it was sent. */
function owned(reply: (refreshToken: string) => Response | Promise<Response> = renewed) {
  const sent: string[] = []
  const source = createOwnedCredentialSource({
    storePath,
    staleMs: 400,
    heartbeatMs: 80,
    now: () => clock,
    fetchImpl: async (_url, init) => {
      const refreshToken = new URLSearchParams(String(init.body)).get("refresh_token") ?? ""
      sent.push(refreshToken)
      return reply(refreshToken)
    },
  })!
  held.push(source)
  return { source, sent }
}

function onDisk(id: string): ChatGptAccount | undefined {
  return createChatGptCredentialStore({ path: storePath }).readAccount(id)
}

const nothing = { due: [], outcome: null }

describe("renewalDueAt", () => {
  it("is 80% into the access token's life: the eighth of ChatGPT's ten days", () => {
    expect(renewalDueAt(account("a", NOW))).toBe(NOW + 8 * DAY)
  })

  it("renews a token that does not say when it was issued when a request would, five minutes before expiry", () => {
    expect(renewalDueAt({ accessToken: "opaque", expiresAt: NOW + 5 * DAY })).toBe(NOW + 5 * DAY - 5 * MINUTE)
  })

  it("is due at once for a seat with no access token or no expiry", () => {
    expect(renewalDueAt({ accessToken: null, expiresAt: NOW + DAY })).toBe(0)
    expect(renewalDueAt({ accessToken: token(NOW, NOW + DAY), expiresAt: null })).toBe(0)
  })
})

describe("renewing owned seats ahead of expiry", () => {
  it("renews a seat 80% into its token's life and leaves a younger one alone", async () => {
    await seed([account("old", NOW - 9 * DAY), account("young", NOW - DAY)])
    const { source, sent } = owned()
    await source.acquire()

    const pass = await source.renewDue!()
    expect(pass.due).toEqual(["old"])
    expect(pass.outcome).toMatchObject({ status: "refreshed", accountUserId: "old" })
    expect(sent).toEqual(["refresh-old"])
    expect(onDisk("old")).toMatchObject({ refreshToken: "rotated-refresh-old", expiresAt: NOW + 10 * DAY })
    expect(onDisk("young")).toMatchObject({ refreshToken: "refresh-young", expiresAt: NOW + 9 * DAY })

    expect(await source.renewDue!()).toEqual(nothing)
    expect(sent).toHaveLength(1)
  })

  it("renews a seat whose token already ran out because no work was sent to it", async () => {
    await seed([account("idle", NOW - 10 * DAY - 2 * HOUR)])
    const { source, sent } = owned()
    await source.acquire()

    expect((await source.renewDue!()).outcome).toMatchObject({ status: "refreshed", accountUserId: "idle" })
    expect(sent).toEqual(["refresh-idle"])
    expect(await source.renewDue!()).toEqual(nothing)
    expect(sent).toHaveLength(1)
  })

  it("renews one seat per pass, the most overdue first", async () => {
    await seed([account("third", NOW - 9 * DAY), account("first", NOW - 12 * DAY), account("second", NOW - 11 * DAY)])
    const { source, sent } = owned()
    await source.acquire()

    expect((await source.renewDue!()).due).toEqual(["first", "second", "third"])
    expect(sent).toEqual(["refresh-first"])
    expect((await source.renewDue!()).due).toEqual(["second", "third"])
    expect((await source.renewDue!()).due).toEqual(["third"])
    expect(await source.renewDue!()).toEqual(nothing)
    expect(sent).toEqual(["refresh-first", "refresh-second", "refresh-third"])
  })

  it("goes on past a seat the provider refused, and pauses six hours once the provider fails one", async () => {
    await seed([account("third", NOW - 9 * DAY), account("first", NOW - 12 * DAY), account("second", NOW - 11 * DAY)])
    const { source, sent } = owned(refreshToken => {
      if (refreshToken === "refresh-first") return refused(401, { error: { code: "refresh_token_reused" } })
      if (refreshToken === "refresh-second") return refused(503, { error: "upstream" })
      return renewed(refreshToken)
    })
    await source.acquire()

    expect(await source.renewDue!()).toMatchObject({
      due: ["first", "second", "third"],
      outcome: { status: "requires-reauth", accountUserId: "first", reason: "rejected", cause: "refresh token already used" },
    })
    expect(await source.renewDue!()).toMatchObject({
      due: ["second", "third"],
      outcome: { status: "requires-reauth", accountUserId: "second", reason: "unverifiable", cause: "HTTP 503" },
    })
    expect(await source.renewDue!()).toEqual(nothing)
    clock = NOW + 6 * HOUR - MINUTE
    expect(await source.renewDue!()).toEqual(nothing)
    expect(sent).toEqual(["refresh-first", "refresh-second"])
    expect(onDisk("third")).toMatchObject({ refreshToken: "refresh-third", exchangeStartedAt: null })

    clock = NOW + 6 * HOUR
    expect(await source.renewDue!()).toMatchObject({ due: ["third"], outcome: { status: "refreshed", accountUserId: "third" } })
    expect(sent).toEqual(["refresh-first", "refresh-second", "refresh-third"])
  })

  it("leaves a seat already waiting for a sign-in alone", async () => {
    await seed([account("stuck", NOW - 12 * DAY, { exchangeStartedAt: NOW - DAY })])
    const { source, sent } = owned()
    await source.acquire()

    expect(await source.renewDue!()).toEqual(nothing)
    expect(sent).toEqual([])
  })

  it("renews nothing without the refresh lease", async () => {
    await seed([account("due", NOW - 9 * DAY)])
    const { source, sent } = owned()

    expect(await source.renewDue!()).toEqual(nothing)
    expect(sent).toEqual([])
  })

  it("runs one pass at a time", async () => {
    await seed([account("due", NOW - 9 * DAY)])
    const { source, sent } = owned()
    await source.acquire()

    const first = source.renewDue!()
    expect(source.renewDue!()).toBe(first)
    await first
    expect(sent).toEqual(["refresh-due"])
  })
})

// A renewal stamps its seat before the exchange goes out and clears the stamp
// when the result is recorded. Read in between, the seat is neither signed
// out nor waiting for a sign-in: it was being listed as needing one, so every
// renewal left a logout and a recovery in its record a second apart.
describe("a seat read while its exchange is in flight", () => {
  const view = (source: { seats(): Array<{ id: string; eligible: boolean; reason?: string }> }, id: string) =>
    source.seats().find(seat => seat.id === id)!

  it("keeps the state it had, and needs a sign-in only once the exchange fails", async () => {
    await seed([account("due", NOW - 9 * DAY)])
    let answer!: (response: Response) => void
    const { source, sent } = owned(() => new Promise<Response>(resolve => { answer = resolve }))
    await source.acquire()

    const pass = source.renewDue!()
    while (sent.length === 0) await new Promise(resolve => setTimeout(resolve, 5))
    expect(onDisk("due")?.exchangeStartedAt).not.toBeNull()
    expect(view(source, "due")).toMatchObject({ eligible: true })
    expect(view(source, "due").reason).toBeUndefined()

    answer(refused(401, { error: { code: "refresh_token_reused" } }))
    await pass
    expect(view(source, "due")).toMatchObject({ eligible: false, reason: "requires_reauth" })
  })

  it("needs a sign-in when the stamp is left from an exchange that never finished", async () => {
    await seed([account("stuck", NOW - 12 * DAY, { exchangeStartedAt: NOW - 1000 })])
    const { source } = owned()
    await source.acquire()
    expect(view(source, "stuck")).toMatchObject({ eligible: false, reason: "requires_reauth" })
  })

  it("on a read-only instance, keeps the state a stamp younger than an exchange can take, and not an older one", async () => {
    await seed([account("fresh", NOW - 9 * DAY, { exchangeStartedAt: NOW - 1000 }), account("old", NOW - 9 * DAY, { exchangeStartedAt: NOW - 60_000 })])
    const source = createOwnedCredentialSource({ storePath, now: () => clock, readOnly: true })!
    held.push(source)
    expect(view(source, "fresh")).toMatchObject({ eligible: true })
    expect(view(source, "old")).toMatchObject({ eligible: false, reason: "requires_reauth" })
  })

  it("on a read-only instance, does not trust a stamp dated in the future", async () => {
    // Another host's clock ahead of this one must not hold a lost sign-in
    // as healthy for the size of the skew.
    await seed([account("ahead", NOW - 9 * DAY, { exchangeStartedAt: NOW + 10 * 60_000 })])
    const source = createOwnedCredentialSource({ storePath, now: () => clock, readOnly: true })!
    held.push(source)
    expect(view(source, "ahead")).toMatchObject({ eligible: false, reason: "requires_reauth" })
  })
})

describe("the renewal schedule", () => {
  const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

  it("looks at once, and again every interval", async () => {
    let looks = 0
    const schedule = startRenewalSchedule(async () => { looks++ }, 20)
    try {
      expect(looks).toBe(1)
      const deadline = Date.now() + 5_000
      while (looks < 3 && Date.now() < deadline) await pause(5)
      expect(looks).toBeGreaterThanOrEqual(3)
    } finally {
      await schedule.stop()
    }
  })

  it("stops looking, and resolves stop only once a renewal still out has settled", async () => {
    let looks = 0
    let finish!: () => void
    const schedule = startRenewalSchedule(() => {
      looks++
      return new Promise<void>(resolve => { finish = resolve })
    }, 20)
    let stopped = false
    const stopping = schedule.stop().then(() => { stopped = true })

    await pause(100)
    expect(stopped).toBe(false)
    expect(looks).toBe(1)

    finish()
    await stopping
    expect(looks).toBe(1)
  })

  it("logs a failed look instead of throwing it", async () => {
    const written: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => { written.push(args.join(" ")) }
    try {
      await startRenewalSchedule(async () => { throw new Error("store unreadable") }).stop()
    } finally {
      console.error = original
    }
    expect(written).toEqual(["[chatgpt] renewing a seat ahead of expiry failed: store unreadable"])
  })
})
