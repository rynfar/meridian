import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { CredentialStore, CredentialsFile } from "../proxy/tokenRefresh"
import { ensureFreshToken as checkToken, getStoredPlanFields, refreshOAuthToken, resetAuthRenewalCache, resetInflightRefresh } from "../proxy/tokenRefresh"
import { planAllowance } from "../proxy/planAllowance"

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile"
const SIX_HOURS = 6 * 60 * 60_000
const originalFetch = globalThis.fetch
const originalReadonly = process.env.MERIDIAN_CREDENTIALS_READONLY
let now = 1_800_000_000_000

function ensureFreshToken(store: CredentialStore): Promise<boolean> {
  return checkToken(store, undefined, true)
}

function stubFetch(fn: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(fn, { preconnect: originalFetch.preconnect })
}

function fixture(plan: { subscriptionType: string; rateLimitTier: string; seatTier?: string }) {
  let credentials: CredentialsFile = { claudeAiOauth: {
    accessToken: "valid-access", refreshToken: "valid-refresh", expiresAt: Date.now() + 4 * SIX_HOURS,
    ...plan,
  } }
  const store: CredentialStore = {
    refreshKey: `test:plan-recheck:${crypto.randomUUID()}`,
    async read() { return structuredClone(credentials) },
    async write(value) { credentials = structuredClone(value); return true },
  }
  let calls = 0
  const source = (organization: object) => {
    stubFetch(async (url) => {
      if (String(url) !== PROFILE_URL) throw new Error("Plan recheck must not rotate a valid token")
      calls++
      return Response.json({ organization })
    })
  }
  return { store, source, calls: () => calls, credentials: () => credentials }
}

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

beforeEach(() => {
  now = 1_800_000_000_000
  spyOn(Date, "now").mockImplementation(() => now)
  delete process.env.MERIDIAN_CREDENTIALS_READONLY
  resetAuthRenewalCache(); resetInflightRefresh()
})
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalReadonly === undefined) delete process.env.MERIDIAN_CREDENTIALS_READONLY
  else process.env.MERIDIAN_CREDENTIALS_READONLY = originalReadonly
  spyOn(Date, "now").mockRestore()
  resetAuthRenewalCache(); resetInflightRefresh()
})

describe("periodic plan recheck", () => {
  it("does not put optional plan lookup on the valid-token foreground path", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    f.source({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })

    expect(await checkToken(f.store)).toBe(true)

    expect(f.calls()).toBe(0)
  })
  it("discovers an upgrade on an undated credential without rotating its valid token", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    await getStoredPlanFields(f.store)
    f.source({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })

    await ensureFreshToken(f.store)

    expect(planAllowance(await getStoredPlanFields(f.store)).weight).toBe(20)
    expect(f.credentials().claudeAiOauth.accessToken).toBe("valid-access")
    expect(f.credentials().claudeAiOauth.refreshToken).toBe("valid-refresh")
  })

  for (const [storedSeat, sourceSeat, weight] of [
    ["team_standard", "team_tier_1", 6.25],
    ["team_tier_1", "team_standard", 1],
  ] as const) {
    it(`corrects ${storedSeat} to ${sourceSeat} during normal credential maintenance`, async () => {
      const f = fixture({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x", seatTier: storedSeat })
      f.source({ organization_type: "claude_team", rate_limit_tier: "default_claude_max_5x", seat_tier: sourceSeat })

      await ensureFreshToken(f.store)

      expect(planAllowance(await getStoredPlanFields(f.store)).weight).toBe(weight)
    })
  }

  it("checks an unchanged complete plan only once until its reading expires", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_20x" })
    f.source({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })

    await Promise.all([ensureFreshToken(f.store), ensureFreshToken(f.store)])
    await ensureFreshToken(f.store)

    expect(f.calls()).toBe(1)
  })

  it("rechecks at six hours, not before", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    f.source({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })
    await ensureFreshToken(f.store)
    now += SIX_HOURS - 1
    await ensureFreshToken(f.store)
    expect(f.calls()).toBe(1)

    now++
    await ensureFreshToken(f.store)

    expect(f.calls()).toBe(2)
  })

  it("preserves omitted fields during a partial plan reading", async () => {
    const f = fixture({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x", seatTier: "team_standard" })
    f.source({ seat_tier: "team_tier_1" })

    await ensureFreshToken(f.store)

    expect(await getStoredPlanFields(f.store)).toEqual({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x", seatTier: "team_tier_1" })
    expect(f.credentials().claudeAiOauth.refreshToken).toBe("valid-refresh")
  })

  it("leaves credentials intact and bounds failed lookups to five-minute retries", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    const before = structuredClone(f.credentials())
    let calls = 0
    stubFetch(async () => { calls++; return new Response(null, { status: 503 }) })
    await ensureFreshToken(f.store)
    await ensureFreshToken(f.store)
    expect(calls).toBe(1)
    expect(f.credentials()).toEqual(before)

    now += 5 * 60_000
    await ensureFreshToken(f.store)

    expect(calls).toBe(2)
    expect(f.credentials()).toEqual(before)
  })

  it("does not read or persist a plan in a read-only instance", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    f.source({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"

    expect(await ensureFreshToken(f.store)).toBe(true)

    expect(f.calls()).toBe(0)
    expect(f.credentials().claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x")
  })

  it("waits for an admitted plan write before a forced token rotation", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    const started = deferred<void>()
    const release = deferred<void>()
    let tokenCalls = 0
    stubFetch(async (url) => {
      if (String(url) === PROFILE_URL) {
        started.resolve(); await release.promise
        return Response.json({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } })
      }
      tokenCalls++
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    })
    const plan = ensureFreshToken(f.store)
    await started.promise
    const token = refreshOAuthToken({ ...f.store })
    await Promise.resolve()
    expect(tokenCalls).toBe(0)

    release.resolve()
    await Promise.all([plan, token])

    expect(tokenCalls).toBe(1)
    expect(f.credentials().claudeAiOauth).toMatchObject({ accessToken: "rotated-access", refreshToken: "rotated-refresh", rateLimitTier: "default_claude_max_20x" })
  })

  it("joins a token rotation without a second plan write from a valid-token caller", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    const started = deferred<void>()
    const release = deferred<void>()
    let profileCalls = 0
    stubFetch(async (url) => {
      if (String(url) === PROFILE_URL) {
        profileCalls++
        return Response.json({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" } })
      }
      started.resolve(); await release.promise
      return Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 })
    })
    const token = refreshOAuthToken(f.store)
    await started.promise
    const plan = ensureFreshToken({ ...f.store })

    release.resolve()
    await Promise.all([token, plan])

    expect(profileCalls).toBe(1)
    expect(f.credentials().claudeAiOauth.refreshToken).toBe("rotated-refresh")
  })

  it("does not let an older in-flight facts read poison the updated plan cache", async () => {
    const f = fixture({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })
    const started = deferred<void>()
    const release = deferred<void>()
    let first = true
    const readingStore: CredentialStore = { ...f.store, async read() {
      const old = await f.store.read()
      if (first) { first = false; started.resolve(); await release.promise }
      return old
    } }
    const oldFacts = getStoredPlanFields(readingStore)
    await started.promise
    f.source({ organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x" })
    await ensureFreshToken(f.store)

    release.resolve()
    await oldFacts

    expect(planAllowance(await getStoredPlanFields(f.store)).weight).toBe(20)
  })

  for (const mode of ["plan", "token"] as const) {
    it(`clears the previous Team seat when ${mode} maintenance discovers personal Max`, async () => {
      const f = fixture({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x", seatTier: "team_tier_1" })
      stubFetch(async (url) => String(url) === PROFILE_URL
        ? Response.json({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_20x", seat_tier: null } })
        : Response.json({ access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }))

      if (mode === "plan") await ensureFreshToken(f.store)
      else await refreshOAuthToken(f.store)

      expect(f.credentials().claudeAiOauth).not.toHaveProperty("seatTier")
      expect(planAllowance(await getStoredPlanFields(f.store)).weight).toBe(20)
    })
  }
})
