/**
 * Unit tests for organizationName.ts.
 *
 * The pure readers are exercised directly. The persistence round trip goes
 * through the real module with MERIDIAN_CONFIG_DIR redirected, the same
 * arrangement settings-unit.test.ts uses — a re-implementation of the JSON
 * handling would pass regardless of what the module actually did.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ORGANIZATION_REFRESH_AFTER_MS,
  enableOrganizationLookup,
  extractAccountIdentity,
  extractOrganizationName,
  fetchOrganization,
  organizationNames,
  organizationNeedsRefresh,
  organizationRecordCurrent,
  readOrganizations,
  refreshOrganizationNameSoon,
  refreshOrganizationNow,
  rememberOrganization,
  resetOrganizationLookupForTesting,
} from "../proxy/organizationName"
import type { CredentialStore } from "../proxy/tokenRefresh"

async function fetchOrganizationName(store: CredentialStore, fetchImpl: Parameters<typeof fetchOrganization>[1]): Promise<string | null> {
  return (await fetchOrganization(store, fetchImpl))?.lookup.name ?? null
}

function rememberOrganizationName(profileId: string, name: string): void {
  rememberOrganization(profileId, { name, accountUuid: null, organizationUuid: null, email: null })
}

function storeWithToken(token: string | null, expiresAt?: number): CredentialStore {
  return {
    read: async () => (token ? { claudeAiOauth: { accessToken: token, ...(expiresAt ? { expiresAt } : {}) } } : null),
    write: async () => true,
    describe: () => "test-store",
  } as unknown as CredentialStore
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

describe("extractOrganizationName", () => {
  test("reads organization.name", () => {
    expect(extractOrganizationName({ organization: { name: "Acme Inc" } })).toBe("Acme Inc")
  })

  test("trims surrounding whitespace", () => {
    expect(extractOrganizationName({ organization: { name: "  Acme Inc  " } })).toBe("Acme Inc")
  })

  test("a missing or unusable name yields null rather than a placeholder", () => {
    expect(extractOrganizationName({ organization: {} })).toBeNull()
    expect(extractOrganizationName({ organization: { name: null } })).toBeNull()
    expect(extractOrganizationName({ organization: { name: "   " } })).toBeNull()
    expect(extractOrganizationName({ organization: null })).toBeNull()
    expect(extractOrganizationName({})).toBeNull()
    expect(extractOrganizationName(null)).toBeNull()
    expect(extractOrganizationName("Acme")).toBeNull()
  })

  test("an absurdly long name is treated as garbage", () => {
    expect(extractOrganizationName({ organization: { name: "x".repeat(5000) } })).toBeNull()
  })

  test("reads the shape Anthropic actually returns, ignoring its other fields", () => {
    const body = {
      account: { uuid: "a", email: "someone@example.com" },
      organization: {
        uuid: "o",
        name: "Nowaker's Org",
        organization_type: "claude_max",
        rate_limit_tier: "default_claude_max_20x",
      },
    }
    expect(extractOrganizationName(body)).toBe("Nowaker's Org")
  })
})

describe("readOrganizations", () => {
  test("keeps well-formed records", () => {
    expect(readOrganizations({ work: { name: "Acme", fetchedAt: 5 } })).toEqual({ work: { name: "Acme", fetchedAt: 5 } })
  })

  test("drops records with no usable name", () => {
    const raw = { a: { name: "Acme", fetchedAt: 1 }, b: { name: "" }, c: { name: 7 }, d: null, e: "Acme" }
    expect(readOrganizations(raw)).toEqual({ a: { name: "Acme", fetchedAt: 1 } })
  })

  test("a missing timestamp reads as never fetched rather than dropping the name", () => {
    expect(readOrganizations({ work: { name: "Acme" } })).toEqual({ work: { name: "Acme", fetchedAt: 0 } })
  })

  test("keeps the account identity a read stored, and a record with no name but a known account", () => {
    const raw = { work: { name: null, fetchedAt: 5, accountUuid: "acct", organizationUuid: "org", email: "a@b.c", credentialMark: 9 } }
    expect(readOrganizations(raw)).toEqual({ work: { name: null, fetchedAt: 5, accountUuid: "acct", organizationUuid: "org", email: "a@b.c", credentialMark: 9 } })
  })

  test("non-object input yields an empty map", () => {
    for (const raw of [undefined, null, "Acme", ["Acme"]]) expect(readOrganizations(raw)).toEqual({})
  })
})

describe("extractAccountIdentity", () => {
  test("reads account.uuid, organization.uuid and account.email", () => {
    const body = { account: { uuid: "acct-1", email: "a@b.c", full_name: "A" }, organization: { uuid: "org-1", name: "Acme" } }
    expect(extractAccountIdentity(body)).toEqual({ accountUuid: "acct-1", organizationUuid: "org-1", email: "a@b.c" })
  })

  test("a body without them yields nulls, never a placeholder", () => {
    for (const body of [null, {}, { account: "x" }, { organization: { uuid: 7 } }]) {
      expect(extractAccountIdentity(body)).toEqual({ accountUuid: null, organizationUuid: null, email: null })
    }
  })
})

describe("organizationNeedsRefresh", () => {
  test("an unknown profile needs one", () => {
    expect(organizationNeedsRefresh(undefined, 1_000)).toBe(true)
  })

  test("a fresh record does not", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 1_000, accountUuid: "acct" }, 1_000 + ORGANIZATION_REFRESH_AFTER_MS - 1)).toBe(false)
  })

  test("a record from before account identity was kept is read once more", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 1_000 }, 1_001)).toBe(true)
    // Asked and not told is an answer: it does not ask again every poll.
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 1_000, accountUuid: null }, 1_001)).toBe(false)
  })

  test("a login or renewal since the read makes the record stale at once", () => {
    const record = { name: "Acme", fetchedAt: 1_000, accountUuid: "acct", credentialMark: 5_000 }
    expect(organizationNeedsRefresh(record, 1_001, ORGANIZATION_REFRESH_AFTER_MS, 5_000)).toBe(false)
    expect(organizationNeedsRefresh(record, 1_001, ORGANIZATION_REFRESH_AFTER_MS, 9_000)).toBe(true)
    expect(organizationRecordCurrent(record, 5_000)).toBe(true)
    expect(organizationRecordCurrent(record, 9_000)).toBe(false)
    // A token that cannot be read now cannot be shown to match the record.
    expect(organizationRecordCurrent(record, null)).toBe(false)
    expect(organizationRecordCurrent({ ...record, credentialMark: null }, null)).toBe(false)
  })

  test("an aged record does", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 1_000 }, 1_000 + ORGANIZATION_REFRESH_AFTER_MS)).toBe(true)
  })

  test("a record recovered without a timestamp is refreshed at the first opportunity", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 0 }, Date.now())).toBe(true)
  })
})

describe("fetchOrganization", () => {
  test("returns the name for a token that works", async () => {
    const name = await fetchOrganizationName(storeWithToken("tok"), async () =>
      jsonResponse({ organization: { name: "Acme Inc" } }))
    expect(name).toBe("Acme Inc")
  })

  test("sends the access token as a bearer credential", async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    await fetchOrganizationName(storeWithToken("tok"), async (url, init) => {
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") })
      return jsonResponse({ organization: { name: "Acme" } })
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.anthropic.com/api/oauth/profile")
    expect(calls[0]?.auth).toBe("Bearer tok")
  })

  test("no token means no request at all", async () => {
    let called = false
    const name = await fetchOrganizationName(storeWithToken(null), async () => {
      called = true
      return jsonResponse({ organization: { name: "Acme" } })
    })
    expect(name).toBeNull()
    expect(called).toBe(false)
  })

  test("an upstream error yields null instead of throwing", async () => {
    const name = await fetchOrganizationName(storeWithToken("tok"), async () => jsonResponse({}, 500))
    expect(name).toBeNull()
  })

  test("a network failure yields null instead of throwing", async () => {
    const name = await fetchOrganizationName(storeWithToken("tok"), async () => { throw new Error("ECONNREFUSED") })
    expect(name).toBeNull()
  })

  test("a body that is not JSON yields null instead of throwing", async () => {
    const name = await fetchOrganizationName(storeWithToken("tok"), async () => new Response("<html>nope</html>"))
    expect(name).toBeNull()
  })
})

describe("persistence and background refresh", () => {
  const tempDir = join(tmpdir(), `meridian-organization-name-${process.pid}`)
  const cacheFile = join(tempDir, "organizations.json")
  let savedConfigDir: string | undefined

  beforeEach(() => {
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
    mkdirSync(tempDir, { recursive: true })
    process.env.MERIDIAN_CONFIG_DIR = tempDir
    resetOrganizationLookupForTesting()
  })

  afterEach(() => {
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(tempDir, { recursive: true, force: true })
    resetOrganizationLookupForTesting()
  })

  test("an unknown profile has no organization", () => {
    expect(organizationNames()).toEqual({})
  })

  test("a name survives a write and read", () => {
    rememberOrganizationName("work", "Acme Inc")
    expect(organizationNames().work?.name).toBe("Acme Inc")
  })

  test("remembering one profile leaves the others alone", () => {
    rememberOrganizationName("work", "Acme Inc")
    rememberOrganizationName("side", "Globex")
    const all = organizationNames()
    expect(all.work?.name).toBe("Acme Inc")
    expect(all.side?.name).toBe("Globex")
  })

  test("the cache file is written with owner-only permissions", () => {
    rememberOrganizationName("work", "Acme Inc")
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
  })

  test("corrupt JSON reads as empty instead of throwing", () => {
    writeFileSync(cacheFile, "not json{{{")
    expect(() => organizationNames()).not.toThrow()
    expect(organizationNames()).toEqual({})
  })

  test("the cache is Meridian's own file, not a credential file", () => {
    rememberOrganizationName("work", "Acme Inc")
    const raw = JSON.parse(readFileSync(cacheFile, "utf-8"))
    expect(Object.keys(raw)).toEqual(["work"])
    expect(raw.work.fetchedAt).toBeGreaterThan(0)
  })

  test("a background refresh stores what it learned", async () => {
    refreshOrganizationNameSoon("work", {
      store: storeWithToken("tok"),
      fetchImpl: async () => jsonResponse({ organization: { name: "Acme Inc" } }),
    })
    await Bun.sleep(20)
    expect(organizationNames().work?.name).toBe("Acme Inc")
  })

  test("a failed lookup leaves the previous name in place", async () => {
    rememberOrganizationName("work", "Acme Inc")
    refreshOrganizationNameSoon("work", {
      store: storeWithToken("tok"),
      fetchImpl: async () => jsonResponse({}, 500),
      retryAfterMs: 0,
    })
    await Bun.sleep(20)
    expect(organizationNames().work?.name).toBe("Acme Inc")
  })

  test("a second attempt inside the retry window does not call upstream again", async () => {
    let calls = 0
    const opts = {
      store: storeWithToken("tok"),
      fetchImpl: async () => { calls++; return jsonResponse({ organization: { name: "Acme Inc" } }) },
    }
    refreshOrganizationNameSoon("work", opts)
    await Bun.sleep(20)
    refreshOrganizationNameSoon("work", opts)
    await Bun.sleep(20)
    expect(calls).toBe(1)
  })

  test("the retry floor is per profile, not global", async () => {
    const seen: string[] = []
    const opts = (name: string) => ({
      store: storeWithToken("tok"),
      fetchImpl: async () => { seen.push(name); return jsonResponse({ organization: { name } }) },
    })
    refreshOrganizationNameSoon("work", opts("Acme Inc"))
    refreshOrganizationNameSoon("side", opts("Globex"))
    await Bun.sleep(20)
    expect(seen.sort()).toEqual(["Acme Inc", "Globex"])
  })

  test("without an injected store the lookup stays disarmed until the CLI enables it", async () => {
    // The guard that keeps the test suite from reading the developer's real
    // ~/.claude credentials and calling Anthropic.
    let called = false
    refreshOrganizationNameSoon("work", { fetchImpl: async () => { called = true; return jsonResponse({}) } })
    await Bun.sleep(20)
    expect(called).toBe(false)
    expect(organizationNames()).toEqual({})

    enableOrganizationLookup()
    refreshOrganizationNameSoon("work", {
      store: storeWithToken("tok"),
      fetchImpl: async () => jsonResponse({ organization: { name: "Acme Inc" } }),
    })
    await Bun.sleep(20)
    expect(organizationNames().work?.name).toBe("Acme Inc")
  })

  test("a refresh stores the account identity and the credential it was read for", async () => {
    refreshOrganizationNameSoon("work", {
      store: storeWithToken("tok", 7_000),
      fetchImpl: async () => jsonResponse({ account: { uuid: "acct", email: "a@b.c" }, organization: { uuid: "org", name: "Acme Inc" } }),
    })
    await Bun.sleep(20)
    expect(organizationNames().work).toMatchObject({ name: "Acme Inc", accountUuid: "acct", organizationUuid: "org", email: "a@b.c", credentialMark: 7_000 })
  })

  test("a new credential is read inside the retry window; the same one is not", async () => {
    let calls = 0
    const opts = (mark: number) => ({
      store: storeWithToken("tok", mark),
      credentialMark: mark,
      fetchImpl: async () => { calls++; return jsonResponse({ account: { uuid: `acct-${calls}` }, organization: { uuid: "org", name: "Acme" } }) },
    })
    refreshOrganizationNameSoon("work", opts(1_000))
    await Bun.sleep(20)
    refreshOrganizationNameSoon("work", opts(1_000))
    await Bun.sleep(20)
    expect(calls).toBe(1)
    // A re-login (or a renewal) writes a new expiry: the previous identity may
    // be the wrong account's, so it is read now rather than in five minutes.
    refreshOrganizationNameSoon("work", opts(2_000))
    await Bun.sleep(20)
    expect(calls).toBe(2)
    expect(organizationNames().work?.accountUuid).toBe("acct-2")
  })

  test("refreshOrganizationNow waits for the answer and ignores the retry floor", async () => {
    const store = storeWithToken("tok", 1)
    refreshOrganizationNameSoon("work", { store, fetchImpl: async () => jsonResponse({ account: { uuid: "old" }, organization: { uuid: "o", name: "Old" } }) })
    await Bun.sleep(20)
    const record = await refreshOrganizationNow("work", { store, fetchImpl: async () => jsonResponse({ account: { uuid: "new" }, organization: { uuid: "o", name: "New" } }) })
    expect(record).toMatchObject({ name: "New", accountUuid: "new" })
    expect(organizationNames().work?.name).toBe("New")
  })

  test("refreshOrganizationNow stays disarmed without a store until enabled", async () => {
    let called = false
    expect(await refreshOrganizationNow("work", { fetchImpl: async () => { called = true; return jsonResponse({}) } })).toBeNull()
    expect(called).toBe(false)
  })

  test("the file is replaced whole, owner-only, with no temporary left behind", () => {
    rememberOrganizationName("work", "Acme Inc")
    rememberOrganizationName("side", "Globex")
    expect(readdirSync(tempDir)).toEqual(["organizations.json"])
    expect(statSync(cacheFile).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(cacheFile, "utf-8")))).toEqual(["work", "side"])
  })

  test("a read made at sign-in counts as the attempt for that credential", async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return jsonResponse({}, 503) }
    const store = storeWithToken("tok", 4_000)
    // Anthropic did not answer the sign-in's read; the next poll sees the same
    // stored token and must wait out the retry floor, not ask again at once.
    expect(await refreshOrganizationNow("work", { store, fetchImpl })).toBeNull()
    refreshOrganizationNameSoon("work", { store, fetchImpl, credentialMark: 4_000 })
    await Bun.sleep(20)
    expect(calls).toBe(1)
    // A credential the sign-in did not read is still read at once.
    refreshOrganizationNameSoon("work", { store: storeWithToken("tok", 5_000), fetchImpl, credentialMark: 5_000 })
    await Bun.sleep(20)
    expect(calls).toBe(2)
  })
})
