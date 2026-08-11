/**
 * Unit tests for the plan fields a headless OAuth login persists.
 *
 * Anthropic's token endpoint returns no plan information, so the headless login
 * reads it from `/api/oauth/profile` and writes `subscriptionType` /
 * `rateLimitTier` alongside the tokens. Network is swapped via
 * `globalThis.fetch`; the credential-building step is pure and asserted directly.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  buildLoginCredentials,
  extractPlanFields,
  fetchOAuthPlanFields,
  subscriptionTypeFromOrganizationType,
} from "../proxy/profileCli"
import type { CredentialStore } from "../proxy/tokenRefresh"

/** Assign a mock to globalThis.fetch without TS complaining about `preconnect`. */
function mockFetch(fn: (...args: unknown[]) => Promise<Response | never>): void {
  globalThis.fetch = fn as typeof fetch
}

function makeSuccessResponse(body: object) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

const TOKEN_DATA = {
  access_token: "the-access-token",
  refresh_token: "the-refresh-token",
  expires_in: 3600,
  scope: "user:profile user:inference",
}

const MAX_PROFILE = {
  organization: {
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_20x",
  },
}

// ---------------------------------------------------------------------------
// organization_type → subscriptionType
// ---------------------------------------------------------------------------

describe("subscriptionTypeFromOrganizationType", () => {
  it("strips the claude_ prefix the CLI also strips", () => {
    expect(subscriptionTypeFromOrganizationType("claude_max")).toBe("max")
    expect(subscriptionTypeFromOrganizationType("claude_pro")).toBe("pro")
    expect(subscriptionTypeFromOrganizationType("claude_team")).toBe("team")
    expect(subscriptionTypeFromOrganizationType("claude_enterprise")).toBe("enterprise")
  })

  it("returns undefined rather than guessing at an unknown plan", () => {
    expect(subscriptionTypeFromOrganizationType("claude_something_new")).toBeUndefined()
    expect(subscriptionTypeFromOrganizationType("max")).toBeUndefined()
    expect(subscriptionTypeFromOrganizationType(null)).toBeUndefined()
    expect(subscriptionTypeFromOrganizationType(undefined)).toBeUndefined()
    expect(subscriptionTypeFromOrganizationType("")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Profile body → plan fields (snake_case on the wire, camelCase on disk)
// ---------------------------------------------------------------------------

describe("extractPlanFields", () => {
  it("translates the snake_case wire names to the camelCase on-disk names", () => {
    expect(extractPlanFields(MAX_PROFILE)).toEqual({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
  })

  it("distinguishes a team account from a max one", () => {
    expect(extractPlanFields({ organization: { organization_type: "claude_team" } }))
      .toEqual({ subscriptionType: "team" })
  })

  it("keeps the tier when only the plan is unrecognized", () => {
    expect(extractPlanFields({ organization: { organization_type: "claude_future", rate_limit_tier: "some_tier" } }))
      .toEqual({ rateLimitTier: "some_tier" })
  })

  it("returns an empty object for an absent or empty organization", () => {
    expect(extractPlanFields(null)).toEqual({})
    expect(extractPlanFields(undefined)).toEqual({})
    expect(extractPlanFields({})).toEqual({})
    expect(extractPlanFields({ organization: null })).toEqual({})
    expect(extractPlanFields({ organization: {} })).toEqual({})
  })

  it("omits keys rather than setting them to undefined", () => {
    const fields = extractPlanFields({ organization: { organization_type: null, rate_limit_tier: null } })
    expect(Object.keys(fields)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The profile fetch — best-effort, never fatal
// ---------------------------------------------------------------------------

describe("fetchOAuthPlanFields", () => {
  let originalFetch: typeof globalThis.fetch
  let originalWarn: typeof console.warn
  let warnings: unknown[][]

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalWarn = console.warn
    warnings = []
    console.warn = (...args: unknown[]) => { warnings.push(args) }
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  })

  it("returns the plan for a healthy response", async () => {
    mockFetch(async () => makeSuccessResponse(MAX_PROFILE))
    expect(await fetchOAuthPlanFields("tok")).toEqual({
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
  })

  it("presents the access token as a bearer credential to the profile endpoint", async () => {
    let seenUrl: unknown
    let seenInit: RequestInit | undefined
    mockFetch(async (url: unknown, init: unknown) => {
      seenUrl = url
      seenInit = init as RequestInit
      return makeSuccessResponse(MAX_PROFILE)
    })

    await fetchOAuthPlanFields("the-access-token")

    expect(seenUrl).toBe("https://api.anthropic.com/api/oauth/profile")
    const headers = seenInit?.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer the-access-token")
  })

  it("returns an empty object on a non-ok response", async () => {
    mockFetch(async () => new Response("Unauthorized", { status: 401 }))
    expect(await fetchOAuthPlanFields("tok")).toEqual({})
    expect(warnings.length).toBe(1)
  })

  it("returns an empty object when the request throws", async () => {
    mockFetch(async () => { throw new Error("network down") })
    expect(await fetchOAuthPlanFields("tok")).toEqual({})
    expect(warnings.length).toBe(1)
  })

  it("returns an empty object when the body is not JSON", async () => {
    mockFetch(async () => new Response("not-json", { status: 200 }))
    expect(await fetchOAuthPlanFields("tok")).toEqual({})
    expect(warnings.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// What actually lands on disk — the regression this change closes
// ---------------------------------------------------------------------------

describe("buildLoginCredentials", () => {
  it("persists the plan alongside the tokens when it is known", () => {
    const creds = buildLoginCredentials(TOKEN_DATA, {
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })

    expect(creds.claudeAiOauth.subscriptionType).toBe("max")
    expect(creds.claudeAiOauth.rateLimitTier).toBe("default_claude_max_20x")
  })

  it("omits the keys entirely when the plan is unknown", () => {
    const creds = buildLoginCredentials(TOKEN_DATA, {})

    // `subscriptionType: undefined` would write a null-ish key into a file the
    // real CLI also parses — absence must mean absent, not present-and-empty.
    expect("subscriptionType" in creds.claudeAiOauth).toBe(false)
    expect("rateLimitTier" in creds.claudeAiOauth).toBe(false)
    expect(JSON.stringify(creds)).not.toContain("subscriptionType")
  })

  it("writes only the field that is known", () => {
    const creds = buildLoginCredentials(TOKEN_DATA, { subscriptionType: "team" })

    expect(creds.claudeAiOauth.subscriptionType).toBe("team")
    expect("rateLimitTier" in creds.claudeAiOauth).toBe(false)
  })

  it("still carries the tokens, scopes and expiry", () => {
    const creds = buildLoginCredentials(TOKEN_DATA, {}, 1_000_000)

    expect(creds.claudeAiOauth.accessToken).toBe("the-access-token")
    expect(creds.claudeAiOauth.refreshToken).toBe("the-refresh-token")
    expect(creds.claudeAiOauth.expiresAt).toBe(1_000_000 + 3600 * 1000)
    expect(creds.claudeAiOauth.scopes).toEqual(["user:profile", "user:inference"])
  })

  it("prefers an absolute expires_at over expires_in", () => {
    const creds = buildLoginCredentials({ ...TOKEN_DATA, expires_at: 42 }, {}, 1_000_000)
    expect(creds.claudeAiOauth.expiresAt).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Once written, the value must survive every subsequent refresh.
//
// doRefresh rebuilds claudeAiOauth with a spread, so anything already on disk
// is carried forward. Turning that spread into an explicit field list would
// silently re-open the same hole one refresh cycle after each login.
// ---------------------------------------------------------------------------

describe("a refresh preserves an already-persisted plan", () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => { originalFetch = globalThis.fetch })
  afterEach(async () => {
    globalThis.fetch = originalFetch
    const { resetInflightRefresh } = await import("../proxy/tokenRefresh")
    resetInflightRefresh()
  })

  it("keeps subscriptionType and rateLimitTier across a token refresh", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    let stored = buildLoginCredentials(TOKEN_DATA, {
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
    })
    const store: CredentialStore = {
      async read() { return JSON.parse(JSON.stringify(stored)) },
      async write(credentials) { stored = credentials; return true },
    }

    mockFetch(async () => makeSuccessResponse({
      access_token: "rotated-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    }))

    expect(await refreshOAuthToken(store)).toBe(true)
    expect(stored.claudeAiOauth.accessToken).toBe("rotated-access-token")
    expect(stored.claudeAiOauth.subscriptionType).toBe("max")
    expect(stored.claudeAiOauth.rateLimitTier).toBe("default_claude_max_20x")
  })

  it("does not invent a plan for a credential written before this change", async () => {
    const { refreshOAuthToken } = await import("../proxy/tokenRefresh")

    let stored = buildLoginCredentials(TOKEN_DATA, {})
    const store: CredentialStore = {
      async read() { return JSON.parse(JSON.stringify(stored)) },
      async write(credentials) { stored = credentials; return true },
    }

    mockFetch(async () => makeSuccessResponse({ access_token: "rotated", expires_in: 3600 }))

    expect(await refreshOAuthToken(store)).toBe(true)
    // A refresh cannot repair an already-blind profile: only a re-login can.
    expect("subscriptionType" in stored.claudeAiOauth).toBe(false)
  })
})
