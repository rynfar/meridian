/**
 * Unit tests for the auth-payload describer.
 *
 * The module is pure, so these are direct assertions with no mocking. The
 * property that matters most is the polarity: a key nobody has seen before must
 * be reported by name and type while its contents stay out of the log, because
 * the whole point is observing fields Anthropic adds after this code was
 * written.
 */

import { describe, it, expect } from "bun:test"
import { authFieldPaths, describeAuthFields, SAFE_AUTH_STRING_KEYS } from "../proxy/authDiscovery"

const TOKEN_RESPONSE = {
  access_token: "sk-ant-oat01-secret-value",
  refresh_token: "sk-ant-ort01-secret-value",
  expires_in: 3600,
  token_type: "Bearer",
  scope: "user:profile user:inference",
  account: { uuid: "0198fa2c-1111-2222-3333-444455556666", email_address: "person@example.com" },
}

const PROFILE_RESPONSE = {
  organization: {
    uuid: "0198fa2c-aaaa-bbbb-cccc-ddddeeeeffff",
    name: "Some Company Inc",
    organization_type: "claude_max",
    rate_limit_tier: "default_claude_max_20x",
  },
}

// ---------------------------------------------------------------------------
// Redaction polarity — the property the whole module exists for
// ---------------------------------------------------------------------------

describe("describeAuthFields redaction", () => {
  it("never prints a token, and says how long it was", () => {
    const described = describeAuthFields(TOKEN_RESPONSE) as Record<string, unknown>

    expect(described.access_token).toBe(`[string len=${TOKEN_RESPONSE.access_token.length}]`)
    expect(described.refresh_token).toBe(`[string len=${TOKEN_RESPONSE.refresh_token.length}]`)
    expect(JSON.stringify(described)).not.toContain("sk-ant")
  })

  it("redacts a key it has never seen rather than printing it", () => {
    // The inverse of logger.ts's deny-list: a field Anthropic adds tomorrow is
    // by definition not on any list somebody wrote today, so the default must
    // be redaction or the first new credential-bearing field leaks.
    const described = describeAuthFields({ some_future_secret: "hunter2" }) as Record<string, unknown>

    expect(described.some_future_secret).toBe("[string len=7]")
    expect(JSON.stringify(described)).not.toContain("hunter2")
  })

  it("still reports that the new key arrived, and what type it is", () => {
    const payload = { some_future_secret: "hunter2", some_future_flag: true, some_future_count: 12 }
    const described = describeAuthFields(payload) as Record<string, unknown>

    expect(Object.keys(described).sort()).toEqual(["some_future_count", "some_future_flag", "some_future_secret"])
    expect(described.some_future_flag).toBe(true)
    expect(described.some_future_count).toBe(12)
  })

  it("keeps a person and an organization out of the log", () => {
    const described = describeAuthFields(TOKEN_RESPONSE) as Record<string, unknown>
    const account = described.account as Record<string, unknown>

    expect(account.email_address).toBe(`[string len=${TOKEN_RESPONSE.account.email_address.length}]`)
    expect(account.uuid).toBe(`[string len=${TOKEN_RESPONSE.account.uuid.length}]`)
    expect(JSON.stringify(described)).not.toContain("person@example.com")
  })
})

// ---------------------------------------------------------------------------
// What is allowed through — the fields the diagnosis is actually made of
// ---------------------------------------------------------------------------

describe("describeAuthFields allow-list", () => {
  it("prints the plan tier verbatim, which is the field being diagnosed", () => {
    const described = describeAuthFields(PROFILE_RESPONSE) as Record<string, unknown>
    const org = described.organization as Record<string, unknown>

    expect(org.organization_type).toBe("claude_max")
    expect(org.rate_limit_tier).toBe("default_claude_max_20x")
  })

  it("prints scopes and token type, which carry no secret", () => {
    const described = describeAuthFields(TOKEN_RESPONSE) as Record<string, unknown>

    expect(described.token_type).toBe("Bearer")
    expect(described.scope).toBe("user:profile user:inference")
  })

  it("redacts the organization's name and uuid even beside allowed siblings", () => {
    const described = describeAuthFields(PROFILE_RESPONSE) as Record<string, unknown>
    const org = described.organization as Record<string, unknown>

    expect(org.name).toBe(`[string len=${PROFILE_RESPONSE.organization.name.length}]`)
    expect(org.uuid).toBe(`[string len=${PROFILE_RESPONSE.organization.uuid.length}]`)
    expect(JSON.stringify(described)).not.toContain("Some Company Inc")
  })

  it("does not allow an identity-bearing key onto the list by accident", () => {
    for (const key of ["email", "email_address", "name", "display_name", "uuid", "access_token", "refresh_token"]) {
      expect(SAFE_AUTH_STRING_KEYS.has(key)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// Shapes that must not throw — this runs inside a login, and a crash here
// would fail an authentication over a debug line.
// ---------------------------------------------------------------------------

describe("describeAuthFields shapes", () => {
  it("passes null and undefined straight through", () => {
    expect(describeAuthFields(null)).toBeNull()
    expect(describeAuthFields(undefined)).toBeUndefined()
    expect(describeAuthFields({ organization: null })).toEqual({ organization: null })
  })

  it("describes each element of an array under the array's own key", () => {
    const described = describeAuthFields({ scopes: ["user:profile", "user:inference"] }) as Record<string, unknown>
    expect(described.scopes).toEqual(["user:profile", "user:inference"])

    const secrets = describeAuthFields({ keys: ["aaa", "bbbb"] }) as Record<string, unknown>
    expect(secrets.keys).toEqual(["[string len=3]", "[string len=4]"])
  })

  it("handles a bare primitive and an empty object", () => {
    expect(describeAuthFields(42)).toBe(42)
    expect(describeAuthFields(true)).toBe(true)
    expect(describeAuthFields({})).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// The key list — the line worth grepping across two logins
// ---------------------------------------------------------------------------

describe("authFieldPaths", () => {
  it("reports nested keys as dotted paths", () => {
    expect(authFieldPaths(PROFILE_RESPONSE)).toEqual([
      "organization",
      "organization.uuid",
      "organization.name",
      "organization.organization_type",
      "organization.rate_limit_tier",
    ])
  })

  it("names the field that is missing by its absence, not by a null", () => {
    // Comparing two logins reduces to comparing two of these lists, which is
    // the point: a profile whose response never carried rate_limit_tier is
    // distinguishable from one where it arrived and was dropped downstream.
    const paths = authFieldPaths({ organization: { organization_type: "claude_max" } })

    expect(paths).toContain("organization.organization_type")
    expect(paths).not.toContain("organization.rate_limit_tier")
  })

  it("returns nothing for a non-object", () => {
    expect(authFieldPaths(null)).toEqual([])
    expect(authFieldPaths(undefined)).toEqual([])
    expect(authFieldPaths("string")).toEqual([])
    expect(authFieldPaths(["a", "b"])).toEqual([])
  })
})
