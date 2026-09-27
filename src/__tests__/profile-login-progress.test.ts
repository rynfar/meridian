import { afterEach, beforeEach, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  completeProfileLogin,
  completeProfileLoginFromCallback,
  getProfileLoginStatus,
  resetPendingLogins,
  startProfileLogin,
} from "../proxy/profileLogin"
import { resetDiskProfileDiscovery } from "../proxy/profiles"

let dir: string
let inheritedDir: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meridian-login-progress-"))
  inheritedDir = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
  resetDiskProfileDiscovery()
  resetPendingLogins()
})

afterEach(() => {
  if (inheritedDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = inheritedDir
  resetPendingLogins()
  rmSync(dir, { recursive: true, force: true })
})

it.each(["paste", "callback"])("keeps %s login observable while its exchange is running", async path => {
  // Given an isolated login with its token exchange held in flight.
  const started = startProfileLogin({
    profiles: [{ id: "fixture", claudeConfigDir: dir }],
    profileId: "fixture",
    hostHeader: "127.0.0.1:3456",
  })
  if (!started.ok) throw new Error("fixture login did not start")
  const state = new URL(started.authorizeUrl).searchParams.get("state")
  if (!state) throw new Error("fixture login has no state")
  const exchange = Promise.withResolvers<Response>()
  const fetchFn: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => String(input).endsWith("/oauth/token")
      ? exchange.promise
      : Response.json({}),
    { preconnect: fetch.preconnect },
  )

  // When completion starts, polling must remain live without permitting replay.
  const completion = path === "paste"
    ? completeProfileLogin({ loginId: started.loginId, input: "fixture-code", fetchFn })
    : completeProfileLoginFromCallback({ state, code: "fixture-code", fetchFn })
  try {
    expect(getProfileLoginStatus(started.loginId)).toMatchObject({ status: "waiting", profileId: "fixture" })
    expect(await completeProfileLogin({ loginId: started.loginId, input: "duplicate", fetchFn }))
      .toMatchObject({ ok: false, code: "expired_login" })
  } finally {
    // A refused exchange exercises the terminal state without platform credential writes.
    exchange.resolve(new Response("fixture refusal", { status: 400 }))
    await completion
  }
  // Then polling observes the outcome instead of losing the operation mid-flight.
  expect(getProfileLoginStatus(started.loginId)).toMatchObject({ status: "failed", code: "exchange_failed" })
})

it("refuses an implicit credential context rather than writing an unused profile directory", () => {
  const result = startProfileLogin({ profiles: [{ id: "fixture" }], profileId: "fixture" })
  expect(result).toMatchObject({ ok: false, code: "missing_config_dir", status: 400 })
})

it.skipIf(process.platform === "darwin")("writes to the explicit inherited Claude credential context used by requests", async () => {
  process.env.CLAUDE_CONFIG_DIR = dir
  const result = startProfileLogin({ profiles: [{ id: "fixture" }], profileId: "fixture" })
  if (!result.ok) throw new Error("fixture login did not start")
  const fetchFn: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => Response.json(String(input).endsWith("/oauth/token")
      ? { access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600 }
      : {}),
    { preconnect: fetch.preconnect },
  )
  expect(await completeProfileLogin({ loginId: result.loginId, input: "fixture-code", fetchFn }))
    .toMatchObject({ ok: true })
  expect(existsSync(join(dir, ".credentials.json"))).toBe(true)
})
