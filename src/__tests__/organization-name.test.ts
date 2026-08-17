/**
 * Unit tests for organizationName.ts.
 *
 * The pure readers are exercised directly. The persistence round trip goes
 * through the real module with MERIDIAN_CONFIG_DIR redirected, the same
 * arrangement settings-unit.test.ts uses — a re-implementation of the JSON
 * handling would pass regardless of what the module actually did.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  ORGANIZATION_REFRESH_AFTER_MS,
  enableOrganizationLookup,
  extractOrganizationName,
  fetchOrganizationName,
  organizationNames,
  organizationNeedsRefresh,
  readOrganizations,
  refreshOrganizationNameSoon,
  rememberOrganizationName,
  resetOrganizationLookupForTesting,
} from "../proxy/organizationName"
import type { CredentialStore } from "../proxy/tokenRefresh"

function storeWithToken(token: string | null): CredentialStore {
  return {
    read: async () => (token ? { claudeAiOauth: { accessToken: token } } : null),
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

  test("non-object input yields an empty map", () => {
    for (const raw of [undefined, null, "Acme", ["Acme"]]) expect(readOrganizations(raw)).toEqual({})
  })
})

describe("organizationNeedsRefresh", () => {
  test("an unknown profile needs one", () => {
    expect(organizationNeedsRefresh(undefined, 1_000)).toBe(true)
  })

  test("a fresh record does not", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 1_000 }, 1_000 + ORGANIZATION_REFRESH_AFTER_MS - 1)).toBe(false)
  })

  test("an aged record does", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 1_000 }, 1_000 + ORGANIZATION_REFRESH_AFTER_MS)).toBe(true)
  })

  test("a record recovered without a timestamp is refreshed at the first opportunity", () => {
    expect(organizationNeedsRefresh({ name: "Acme", fetchedAt: 0 }, Date.now())).toBe(true)
  })
})

describe("fetchOrganizationName", () => {
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
})
