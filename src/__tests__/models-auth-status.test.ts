/**
 * Auth-status caching and resilience — against the REAL implementation (#707).
 *
 * This file previously declared its own `authCache`, `lastKnownGood`, TTLs and
 * caching logic and asserted against that copy. It never imported
 * `../proxy/models`, so all 8 tests would have passed with
 * `getClaudeAuthStatusAsync` deleted — no coverage at all of the resilience
 * behaviour it claimed to test.
 *
 * The original objection to mocking was real and is quoted in the old file:
 * bun's `mock.module` is global and leaks across files. It no longer applies —
 * `package.json` excludes this file from the main `bun test` run and executes
 * it as its own invocation, so a module mock here cannot reach other files.
 *
 * Two things make the real implementation testable deterministically:
 *   - `MERIDIAN_CLAUDE_PATH` short-circuits executable resolution, so no real
 *     binary is probed.
 *   - `profileAuthCaches` is keyed by profile id, so a unique profile per test
 *     gives isolation without any shared-singleton race — which is what drove
 *     the reimplementation in the first place.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, mock } from "bun:test"
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Controls what the mocked `claude auth status` does on the next call. */
let authBehavior: "success" | "fail" = "success"
let execFileCalls = 0
let currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }

mock.module("child_process", () => ({
  exec: (_cmd: string, optsOrCb: any, cb?: any) => {
    const done = typeof optsOrCb === "function" ? optsOrCb : cb
    done?.(null, { stdout: "", stderr: "" })
  },
  execFile: (_file: string, _args: any, optsOrCb: any, cb?: any) => {
    execFileCalls++
    const done = typeof optsOrCb === "function" ? optsOrCb : cb
    if (authBehavior === "fail") {
      done?.(new Error("claude auth status failed"), { stdout: "", stderr: "" })
      return
    }
    done?.(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
  },
}))

const savedClaudePath = process.env.MERIDIAN_CLAUDE_PATH
process.env.MERIDIAN_CLAUDE_PATH = "/fake/claude"

const {
  getClaudeAuthStatusAsync,
  getAuthCacheInfo,
  resetCachedClaudeAuthStatus,
  expireAuthStatusCache,
} = await import("../proxy/models")

afterAll(() => {
  if (savedClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
  else process.env.MERIDIAN_CLAUDE_PATH = savedClaudePath
})

/** Unique profile per test — the isolation that replaces the local copy. */
let profileSeq = 0
const nextProfile = () => `auth-test-${++profileSeq}`

describe("getClaudeAuthStatusAsync — real implementation", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  it("fetches and returns auth status on a cold cache", async () => {
    const status = await getClaudeAuthStatusAsync(nextProfile())
    expect(status).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("serves from cache within the TTL instead of re-running the CLI", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    // The point of the cache: one subprocess, not two.
    expect(execFileCalls).toBe(1)
  })

  it("re-fetches once the TTL has expired", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up a changed payload after expiry", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    currentPayload = { loggedIn: true, email: "new@test.com", subscriptionType: "team" }
    expireAuthStatusCache()
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("falls back to last-known-good when the auth check fails", async () => {
    // The resilience property with no real coverage before: a transient CLI
    // failure must not blank the proxy's view of auth.
    const p = nextProfile()
    const good = await getClaudeAuthStatusAsync(p)
    expect(good).toEqual(currentPayload)

    authBehavior = "fail"
    expireAuthStatusCache()
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("returns null when the first check fails and there is no last-known-good", async () => {
    authBehavior = "fail"
    expect(await getClaudeAuthStatusAsync(nextProfile())).toBeNull()
  })

  it("marks the cache as failed so /health can report it", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)
  })

  it("clears the failure flag once a later check succeeds", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)

    authBehavior = "success"
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    const info = getAuthCacheInfo(p)
    expect(info.isFailure).toBe(false)
    expect(info.lastSuccessAt).toBeGreaterThan(0)
  })

  it("records lastSuccessAt only on success", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(getAuthCacheInfo(p).lastSuccessAt).toBe(0)
  })

  it("de-duplicates concurrent cold-cache calls into one subprocess", async () => {
    // Without the in-flight promise, a burst of requests on a cold cache would
    // spawn one `claude auth status` each.
    const p = nextProfile()
    const results = await Promise.all([
      getClaudeAuthStatusAsync(p),
      getClaudeAuthStatusAsync(p),
      getClaudeAuthStatusAsync(p),
    ])
    for (const r of results) expect(r).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("keeps profiles isolated — one account's failure does not poison another", async () => {
    // The reason the cache is per-profile at all: two Claude accounts have
    // independent auth state.
    const good = nextProfile()
    const bad = nextProfile()
    await getClaudeAuthStatusAsync(good)

    authBehavior = "fail"
    await getClaudeAuthStatusAsync(bad)

    expect(getAuthCacheInfo(good).isFailure).toBe(false)
    expect(getAuthCacheInfo(bad).isFailure).toBe(true)
    // The healthy profile still serves from its own cache, no new subprocess.
    const callsBefore = execFileCalls
    expect(await getClaudeAuthStatusAsync(good)).toEqual(currentPayload)
    expect(execFileCalls).toBe(callsBefore)
  })

  it("reports zeroed cache info for a profile never checked", async () => {
    expect(getAuthCacheInfo("never-seen")).toEqual({
      lastCheckedAt: 0,
      lastSuccessAt: 0,
      isFailure: false,
    })
  })
})

/**
 * Credential-file mtime invalidation under MERIDIAN_CREDENTIALS_READONLY.
 *
 * A read-only instance never refreshes its own tokens, so the only thing that
 * ever changes its auth status is a rotation performed by the instance that
 * owns them. Time-based expiry alone would keep serving the pre-rotation
 * answer for up to a full TTL after one lands.
 *
 * Lives here rather than in credentials-readonly.test.ts because it asserts on
 * the real auth-status cache: four files in the main `bun test` run call
 * `mock.module("../proxy/models", …)`, which is global, so those assertions
 * only hold in this file's own isolated invocation.
 */
describe("auth-status cache — credential mtime invalidation", () => {
  let dir: string
  let credFile: string

  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    resetCachedClaudeAuthStatus()
    dir = mkdtempSync(join(tmpdir(), "meridian-readonly-mtime-"))
    credFile = join(dir, ".credentials.json")
    // Fabricated placeholder — only the file's mtime matters here.
    writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "placeholder" } }))
  })

  afterEach(() => {
    delete process.env.MERIDIAN_CREDENTIALS_READONLY
    rmSync(dir, { recursive: true, force: true })
  })

  /** Push mtime forward a whole second so the change is unambiguous. */
  function ageCredentialFile(): void {
    const next = new Date(statSync(credFile).mtimeMs + 1000)
    utimesSync(credFile, next, next)
  }

  it("re-reads when the other instance rotates the credential file", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(2)
  })

  it("picks up the rotated payload rather than the cached one", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    currentPayload = { loggedIn: true, email: "rotated@test.com", subscriptionType: "max" }

    ageCredentialFile()
    expect(await getClaudeAuthStatusAsync(p, overrides)).toEqual(currentPayload)
  })

  it("leaves the time-based cache untouched when the flag is absent", async () => {
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    expect(execFileCalls).toBe(1)
  })
})
