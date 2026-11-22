/**
 * Regression test for issue #477.
 *
 * Before the fix, every route under `/settings/*` (including
 * `PATCH /settings/api/features/:adapter` which mutates per-adapter SDK
 * feature config — sharedMemory, additionalDirectories, maxBudgetUsd, etc.)
 * was registered without going through `requireAuth`. With
 * `MERIDIAN_API_KEY` set, every other prefix returned 401 to unauthenticated
 * callers; `/settings/*` quietly served full read/write access. SilverResort
 * reported it; this test pins the gate in place.
 *
 * The `audit` block walks every prefix the server registers and asserts an
 * unauthenticated caller is rejected (or the prefix is on a small explicit
 * public allowlist — `/`, `/health`). That makes the next "we forgot to
 * protect /<new-feature>" mistake fail CI instead of waking up as a security
 * report.
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"

const SAVED_KEY = process.env.MERIDIAN_API_KEY
const TEST_KEY = "test-meridian-api-key"

beforeAll(() => {
  process.env.MERIDIAN_API_KEY = TEST_KEY
})

afterAll(() => {
  if (SAVED_KEY !== undefined) process.env.MERIDIAN_API_KEY = SAVED_KEY
  else delete process.env.MERIDIAN_API_KEY
})

// Imported after env is set so auth middleware reads our test key on its
// first invocation. requireAuth re-reads env per-call, but using `await
// import()` here keeps the timing explicit and matches the rest of the
// test suite's pattern for env-sensitive imports.
const { createProxyServer } = await import("../proxy/server")

describe("quota reset boundary rejects before credential access", () => {
  it("requires API authentication even with valid explicit IDs", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
      method: "POST", body: JSON.stringify({ profile: "default", grantId: "grant", requestId: "request" }),
    }))
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  it("rejects foreign and opaque browser origins despite valid authentication", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    for (const origin of ["https://foreign.example", "null"]) {
      const response = await app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
        method: "POST", headers: { Authorization: `Bearer ${TEST_KEY}`, Origin: origin },
        body: JSON.stringify({ profile: "default", grantId: "grant", requestId: "request" }),
      }))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ code: "forbidden_origin" })
    }
  })

  it("rejects malformed JSON, arrays, implicit selection, bad IDs and extra fields", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    for (const body of ["{", "[]", "null", "{}", JSON.stringify({ profile: "default", grantId: "grant" }),
      JSON.stringify({ profile: "default", grantId: "BAD", requestId: "request" }),
      JSON.stringify({ profile: "", grantId: "grant", requestId: "request" }),
      JSON.stringify({ profile: 42, grantId: "grant", requestId: "request" }),
      JSON.stringify({ profile: "default", grantId: "x".repeat(41), requestId: "request" }),
      JSON.stringify({ profile: "default", grantId: "grant", requestId: "" }),
      JSON.stringify({ profile: "default", grantId: "grant", requestId: "x".repeat(65) }),
      JSON.stringify({ profile: "default", grantId: "grant", requestId: "not allowed" }),
      JSON.stringify({ profile: "default", grantId: "grant", requestId: "request", organization: "caller-org" })]) {
      const response = await app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
        method: "POST", headers: { Authorization: `Bearer ${TEST_KEY}`, Origin: "http://localhost" }, body,
      }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "invalid_request" })
      expect(response.headers.get("cache-control")).toBe("no-store")
    }
  })

  it("rejects nonexistent profiles without falling back to default credentials", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const response = await app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
      method: "POST", headers: { Authorization: `Bearer ${TEST_KEY}` },
      body: JSON.stringify({ profile: "nonexistent", grantId: "grant", requestId: "request" }),
    }))
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ code: "profile_not_found" })
  })
  it("rejects API profiles and does not allow implicit default beside configured profiles", async () => {
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1",
      profiles: [{ id: "api-seat", type: "api", apiKey: "fake-api-key" }],
    })
    for (const [profile, status, code] of [["api-seat", 400, "not_oauth"], ["default", 404, "profile_not_found"]] as const) {
      const response = await app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
        method: "POST", headers: { Authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ profile, grantId: "grant", requestId: "request" }),
      }))
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ code })
    }
  })
  it("rejects token profiles even when their raw type is absent or claims claude-max", async () => {
    const { app } = createProxyServer({
      port: 0, host: "127.0.0.1",
      profiles: [
        { id: "inferred", oauthToken: "fake-inferred-token" },
        { id: "mislabelled", type: "claude-max", oauthToken: "fake-mislabelled-token" },
      ],
    })
    for (const profile of ["inferred", "mislabelled"]) {
      const response = await app.fetch(new Request("http://localhost/v1/usage/quota/reset", {
        method: "POST", headers: { Authorization: `Bearer ${TEST_KEY}` },
        body: JSON.stringify({ profile, grantId: "grant", requestId: "request" }),
      }))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ code: "not_oauth" })
    }
  })
})

describe("MERIDIAN_API_KEY — /settings/api/* (regression for #477)", () => {
  it("rejects GET /settings/api/features without auth", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features"))
    expect(res.status).toBe(401)
  })

  it("rejects PATCH /settings/api/features/:adapter without auth", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sharedMemory: true }),
    }))
    expect(res.status).toBe(401)
  })

  it("rejects DELETE /settings/api/features/:adapter without auth", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features/opencode", {
      method: "DELETE",
    }))
    expect(res.status).toBe(401)
  })

  it("rejects GET /settings (HTML dashboard) without auth — same protection as /profiles, /plugins", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings"))
    expect(res.status).toBe(401)
  })

  it("accepts GET /settings/api/features with a matching x-api-key", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features", {
      headers: { "x-api-key": TEST_KEY },
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // Body shape is FeatureConfig — a record of adapter → partial features.
    // We only assert it parses; exact contents depend on host config.
    expect(typeof body).toBe("object")
  })

  it("accepts GET /settings/api/features with a matching Bearer token", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })
    const res = await app.fetch(new Request("http://localhost/settings/api/features", {
      headers: { "authorization": `Bearer ${TEST_KEY}` },
    }))
    expect(res.status).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Audit: any sensitive route added in the future must go through requireAuth.
// ---------------------------------------------------------------------------
describe("auth audit: every registered prefix is protected when MERIDIAN_API_KEY is set", () => {
  // Routes that are *intentionally* public. They serve read-only,
  // non-sensitive content (landing page; auth status; the two probes). If
  // you're adding to this list, that's a security review. When in doubt, gate
  // it.
  //
  // The review for `/livez` and `/readyz`, since this list is where it belongs:
  //
  //   what they emit  `ok`, or a check NAME and pass/fail per check. No
  //                   account, no email, no token, no profile id - strictly
  //                   less than `/health` beside them, which answers with the
  //                   signed-in email and subscription type to anyone.
  //   why not gated   a 401 is what a load balancer reads as "this backend is
  //                   down". Gating these would make every instance look
  //                   unhealthy the moment MERIDIAN_API_KEY is set, so an auth
  //                   setting would become a total outage of whatever sits in
  //                   front - the failure this pair exists to prevent.
  //
  // The review for `/inflight`:
  //
  //   what it emits   request COUNTS per upstream and two timestamps. No
  //                   session id, prompt, profile, account or token.
  //   why not gated   its reader is a restart supervisor on the same host,
  //                   which has no reason to hold the API key. It is instead
  //                   answered only to a loopback socket peer without
  //                   forwarding headers, so it returns 403, not 401, here.
  //
  //   /callback OAuth redirect target for profile login.
  //
  //     Cannot be gated: Anthropic redirects the user's BROWSER here after
  //     sign-in, and that redirect carries no API key. Gating it would make
  //     the browser login flow fail on exactly the instances that took the
  //     trouble to set MERIDIAN_API_KEY.
  //
  //     Safe to leave open because reaching it proves nothing and grants
  //     nothing. It acts only on a `state` that (a) was minted by
  //     /profiles/login/start, which IS gated, (b) is 256 bits of CSPRNG
  //     output that never leaves this process except into the authorize URL,
  //     and (c) is single-use and expires in 10 minutes. Without a matching
  //     open login it returns 410 and does nothing at all. It cannot start a
  //     login, cannot name a profile, cannot enumerate anything: the response
  //     is the same page whether the `state` was wrong or merely expired.
  //     An attacker who could guess a live `state` would still be handing
  //     Anthropic's own authorization code to the user's own profile — the
  //     PKCE verifier it would be exchanged against is held here, not by them.
  //
  // `/drain` mutates admission, so #1282 requires the configured API key in
  // addition to the actual loopback/no-Origin/no-forwarding checks.
  const PUBLIC_PREFIXES = new Set(["/", "/health", "/livez", "/readyz", "/inflight", "/callback"])

  it("rejects unauthenticated requests to every non-public route prefix", async () => {
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1" })

    // Hono exposes the registered routes via `app.routes`. Each entry has
    // { method, path, handler }. Middleware mounts (app.use) appear too but
    // with method "ALL"; we want the actual route handlers (GET/POST/etc.)
    // for paths to probe.
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes
    const prefixes = new Set<string>()
    for (const r of routes) {
      if (r.method === "ALL") continue
      // Strip param placeholders so `/settings/api/features/:adapter`
      // becomes `/settings/api/features/x` — a fetchable path.
      const probePath = r.path.replace(/:\w+/g, "x")
      prefixes.add(probePath)
    }

    const failures: string[] = []
    for (const path of prefixes) {
      if (PUBLIC_PREFIXES.has(path)) continue
      const res = await app.fetch(new Request(`http://localhost${path}`))
      // Non-401 → not gated. 401 → correctly gated. Any other status (404,
      // 405) on a route the server registered would itself be surprising.
      if (res.status !== 401) {
        failures.push(`${path} returned ${res.status} (expected 401 — not protected by requireAuth)`)
      }
    }

    expect(failures).toEqual([])
  })
})
