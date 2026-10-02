import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  completeProfileAdd,
  pendingAddCount,
  resetPendingAdds,
  startProfileAdd,
} from "../proxy/profileAdd"
import { createProfileSlot, isValidProfileId, loadProfileIds } from "../proxy/profileCli"
import { LOGIN_TTL_MS } from "../proxy/profileLogin"
import type { ProfileConfig } from "../proxy/profiles"

const TOKEN_RESPONSE = {
  access_token: "web-add-access-token",
  refresh_token: "web-add-refresh-token",
  expires_in: 3600,
  scope: "user:inference user:profile",
}

interface TokenRequest {
  code?: string
  state?: string
  code_verifier?: string
  grant_type?: string
}

function stubTokenFetch(makeResponse: () => Response | Promise<Response>) {
  const requests: TokenRequest[] = []
  const fetchFn: typeof fetch = Object.assign(
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (String(_input) === "https://api.anthropic.com/api/oauth/profile") {
        return Response.json({ organization: { organization_type: "claude_max", rate_limit_tier: "default_claude_max_5x" } })
      }
      expect(String(_input)).toBe("https://platform.claude.com/v1/oauth/token")
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

// Credential writes go to the Keychain on darwin, so every assertion that reads
// a .credentials.json file is Linux/Windows only — same reason
// profile-login-unit.test.ts skips there.
const skipOnDarwin = process.platform === "darwin"

describe("profileAdd", () => {
  let configDir: string
  let savedConfigDir: string | undefined
  let profiles: ProfileConfig[]

  function profilesJson(): ProfileConfig[] {
    return JSON.parse(readFileSync(join(configDir, "profiles.json"), "utf-8")) as ProfileConfig[]
  }

  function writeProfilesJson(entries: ProfileConfig[]): void {
    mkdirSync(join(configDir, "profiles"), { recursive: true })
    writeFileSync(join(configDir, "profiles.json"), `${JSON.stringify(entries, null, 2)}\n`)
  }

  /** Start an add and hand back what a completion needs, or fail loudly. */
  function start(id: string): { addId: string; state: string } {
    const result = startProfileAdd({ profiles, profileId: id })
    if (!result.ok) throw new Error(`expected a started add, got ${result.code}`)
    const state = new URL(result.authorizeUrl).searchParams.get("state")
    if (!state) throw new Error("authorize URL carried no state")
    return { addId: result.addId, state }
  }

  beforeEach(() => {
    // Redirected so nothing here can reach the real ~/.config/meridian —
    // profiles.json is the file this feature writes, and a test that writes
    // the developer's own is a test that creates a real account slot.
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    configDir = mkdtempSync(join(tmpdir(), "meridian-web-add-"))
    process.env.MERIDIAN_CONFIG_DIR = configDir
    profiles = [{ id: "personal", claudeConfigDir: join(configDir, "profiles", "personal") }]
    resetPendingAdds()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
  })

  afterEach(() => {
    resetPendingAdds()
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
    if (savedConfigDir !== undefined) process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    else delete process.env.MERIDIAN_CONFIG_DIR
    rmSync(configDir, { recursive: true, force: true })
  })

  describe("isValidProfileId", () => {
    it("accepts the character set a directory name can carry", () => {
      for (const id of ["work", "work-2", "work_2", "Work2", "a"]) {
        expect(isValidProfileId(id)).toBe(true)
      }
    })

    it("rejects an empty id", () => {
      expect(isValidProfileId("")).toBe(false)
    })

    // The reason this function exists: the id becomes a directory name.
    it("rejects path traversal and separators", () => {
      for (const id of ["../../etc", "..", ".", "a/b", "a\\b", "~", "/etc/passwd"]) {
        expect(isValidProfileId(id)).toBe(false)
      }
    })

    it("rejects spaces, dots and shell metacharacters", () => {
      for (const id of ["my profile", "work.2", "a;b", "a$b", "a\u0000b"]) {
        expect(isValidProfileId(id)).toBe(false)
      }
    })
  })

  describe("createProfileSlot", () => {
    it("writes the profiles.json entry and the config directory together", () => {
      const created = createProfileSlot("work")
      if (!created.ok) throw new Error(`expected success, got ${created.reason}`)

      expect(created.profile.id).toBe("work")
      expect(created.profile.claudeConfigDir).toBe(join(configDir, "profiles", "work"))
      expect(existsSync(join(configDir, "profiles", "work"))).toBe(true)
      expect(profilesJson()).toEqual([{ id: "work", claudeConfigDir: join(configDir, "profiles", "work") }])
    })

    it("appends rather than replacing what is already there", () => {
      createProfileSlot("work")
      createProfileSlot("personal")
      expect(loadProfileIds()).toEqual(["work", "personal"])
    })

    it("refuses an invalid id without creating anything", () => {
      const created = createProfileSlot("../escape")
      expect(created).toMatchObject({ ok: false, reason: "invalid_id" })
      expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
    })

    it("refuses a collision", () => {
      writeProfilesJson([{ id: "work", claudeConfigDir: "/somewhere/else" }])
      const created = createProfileSlot("work")
      expect(created).toMatchObject({ ok: false, reason: "already_exists" })
      // The existing entry is untouched — a refusal must not rewrite it.
      expect(profilesJson()).toEqual([{ id: "work", claudeConfigDir: "/somewhere/else" }])
    })

    it("adopts an explicit config dir — the CLI's ~/.claude import", () => {
      const existing = join(configDir, "dot-claude")
      mkdirSync(existing, { recursive: true })
      const created = createProfileSlot("imported", { claudeConfigDir: existing })
      if (!created.ok) throw new Error(`expected success, got ${created.reason}`)
      expect(created.profile.claudeConfigDir).toBe(existing)
      expect(existsSync(join(configDir, "profiles", "imported"))).toBe(false)
    })
  })

  describe("startProfileAdd", () => {
    it("returns an authorize URL and an opaque id, and never the PKCE verifier", () => {
      const result = startProfileAdd({ profiles, profileId: "work" })
      if (!result.ok) throw new Error(`expected success, got ${result.code}`)

      expect(result.profileId).toBe("work")
      expect(result.addId.length).toBeGreaterThan(16)
      expect(result.expiresAt).toBeGreaterThan(Date.now())

      const url = new URL(result.authorizeUrl)
      expect(url.origin + url.pathname).toBe("https://claude.com/cai/oauth/authorize")
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(url.searchParams.get("code_challenge")).toBeTruthy()
      expect(url.searchParams.get("redirect_uri")).toBe("https://platform.claude.com/oauth/code/callback")

      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain("codeVerifier")
      expect(serialized).not.toContain("code_verifier")
    })

    // The slot appearing only after a successful exchange is the whole answer
    // to "what happens if OAuth fails" — so nothing may exist yet at this point.
    it("writes nothing to disk", () => {
      startProfileAdd({ profiles, profileId: "work" })
      expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
      expect(existsSync(join(configDir, "profiles", "work"))).toBe(false)
      expect(pendingAddCount()).toBe(1)
    })

    it("refuses an empty name", () => {
      expect(startProfileAdd({ profiles, profileId: "   " }))
        .toMatchObject({ ok: false, code: "invalid_request", status: 400 })
      expect(pendingAddCount()).toBe(0)
    })

    it("refuses an id that would escape the profiles directory", () => {
      const result = startProfileAdd({ profiles, profileId: "../../etc" })
      expect(result).toMatchObject({ ok: false, code: "invalid_profile_id", status: 400 })
      expect(pendingAddCount()).toBe(0)
    })

    it("refuses a name the running instance already serves, and points at the login button", () => {
      const result = startProfileAdd({ profiles, profileId: "personal" })
      expect(result).toMatchObject({ ok: false, code: "profile_exists", status: 409 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("Log in from browser")
      expect(pendingAddCount()).toBe(0)
    })

    // Disk discovery is off in tests, so an instance configured from
    // MERIDIAN_PROFILES would not see this one in its effective list — the
    // profiles.json read is what stops the write landing on top of it.
    it("refuses a name already written to profiles.json but not served", () => {
      writeProfilesJson([{ id: "onlyondisk", claudeConfigDir: join(configDir, "profiles", "onlyondisk") }])
      expect(startProfileAdd({ profiles, profileId: "onlyondisk" }))
        .toMatchObject({ ok: false, code: "profile_exists", status: 409 })
    })

    it("refuses on an instance that must not write credential files, before minting anything", () => {
      process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
      const result = startProfileAdd({ profiles, profileId: "work" })
      expect(result).toMatchObject({ ok: false, code: "credentials_readonly", status: 409 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("MERIDIAN_CREDENTIALS_READONLY")
      expect(result.message).toContain("meridian profile add work")
      expect(pendingAddCount()).toBe(0)
    })

    // Found in browser QA: cancelling the panel, reloading the page and closing
    // the tab all abandon a sign-in without telling the server, so refusing a
    // second start locked the name out for the whole TTL with nothing the user
    // could do to release it.
    it("supersedes an abandoned sign-in for the same name rather than locking the name out", async () => {
      const first = startProfileAdd({ profiles, profileId: "work" })
      if (!first.ok) throw new Error("expected success")

      const second = startProfileAdd({ profiles, profileId: "work" })
      if (!second.ok) throw new Error(`expected the retry to be allowed, got ${second.code}`)
      expect(second.addId).not.toBe(first.addId)
      // Still one entry per name — that is what stops two sign-ins for one new
      // name from both completing.
      expect(pendingAddCount()).toBe(1)

      // The superseded one is dead, and says so without contacting Anthropic.
      const stale = await completeProfileAdd({ addId: first.addId, input: "abc123" })
      expect(stale).toMatchObject({ ok: false, code: "expired_add" })
    })

    it("allows concurrent sign-ins for different names", () => {
      start("work")
      start("side")
      expect(pendingAddCount()).toBe(2)
    })

    it("frees the name again once the pending add has expired", () => {
      const first = startProfileAdd({ profiles, profileId: "work" })
      if (!first.ok) throw new Error("expected success")
      const later = startProfileAdd({ profiles, profileId: "work", now: Date.now() + LOGIN_TTL_MS + 1 })
      expect(later.ok).toBe(true)
    })
  })

  describe("completeProfileAdd", () => {
    it.skipIf(skipOnDarwin)("preserves the winning credentials when an older exchange finishes last", async () => {
      const first = start("work")
      const tokenResponse = Promise.withResolvers<Response>()
      const { fetchFn } = stubTokenFetch(() => tokenResponse.promise)
      const firstCompletion = completeProfileAdd({ addId: first.addId, input: "first-code", fetchFn })
      const second = start("work")
      const winner = await completeProfileAdd({ addId: second.addId, input: "second-code", fetchFn: okTokenFetch().fetchFn })
      if (!winner.ok) throw new Error(`expected winner, got ${winner.code}`)
      const winnerFile = join(winner.claudeConfigDir, ".credentials.json")
      const winnerCredentials = readFileSync(winnerFile, "utf-8")

      tokenResponse.resolve(Response.json({ ...TOKEN_RESPONSE, access_token: "losing-access-token" }))
      expect(await firstCompletion).toMatchObject({ ok: false, code: "profile_exists", status: 409 })
      expect(readFileSync(winnerFile, "utf-8")).toBe(winnerCredentials)
      expect(profilesJson()).toEqual([{ id: "work", claudeConfigDir: winner.claudeConfigDir }])
      expect(readdirSync(join(configDir, "profiles"))).toHaveLength(1)
    })

    it.skipIf(skipOnDarwin)("preserves CLI credentials when the CLI creates the name during exchange", async () => {
      const { addId } = start("work")
      const tokenResponse = Promise.withResolvers<Response>()
      const { fetchFn } = stubTokenFetch(() => tokenResponse.promise)
      const completion = completeProfileAdd({ addId, input: "browser-code", fetchFn })
      const cli = createProfileSlot("work")
      if (!cli.ok || !cli.profile.claudeConfigDir) throw new Error("expected CLI slot")
      const credentialFile = join(cli.profile.claudeConfigDir, ".credentials.json")
      const cliCredentials = JSON.stringify({ claudeAiOauth: { accessToken: "cli-winner-token" } })
      writeFileSync(credentialFile, cliCredentials)

      tokenResponse.resolve(Response.json(TOKEN_RESPONSE))
      expect(await completion).toMatchObject({ ok: false, code: "profile_exists", status: 409 })
      expect(readFileSync(credentialFile, "utf-8")).toBe(cliCredentials)
      expect(profilesJson()).toEqual([cli.profile])
      expect(readdirSync(join(configDir, "profiles"))).toEqual(["work"])
    })

    it("410s an id that was never issued", async () => {
      const result = await completeProfileAdd({ addId: "made-up", input: "abc123" })
      expect(result).toMatchObject({ ok: false, code: "expired_add", status: 410 })
    })

    it("410s an expired sign-in", async () => {
      const { addId } = start("work")
      const result = await completeProfileAdd({ addId, input: "abc123", now: Date.now() + LOGIN_TTL_MS + 1 })
      expect(result).toMatchObject({ ok: false, code: "expired_add", status: 410 })
    })

    it("keeps the sign-in open when the paste holds no code", async () => {
      const { addId } = start("work")
      const { fetchFn, requests } = okTokenFetch()

      const result = await completeProfileAdd({ addId, input: "   ", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "no_code", status: 400, retryable: true })
      expect(requests).toHaveLength(0)
      expect(pendingAddCount()).toBe(1)
    })

    it("keeps the sign-in open on a state mismatch, and never contacts Anthropic", async () => {
      const { addId } = start("work")
      const { fetchFn, requests } = okTokenFetch()

      const result = await completeProfileAdd({
        addId,
        input: "https://platform.claude.com/oauth/code/callback?code=abc123&state=another-tabs-state",
        fetchFn,
      })
      expect(result).toMatchObject({ ok: false, code: "state_mismatch", status: 400, retryable: true })
      expect(requests).toHaveLength(0)
      expect(pendingAddCount()).toBe(1)
      expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
    })

    it.skipIf(skipOnDarwin)("creates the profile from a bare code", async () => {
      const { addId } = start("work")
      const { fetchFn, requests } = okTokenFetch()

      const result = await completeProfileAdd({ addId, input: "abc123", fetchFn })
      if (!result.ok) throw new Error(`expected success, got ${result.code}`)

      expect(result.profileId).toBe("work")
      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({ grant_type: "authorization_code", code: "abc123" })

      expect(profilesJson()).toEqual([{ id: "work", claudeConfigDir: result.claudeConfigDir }])
      expect(result.claudeConfigDir).not.toBe(join(configDir, "profiles", "work"))
      if (process.platform === "linux") expect(statSync(result.claudeConfigDir).mode & 0o777).toBe(0o700)
      const stored = JSON.parse(readFileSync(join(result.claudeConfigDir, ".credentials.json"), "utf-8"))
      expect(stored.claudeAiOauth.accessToken).toBe("web-add-access-token")
      expect(stored.claudeAiOauth.refreshToken).toBe("web-add-refresh-token")
      expect(stored.claudeAiOauth.subscriptionType).toBe("max")
      expect(stored.claudeAiOauth.rateLimitTier).toBe("default_claude_max_5x")
      expect(pendingAddCount()).toBe(0)
    })

    it.skipIf(skipOnDarwin)("creates the profile from the whole pasted callback URL", async () => {
      const { addId, state } = start("work")
      const { fetchFn, requests } = okTokenFetch()

      const result = await completeProfileAdd({
        addId,
        input: `https://platform.claude.com/oauth/code/callback?code=url-code&state=${state}`,
        fetchFn,
      })
      expect(result.ok).toBe(true)
      expect(requests[0]).toMatchObject({ code: "url-code", state })
      expect(loadProfileIds()).toEqual(["work"])
    })

    it.skipIf(skipOnDarwin)("is single use", async () => {
      const { addId } = start("work")
      const { fetchFn, requests } = okTokenFetch()

      expect((await completeProfileAdd({ addId, input: "abc123", fetchFn })).ok).toBe(true)
      expect(await completeProfileAdd({ addId, input: "abc123", fetchFn }))
        .toMatchObject({ ok: false, code: "expired_add", status: 410 })
      expect(requests).toHaveLength(1)
    })

    // The judgement call this flow had to make: a failed exchange leaves no
    // profile at all, rather than a slot that shows as permanently logged out.
    it("leaves no profile behind when Anthropic rejects the code", async () => {
      const { addId } = start("work")
      const { fetchFn } = stubTokenFetch(() => new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "code already redeemed" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ))

      const result = await completeProfileAdd({ addId, input: "stale-code", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed", status: 502 })
      if (result.ok) throw new Error("expected refusal")

      // Neither half of a profile exists, and the upstream body is not echoed.
      expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
      expect(result.message).not.toContain("invalid_grant")
      expect(result.message).not.toContain("already redeemed")
      expect(result.retryable).toBeUndefined()
    })

    it("frees the name for another attempt after a failed exchange", async () => {
      const { addId } = start("work")
      const { fetchFn } = stubTokenFetch(() => new Response("nope", { status: 500 }))

      await completeProfileAdd({ addId, input: "stale-code", fetchFn })
      expect(pendingAddCount()).toBe(0)
      expect(startProfileAdd({ profiles, profileId: "work" }).ok).toBe(true)
    })

    it("reports the network reaching Anthropic failing without claiming a profile exists", async () => {
      const { addId } = start("work")
      const fetchFn: typeof fetch = Object.assign(
        async () => { throw new Error("ECONNREFUSED") },
        { preconnect: globalThis.fetch.preconnect },
      )

      const result = await completeProfileAdd({ addId, input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "exchange_failed", status: 502 })
      expect(existsSync(join(configDir, "profiles.json"))).toBe(false)
    })

    // Nothing holds the name on disk during sign-in, so the CLI can take it.
    it.skipIf(skipOnDarwin)("refuses when the name was taken during the sign-in", async () => {
      const { addId } = start("work")
      const { fetchFn } = okTokenFetch()
      writeProfilesJson([{ id: "work", claudeConfigDir: "/somebody/elses/dir" }])

      const result = await completeProfileAdd({ addId, input: "abc123", fetchFn })
      expect(result).toMatchObject({ ok: false, code: "profile_exists", status: 409 })
      if (result.ok) throw new Error("expected refusal")
      expect(result.message).toContain("created elsewhere")
      expect(profilesJson()).toEqual([{ id: "work", claudeConfigDir: "/somebody/elses/dir" }])
    })
  })
})
