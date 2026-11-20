/** Credentialless token-exchange deadline gate; emulates the file backend, not native login. */
import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, mock } from "bun:test"
import type { CredentialsFile } from "../proxy/tokenRefresh"

const selfPath = fileURLToPath(import.meta.url)

if (process.argv[2] !== "worker") {
  it("the shared synthetic token exchange persists deadlines and retains write/isolation boundaries", async () => {
    const child = Bun.spawn([process.execPath, selfPath, "worker"], {
      env: { ...process.env }, stdout: "pipe", stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill(), 20_000)
    try {
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ])
      expect(stderr).toBe("")
      expect(exit).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({
        result: "PASS",
        controls: 11,
        nativeCalls: 0,
        sdkCalls: 0,
        backend: "emulated-file",
        actualProvider: false,
      })
    } finally {
      clearTimeout(timer)
    }
  }, 25_000)
} else {
  const root = mkdtempSync(join(os.tmpdir(), "meridian-login-deadline-"))
  for (const key of Object.keys(process.env)) {
    if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
  }
  Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_NO_UPDATE_CHECK: "1" })
  mock.module("node:os", () => ({ ...os, platform: () => "linux" }))
  let nativeCalls = 0
  const refuseNative = () => { nativeCalls++; throw new Error("Unexpected native command in synthetic exchange gate") }
  mock.module("node:child_process", () => ({
    ...childProcess,
    exec: refuseNative,
    execSync: refuseNative,
    execFile: refuseNative,
    execFileSync: refuseNative,
    spawn: refuseNative,
    spawnSync: refuseNative,
    fork: refuseNative,
  }))
  const { setLoggerMock } = await import("./loggerMock")
  setLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
  let sdkCalls = 0
  // This isolated exchange worker tests a real, owned file-store write. It
  // never runs HTTP/SDK setup, so keep only an identity-checked SDK refusal.
  const refuseSdkQuery = () => { sdkCalls++; throw new Error("Unexpected SDK query") }
  mock.module("@anthropic-ai/claude-agent-sdk", () => ({
    query: refuseSdkQuery,
    createSdkMcpServer: () => ({}),
    tool: () => ({}),
  }))
  const sdk = await import("@anthropic-ai/claude-agent-sdk")
  assert.equal(sdk.query, refuseSdkQuery)
  const { exchangeAuthorizationCodeForCredentials } = await import("../proxy/profileCli")
  const originalFetch = globalThis.fetch
  globalThis.fetch = Object.assign(
    (): Promise<Response> => { throw new Error("Unexpected network request outside injected exchange") },
    { preconnect: originalFetch.preconnect },
  )
  const originalWarn = console.warn
  const originalError = console.error
  const diagnostics: string[] = []
  console.warn = (...values: unknown[]) => diagnostics.push(values.map(String).join(" "))
  console.error = (...values: unknown[]) => diagnostics.push(values.map(String).join(" "))
  const dir = join(root, "profile")
  mkdirSync(dir)
  const file = join(dir, ".credentials.json")
  const base = {
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    expires_in: 3600,
    scope: "user:profile user:inference",
  }
  let tokenRequests = 0
  const exchange = (metadata: Record<string, unknown>, claudeConfigDir = dir) => {
    const fetchFn: typeof fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input) === "https://platform.claude.com/v1/oauth/token") {
        tokenRequests++
        return Response.json({ ...base, ...metadata })
      }
      assert.equal(String(input), "https://api.anthropic.com/api/oauth/profile", "Unexpected upstream URL")
      return Response.json({ organization: { organization_type: "claude_team", seat_tier: "team_tier_1" } })
    }, { preconnect: originalFetch.preconnect })
    return exchangeAuthorizationCodeForCredentials({
      code: "synthetic-code",
      returnedState: "synthetic-state",
      sessionState: "synthetic-state",
      codeVerifier: "synthetic-verifier",
      claudeConfigDir,
      fetchFn,
    })
  }
  const stored = (): NonNullable<CredentialsFile["claudeAiOauth"]> => {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as CredentialsFile
    assert(parsed.claudeAiOauth, "Expected claudeAiOauth in stored credentials")
    return parsed.claudeAiOauth
  }
  let assertions = 0
  try {
    const before = Date.now()
    assert.deepEqual(await exchange({ refresh_token_expires_in: 29 * 86400 }), { ok: true })
    const relative = stored()
    assert(
      typeof relative.refreshTokenExpiresAt === "number"
        && relative.refreshTokenExpiresAt >= before + 29 * 86400 * 1000
        && relative.refreshTokenExpiresAt <= Date.now() + 29 * 86400 * 1000,
      "Token exchange dropped the provider refresh deadline",
    )
    assert.equal(relative.accessToken, base.access_token)
    assert.equal(relative.refreshToken, base.refresh_token)
    assert.deepEqual(relative.scopes, ["user:profile", "user:inference"])
    assert.equal(relative.subscriptionType, "team")
    assert.equal(relative.seatTier, "team_tier_1")
    assert(!readFileSync(file, "utf8").includes("\n"), "Credential format stopped being compact")
    assertions += 8

    const absolute = Date.now() + 28 * 86400 * 1000
    assert.deepEqual(await exchange({ refresh_token_expires_at: absolute, refresh_token_expires_in: 29 * 86400 }), { ok: true })
    assert.equal(stored().refreshTokenExpiresAt, absolute, "Absolute refresh deadline lost precedence")
    assertions += 2

    // Reusing the same profile/store with absent or malformed new metadata must
    // replace the old credential without reviving its old login deadline.
    for (const metadata of [
      {},
      { refresh_token_expires_in: "3600" },
      { refresh_token_expires_in: 0 },
      { refresh_token_expires_in: -1 },
      { refresh_token_expires_in: 1e100 },
      { refresh_token_expires_at: Date.now() / 1000, refresh_token_expires_in: 3600 },
      { refresh_token_expires_at: 1e100 },
    ]) {
      assert.deepEqual(await exchange({ refresh_token_expires_at: absolute }), { ok: true })
      assert.equal(stored().refreshTokenExpiresAt, absolute, "Replacement control did not start from a known prior deadline")
      assert.deepEqual(await exchange(metadata), { ok: true })
      assert(!("refreshTokenExpiresAt" in stored()), "Invalid/absent metadata retained a previous login deadline")
      assertions += 4
    }

    const unchanged = readFileSync(file, "utf8")
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    assert.deepEqual(await exchange({ refresh_token_expires_in: 86400 }), { ok: false, reason: "write_failed" })
    assert.equal(readFileSync(file, "utf8"), unchanged, "Read-only exchange wrote credentials")
    assert(diagnostics.some(text => text.includes("REFUSED credential write")), "Read-only refusal lost its existing diagnostic")
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    const blocked = join(root, "blocked")
    writeFileSync(blocked, "foreign sentinel")
    assert.deepEqual(
      await exchange({ refresh_token_expires_in: 86400 }, join(blocked, "profile")),
      { ok: false, reason: "write_failed" },
    )
    assert.equal(readFileSync(blocked, "utf8"), "foreign sentinel")
    assert(
      !diagnostics.some(text => /synthetic-access|synthetic-refresh|synthetic-code|synthetic-verifier/.test(text)),
      "Credential values reached diagnostics",
    )
    // A completed login is recorded in the login history (#1543), which must
    // never hold a credential value.
    const history = readFileSync(join(root, "config", "auth-lifecycle.json"), "utf8")
    assert(/"authObtainedVia": "login"/.test(history), "The completed login was not recorded")
    assert(!/synthetic-access|synthetic-refresh|synthetic-code|synthetic-verifier/.test(history), "Credential values reached the login history")
    assert.equal(nativeCalls, 0)
    assert.equal(sdkCalls, 0)
    assertions += 9
    console.log(JSON.stringify({
      result: "PASS",
      controls: 11,
      assertions,
      tokenRequests,
      nativeCalls,
      sdkCalls,
      backend: "emulated-file",
      actualProvider: false,
    }))
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
    console.error = originalError
    rmSync(root, { recursive: true, force: true })
  }
}
