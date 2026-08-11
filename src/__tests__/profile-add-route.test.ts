import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetPendingAdds } from "../proxy/profileAdd"
import type { ProfileConfig } from "../proxy/profiles"
import { createProxyServer } from "../proxy/server"
import { stopBackgroundRefresh } from "../proxy/tokenRefresh"

const TOKEN_RESPONSE = {
  access_token: "add-route-access-token",
  refresh_token: "add-route-refresh-token",
  expires_in: 3600,
}

// Credential writes are Keychain-backed on darwin; the paths that actually
// persist are Linux/Windows only, as in profile-login-route.test.ts.
const skipOnDarwin = process.platform === "darwin"

describe("profile add routes", () => {
  let originalFetch: typeof globalThis.fetch
  let configDir: string
  let savedConfigDir: string | undefined
  let app: ReturnType<typeof createProxyServer>["app"]

  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return app.fetch(new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }))
  }

  async function startAdd(profile: string): Promise<{ addId: string; state: string }> {
    const res = await post("/profiles/add/start", { profile })
    if (res.status !== 200) throw new Error(`start failed with ${res.status}`)
    const body = await res.json() as { addId: string; authorizeUrl: string }
    const state = new URL(body.authorizeUrl).searchParams.get("state")
    if (!state) throw new Error("authorize URL carried no state")
    return { addId: body.addId, state }
  }

  function profilesJson(): ProfileConfig[] {
    return JSON.parse(readFileSync(join(configDir, "profiles.json"), "utf-8")) as ProfileConfig[]
  }

  beforeEach(() => {
    originalFetch = globalThis.fetch
    // Redirected so a route test can never write the real profiles.json.
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    configDir = mkdtempSync(join(tmpdir(), "meridian-add-route-"))
    process.env.MERIDIAN_CONFIG_DIR = configDir
    mkdirSync(join(configDir, "profiles", "personal"), { recursive: true })
    resetPendingAdds()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_API_KEY

    app = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [{ id: "personal", claudeConfigDir: join(configDir, "profiles", "personal") }],
      defaultProfile: "personal",
      silent: true,
    }).app
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    stopBackgroundRefresh()
    resetPendingAdds()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.MERIDIAN_API_KEY
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
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

  function stubOkToken() {
    return stubTokenEndpoint(() => new Response(JSON.stringify(TOKEN_RESPONSE), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))
  }

  it("starts a creation and returns an authorize URL without the PKCE verifier", async () => {
    const res = await post("/profiles/add/start", { profile: "work" })
    expect(res.status).toBe(200)

    const raw = await res.text()
    expect(raw).not.toContain("codeVerifier")
    expect(raw).not.toContain("code_verifier")

    const body = JSON.parse(raw) as { addId: string; authorizeUrl: string; expiresAt: number; profile: string }
    expect(body.profile).toBe("work")
    expect(body.addId).toBeTruthy()
    expect(body.expiresAt).toBeGreaterThan(Date.now())
    expect(new URL(body.authorizeUrl).searchParams.get("code_challenge")).toBeTruthy()

    // Starting is not creating: nothing exists until a code comes back.
    expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
  })

  it("refuses to start on an instance that must not write credentials", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const res = await post("/profiles/add/start", { profile: "work" })
    expect(res.status).toBe(409)

    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe("credentials_readonly")
    expect(body.error).toContain("MERIDIAN_CREDENTIALS_READONLY")
    expect(body.error).toContain("meridian profile add work")
  })

  it("400s a name that would escape the profiles directory", async () => {
    const res = await post("/profiles/add/start", { profile: "../../etc" })
    expect(res.status).toBe(400)
    expect((await res.json() as { code: string }).code).toBe("invalid_profile_id")
  })

  it("409s an existing name and sends the user to the login button instead", async () => {
    const res = await post("/profiles/add/start", { profile: "personal" })
    expect(res.status).toBe(409)

    const body = await res.json() as { error: string; code: string }
    expect(body.code).toBe("profile_exists")
    expect(body.error).toContain("Log in from browser")
  })

  it("400s a missing name, malformed JSON, and a completion with no add id", async () => {
    expect((await post("/profiles/add/start", {})).status).toBe(400)

    const malformed = await app.fetch(new Request("http://localhost/profiles/add/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }))
    expect(malformed.status).toBe(400)

    const noId = await post("/profiles/add/complete", { code: "abc123" })
    expect(noId.status).toBe(400)
    expect((await noId.json() as { code: string }).code).toBe("invalid_request")
  })

  it("410s an add id that was never issued", async () => {
    const res = await post("/profiles/add/complete", { addId: "made-up", code: "abc123" })
    expect(res.status).toBe(410)
    expect((await res.json() as { code: string }).code).toBe("expired_add")
  })

  it.skipIf(skipOnDarwin)("creates the profile from a bare code", async () => {
    const { addId } = await startAdd("work")
    const requests = stubOkToken()

    const res = await post("/profiles/add/complete", { addId, code: "abc123" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, profile: "work" })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ grant_type: "authorization_code", code: "abc123" })
    expect(profilesJson()).toEqual([{ id: "work", claudeConfigDir: join(configDir, "profiles", "work") }])
    expect(JSON.parse(readFileSync(join(configDir, "profiles", "work", ".credentials.json"), "utf-8")).claudeAiOauth.accessToken)
      .toBe("add-route-access-token")
  })

  it.skipIf(skipOnDarwin)("creates the profile from the pasted callback URL", async () => {
    const { addId, state } = await startAdd("work")
    stubOkToken()

    const res = await post("/profiles/add/complete", {
      addId,
      code: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
    })
    expect(res.status).toBe(200)
    expect(profilesJson().map(p => p.id)).toEqual(["work"])
  })

  it.skipIf(skipOnDarwin)("410s a replayed completion", async () => {
    const { addId } = await startAdd("work")
    const requests = stubOkToken()

    expect((await post("/profiles/add/complete", { addId, code: "abc123" })).status).toBe(200)
    expect((await post("/profiles/add/complete", { addId, code: "abc123" })).status).toBe(410)
    expect(requests).toHaveLength(1)
    expect(profilesJson()).toHaveLength(1)
  })

  it("400s a state that does not match, and never contacts the token endpoint", async () => {
    const { addId } = await startAdd("work")
    const requests = stubTokenEndpoint(() => new Response("{}", { status: 200 }))

    const res = await post("/profiles/add/complete", {
      addId,
      code: "https://platform.claude.com/oauth/code/callback?code=abc123&state=someone-elses-state",
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "state_mismatch", retryable: true })
    expect(requests).toHaveLength(0)
    expect(existsSync(join(configDir, "profiles.json"))).toBe(false)

    // Nothing reached Anthropic, so the sign-in is still open for the right paste.
    const retry = await post("/profiles/add/complete", { addId, code: "abc123" })
    expect(retry.status).not.toBe(410)
  })

  it("502s an upstream rejection, leaves no profile, and does not leak the error body", async () => {
    const { addId } = await startAdd("work")
    stubTokenEndpoint(() => new Response(
      JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    ))

    const res = await post("/profiles/add/complete", { addId, code: "stale-code" })
    expect(res.status).toBe(502)
    const raw = await res.text()
    expect(raw).toContain("exchange_failed")
    expect(raw).not.toContain("retryable")
    expect(raw).not.toContain("invalid_grant")
    expect(raw).not.toContain("already redeemed")
    expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
  })

  // Both routes sit under the /profiles/* prefix, so they inherit requireAuth
  // rather than needing their own registration — asserted rather than assumed.
  it("requires the API key on both routes when one is configured", async () => {
    process.env.MERIDIAN_API_KEY = "secret-key"

    expect((await post("/profiles/add/start", { profile: "work" })).status).toBe(401)
    expect((await post("/profiles/add/complete", { addId: "x", code: "y" })).status).toBe(401)

    const authorized = await post("/profiles/add/start", { profile: "work" }, { "x-api-key": "secret-key" })
    expect(authorized.status).toBe(200)
  })

  it("serves an Add profile affordance on the profiles page", async () => {
    const res = await app.fetch(new Request("http://localhost/profiles"))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain("Add a profile")
    expect(html).toContain("/profiles/add/start")
    expect(html).toContain("/profiles/add/complete")
  })
})
