import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPendingLogins } from "../proxy/profileLogin"
import { resetDiskProfileDiscovery } from "../proxy/profiles"
import { createProxyServer } from "../proxy/server"
import { stopBackgroundRefresh } from "../proxy/tokenRefresh"

const TOKEN_RESPONSE = {
  access_token: "route-access-token",
  refresh_token: "route-refresh-token",
  expires_in: 3600,
}

// Credential writes are Keychain-backed on darwin; the paths that actually
// persist are Linux/Windows only here, as in profile-token-refresh-route.test.ts.
const skipOnDarwin = process.platform === "darwin"

describe("profile login routes", () => {
  let originalFetch: typeof globalThis.fetch
  let tempDir: string
  let app: ReturnType<typeof createProxyServer>["app"]

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.fetch(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }))
  }

  function get(path: string, headers: Record<string, string> = {}) {
    return app.fetch(new Request(`http://localhost${path}`, { headers }))
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    tempDir = mkdtempSync(join(tmpdir(), "meridian-login-route-"))
    mkdirSync(join(tempDir, "personal"), { recursive: true })
    resetPendingLogins()
    // The server is built with an explicit profile list; keep disk discovery
    // out of it so an earlier file in the same process cannot merge the host's
    // real profiles.json into these assertions.
    resetDiskProfileDiscovery()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_API_KEY

    app = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [
        { id: "personal", claudeConfigDir: join(tempDir, "personal") },
        { id: "direct", type: "api", apiKey: "sk-ant-api-test" },
      ],
      defaultProfile: "personal",
      silent: true,
    }).app
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    stopBackgroundRefresh()
    resetPendingLogins()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_API_KEY
    rmSync(tempDir, { recursive: true, force: true })
  })

  function stubTokenEndpoint(makeResponse: () => Response) {
    const requests: Array<Record<string, unknown>> = []
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>)
        return makeResponse()
      },
      { preconnect: originalFetch.preconnect },
    )
    return requests
  }

  it("starts a login and returns an authorize URL without the PKCE verifier", async () => {
    const res = await post("/profiles/login/start", { profile: "personal" })
    expect(res.status).toBe(200)

    const raw = await res.text()
    expect(raw).not.toContain("codeVerifier")
    expect(raw).not.toContain("code_verifier")

    const body = JSON.parse(raw) as { loginId: string; authorizeUrl: string; expiresAt: number; profile: string }
    expect(body.profile).toBe("personal")
    expect(body.loginId).toBeTruthy()
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    expect(new URL(body.authorizeUrl).searchParams.get("code_challenge")).toBeTruthy()
  })

  it("refuses to start on an instance that must not write credentials", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const res = await post("/profiles/login/start", { profile: "personal" })
    expect(res.status).toBe(409)

    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe("credentials_readonly")
    expect(body.error).toContain("MERIDIAN_CREDENTIALS_READONLY")
    expect(body.error).toContain("meridian profile login personal")
  })

  it("404s an unknown profile and 400s a profile type with no OAuth flow", async () => {
    const unknown = await post("/profiles/login/start", { profile: "ghost" })
    expect(unknown.status).toBe(404)
    expect((await unknown.json() as { code: string }).code).toBe("unknown_profile")

    const apiProfile = await post("/profiles/login/start", { profile: "direct" })
    expect(apiProfile.status).toBe(400)
    expect((await apiProfile.json() as { code: string }).code).toBe("unsupported_profile_type")
  })

  it("400s a missing profile, malformed JSON, and a completion with no login id", async () => {
    expect((await post("/profiles/login/start", {})).status).toBe(400)

    const malformed = await app.fetch(new Request("http://localhost/profiles/login/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }))
    expect(malformed.status).toBe(400)

    const noId = await post("/profiles/login/complete", { code: "abc123" })
    expect(noId.status).toBe(400)
    expect((await noId.json() as { code: string }).code).toBe("invalid_request")
  })

  it("410s a login id that was never issued", async () => {
    const res = await post("/profiles/login/complete", { loginId: "made-up", code: "abc123" })
    expect(res.status).toBe(410)
    expect((await res.json() as { code: string }).code).toBe("expired_login")
  })

  it.skipIf(skipOnDarwin)("completes a login from a bare code and writes the profile's credentials", async () => {
    const started = await post("/profiles/login/start", { profile: "personal" })
    const { loginId } = await started.json() as { loginId: string }

    const requests = stubTokenEndpoint(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))

    const res = await post("/profiles/login/complete", { loginId, code: "abc123" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, profile: "personal" })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ grant_type: "authorization_code", code: "abc123" })
    expect(JSON.parse(readFileSync(join(tempDir, "personal", ".credentials.json"), "utf-8")).claudeAiOauth.accessToken)
      .toBe("route-access-token")
  })

  it.skipIf(skipOnDarwin)("completes a login from the pasted callback URL", async () => {
    const started = await post("/profiles/login/start", { profile: "personal" })
    const { loginId, authorizeUrl } = await started.json() as { loginId: string; authorizeUrl: string }
    const state = new URL(authorizeUrl).searchParams.get("state")

    stubTokenEndpoint(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))

    const res = await post("/profiles/login/complete", {
      loginId,
      code: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
    })
    expect(res.status).toBe(200)
    expect(JSON.parse(readFileSync(join(tempDir, "personal", ".credentials.json"), "utf-8")).claudeAiOauth.accessToken)
      .toBe("route-access-token")
  })

  it.skipIf(skipOnDarwin)("410s a replayed completion", async () => {
    const started = await post("/profiles/login/start", { profile: "personal" })
    const { loginId } = await started.json() as { loginId: string }

    const requests = stubTokenEndpoint(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))

    expect((await post("/profiles/login/complete", { loginId, code: "abc123" })).status).toBe(200)
    expect((await post("/profiles/login/complete", { loginId, code: "abc123" })).status).toBe(410)
    expect(requests).toHaveLength(1)
  })

  it("400s a state that does not match, and never contacts the token endpoint", async () => {
    const started = await post("/profiles/login/start", { profile: "personal" })
    const { loginId } = await started.json() as { loginId: string }

    const requests = stubTokenEndpoint(() => new Response("{}", { status: 200 }))

    const res = await post("/profiles/login/complete", {
      loginId,
      code: "https://platform.claude.com/oauth/code/callback?code=abc123&state=someone-elses-state",
    })
    expect(res.status).toBe(400)
    // `retryable` is what tells the page to keep its paste box open rather than
    // sending the user back through sign-in.
    expect(await res.json()).toMatchObject({ code: "state_mismatch", retryable: true })
    expect(requests).toHaveLength(0)
    expect(existsSync(join(tempDir, "personal", ".credentials.json"))).toBe(false)

    // Nothing reached Anthropic, so the login is still open for the right paste.
    const retry = await post("/profiles/login/complete", { loginId, code: "abc123" })
    expect(retry.status).not.toBe(410)
  })

  it("502s an upstream rejection without leaking the token endpoint's body", async () => {
    const started = await post("/profiles/login/start", { profile: "personal" })
    const { loginId } = await started.json() as { loginId: string }

    stubTokenEndpoint(() => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ))

    const res = await post("/profiles/login/complete", { loginId, code: "stale-code" })
    expect(res.status).toBe(502)
    const raw = await res.text()
    expect(raw).toContain("exchange_failed")
    expect(raw).not.toContain("retryable")
    expect(raw).not.toContain("invalid_grant")
    expect(raw).not.toContain("already redeemed")
  })

  // The three /profiles/* routes inherit requireAuth from the prefix rather
  // than registering it themselves — asserted rather than assumed. /callback
  // deliberately does not; see the next test.
  it("requires the API key on the profile-scoped routes when one is configured", async () => {
    process.env.MERIDIAN_API_KEY = "secret-key"

    expect((await post("/profiles/login/start", { profile: "personal" })).status).toBe(401)
    expect((await post("/profiles/login/complete", { loginId: "x", code: "y" })).status).toBe(401)
    expect((await get("/profiles/login/status?loginId=x")).status).toBe(401)

    const authorized = await post("/profiles/login/start", { profile: "personal" }, { "x-api-key": "secret-key" })
    expect(authorized.status).toBe(200)
  })

  it("leaves /callback reachable without the API key, because Anthropic's redirect carries none", async () => {
    process.env.MERIDIAN_API_KEY = "secret-key"

    const res = await get("/callback?state=nothing-is-waiting&code=x")
    // Refused on its merits (no such login), NOT on auth.
    expect(res.status).toBe(410)
    expect(res.headers.get("content-type")).toContain("text/html")
  })

  describe("browser redirect flow", () => {
    it("offers a loopback redirect to a browser on this host, and a paste to any other", async () => {
      const local = await post("/profiles/login/start", { profile: "personal" }, { host: "127.0.0.1:3457" })
      const localBody = await local.json() as { mode: string; authorizeUrl: string; pasteAuthorizeUrl: string }
      expect(localBody.mode).toBe("redirect")
      expect(new URL(localBody.authorizeUrl).searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3457/callback")
      expect(new URL(localBody.pasteAuthorizeUrl).searchParams.get("redirect_uri"))
        .toBe("https://platform.claude.com/oauth/code/callback")

      const remote = await post("/profiles/login/start", { profile: "personal" }, { host: "meridian.example.com" })
      const remoteBody = await remote.json() as { mode: string; authorizeUrl: string; pasteAuthorizeUrl: string }
      expect(remoteBody.mode).toBe("paste")
      expect(remoteBody.authorizeUrl).toBe(remoteBody.pasteAuthorizeUrl)
    })

    it.skipIf(skipOnDarwin)("completes a login presented by a client that never initiated it", async () => {
      // The point of putting a real URL in an href: the sign-in can be finished
      // in an incognito window, or another browser entirely, which shares no
      // cookies, no storage and no script with the page that started it. That
      // works only because the verifier and `state` are held server-side and
      // keyed by `state` alone — so this pins it.
      const started = await post("/profiles/login/start", { profile: "personal" }, {
        host: "127.0.0.1:3457",
        cookie: "meridian-ui=originating-browser",
        "user-agent": "OriginatingBrowser/1.0",
      })
      const { loginId, loopbackAuthorizeUrl } = await started.json() as {
        loginId: string
        loopbackAuthorizeUrl: string
      }
      const state = new URL(loopbackAuthorizeUrl).searchParams.get("state") ?? ""

      const requests = stubTokenEndpoint(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))

      const res = await app.fetch(new Request(`http://localhost/callback?state=${state}&code=from-another-browser`, {
        headers: { "user-agent": "PrivateWindow/2.0", host: "127.0.0.1:3457" },
      }))
      expect(res.status).toBe(200)
      expect(requests).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(tempDir, "personal", ".credentials.json"), "utf-8")).claudeAiOauth.accessToken)
        .toBe(TOKEN_RESPONSE.access_token)

      // …and the page that started it learns the outcome, having done nothing.
      const status = await get(`/profiles/login/status?loginId=${loginId}`)
      expect(await status.json()).toMatchObject({ status: "completed", profileId: "personal" })
    })

    it("hands a browser under another name the loopback candidate and a probe for it", async () => {
      // A configured port is what makes the candidate expressible; the other
      // tests run on port 0, where there is no address to offer.
      const ported = createProxyServer({
        port: 3999,
        host: "127.0.0.1",
        profiles: [{ id: "personal", claudeConfigDir: join(tempDir, "personal") }],
        defaultProfile: "personal",
        silent: true,
      }).app

      const res = await ported.fetch(new Request("http://localhost/profiles/login/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", host: "meridian-dev.desktop.ts.nowaker.net" },
        body: JSON.stringify({ profile: "personal" }),
      }))
      const body = await res.json() as {
        mode: string
        loginId: string
        authorizeUrl: string
        pasteAuthorizeUrl: string
        loopbackAuthorizeUrl?: string
        loopbackProbeUrl?: string
      }

      expect(body.mode).toBe("paste")
      expect(body.authorizeUrl).toBe(body.pasteAuthorizeUrl)
      expect(new URL(body.loopbackAuthorizeUrl ?? "").searchParams.get("redirect_uri"))
        .toBe("http://127.0.0.1:3999/callback")
      // The probe is this login's own status URL on the loopback origin, so a
      // 200 from it proves the responder is this very instance.
      expect(body.loopbackProbeUrl)
        .toBe(`http://127.0.0.1:3999/profiles/login/status?loginId=${encodeURIComponent(body.loginId)}`)
    })

    it.skipIf(skipOnDarwin)("completes the login when Claude redirects back, and says so on the page", async () => {
      const started = await post("/profiles/login/start", { profile: "personal" }, { host: "127.0.0.1:3457" })
      const { loginId, authorizeUrl } = await started.json() as { loginId: string; authorizeUrl: string }
      const state = new URL(authorizeUrl).searchParams.get("state") ?? ""

      const requests = stubTokenEndpoint(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))

      const res = await get(`/callback?code=redirect-code&state=${encodeURIComponent(state)}`)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain("Signed in")
      expect(html).toContain("personal")
      // The one-time code must not survive into the rendered page.
      expect(html).not.toContain("redirect-code")

      expect(requests[0]).toMatchObject({ redirect_uri: "http://127.0.0.1:3457/callback" })
      expect(JSON.parse(readFileSync(join(tempDir, "personal", ".credentials.json"), "utf-8")).claudeAiOauth.accessToken)
        .toBe("route-access-token")

      const status = await get(`/profiles/login/status?loginId=${encodeURIComponent(loginId)}`)
      expect(status.status).toBe(200)
      expect(await status.json()).toEqual({ status: "completed", profileId: "personal" })
    })

    it("renders an error page, not a success one, when the redirect brings a refusal", async () => {
      const started = await post("/profiles/login/start", { profile: "personal" }, { host: "127.0.0.1:3457" })
      const { loginId, authorizeUrl } = await started.json() as { loginId: string; authorizeUrl: string }
      const state = new URL(authorizeUrl).searchParams.get("state") ?? ""

      const requests = stubTokenEndpoint(() => new Response("{}", { status: 200 }))
      const res = await get(`/callback?error=access_denied&state=${encodeURIComponent(state)}`)

      expect(res.status).toBe(400)
      expect(await res.text()).toContain("Login failed")
      expect(requests).toHaveLength(0)

      const status = await get(`/profiles/login/status?loginId=${encodeURIComponent(loginId)}`)
      expect(await status.json()).toMatchObject({ status: "failed", code: "login_denied" })
    })

    it("reports a login still waiting, and 410s a status nobody is holding", async () => {
      const started = await post("/profiles/login/start", { profile: "personal" }, { host: "127.0.0.1:3457" })
      const { loginId } = await started.json() as { loginId: string }

      const waiting = await get(`/profiles/login/status?loginId=${encodeURIComponent(loginId)}`)
      expect(await waiting.json()).toEqual({ status: "waiting", profileId: "personal" })

      const unknown = await get("/profiles/login/status?loginId=made-up")
      expect(unknown.status).toBe(410)
      expect((await unknown.json() as { code: string }).code).toBe("expired_login")

      const missingParam = await get("/profiles/login/status")
      expect(missingParam.status).toBe(400)
      expect((await missingParam.json() as { code: string }).code).toBe("invalid_request")
    })
  })
})
