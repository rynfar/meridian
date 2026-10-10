/**
 * /profiles/list reports each login's lifetime: the deadline read off the
 * profile's own credential, and the record authLifecycle.ts keeps.
 *
 * Real credential files in temp directories, so this runs the same store
 * selection production does. Skipped on macOS, where credentials live in the
 * Keychain and a file fixture cannot stand in for them.
 */
import { describe, test, expect, mock, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "profiles-list-login-lifetime.test.ts")

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

import { resolveSdkModelDefaults } from "../proxy/models"

mock.module("../proxy/models", () => ({
  mapModelToClaudeModel: () => "sonnet",
  resolveClaudeExecutableAsync: async () => "claude",
  resolveSdkModelDefaults,
  getClaudeAuthStatusAsync: async () => ({ loggedIn: true, email: "test@test.com", subscriptionType: "max" }),
  getAuthCacheInfo: () => ({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false }),
  hasExtendedContext: () => false,
  stripExtendedContext: (m: string) => m,
  isClosedControllerError: (e: unknown) => e instanceof Error && e.message.includes("controller is closed"),
  recordExtendedContextUnavailable: () => {},
  isExtendedContextKnownUnavailable: () => false,
}))

const { createProxyServer } = await import("../proxy/server")
const { createPlatformCredentialStore, getAuthRenewalStatus } = await import("../proxy/tokenRefresh")
const { authLifecycleFor, noteAuthLogin } = await import("../proxy/authLifecycle")

const HOUR = 3_600_000
const root = mkdtempSync(join(tmpdir(), "meridian-login-lifetime-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

function profileDir(name: string, oauth: Record<string, unknown>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: oauth }))
  return dir
}

describe("/profiles/list login lifetime", () => {
  test.skipIf(process.platform === "darwin")("reports the deadline, and a wiped credential as logged out", async () => {
    const now = Date.now()
    const deadline = now + 2 * 24 * HOUR
    const accessExpiry = now + 7 * HOUR
    const alive = profileDir("alive", { accessToken: "x", refreshToken: "r", expiresAt: accessExpiry, refreshTokenExpiresAt: deadline })
    const wiped = profileDir("wiped", { accessToken: "", refreshToken: "", expiresAt: 0 })
    const { app } = createProxyServer({
      port: 0,
      host: "127.0.0.1",
      profiles: [{ id: "alive", claudeConfigDir: alive }, { id: "wiped", claudeConfigDir: wiped }] as never,
    })

    const res = await app.fetch(new Request("http://localhost/profiles/list"))
    expect(res.status).toBe(200)
    const body = await res.json() as { profiles: Array<Record<string, unknown>> }
    const byId = Object.fromEntries(body.profiles.map(p => [p.id as string, p]))

    expect(byId.alive).toMatchObject({
      refreshTokenExpiresAt: deadline,
      daysUntilRenewal: 2,
      renewalRequiredSoon: true,
      accessTokenExpiresAt: accessExpiry,
      firstUnauthedAt: null,
    })
    expect(byId.wiped).toMatchObject({ loggedIn: false, unauthedReason: "credentials_cleared" })
    expect(typeof byId.wiped!.firstUnauthedAt).toBe("number")

    // Recorded once: a second poll reports the same moment, not a new one.
    const again = await (await app.fetch(new Request("http://localhost/profiles/list"))).json() as typeof body
    expect(again.profiles.find(p => p.id === "wiped")!.firstUnauthedAt).toBe(byId.wiped!.firstUnauthedAt)
  })

  test.skipIf(process.platform === "darwin")("a re-login reads back as one login while the old deadline is still cached", async () => {
    const now = Date.now()
    const oldDeadline = now + 2 * HOUR
    const newDeadline = now + 30 * 24 * HOUR
    const dir = profileDir("relogin", { accessToken: "x", refreshToken: "r", expiresAt: now + HOUR, refreshTokenExpiresAt: oldDeadline })
    const store = createPlatformCredentialStore({ claudeConfigDir: dir })
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: [{ id: "relogin", claudeConfigDir: dir }] as never })
    await app.fetch(new Request("http://localhost/profiles/list"))
    // /health's renewal read caches the deadline for minutes.
    expect((await getAuthRenewalStatus(store)).refreshTokenExpiresAt).toBe(oldDeadline)

    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "y", refreshToken: "r2", expiresAt: now + 8 * HOUR, refreshTokenExpiresAt: newDeadline },
    }))
    noteAuthLogin(store.refreshKey, { refreshTokenExpiresAt: newDeadline })

    const body = await (await app.fetch(new Request("http://localhost/profiles/list"))).json() as { profiles: Array<Record<string, unknown>> }
    expect(body.profiles[0]).toMatchObject({ refreshTokenExpiresAt: newDeadline, authObtainedVia: "login" })
    expect(authLifecycleFor(store.refreshKey)!.events.map(e => e.kind)).toEqual(["login"])
  })
})
