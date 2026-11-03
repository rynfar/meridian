/** HTTP regression controls; isolated because native-store/auth spies are process-global. */
import { afterAll, beforeEach, describe, expect, test, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProfileConfig } from "../proxy/profiles"
import type { CredentialsFile } from "../proxy/tokenRefresh"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"

const root = mkdtempSync(join(tmpdir(), "meridian-profile-metadata-test-"))
const originalEnv = { ...process.env }
for (const key of Object.keys(process.env)) {
  if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_)/.test(key)) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: root, MERIDIAN_SESSION_DIR: join(root, "sessions"),
  MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_TELEMETRY_PERSIST: "0" })
installSdkMock(() => ({ query: () => { throw new Error("Metadata must not call a model") },
  createSdkMcpServer: () => ({}), tool: () => ({}) }), "profile-credential-isolation.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn() }))
const models = await import("../proxy/models")
const tokens = await import("../proxy/tokenRefresh")
const organizations = await import("../proxy/organizationName")
let loggedIn = true
let credentials: CredentialsFile | null
let reads = 0
let storeDirs: Array<string | undefined> = []
let throws = false
const authSpy = spyOn(models, "getClaudeAuthStatusAsync").mockImplementation(async () => ({ loggedIn }))
const storeSpy = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(opts => {
  storeDirs.push(opts?.claudeConfigDir)
  return { read: async () => { reads++; if (throws) throw new Error("Owned store unavailable"); return credentials },
    write: async () => { throw new Error("Metadata must not write credentials") } }
})
const organizationSpy = spyOn(organizations, "refreshOrganizationNameSoon").mockImplementation(() => {})
const { createProxyServer } = await import("../proxy/server")
const { resetActiveProfile } = await import("../proxy/profiles")
beforeEach(() => {
  resetActiveProfile(); tokens.resetAuthRenewalCache(); reads = 0; storeDirs = []; throws = false; loggedIn = true
  credentials = { claudeAiOauth: { accessToken: "owned-fixture", refreshToken: "owned-refresh",
    expiresAt: Date.now() + 3_600_000, refreshTokenExpiresAt: Date.now() + 86_400_000,
    subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }
})
afterAll(() => {
  authSpy.mockRestore(); storeSpy.mockRestore(); organizationSpy.mockRestore()
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv); rmSync(root, { recursive: true, force: true })
})
interface Facts { loggedIn: boolean; rateLimitTier: string | null; allowance: string | null;
  planLabel: string | null; renewalRequiredSoon?: boolean }
async function facts(profile: ProfileConfig) {
  const { app } = createProxyServer({ profiles: [profile], defaultProfile: profile.id, silent: true })
  const health = await app.fetch(new Request("http://localhost/health"))
  const healthBody = await health.json() as { status: string; auth: Facts }
  const listed = await app.fetch(new Request("http://localhost/profiles/list"))
  const listBody = await listed.json() as { profiles: Facts[] }
  expect(health.status).toBe(loggedIn ? 200 : 503)
  expect(listed.status).toBe(200)
  return { health: healthBody.auth, profile: listBody.profiles[0]! }
}
describe("profile native-credential metadata isolation", () => {
  test("API keys do not inherit a host subscription or renewal warning", async () => {
    const result = await facts({ id: "api", type: "api", apiKey: "owned-key" })
    for (const item of [result.health, result.profile]) {
      expect(item.loggedIn).toBe(true); expect(item.rateLimitTier).toBeNull()
      expect(item.allowance).toBeNull(); expect(item.planLabel).toBeNull()
    }
    expect(result.health.renewalRequiredSoon).toBe(false)
    expect(reads).toBe(0); expect(storeDirs).toEqual([])
  })
  test("an unrelated empty OAuth grant does not demote an API key", async () => {
    credentials = { claudeAiOauth: { accessToken: "", refreshToken: "owned-refresh", expiresAt: 0 } }
    expect((await facts({ id: "api-empty", type: "api", apiKey: "owned-key" })).profile.loggedIn).toBe(true)
    expect(reads).toBe(0)
  })
  test("a supplied setup token is not demoted by an empty stored grant", async () => {
    credentials = { claudeAiOauth: { accessToken: "", refreshToken: "owned-refresh", expiresAt: 0 } }
    const result = await facts({ id: "setup-token", oauthToken: "owned-token" })
    expect(result.profile.loggedIn).toBe(true); expect(result.health.renewalRequiredSoon).toBe(false)
    expect(reads).toBe(0); expect(storeDirs).toEqual([])
  })
  test("stored Max plan and renewal still come from the resolved directory", async () => {
    const dir = join(root, "subscription")
    const result = await facts({ id: "max", claudeConfigDir: dir })
    expect(result.health.allowance).toBe("20x"); expect(result.profile.allowance).toBe("20x")
    expect(result.health.renewalRequiredSoon).toBe(true); expect(result.profile.loggedIn).toBe(true)
    expect(storeDirs).toEqual([dir, dir]); expect(reads).toBeGreaterThan(0)
  })
  test("a successfully read empty stored Claude grant still demotes the profile", async () => {
    credentials = { claudeAiOauth: { accessToken: "", refreshToken: "owned-refresh", expiresAt: 0 } }
    expect((await facts({ id: "empty-max", claudeConfigDir: join(root, "empty") })).profile.loggedIn).toBe(false)
  })
  test("unavailable stored credentials remain unknown rather than logged out", async () => {
    throws = true
    const result = await facts({ id: "unavailable-max", claudeConfigDir: join(root, "unavailable") })
    expect(result.profile.loggedIn).toBe(true); expect(result.health.renewalRequiredSoon).toBe(false)
    expect(result.profile.allowance).toBeNull()
  })
  test("default-directory Claude subscriptions retain their own metadata", async () => {
    const result = await facts({ id: "default-max" })
    expect(result.profile.allowance).toBe("20x"); expect(result.health.allowance).toBe("20x")
    expect(storeDirs).toEqual([undefined, undefined])
  })
  test("auth-status failure is not made healthy by ignoring an unrelated store", async () => {
    loggedIn = false
    const result = await facts({ id: "logged-out-api", type: "api", apiKey: "owned-key" })
    expect(result.health.loggedIn).toBe(false); expect(result.profile.loggedIn).toBe(false)
    expect(reads).toBe(0)
  })
})
describe("duplicate detection trusts only account records read for the stored credential", () => {
  interface Listed { id: string; email: string | null; duplicateOf: string[]; duplicateBasis: string | null }
  const account = { name: "Acme", accountUuid: "acct-1", organizationUuid: "org-1", email: "one@example.com" }
  async function listTwins(): Promise<Record<string, Listed>> {
    const { app } = createProxyServer({ silent: true, defaultProfile: "a",
      profiles: [{ id: "a", claudeConfigDir: join(root, "twin-a") }, { id: "b", claudeConfigDir: join(root, "twin-b") }] })
    const body = await (await app.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Listed[] }
    return Object.fromEntries(body.profiles.map(p => [p.id, p]))
  }
  test("two profiles whose current credentials read the same account are flagged", async () => {
    const mark = credentials!.claudeAiOauth!.expiresAt!
    organizations.rememberOrganization("a", account, mark)
    organizations.rememberOrganization("b", account, mark)
    const listed = await listTwins()
    expect(listed.a!.duplicateOf).toEqual(["b"]); expect(listed.b!.duplicateOf).toEqual(["a"])
    expect(listed.a!.duplicateBasis).toBe("account-organization")
    expect(listed.b!.email).toBe("one@example.com")
  })
  test("a record read for an earlier credential flags nothing and names no account", async () => {
    // b was signed in to another account with `claude login`, with no page
    // open: its stored token changed, its saved record still names acct-1.
    const mark = credentials!.claudeAiOauth!.expiresAt!
    organizations.rememberOrganization("a", account, mark)
    organizations.rememberOrganization("b", account, mark - 60_000)
    const listed = await listTwins()
    expect(listed.a!.duplicateOf).toEqual([]); expect(listed.b!.duplicateOf).toEqual([])
    expect(listed.b!.duplicateBasis).toBeNull()
    expect(listed.b!.email).toBeNull()
  })
})
