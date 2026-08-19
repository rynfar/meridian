import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { networkInterfaces, tmpdir } from "node:os"
import { join } from "node:path"
import {
  LOGIN_RESULT_TTL_MS,
  LOGIN_TTL_MS,
  clientIsOnThisHost,
  completeProfileLogin,
  completeProfileLoginFromCallback,
  getProfileLoginStatus,
  isLoopbackCallbackInput,
  normalizeClientAddress,
  pendingLoginCount,
  resetPendingLogins,
  loopbackRedirectUriForPort,
  resolveLoopbackRedirectUri,
  startProfileLogin,
} from "../proxy/profileLogin"
import { resetDiskProfileDiscovery, type ProfileConfig } from "../proxy/profiles"

const TOKEN_RESPONSE = {
  access_token: "web-login-access-token",
  refresh_token: "web-login-refresh-token",
  expires_in: 3600,
  scope: "user:inference user:profile",
}

interface TokenRequest {
  code?: string
  state?: string
  code_verifier?: string
  redirect_uri?: string
  grant_type?: string
}

/** Records the token requests it is handed, so tests can assert what was sent
 *  (and, for the failure paths, that nothing was sent at all). */
function stubTokenFetch(makeResponse: () => Response) {
  const requests: TokenRequest[] = []
  const fetchFn: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(JSON.parse(String(init?.body ?? "{}")) as TokenRequest)
      return makeResponse()
    },
    { preconnect: globalThis.fetch.preconnect },
  )
  return { fetchFn, requests }
}

function okTokenFetch() {
  return stubTokenFetch(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }))
}

function credentialsAt(dir: string): { accessToken: string; refreshToken: string; scopes: string[] } {
  return JSON.parse(readFileSync(join(dir, ".credentials.json"), "utf-8")).claudeAiOauth
}

// Credential writes go to the Keychain on darwin, so the assertions that read a
// .credentials.json file (and any path that writes at all) are Linux/Windows
// only — same reason profile-token-refresh-route.test.ts skips there.
const skipOnDarwin = process.platform === "darwin"

// A real address of the machine running the test, so "is this one of ours?" is
// asserted against what the host actually reports rather than a literal that
// would only be right on one box. A container with nothing but loopback has
// none, and those cases skip.
const ownExternalAddress = Object.values(networkInterfaces())
  .flatMap(addresses => addresses ?? [])
  .find(address => !address.internal && address.family === "IPv4")
  ?.address

describe("profileLogin", () => {
  let tempDir: string
  let profiles: ProfileConfig[]

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "meridian-web-login-"))
    mkdirSync(join(tempDir, "personal"), { recursive: true })
    mkdirSync(join(tempDir, "work"), { recursive: true })
    profiles = [
      { id: "personal", claudeConfigDir: join(tempDir, "personal") },
      { id: "work", claudeConfigDir: join(tempDir, "work") },
      { id: "ci", type: "oauth-token", oauthToken: "sk-ant-oat01-test" },
      { id: "direct", type: "api", apiKey: "sk-ant-api-test" },
    ]
    resetPendingLogins()
    // These cases pass an explicit profile list, so disk discovery must be off
    // — otherwise a file that ran earlier in the same process (proxy-async-ops
    // imports bin/cli.ts) has turned it on, and the host's real profiles.json
    // merges into every assertion.
    resetDiskProfileDiscovery()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
  })

  afterEach(() => {
    resetPendingLogins()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe("startProfileLogin", () => {
    it("returns an authorize URL and an opaque login id, and never the PKCE verifier", () => {
      const result = startProfileLogin({ profiles, profileId: "personal" })
      if (!result.ok) throw new Error(`expected success, got ${result.code}`)

      expect(result.profileId).toBe("personal")
      expect(result.loginId.length).toBeGreaterThan(16)
      expect(result.expiresAt).toBeGreaterThan(Date.now())

      const url = new URL(result.authorizeUrl)
      expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toBeTruthy()
      expect(url.searchParams.get("state")).toBeTruthy()
      expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback")

      // The whole point of the server-side map: neither half of the PKCE pair
      // that the browser must not hold may appear in the response.
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("codeVerifier")
      expect(serialized).not.toContain("code_verifier")
      expect(pendingLoginCount()).toBe(1)
    })

    it("refuses an unknown profile instead of creating one", () => {
      const result = startProfileLogin({ profiles, profileId: "nope" })
      expect(result).toMatchObject({ ok: false, code: "unknown_profile", status: 404 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("personal")
      expect(pendingLoginCount()).toBe(0)
    })

    it("refuses when no profiles are configured", () => {
      const result = startProfileLogin({ profiles: [], profileId: "personal" })
      expect(result).toMatchObject({ ok: false, code: "no_profiles", status: 400 })
    })

    it("refuses a blank profile id", () => {
      const result = startProfileLogin({ profiles, profileId: "  " })
      expect(result).toMatchObject({ ok: false, code: "invalid_request", status: 400 })
    })

    it("refuses an oauth-token profile and names the replacement path", () => {
      const result = startProfileLogin({ profiles, profileId: "ci" })
      expect(result).toMatchObject({ ok: false, code: "unsupported_profile_type", status: 400 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("oauth-token")
      expect(result.message).toContain("--oauth-token")
      expect(pendingLoginCount()).toBe(0)
    })

    it("refuses an api profile", () => {
      const result = startProfileLogin({ profiles, profileId: "direct" })
      expect(result).toMatchObject({ ok: false, code: "unsupported_profile_type", status: 400 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("api")
    })

    it("refuses on a read-only instance before any login is started", () => {
      process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
      const result = startProfileLogin({ profiles, profileId: "personal" })
      expect(result).toMatchObject({ ok: false, code: "credentials_readonly", status: 409 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("MERIDIAN_CREDENTIALS_READONLY")
      expect(result.message).toContain("meridian profile login personal")
      // Nothing was minted, so no authorization code can be burned against it.
      expect(pendingLoginCount()).toBe(0)
    })

    it("honours the legacy CLAUDE_PROXY_ alias for the read-only flag", () => {
      process.env.CLAUDE_PROXY_CREDENTIALS_READONLY = "1"
      expect(startProfileLogin({ profiles, profileId: "personal" })).toMatchObject({
        ok: false,
        code: "credentials_readonly",
      })
    })

    it("keeps two logins for different profiles independent", () => {
      const first = startProfileLogin({ profiles, profileId: "personal" })
      const second = startProfileLogin({ profiles, profileId: "work" })
      if (!first.ok || !second.ok) throw new Error("expected both to start")

      expect(first.loginId).not.toBe(second.loginId)
      expect(new URL(first.authorizeUrl).searchParams.get("state"))
        .not.toBe(new URL(second.authorizeUrl).searchParams.get("state"))
      expect(pendingLoginCount()).toBe(2)
    })
  })

  describe("completeProfileLogin", () => {
    it("rejects an unknown login id", async () => {
      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({ loginId: "never-issued", input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(0)
    })

    it("rejects a login past its TTL", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: "abc123",
        now: Date.now() + LOGIN_TTL_MS + 1,
        fetchFn,
      })
      expect(result).toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(0)
      expect(pendingLoginCount()).toBe(0)
    })

    it("rejects a state that does not match the login, without sending the code", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: "https://platform.claude.com/oauth/code/callback?code=abc123&state=not-my-state",
        fetchFn,
      })
      expect(result).toMatchObject({ ok: false, code: "state_mismatch", status: 400, retryable: true })
      expect(requests).toHaveLength(0)
      expect(existsSync(join(tempDir, "personal", ".credentials.json"))).toBe(false)
      // Nothing was spent, so the login survives — see the next test.
      expect(pendingLoginCount()).toBe(1)
    })

    it.skipIf(skipOnDarwin)("still accepts the right paste after a state mismatch", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state")

      const { fetchFn, requests } = okTokenFetch()
      const wrongTab = await completeProfileLogin({
        loginId: started.loginId,
        input: "https://platform.claude.com/oauth/code/callback?code=other-flow&state=not-my-state",
        fetchFn,
      })
      expect(wrongTab).toMatchObject({ ok: false, code: "state_mismatch" })

      const rightTab = await completeProfileLogin({
        loginId: started.loginId,
        input: `https://platform.claude.com/oauth/code/callback?code=real-code&state=${state}`,
        fetchFn,
      })
      expect(rightTab).toMatchObject({ ok: true, profileId: "personal" })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ code: "real-code" })
      expect(pendingLoginCount()).toBe(0)
    })

    it("keeps the login open when the paste carries no code", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({ loginId: started.loginId, input: "   ", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "no_code", status: 400, retryable: true })
      expect(requests).toHaveLength(0)
      // A mistyped paste must not cost the user another trip through sign-in.
      expect(pendingLoginCount()).toBe(1)
    })

    it("reports an upstream rejection without echoing the token endpoint's body", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ))
      const result = await completeProfileLogin({ loginId: started.loginId, input: "expired-code", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed", status: 502 })
      if (result.ok) throw new Error("expected refusal")
      // The code reached Anthropic and is spent — never invite a retry with it.
      expect(result.retryable).toBeUndefined()
      expect(pendingLoginCount()).toBe(0)
      expect(result.message).toContain("400")
      expect(result.message).not.toContain("invalid_grant")
      expect(result.message).not.toContain("already redeemed")
    })

    it("reports a transport failure", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const fetchFn: typeof fetch = Object.assign(
        async () => { throw new Error("getaddrinfo ENOTFOUND platform.claude.com") },
        { preconnect: globalThis.fetch.preconnect },
      )
      const result = await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed", status: 502 })
    })

    it.skipIf(skipOnDarwin)("accepts a bare code and writes the profile's credentials", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({ loginId: started.loginId, input: "  abc123  ", fetchFn })
      expect(result).toMatchObject({ ok: true, profileId: "personal" })

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        grant_type: "authorization_code",
        code: "abc123",
        redirect_uri: "https://platform.claude.com/oauth/code/callback",
      })

      const stored = credentialsAt(join(tempDir, "personal"))
      expect(stored.accessToken).toBe("web-login-access-token")
      expect(stored.refreshToken).toBe("web-login-refresh-token")
      expect(stored.scopes).toEqual(["user:inference", "user:profile"])
      expect(existsSync(join(tempDir, "work", ".credentials.json"))).toBe(false)
    })

    it.skipIf(skipOnDarwin)("accepts the whole callback URL, matching its state", async () => {
      const started = startProfileLogin({ profiles, profileId: "work" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state")

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
        fetchFn,
      })
      expect(result).toMatchObject({ ok: true, profileId: "work" })
      expect(requests[0]).toMatchObject({ code: "url-code", state })
      expect(credentialsAt(join(tempDir, "work")).accessToken).toBe("web-login-access-token")
    })

    it.skipIf(skipOnDarwin)("sends the verifier that matches the challenge the browser was given", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")
      const challenge = new URL(started.authorizeUrl).searchParams.get("code_challenge") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })

      const sent = requests[0]?.code_verifier
      expect(sent).toBeTruthy()
      expect(createHash("sha256").update(String(sent)).digest("base64url")).toBe(challenge)
    })

    it.skipIf(skipOnDarwin)("is single-use — a replayed login id is gone", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      expect(await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn }))
        .toMatchObject({ ok: true })
      expect(await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn }))
        .toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(1)
      expect(pendingLoginCount()).toBe(0)
    })

    it.skipIf(skipOnDarwin)("consumes the login even when the exchange fails, since the code was sent", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn } = stubTokenFetch(() => new Response("{}", { status: 400 }))
      await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })
      expect(pendingLoginCount()).toBe(0)
    })

    it.skipIf(skipOnDarwin)("refuses a token response that omits the refresh token", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ access_token: "only-access", expires_in: 3600 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      const result = await completeProfileLogin({ loginId: started.loginId, input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed" })
      expect(existsSync(join(tempDir, "personal", ".credentials.json"))).toBe(false)
    })

    it.skipIf(skipOnDarwin)("routes two concurrent logins to their own profiles", async () => {
      const first = startProfileLogin({ profiles, profileId: "personal" })
      const second = startProfileLogin({ profiles, profileId: "work" })
      if (!first.ok || !second.ok) throw new Error("expected both to start")

      const personalFetch = stubTokenFetch(() => new Response(
        JSON.stringify({ ...TOKEN_RESPONSE, access_token: "personal-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      const workFetch = stubTokenFetch(() => new Response(
        JSON.stringify({ ...TOKEN_RESPONSE, access_token: "work-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))

      const [personalResult, workResult] = await Promise.all([
        completeProfileLogin({ loginId: first.loginId, input: "code-a", fetchFn: personalFetch.fetchFn }),
        completeProfileLogin({ loginId: second.loginId, input: "code-b", fetchFn: workFetch.fetchFn }),
      ])

      expect(personalResult).toMatchObject({ ok: true, profileId: "personal" })
      expect(workResult).toMatchObject({ ok: true, profileId: "work" })
      expect(credentialsAt(join(tempDir, "personal")).accessToken).toBe("personal-token")
      expect(credentialsAt(join(tempDir, "work")).accessToken).toBe("work-token")
    })
  })

  describe("resolveLoopbackRedirectUri", () => {
    it("builds a callback URL for the two hosts Anthropic registered", () => {
      expect(resolveLoopbackRedirectUri("localhost:3457")).toBe("http://localhost:3457/callback")
      expect(resolveLoopbackRedirectUri("127.0.0.1:3457")).toBe("http://127.0.0.1:3457/callback")
      // Port 80 — the registered URI verbatim.
      expect(resolveLoopbackRedirectUri("localhost")).toBe("http://localhost/callback")
    })

    it("declines every origin a redirect could not come back from", () => {
      expect(resolveLoopbackRedirectUri("meridian.example.com")).toBeUndefined()
      expect(resolveLoopbackRedirectUri("meridian-dev.desktop.ts.nowaker.net")).toBeUndefined()
      expect(resolveLoopbackRedirectUri("192.168.1.5:3457")).toBeUndefined()
      expect(resolveLoopbackRedirectUri(undefined)).toBeUndefined()
      expect(resolveLoopbackRedirectUri("")).toBeUndefined()
      expect(resolveLoopbackRedirectUri("not a host")).toBeUndefined()
      expect(resolveLoopbackRedirectUri("localhost:999999")).toBeUndefined()
    })

    it("declines IPv6 loopback, which is not among the registered URIs", () => {
      expect(resolveLoopbackRedirectUri("[::1]:3457")).toBeUndefined()
    })

    it("rebuilds the URL instead of echoing the header", () => {
      // Host is client-supplied; anything past the authority is discarded
      // rather than trusted into the redirect target.
      expect(resolveLoopbackRedirectUri("localhost:3457/evil?x=1")).toBe("http://localhost:3457/callback")
      expect(resolveLoopbackRedirectUri("LOCALHOST:3457")).toBe("http://localhost:3457/callback")
    })
  })

  describe("loopbackRedirectUriForPort", () => {
    it("builds the candidate on the registered loopback host", () => {
      expect(loopbackRedirectUriForPort(3457)).toBe("http://127.0.0.1:3457/callback")
      expect(loopbackRedirectUriForPort(1)).toBe("http://127.0.0.1:1/callback")
      expect(loopbackRedirectUriForPort(65535)).toBe("http://127.0.0.1:65535/callback")
    })

    it("has nothing to offer without a real port", () => {
      expect(loopbackRedirectUriForPort(undefined)).toBeUndefined()
      expect(loopbackRedirectUriForPort(0)).toBeUndefined()
      expect(loopbackRedirectUriForPort(-1)).toBeUndefined()
      expect(loopbackRedirectUriForPort(65536)).toBeUndefined()
      expect(loopbackRedirectUriForPort(3457.5)).toBeUndefined()
      expect(loopbackRedirectUriForPort(Number.NaN)).toBeUndefined()
    })
  })

  describe("normalizeClientAddress", () => {
    it("strips what a proxy adds around an address", () => {
      expect(normalizeClientAddress("10.0.0.4:51234")).toBe("10.0.0.4")
      expect(normalizeClientAddress("[fd7a:115c:a1e0::1]:51234")).toBe("fd7a:115c:a1e0::1")
      expect(normalizeClientAddress("fe80::1%eth0")).toBe("fe80::1")
      expect(normalizeClientAddress("::ffff:127.0.0.1")).toBe("127.0.0.1")
      expect(normalizeClientAddress("  100.105.229.19  ")).toBe("100.105.229.19")
      expect(normalizeClientAddress("")).toBe("")
    })

    it("does not mistake an IPv6 address's last group for a port", () => {
      expect(normalizeClientAddress("fd7a:115c:a1e0::9538:e513")).toBe("fd7a:115c:a1e0::9538:e513")
      expect(normalizeClientAddress("::1")).toBe("::1")
    })
  })

  describe("clientIsOnThisHost", () => {
    it("says nothing when no proxy recorded an address", () => {
      expect(clientIsOnThisHost(undefined)).toBe(false)
      expect(clientIsOnThisHost("")).toBe(false)
      expect(clientIsOnThisHost("   ")).toBe(false)
    })

    it("recognizes loopback however it is spelled", () => {
      expect(clientIsOnThisHost("127.0.0.1")).toBe(true)
      expect(clientIsOnThisHost("::1")).toBe(true)
      expect(clientIsOnThisHost("::ffff:127.0.0.1")).toBe(true)
    })

    it("does not claim a browser on another machine", () => {
      expect(clientIsOnThisHost("203.0.113.7")).toBe(false)
      expect(clientIsOnThisHost("2001:db8::1")).toBe(false)
    })

    it("reads the CLIENT, not the proxy that carried it", () => {
      // Left to right: the first entry is the browser. A local proxy appearing
      // later must not make a remote browser look local — that would hand the
      // redirect flow to a machine it cannot come back to.
      expect(clientIsOnThisHost("127.0.0.1, 10.0.0.1")).toBe(true)
      expect(clientIsOnThisHost("203.0.113.7, 127.0.0.1")).toBe(false)
    })

    it.skipIf(!ownExternalAddress)("recognizes an address this machine answers on", () => {
      expect(clientIsOnThisHost(ownExternalAddress)).toBe(true)
      expect(clientIsOnThisHost(`${ownExternalAddress}:51234`)).toBe(true)
    })
  })

  describe("isLoopbackCallbackInput", () => {
    it("recognizes the address bar of a loopback callback", () => {
      expect(isLoopbackCallbackInput("http://127.0.0.1:3457/callback?code=x&state=y")).toBe(true)
      expect(isLoopbackCallbackInput("http://localhost:3457/callback?code=x")).toBe(true)
      expect(isLoopbackCallbackInput("  http://127.0.0.1:3457/callback?code=x  ")).toBe(true)
    })

    it("does not mistake a code, or the code-display page, for one", () => {
      expect(isLoopbackCallbackInput("bare-authorization-code")).toBe(false)
      expect(isLoopbackCallbackInput("https://platform.claude.com/oauth/code/callback?code=x")).toBe(false)
      expect(isLoopbackCallbackInput("http://127.0.0.1:3457/profiles")).toBe(false)
      expect(isLoopbackCallbackInput("https://127.0.0.1:3457/callback?code=x")).toBe(false)
      expect(isLoopbackCallbackInput("http://meridian.example.com/callback?code=x")).toBe(false)
    })
  })

  describe("startProfileLogin — redirect vs paste", () => {
    it("offers a loopback redirect when the browser is on this host", () => {
      const result = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!result.ok) throw new Error(`expected success, got ${result.code}`)

      expect(result.mode).toBe("redirect")
      expect(new URL(result.authorizeUrl).searchParams.get("redirect_uri"))
        .toBe("http://127.0.0.1:3457/callback")
      expect(new URL(result.pasteAuthorizeUrl).searchParams.get("redirect_uri"))
        .toBe("https://platform.claude.com/oauth/code/callback")
    })

    it("mints both authorize URLs from ONE challenge, so either may be completed", () => {
      const result = startProfileLogin({ profiles, profileId: "personal", hostHeader: "localhost:3457" })
      if (!result.ok) throw new Error("expected success")

      const redirect = new URL(result.authorizeUrl).searchParams
      const paste = new URL(result.pasteAuthorizeUrl).searchParams
      expect(redirect.get("state")).toBe(paste.get("state"))
      expect(redirect.get("code_challenge")).toBe(paste.get("code_challenge"))
      // One login, not two.
      expect(pendingLoginCount()).toBe(1)
    })

    it("falls back to paste for a browser that cannot be redirected back", () => {
      const result = startProfileLogin({ profiles, profileId: "personal", hostHeader: "meridian.example.com" })
      if (!result.ok) throw new Error("expected success")

      expect(result.mode).toBe("paste")
      expect(result.authorizeUrl).toBe(result.pasteAuthorizeUrl)
      expect(new URL(result.authorizeUrl).searchParams.get("redirect_uri"))
        .toBe("https://platform.claude.com/oauth/code/callback")
    })

    it("offers a loopback CANDIDATE to a browser that reached us under another name", () => {
      const result = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "meridian-dev.desktop.ts.nowaker.net",
        serverPort: 3457,
      })
      if (!result.ok) throw new Error("expected success")

      // Still paste by default — being on the Meridian host is not proven yet.
      expect(result.mode).toBe("paste")
      expect(result.authorizeUrl).toBe(result.pasteAuthorizeUrl)

      // …but the upgrade is offered, for the page to probe.
      expect(new URL(result.loopbackAuthorizeUrl ?? "").searchParams.get("redirect_uri"))
        .toBe("http://127.0.0.1:3457/callback")
      expect(result.loopbackProbeUrl)
        .toBe(`http://127.0.0.1:3457/profiles/login/status?loginId=${encodeURIComponent(result.loginId)}`)
    })

    it("redirects a browser a proxy placed on this host, without any probe", () => {
      // Nowaker's topology: the browser is on the Meridian box but reaches it
      // through Caddy under a tailnet name, so `Host` cannot tell and the page
      // was left to probe loopback from JavaScript. The proxy already knew.
      const result = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "meridian-dev.desktop.ts.nowaker.net",
        forwardedFor: "127.0.0.1",
        serverPort: 3457,
      })
      if (!result.ok) throw new Error("expected success")

      expect(result.mode).toBe("redirect")
      expect(result.authorizeUrl).toBe(result.loopbackAuthorizeUrl ?? "")
      expect(new URL(result.authorizeUrl).searchParams.get("redirect_uri"))
        .toBe("http://127.0.0.1:3457/callback")
    })

    it.skipIf(!ownExternalAddress)("redirects when the proxy recorded one of this host's own addresses", () => {
      const result = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "meridian-dev.desktop.ts.nowaker.net",
        forwardedFor: ownExternalAddress,
        serverPort: 3457,
      })
      if (!result.ok) throw new Error("expected success")
      expect(result.mode).toBe("redirect")
    })

    it("still pastes for a browser the proxy placed on another machine", () => {
      const result = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "meridian-dev.desktop.ts.nowaker.net",
        forwardedFor: "203.0.113.7",
        serverPort: 3457,
      })
      if (!result.ok) throw new Error("expected success")

      expect(result.mode).toBe("paste")
      expect(result.authorizeUrl).toBe(result.pasteAuthorizeUrl)
      // The candidate and its probe stand: a phone on the tailnet cannot reach
      // this host's loopback, but an SSH port-forward on another box can.
      expect(result.loopbackAuthorizeUrl).toBeDefined()
      expect(result.loopbackProbeUrl).toBeDefined()
    })

    it("prefers the address the browser actually used over the one a proxy reported", () => {
      const result = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "localhost:9999",
        forwardedFor: "203.0.113.7",
        serverPort: 3457,
      })
      if (!result.ok) throw new Error("expected success")

      expect(result.mode).toBe("redirect")
      expect(new URL(result.authorizeUrl).searchParams.get("redirect_uri"))
        .toBe("http://localhost:9999/callback")
    })

    it("offers no candidate when it cannot name a port", () => {
      const result = startProfileLogin({ profiles, profileId: "personal", hostHeader: "meridian.example.com" })
      if (!result.ok) throw new Error("expected success")
      expect(result.loopbackAuthorizeUrl).toBeUndefined()
      expect(result.loopbackProbeUrl).toBeUndefined()
    })

    it("does not need the probe when Host already proved loopback", () => {
      const result = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "localhost:3457",
        serverPort: 3457,
      })
      if (!result.ok) throw new Error("expected success")
      expect(result.mode).toBe("redirect")
      // Host wins over the port-derived guess: it is the address the browser
      // actually used, so it is the one that will come back.
      expect(result.authorizeUrl).toBe(result.loopbackAuthorizeUrl ?? "")
      expect(new URL(result.authorizeUrl).searchParams.get("redirect_uri"))
        .toBe("http://localhost:3457/callback")
    })

    it.skipIf(skipOnDarwin)("exchanges an UPGRADED login against the loopback redirect_uri", async () => {
      // The page probed loopback, took the upgrade and signed in there, so the
      // grant must name the loopback URI even though `mode` said paste.
      const started = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "meridian-dev.desktop.ts.nowaker.net",
        serverPort: 3457,
      })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.loopbackAuthorizeUrl ?? "").searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      expect(await completeProfileLoginFromCallback({ state, code: "redirected-code", fetchFn }))
        .toMatchObject({ ok: true, profileId: "personal" })
      expect(requests[0]?.redirect_uri).toBe("http://127.0.0.1:3457/callback")
    })

    it.skipIf(skipOnDarwin)("still exchanges a PASTED code against the code-display redirect_uri", async () => {
      // Started in redirect mode, finished by paste: the code came from the
      // other URL, so the grant must name that one or Anthropic rejects it.
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")

      const { fetchFn, requests } = okTokenFetch()
      expect(await completeProfileLogin({ loginId: started.loginId, input: "pasted-code", fetchFn }))
        .toMatchObject({ ok: true })
      expect(requests[0]?.redirect_uri).toBe("https://platform.claude.com/oauth/code/callback")
    })

    it.skipIf(skipOnDarwin)("completes from a PASTED loopback callback URL", async () => {
      // The redirect could not land — a browser on another machine, or a tab
      // that failed to load — so the user copied the address bar instead. That
      // code is bound to the loopback redirect_uri, and naming the code-display
      // one would have Anthropic reject a sign-in the user already completed.
      const started = startProfileLogin({
        profiles,
        profileId: "personal",
        hostHeader: "meridian-dev.desktop.ts.nowaker.net",
        serverPort: 3457,
      })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.loopbackAuthorizeUrl ?? "").searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLogin({
        loginId: started.loginId,
        input: `http://127.0.0.1:3457/callback?code=address-bar-code&state=${encodeURIComponent(state)}`,
        fetchFn,
      })

      expect(result).toMatchObject({ ok: true, profileId: "personal" })
      expect(requests[0]).toMatchObject({
        code: "address-bar-code",
        redirect_uri: "http://127.0.0.1:3457/callback",
      })
      expect(credentialsAt(join(tempDir, "personal")).accessToken).toBe("web-login-access-token")
    })
  })

  describe("completeProfileLoginFromCallback", () => {
    it.skipIf(skipOnDarwin)("exchanges against the loopback redirect_uri and writes the credentials", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLoginFromCallback({ state, code: "redirect-code", fetchFn })

      expect(result).toMatchObject({ ok: true, profileId: "personal" })
      expect(requests[0]).toMatchObject({
        code: "redirect-code",
        redirect_uri: "http://127.0.0.1:3457/callback",
        grant_type: "authorization_code",
      })
      expect(credentialsAt(join(tempDir, "personal")).accessToken).toBe("web-login-access-token")
      expect(pendingLoginCount()).toBe(0)
    })

    it("refuses a state no login is waiting for, without sending anything", async () => {
      startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLoginFromCallback({ state: "not-a-real-state", code: "x", fetchFn })

      expect(result).toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(0)
      // The open login is untouched — a wrong state reaches nothing.
      expect(pendingLoginCount()).toBe(1)
    })

    it("reports a refusal from Claude without exchanging anything", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLoginFromCallback({
        state,
        error: "access_denied",
        errorDescription: "user refused",
        fetchFn,
      })

      expect(result).toMatchObject({ ok: false, code: "login_denied", status: 400 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("access_denied")
      expect(requests).toHaveLength(0)
      expect(pendingLoginCount()).toBe(0)
    })

    it("refuses a callback for a login that never issued a loopback URL", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "meridian.example.com" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLoginFromCallback({ state, code: "abc", fetchFn })

      expect(result).toMatchObject({ ok: false, code: "no_code" })
      expect(requests).toHaveLength(0)
    })

    it.skipIf(skipOnDarwin)("is single-use — the same redirect replayed finds nothing", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      expect(await completeProfileLoginFromCallback({ state, code: "abc", fetchFn })).toMatchObject({ ok: true })
      expect(await completeProfileLoginFromCallback({ state, code: "abc", fetchFn }))
        .toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(1)
    })

    it("refuses a callback for an expired login", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn, requests } = okTokenFetch()
      const result = await completeProfileLoginFromCallback({
        state,
        code: "abc",
        now: Date.now() + LOGIN_TTL_MS + 1,
        fetchFn,
      })
      expect(result).toMatchObject({ ok: false, code: "expired_login", status: 410 })
      expect(requests).toHaveLength(0)
    })

    it.skipIf(skipOnDarwin)("keeps two concurrent logins apart by state", async () => {
      const first = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      const second = startProfileLogin({ profiles, profileId: "work", hostHeader: "127.0.0.1:3457" })
      if (!first.ok || !second.ok) throw new Error("expected both to start")
      const secondState = new URL(second.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ ...TOKEN_RESPONSE, access_token: "work-token" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ))
      expect(await completeProfileLoginFromCallback({ state: secondState, code: "abc", fetchFn }))
        .toMatchObject({ ok: true, profileId: "work" })

      expect(credentialsAt(join(tempDir, "work")).accessToken).toBe("work-token")
      expect(existsSync(join(tempDir, "personal", ".credentials.json"))).toBe(false)
      expect(pendingLoginCount()).toBe(1)
    })
  })

  describe("getProfileLoginStatus", () => {
    it("reports waiting while the user is still signing in", () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      expect(getProfileLoginStatus(started.loginId)).toEqual({ status: "waiting", profileId: "personal" })
    })

    it.skipIf(skipOnDarwin)("reports completed once the redirect finished the login", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn } = okTokenFetch()
      await completeProfileLoginFromCallback({ state, code: "abc", fetchFn })
      expect(getProfileLoginStatus(started.loginId)).toEqual({ status: "completed", profileId: "personal" })
    })

    it("reports the reason a login failed, so the page can show it", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ))
      await completeProfileLoginFromCallback({ state, code: "stale", fetchFn })

      const status = getProfileLoginStatus(started.loginId)
      expect(status).toMatchObject({ status: "failed", profileId: "personal", code: "exchange_failed" })
      expect(status?.error).toContain("400")
      // The token endpoint's body never reaches a surface the user can read.
      expect(status?.error).not.toContain("invalid_grant")
    })

    it("knows nothing about an id it never issued", () => {
      expect(getProfileLoginStatus("never-issued")).toBeNull()
    })

    it.skipIf(skipOnDarwin)("forgets an outcome once its retention window passes", async () => {
      const started = startProfileLogin({ profiles, profileId: "personal", hostHeader: "127.0.0.1:3457" })
      if (!started.ok) throw new Error("expected success")
      const state = new URL(started.authorizeUrl).searchParams.get("state") ?? ""

      const { fetchFn } = okTokenFetch()
      await completeProfileLoginFromCallback({ state, code: "abc", fetchFn })
      expect(getProfileLoginStatus(started.loginId)).toMatchObject({ status: "completed" })
      expect(getProfileLoginStatus(started.loginId, Date.now() + LOGIN_RESULT_TTL_MS + 1)).toBeNull()
    })
  })
})
