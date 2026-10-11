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
import { describe, it, expect, beforeEach, afterEach, afterAll, mock, setSystemTime, spyOn } from "bun:test"
import * as realChildProcess from "node:child_process"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Controls what the mocked `claude auth status` does on the next call.
 * "hang" models a spawn stalled on a loaded host: the callback is parked in
 * `hungSpawns` until the test settles it with `releaseHungSpawns`.
 */
let authBehavior: "success" | "fail" | "hang" | "timeout" | "exit1" | "exit2" | "logout-killed" | "logout-signal" | "logout-truncated" | "logout-exit2" = "success"
let execFileCalls = 0
/** Options the probe passed to execFile, so spawn flags can be asserted. */
let execFileOptions: realChildProcess.ExecFileOptions | undefined
let currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
let hungSpawns: Array<(err: Error | null, out: { stdout: string; stderr: string }) => void> = []

function releaseHungSpawns(): void {
  const pending = hungSpawns
  hungSpawns = []
  for (const done of pending) done(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
}

/** What execFile rejects with when it kills the child at its timeout. */
const timeoutError = () =>
  Object.assign(new Error("Command failed: /fake/claude auth status\n"), { killed: true, signal: "SIGTERM", code: null })

function killHungSpawns(): void {
  const pending = hungSpawns
  hungSpawns = []
  for (const done of pending) done(timeoutError(), { stdout: "", stderr: "" })
}

interface FakeAuthChild {
  child: realChildProcess.ChildProcess
  signals: NodeJS.Signals[]
  callback(error: Error | null, output: { stdout: string; stderr: string }): void
  witnesses(code?: number | null, signal?: NodeJS.Signals | null): void
}
let fakeAuthChildren: FakeAuthChild[] = []
let resolverChildren: FakeAuthChild[] = []
let resolverLookups = 0
let resolverVersions = 0
let resolverVersionOptions: realChildProcess.ExecFileOptions[] = []
function resolverFixture(done: (error: Error | null, stdout: string, stderr: string) => void): realChildProcess.ChildProcess {
  const signals: NodeJS.Signals[] = []
  const child = Object.assign(new EventEmitter(), { pid: 20_000 + resolverChildren.length,
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: (signal: NodeJS.Signals = 'SIGTERM') => { signals.push(signal); return true },
  }) as unknown as realChildProcess.ChildProcess
  resolverChildren.push({ child, signals, callback: (error, output) => done(error, output.stdout, output.stderr),
    witnesses(code = 0, signal = null) {
      child.emit('exit', code, signal); child.stdout?.emit('close'); child.stderr?.emit('close'); child.emit('close', code, signal)
    } })
  return child
}
// These are unspawned EventEmitter/pipe fixtures, not native processes.
mock.module("child_process", () => ({
  ...realChildProcess,
  exec: (_command: string, _options: realChildProcess.ExecOptions,
    done: (error: Error | null, stdout: string, stderr: string) => void) => {
    resolverLookups++
    return resolverFixture(done)
  },
  execFile: (_file: string, _args: string[], options: realChildProcess.ExecFileOptions,
    done: (error: Error | null, stdout: string, stderr: string) => void) => {
    if (_args[0] === '--version') { resolverVersions++; resolverVersionOptions.push(options); return resolverFixture(done) }
    execFileCalls++
    execFileOptions = options
    const signals: NodeJS.Signals[] = []
    const child = Object.assign(new EventEmitter(), {
      pid: 10_000 + execFileCalls, stdout: new PassThrough(), stderr: new PassThrough(),
      kill: (signal: NodeJS.Signals = "SIGTERM") => { signals.push(signal); return true },
    }) as unknown as realChildProcess.ChildProcess
    const fixture: FakeAuthChild = {
      child, signals,
      callback: (error, output) => done(error, output.stdout, output.stderr),
      witnesses(code = 0, signal = null) {
        child.emit("exit", code, signal)
        child.stdout?.emit("close"); child.stderr?.emit("close")
        child.emit("close", code, signal)
      },
    }
    fakeAuthChildren.push(fixture)
    const complete = (error: Error | null, output: { stdout: string; stderr: string }) => {
      fixture.callback(error, output)
      fixture.witnesses(error ? 1 : 0)
    }
    queueMicrotask(() => {
      if (authBehavior === "hang") { hungSpawns.push(complete); return }
      if (authBehavior === "fail") { complete(new Error("claude auth status failed"), { stdout: "", stderr: "" }); return }
      if (authBehavior === "timeout") { complete(timeoutError(), { stdout: "", stderr: "" }); return }
      if (authBehavior === "exit1") {
        const stdout = JSON.stringify({ loggedIn: false, email: "private@test.com" })
        // Node's callback error does not carry stdout: only promisify adds it.
        complete(Object.assign(new Error("Command failed: /fake/claude auth status\n"), { killed: false, signal: null, code: 1 }), { stdout, stderr: "" }); return
      }
      if (authBehavior.startsWith("logout-")) {
        const stdout = authBehavior === "logout-truncated" ? '{"loggedIn":false' : JSON.stringify({ loggedIn: false })
        complete(Object.assign(new Error("Unavailable auth probe"), {
          killed: authBehavior === "logout-killed",
          signal: authBehavior === "logout-signal" ? "SIGTERM" : null,
          code: authBehavior === "logout-exit2" ? 2 : 1,
        }), { stdout, stderr: "" }); return
      }
      if (authBehavior === "exit2") {
        complete(Object.assign(new Error("Command failed: /fake/claude auth status\n"), { killed: false, signal: null, code: 2, stdout: "not json" }), { stdout: "not json", stderr: "" }); return
      }
      complete(null, { stdout: JSON.stringify(currentPayload), stderr: "" })
    })
    return child
  },
}))

mock.module("../proxy/setup", () => ({
  checkPluginConfigured: () => false,
  isPluginlessOpenCodeRequest: () => false,
  notePluginlessOpenCodeRequest: () => undefined,
}))
// All store/SDK doubles are installed before production imports. Only the
// mtime tests below name an owned synthetic .credentials.json file.
mock.module("../proxy/tokenRefresh", () => ({
  credentialsFilePathForProfile: (dir?: string) => {
    if (!dir) throw new Error("No default owner credential store in this fixture")
    return join(dir, ".credentials.json")
  },
  createPlatformCredentialStore: () => ({ read: async () => null,
    write: async () => { throw new Error("Fixture must not write credentials") } }),
  readStoredCredentialPresence: async () => "absent",
  refreshOAuthToken: async () => false,
  ensureFreshToken: async () => false,
  startBackgroundRefresh: () => undefined,
  stopBackgroundRefresh: () => undefined,
  getAuthRenewalStatus: async () => ({ renewalRequiredSoon: false }),
  getStoredPlanFields: async () => ({}),
  resolveRenewalWarnDays: () => 3,
  configDirToKeychainService: () => "fixture-no-keychain",
  configDirToCredentialsFile: (dir: string) => join(dir, ".credentials.json"),
}))
installSdkMock(() => ({ query: () => { throw new Error("Auth fixtures must not query a model") },
  createSdkMcpServer: () => ({}), tool: () => ({}) }), "models-auth-status.test.ts")
installLoggerMock(() => ({ claudeLog: () => undefined,
  withClaudeLogContext: (_ctx: unknown, callback: () => unknown) => callback() }))
const savedAuthFixtureEnv = { ...process.env }
const fixtureRoot = mkdtempSync(join(tmpdir(), "meridian-auth-status-owned-"))
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(fixtureRoot, "config"),
  MERIDIAN_SESSION_DIR: join(fixtureRoot, "sessions"), MERIDIAN_WORKDIR: fixtureRoot,
  MERIDIAN_PROFILES: "[]", MERIDIAN_CREDENTIALS_READONLY: "1",
  MERIDIAN_NO_UPDATE_CHECK: "1", MERIDIAN_TELEMETRY_PERSIST: "0" })

const savedClaudePath = process.env.MERIDIAN_CLAUDE_PATH
const ownedExecutable = join(fixtureRoot, "owned-auth-program")
writeFileSync(ownedExecutable, "# Owned placeholder: every process call is mocked before import.\n", { mode: 0o700 })
process.env.MERIDIAN_CLAUDE_PATH = ownedExecutable

const {
  getClaudeAuthStatusAsync,
  resolveClaudeExecutableAsync,
  resetCachedClaudePath,
  getAuthCacheInfo,
  resetCachedClaudeAuthStatus,
  expireAuthStatusCache,
  pendingAuthStatusRefresh,
  authStatusFailureTtlMs,
  setAuthStatusWaitMsForTesting,
} = await import("../proxy/models")

/** Failed checks warn; kept off the test output and asserted where it matters. */
const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
const warnings = () => warnSpy.mock.calls.map(call => String(call[0]))

beforeEach(() => { warnSpy.mockClear(); fakeAuthChildren = [] })

afterAll(() => {
  warnSpy.mockRestore()
  for (const key of Object.keys(process.env)) if (!(key in savedAuthFixtureEnv)) delete process.env[key]
  Object.assign(process.env, savedAuthFixtureEnv)
  rmSync(fixtureRoot, { recursive: true, force: true })
  if (savedClaudePath === undefined) delete process.env.MERIDIAN_CLAUDE_PATH
  else process.env.MERIDIAN_CLAUDE_PATH = savedClaudePath
})

const NOT_SETTLED = Symbol("not settled")

function settledWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof NOT_SETTLED> {
  return Promise.race([promise, new Promise<typeof NOT_SETTLED>((r) => setTimeout(() => r(NOT_SETTLED), ms))])
}

/** Let the refresh reach execFile: it first awaits executable resolution. */
const tick = () => new Promise((r) => setTimeout(r, 10))

/** Unique profile per test — the isolation that replaces the local copy. */
let profileSeq = 0
const nextProfile = () => `auth-test-${++profileSeq}`

describe("getClaudeAuthStatusAsync — real implementation", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    execFileOptions = undefined
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
    setSystemTime()
    setAuthStatusWaitMsForTesting()
  })

  // Windows allocates a visible console for a child launched without this flag,
  // and the probe re-runs on cache expiry, so a service with no console of its
  // own flashed a window on most prompts (#1172). The flag is a no-op elsewhere,
  // so this guards the fix from every platform CI runs on.
  it("hides the console window when probing auth status", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(execFileCalls).toBe(1)
    expect(execFileOptions?.windowsHide).toBe(true)
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
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up a changed payload after expiry, one call later", async () => {
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    currentPayload = { loggedIn: true, email: "new@test.com", subscriptionType: "team" }
    expireAuthStatusCache()
    // The caller that finds the cache expired is answered from it...
    expect(await getClaudeAuthStatusAsync(p)).toEqual(previous!)
    await pendingAuthStatusRefresh(p)
    // ...and the refresh it started answers the next one.
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("does not wait on the auth-status spawn once the cache has expired", async () => {
    // The /health freeze: a load balancer probing with a 2 s timeout marked the
    // proxy down whenever the expired cache made the probe wait on a spawn
    // that a loaded host stretched past it.
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    authBehavior = "hang"

    expect(await settledWithin(getClaudeAuthStatusAsync(p), 200)).toEqual(previous!)
    await tick()
    expect(hungSpawns).toHaveLength(1)

    currentPayload = { loggedIn: true, email: "later@test.com", subscriptionType: "max" }
    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
  })

  it("starts a single background refresh for concurrent callers after expiry", async () => {
    const p = nextProfile()
    const previous = await getClaudeAuthStatusAsync(p)
    expireAuthStatusCache()
    authBehavior = "hang"

    const results = await settledWithin(
      Promise.all(Array.from({ length: 5 }, () => getClaudeAuthStatusAsync(p))),
      200,
    )
    expect(results).toEqual(Array.from({ length: 5 }, () => previous!))
    await tick()
    // One warm-up spawn plus exactly one refresh, still in flight.
    expect(execFileCalls).toBe(2)
    expect(await settledWithin(getClaudeAuthStatusAsync(p), 200)).toEqual(previous!)
    await tick()
    expect(execFileCalls).toBe(2)
  })

  it("still waits on a cold start with nothing to fall back on", async () => {
    const p = nextProfile()
    authBehavior = "hang"
    const first = getClaudeAuthStatusAsync(p)
    expect(await settledWithin(first, 100)).toBe(NOT_SETTLED)
    releaseHungSpawns()
    expect(await first).toEqual(currentPayload)
  })

  it("lets the CLI run far longer than any caller waits for it", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(execFileOptions?.timeout).toBe(90_000)
  })

  it("stops waiting on a slow first check without killing it, then serves its answer", async () => {
    // A cold CLI on a loaded host was measured taking 15-40 s. Killed at the
    // caller's 5 s, no check ever finished and the proxy stayed unverified.
    setAuthStatusWaitMsForTesting(50)
    const p = nextProfile()
    authBehavior = "hang"

    expect(await settledWithin(getClaudeAuthStatusAsync(p), 1_000)).toBeNull()
    expect(await settledWithin(getClaudeAuthStatusAsync(p), 1_000)).toBeNull()
    expect(hungSpawns).toHaveLength(1)
    // Still running, not failed: nothing to back off from.
    expect(getAuthCacheInfo(p)).toEqual({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false })

    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
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

  it("doubles the retry delay per consecutive failure, capped at 5 minutes", () => {
    expect(authStatusFailureTtlMs(1)).toBe(5_000)
    expect(authStatusFailureTtlMs(2)).toBe(10_000)
    expect(authStatusFailureTtlMs(3)).toBe(20_000)
    expect(authStatusFailureTtlMs(6)).toBe(160_000)
    expect(authStatusFailureTtlMs(7)).toBe(300_000)
    expect(authStatusFailureTtlMs(1_000)).toBe(300_000)
  })

  it("backs off after repeated failures and resets on success", async () => {
    // A flat 5 s retry re-spawned `claude auth status` on every health probe
    // for as long as the check kept failing.
    const p = nextProfile()
    let now = Date.parse("2026-01-01T00:00:00Z")
    const advance = (ms: number) => { now += ms; setSystemTime(new Date(now)) }
    setSystemTime(new Date(now))

    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(1)

    advance(4_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(1)
    advance(1_500)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)

    // Second consecutive failure: 10 s, not 5 s.
    advance(6_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(2)
    advance(4_500)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(3)

    // Third: 20 s.
    advance(15_000)
    await getClaudeAuthStatusAsync(p)
    expect(execFileCalls).toBe(3)
    advance(5_500)
    authBehavior = "success"
    expect(await getClaudeAuthStatusAsync(p)).toEqual(currentPayload)
    expect(execFileCalls).toBe(4)

    // A success resets the count: the next failure is retried after 5 s again.
    advance(61_000)
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(5)
    expect(getAuthCacheInfo(p).isFailure).toBe(true)
    advance(5_500)
    await getClaudeAuthStatusAsync(p)
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(6)
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

describe("auth refresh process ownership", () => {
  beforeEach(() => {
    authBehavior = "hang"; execFileCalls = 0; hungSpawns = []
    resetCachedClaudeAuthStatus(); setAuthStatusWaitMsForTesting(10)
  })
  afterEach(() => {
    releaseHungSpawns(); setAuthStatusWaitMsForTesting()
  })

  it("does not treat the callback, exit or one closed pipe as complete cleanup", async () => {
    const { startAuthStatusProcess } = await import("../proxy/authStatusProcess")
    const process = startAuthStatusProcess("/fake/claude", { timeoutMs: 10_000 })
    await tick()
    const fake = fakeAuthChildren[0]!
    fake.callback(null, { stdout: "{}", stderr: "" })
    fake.child.emit("exit", 0, null)
    fake.child.stdout?.emit("close")
    expect(await settledWithin(process.result, 20)).toBe(NOT_SETTLED)
    fake.child.emit("close", 0, null)
    expect(await settledWithin(process.joined, 20)).toBe(NOT_SETTLED)
    fake.child.stderr?.emit("close")
    expect(await process.result).toBe("{}")
    await process.joined
    expect(fake.signals).toEqual([])
    hungSpawns = []
  })

  it("bounds a missing close witness without inventing an exit or pipe join", async () => {
    const { startAuthStatusProcess } = await import("../proxy/authStatusProcess")
    const process = startAuthStatusProcess("/fake/claude", { timeoutMs: 10_000, killGraceMs: 5, joinGraceMs: 10 })
    await tick()
    const fake = fakeAuthChildren[0]!
    await expect(process.cancel()).rejects.toThrow("cleanup is unconfirmed")
    await expect(process.result).rejects.toThrow("cleanup is unconfirmed")
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(await settledWithin(process.joined, 20)).toBe(NOT_SETTLED)
    fake.callback(timeoutError(), { stdout: "", stderr: "" }); fake.witnesses(null, "SIGKILL")
    await process.joined
    hungSpawns = []
  })

  it("never signals an exited child whose pipe close is still missing", async () => {
    const { startAuthStatusProcess } = await import("../proxy/authStatusProcess")
    const process = startAuthStatusProcess("/fake/claude", { timeoutMs: 10_000, killGraceMs: 5, joinGraceMs: 10 })
    await tick()
    const fake = fakeAuthChildren[0]!
    fake.callback(null, { stdout: "{}", stderr: "" }); fake.child.emit("exit", 0, null)
    await expect(process.cancel()).rejects.toThrow("cleanup is unconfirmed")
    expect(fake.signals).toEqual([])
    fake.witnesses(); await process.joined
    hungSpawns = []
  })

  it("last-owner close waits for actual exit, close and both pipes", async () => {
    const { createAuthStatusOwner } = await import("../proxy/authStatusOwnership")
    const owner = createAuthStatusOwner()
    const profile = nextProfile()
    expect(await owner.run(() => getClaudeAuthStatusAsync(profile))).toBeNull()
    const fake = fakeAuthChildren[0]!
    const closing = owner.close()
    expect(fake.signals).toEqual(["SIGTERM"])
    fake.callback(timeoutError(), { stdout: "", stderr: "" })
    fake.child.emit("exit", null, "SIGTERM")
    expect(await settledWithin(closing, 20)).toBe(NOT_SETTLED)
    fake.child.stdout?.emit("close"); fake.child.stderr?.emit("close")
    expect(await settledWithin(closing, 20)).toBe(NOT_SETTLED)
    fake.child.emit("close", null, "SIGTERM")
    await closing
    expect(getAuthCacheInfo(profile)).toEqual({ lastCheckedAt: 0, lastSuccessAt: 0, isFailure: false })
    expect(await owner.run(() => getClaudeAuthStatusAsync(profile))).toBeNull()
    expect(execFileCalls).toBe(1)
    hungSpawns = []
  })

  it("one embedded owner closing cannot cancel the sibling's shared check", async () => {
    const { createAuthStatusOwner } = await import("../proxy/authStatusOwnership")
    const first = createAuthStatusOwner(); const second = createAuthStatusOwner()
    const profile = nextProfile()
    await Promise.all([first.run(() => getClaudeAuthStatusAsync(profile)), second.run(() => getClaudeAuthStatusAsync(profile))])
    expect(execFileCalls).toBe(1)
    await first.close()
    expect(fakeAuthChildren[0]!.signals).toEqual([])
    releaseHungSpawns(); await pendingAuthStatusRefresh(profile)
    expect(await second.run(() => getClaudeAuthStatusAsync(profile))).toEqual(currentPayload)
    await second.close()
    expect(execFileCalls).toBe(1)
  })

  it("a direct independent caller retains the shared check when the embedded owner closes", async () => {
    const { createAuthStatusOwner } = await import("../proxy/authStatusOwnership")
    const owner = createAuthStatusOwner(); const profile = nextProfile()
    await Promise.all([owner.run(() => getClaudeAuthStatusAsync(profile)), getClaudeAuthStatusAsync(profile)])
    await owner.close()
    expect(fakeAuthChildren[0]!.signals).toEqual([])
    releaseHungSpawns(); await pendingAuthStatusRefresh(profile)
    expect(await getClaudeAuthStatusAsync(profile)).toEqual(currentPayload)
    expect(execFileCalls).toBe(1)
  })

  it("expiry cannot start another process while the first check owns its slot", async () => {
    const profile = nextProfile()
    expect(await getClaudeAuthStatusAsync(profile)).toBeNull()
    expireAuthStatusCache()
    expect(await getClaudeAuthStatusAsync(profile)).toBeNull()
    expect(execFileCalls).toBe(1)
    releaseHungSpawns(); await pendingAuthStatusRefresh(profile)
    expect(await getClaudeAuthStatusAsync(profile)).toEqual(currentPayload)
  })

  it("a missing last-owner close rejects shutdown and retains the shared slot", async () => {
    const { createAuthStatusOwner } = await import("../proxy/authStatusOwnership")
    const owner = createAuthStatusOwner(); const nextOwner = createAuthStatusOwner()
    const profile = nextProfile()
    await owner.run(() => getClaudeAuthStatusAsync(profile))
    const fake = fakeAuthChildren[0]!
    await expect(owner.close()).rejects.toThrow("cleanup is unconfirmed")
    expect(fake.signals).toEqual(["SIGTERM", "SIGKILL"])
    await nextOwner.run(() => getClaudeAuthStatusAsync(profile))
    expect(execFileCalls).toBe(1)
    fake.callback(timeoutError(), { stdout: "", stderr: "" }); fake.witnesses(null, "SIGKILL")
    await tick()
    authBehavior = "success"
    expect(await nextOwner.run(() => getClaudeAuthStatusAsync(profile))).toEqual(currentPayload)
    expect(execFileCalls).toBe(2)
    await nextOwner.close()
    hungSpawns = []
  }, 5000)

  it("ProxyInstance.close joins an auth check after the first HTTP wait expires", async () => {
    const { startProxyServer } = await import("../proxy/server")
    const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true,
      profiles: [{ id: "owned-close-api", type: "api", apiKey: "fixture-key" }], defaultProfile: "owned-close-api" })
    try {
      const address = instance.server.address()
      expect(address && typeof address === "object").toBe(true)
      if (!address || typeof address !== "object") throw new Error("Owned fixture listener missing")
      const response = await fetch(`http://127.0.0.1:${address.port}/health`)
      expect((await response.json() as { status: string }).status).toBe("degraded")
      const closing = instance.close()
      await tick()
      const fake = fakeAuthChildren[0]!
      expect(fake.signals).toEqual(["SIGTERM"])
      fake.callback(timeoutError(), { stdout: "", stderr: "" }); fake.witnesses(null, "SIGTERM")
      await closing
      expect(instance.server.listening).toBe(false)
      hungSpawns = []
    } finally {
      releaseHungSpawns()
      await instance.close()
    }
  })

  it("closing one actual HTTP instance leaves the second instance's shared check intact", async () => {
    const { startProxyServer } = await import("../proxy/server")
    const config = { port: 0, host: "127.0.0.1", silent: true,
      profiles: [{ id: "two-http-api", type: "api" as const, apiKey: "fixture-key" }], defaultProfile: "two-http-api" }
    const first = await startProxyServer(config)
    const second = await startProxyServer(config)
    const health = async (instance: typeof first) => {
      const address = instance.server.address()
      if (!address || typeof address !== "object") throw new Error("Owned listener missing")
      return (await (await fetch(`http://127.0.0.1:${address.port}/health`)).json() as { status: string }).status
    }
    try {
      expect(await Promise.all([health(first), health(second)])).toEqual(["degraded", "degraded"])
      expect(execFileCalls).toBe(1)
      await first.close()
      expect(fakeAuthChildren[0]!.signals).toEqual([])
      releaseHungSpawns(); await pendingAuthStatusRefresh("two-http-api")
      expect(await health(second)).toBe("healthy")
      expect(execFileCalls).toBe(1)
    } finally {
      releaseHungSpawns()
      await Promise.all([first.close(), second.close()])
    }
  })
})

/**
 * A failed check used to be visible only with OPENCODE_CLAUDE_PROVIDER_DEBUG
 * set, so a proxy stuck at "Could not verify auth status" said nothing about why.
 */
describe("auth-status warnings", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
    setAuthStatusWaitMsForTesting()
    setSystemTime()
  })

  async function failAgain(p: string): Promise<void> {
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    // A stale answer returns before its background refresh settles. Assert
    // the refresh's warning only after that exact pending check completes.
    await pendingAuthStatusRefresh(p)
  }

  it("warns why a check failed, then only on the 2nd, 4th, 8th... repeat", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`Could not verify Claude auth status for profile "${p}": claude auth status failed`)
    expect(warnings()[0]).toContain("1 in a row; no status known yet; next check in 5s")

    await failAgain(p)
    expect(warnings()).toHaveLength(2)
    await failAgain(p)
    expect(warnings()).toHaveLength(2)
    await failAgain(p)
    expect(warnings()).toHaveLength(3)
    expect(warnings()[2]).toContain("4 in a row")

    authBehavior = "success"
    expireAuthStatusCache()
    await getClaudeAuthStatusAsync(p)
    expect(warnings()[3]).toContain(`Verified Claude auth status for profile "${p}" after 4 failed checks`)
  })

  it("warns again at once when the failure changes", async () => {
    const p = nextProfile()
    authBehavior = "fail"
    await getClaudeAuthStatusAsync(p)
    await failAgain(p)
    authBehavior = "timeout"
    await failAgain(p)
    expect(warnings()).toHaveLength(3)
    expect(warnings()[2]).toContain("no answer within 90s, so the check was killed")
  })

  it("counts timeouts as the same failure however long each run took", async () => {
    const p = nextProfile()
    let now = Date.parse("2026-01-01T00:00:00Z")
    setSystemTime(new Date(now))
    authBehavior = "hang"
    for (const runMs of [90_012, 90_377, 91_840]) {
      expireAuthStatusCache()
      void getClaudeAuthStatusAsync(p)
      await tick()
      now += runMs
      setSystemTime(new Date(now))
      killHungSpawns()
      await pendingAuthStatusRefresh(p)
    }
    expect(warnings()).toHaveLength(2)
  })

  it("says when the last known status is being served", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    authBehavior = "timeout"
    await failAgain(p)
    expect(warnings()[0]).toContain("serving the last known status")
  })

  it("reports the captured loggedIn answer when the callback error has no stdout, never private output", async () => {
    const p = nextProfile()
    authBehavior = "exit1"
    await getClaudeAuthStatusAsync(p)
    expect(warnings()[0]).toContain("exited with code 1 reporting loggedIn: false")
    expect(warnings().join("\n")).not.toContain("private@test.com")
    expect(warnings().join("\n")).not.toContain('"loggedIn":false')
    expect(warnings().join("\n")).not.toContain('"email"')
  })

  it("replaces a remembered login when the CLI explicitly reports logged out", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    const verifiedAt = getAuthCacheInfo(p).lastSuccessAt

    authBehavior = "exit1"
    await failAgain(p)

    expect((await getClaudeAuthStatusAsync(p))?.loggedIn).toBe(false)
    expect(getAuthCacheInfo(p).lastSuccessAt).toBe(verifiedAt)
    expect(getAuthCacheInfo(p).isFailure).toBe(false)
  })

  it("keeps an explicit logout when the following check times out", async () => {
    const p = nextProfile()
    await getClaudeAuthStatusAsync(p)
    authBehavior = "exit1"
    await failAgain(p)

    authBehavior = "timeout"
    await failAgain(p)

    expect((await getClaudeAuthStatusAsync(p))?.loggedIn).toBe(false)
  })

  it("reports a cold explicit logout rather than an unknown status", async () => {
    authBehavior = "exit1"

    const status = await getClaudeAuthStatusAsync(nextProfile())

    expect(status?.loggedIn).toBe(false)
  })

  for (const behavior of ["logout-killed", "logout-signal", "logout-truncated", "logout-exit2"] as const) {
    it(`preserves the previous login for an unavailable negative answer (${behavior})`, async () => {
      const p = nextProfile()
      await getClaudeAuthStatusAsync(p)
      const verifiedAt = getAuthCacheInfo(p).lastSuccessAt
      authBehavior = behavior
      await failAgain(p)
      expect((await getClaudeAuthStatusAsync(p))?.loggedIn).toBe(true)
      expect(getAuthCacheInfo(p).isFailure).toBe(true)
      expect(getAuthCacheInfo(p).lastSuccessAt).toBe(verifiedAt)
    })
  }

  it("does not advance the default account's successful-check time on logout", async () => {
    await getClaudeAuthStatusAsync()
    const verifiedAt = getAuthCacheInfo().lastSuccessAt
    setSystemTime(verifiedAt + 60_000)
    authBehavior = "exit1"
    expireAuthStatusCache()

    await getClaudeAuthStatusAsync()
    await pendingAuthStatusRefresh()

    expect((await getClaudeAuthStatusAsync())?.loggedIn).toBe(false)
    expect(getAuthCacheInfo().lastSuccessAt).toBe(verifiedAt)
  })

  it("reports a non-zero exit whose output is not JSON by its code alone", async () => {
    authBehavior = "exit2"
    await getClaudeAuthStatusAsync(nextProfile())
    expect(warnings()[0]).toContain("`claude auth status` exited with code 2 (1 in a row")
  })

  it("notes a first answer that outlived the caller's wait", async () => {
    setAuthStatusWaitMsForTesting(20)
    const p = nextProfile()
    authBehavior = "hang"
    expect(await getClaudeAuthStatusAsync(p)).toBeNull()
    expect(warnings()).toHaveLength(0)

    await new Promise(r => setTimeout(r, 30))
    releaseHungSpawns()
    await pendingAuthStatusRefresh(p)
    expect(warnings()).toHaveLength(1)
    expect(warnings()[0]).toContain(`Claude auth status for profile "${p}" took`)
    expect(warnings()[0]).toContain("it read as unverified until then")
  })

  it("stays quiet about a fast first answer", async () => {
    await getClaudeAuthStatusAsync(nextProfile())
    expect(warnings()).toHaveLength(0)
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
    await pendingAuthStatusRefresh(p)
    expect(execFileCalls).toBe(2)
  })

  it("picks up the rotated payload rather than the cached one", async () => {
    process.env.MERIDIAN_CREDENTIALS_READONLY = "1"
    const p = nextProfile()
    const overrides = { CLAUDE_CONFIG_DIR: dir }

    await getClaudeAuthStatusAsync(p, overrides)
    currentPayload = { loggedIn: true, email: "rotated@test.com", subscriptionType: "max" }

    ageCredentialFile()
    await getClaudeAuthStatusAsync(p, overrides)
    await pendingAuthStatusRefresh(p)
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

/**
 * The same property end to end: `/health` over the real auth-status cache.
 * Caddy probes it with a 2 s timeout, so a probe that waits on the spawn is a
 * proxy marked down.
 */
describe("/health with an expired auth-status cache", () => {
  beforeEach(() => {
    authBehavior = "success"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
  })

  afterEach(() => {
    releaseHungSpawns()
  })

  it("answers healthy from the previous status while the refresh is stalled", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: [{ id: "fixture-api", type: "api", apiKey: "owned-key" }], defaultProfile: "fixture-api" })
    const probe = async () => {
      const res = await app.fetch(new Request("http://localhost/health"))
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    }

    expect((await probe()).body.status).toBe("healthy")
    expireAuthStatusCache()
    authBehavior = "hang"

    const stalled = await settledWithin(probe(), 1_000)
    expect(stalled).not.toBe(NOT_SETTLED)
    if (stalled === NOT_SETTLED) return
    expect(stalled.status).toBe(200)
    expect(stalled.body.status).toBe("healthy")
    await tick()
    expect(hungSpawns).toHaveLength(1)
  })
})

/**
 * A fresh process whose first check is slower than any caller waits: what the
 * HTTP surfaces say while it runs, and that its answer is what they say next.
 */
describe("HTTP surfaces during a slow first auth check", () => {
  beforeEach(() => {
    authBehavior = "hang"
    execFileCalls = 0
    hungSpawns = []
    currentPayload = { loggedIn: true, email: "test@test.com", subscriptionType: "max" }
    resetCachedClaudeAuthStatus()
    setAuthStatusWaitMsForTesting(50)
  })

  afterEach(() => {
    releaseHungSpawns()
    setAuthStatusWaitMsForTesting()
  })

  it("/health answers degraded within the wait, then healthy once the check lands", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({ port: 0, host: "127.0.0.1", profiles: [{ id: "fixture-api", type: "api", apiKey: "owned-key" }], defaultProfile: "fixture-api" })
    const probe = async () => (await (await app.fetch(new Request("http://localhost/health"))).json() as { status: string }).status

    expect(await settledWithin(probe(), 1_000)).toBe("degraded")
    expect(hungSpawns).toHaveLength(1)

    releaseHungSpawns()
    await pendingAuthStatusRefresh("fixture-api")
    expect(await probe()).toBe("healthy")
    expect(execFileCalls).toBe(1)
  })

  it("/profiles/list reports the profile as never read, not logged out, until then", async () => {
    const { createProxyServer } = await import("../proxy/server")
    const { app } = createProxyServer({
      profiles: [{ id: "slow-first", type: "api", apiKey: "fixture-key" }],
      defaultProfile: "slow-first",
      silent: true,
    })
    const listed = async () => {
      const body = await (await app.fetch(new Request("http://localhost/profiles/list"))).json() as {
        profiles: Array<{ loggedIn: boolean; authProvenance: string }>
      }
      return body.profiles[0]!
    }

    expect(await listed()).toMatchObject({ loggedIn: false, authProvenance: "never" })

    releaseHungSpawns()
    await pendingAuthStatusRefresh("slow-first")
    expect(await listed()).toMatchObject({ loggedIn: true, authProvenance: "live" })
  })
})


describe('auth refresh owns the actual asynchronous resolver path', () => {
  beforeEach(() => {
    delete process.env.MERIDIAN_CLAUDE_PATH
    resetCachedClaudePath(); resetCachedClaudeAuthStatus()
    resolverChildren = []; resolverLookups = 0; resolverVersions = 0; resolverVersionOptions = []; execFileCalls = 0
    authBehavior = 'success'
    setAuthStatusWaitMsForTesting(10)
  })
  afterEach(async () => {
    for (const fixture of resolverChildren) {
      fixture.callback(null, { stdout: '', stderr: '' }); fixture.witnesses()
    }
    await tick()
    process.env.MERIDIAN_CLAUDE_PATH = ownedExecutable
    resetCachedClaudePath(); resetCachedClaudeAuthStatus(); setAuthStatusWaitMsForTesting()
  })
  const owners = async () => (await import('../proxy/authStatusOwnership')).createAuthStatusOwner
  const finishLookup = async () => {
    resolverChildren[0]!.callback(null, { stdout: ownedExecutable + '\n', stderr: '' })
    resolverChildren[0]!.witnesses(); await tick()
  }
  const finishVersion = async () => {
    resolverChildren[1]!.callback(null, { stdout: '2.1.999 (Claude Code)', stderr: '' })
    resolverChildren[1]!.witnesses(); await tick()
  }
  it('keeps the shared 45-second PATH budget for an instance-owned version probe', async () => {
    let now = 0
    const clock = spyOn(performance, 'now').mockImplementation(() => now)
    const owner = (await owners())()
    const profile = nextProfile()
    try {
      const answer = owner.run(() => getClaudeAuthStatusAsync(profile))
      await tick()
      now = 2000
      await finishLookup()
      expect(resolverVersionOptions).toHaveLength(1)
      expect(resolverVersionOptions[0]!.timeout).toBe(43_000)
      await finishVersion()
      await answer
      expect(await getClaudeAuthStatusAsync(profile)).toMatchObject({ loggedIn: true })
      expect(execFileCalls).toBe(1)
      expect(execFileOptions?.timeout).toBe(90_000)
      await owner.close()
      expect(resolverChildren.flatMap(child => child.signals)).toEqual([])
    } finally {
      clock.mockRestore()
    }
  })
  it('closing before resolver admission prevents even the first lookup', async () => {
    const owner = (await owners())(); const profile = nextProfile()
    const answer = owner.run(() => getClaudeAuthStatusAsync(profile))
    await owner.close(); await answer; await tick()
    expect(resolverLookups).toBe(0); expect(resolverVersions).toBe(0); expect(execFileCalls).toBe(0)
    expect(pendingAuthStatusRefresh(profile)).toBeNull()
  })
  it('last owner cancels a pending PATH child and cannot spawn a late version/auth process', async () => {
    const owner = (await owners())(); const profile = nextProfile()
    const answer = owner.run(() => getClaudeAuthStatusAsync(profile)); await tick()
    expect(resolverLookups).toBe(1)
    const closing = owner.close(); await tick()
    expect(resolverChildren[0]!.signals).toEqual(['SIGTERM'])
    resolverChildren[0]!.callback(null, { stdout: ownedExecutable, stderr: '' })
    let closed = false; void closing.then(() => { closed = true })
    await tick(); expect(closed).toBe(false)
    resolverChildren[0]!.witnesses(); await closing; await answer; await tick()
    expect(resolverVersions).toBe(0); expect(execFileCalls).toBe(0)
    expect(pendingAuthStatusRefresh(profile)).toBeNull()
  })
  it('version callback alone does not join the resolver; late witnesses close without auth spawn', async () => {
    const owner = (await owners())(); const profile = nextProfile()
    const answer = owner.run(() => getClaudeAuthStatusAsync(profile)); await tick(); await finishLookup()
    expect(resolverVersions).toBe(1)
    const closing = owner.close(); await tick()
    resolverChildren[1]!.callback(null, { stdout: '2.1.999 (Claude Code)', stderr: '' })
    let closed = false; void closing.then(() => { closed = true })
    await tick(); expect(closed).toBe(false); expect(execFileCalls).toBe(0)
    resolverChildren[1]!.witnesses(); await closing; await answer
    expect(execFileCalls).toBe(0)
  })
  it('a distinct profile owner retains the shared resolver while its sibling closes', async () => {
    const create = await owners(); const first = create(); const second = create()
    const a = first.run(() => getClaudeAuthStatusAsync(nextProfile()))
    const b = second.run(() => getClaudeAuthStatusAsync(nextProfile()))
    await tick(); await first.close()
    expect(resolverChildren[0]!.signals).toEqual([]); expect(resolverLookups).toBe(1)
    await finishLookup(); await finishVersion(); await a; await b
    expect(execFileCalls).toBe(1); await second.close()
  })
  it('a direct resolver caller keeps lookup/version custody after the last auth owner closes', async () => {
    const owner = (await owners())()
    const answer = owner.run(() => getClaudeAuthStatusAsync(nextProfile()))
    const direct = resolveClaudeExecutableAsync(); await tick(); await owner.close()
    expect(resolverChildren[0]!.signals).toEqual([])
    await finishLookup(); await finishVersion()
    expect(await direct).toBe(ownedExecutable); await answer
    expect(execFileCalls).toBe(0)
  })
  it('missing resolver close rejects shutdown and retains the shared slot until actual late join', async () => {
    const owner = (await owners())(); const profile = nextProfile()
    const answer = owner.run(() => getClaudeAuthStatusAsync(profile)); await tick()
    const closing = owner.close()
    await expect(closing).rejects.toThrow('cleanup is unconfirmed')
    await answer
    expect(resolverChildren[0]!.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(pendingAuthStatusRefresh(profile)).not.toBeNull()
    const direct = resolveClaudeExecutableAsync(); void direct.catch(() => undefined)
    await expect(direct).rejects.toThrow('cleanup is unconfirmed')
    expect(resolverLookups).toBe(1); expect(resolverVersions).toBe(0); expect(execFileCalls).toBe(0)
    resolverChildren[0]!.callback(null, { stdout: ownedExecutable, stderr: '' }); resolverChildren[0]!.witnesses()
    await tick(); expect(pendingAuthStatusRefresh(profile)).toBeNull()
  })
  it('a preference change cannot bypass an older resolver with unconfirmed custody', async () => {
    const { getSetting, setSetting } = await import('../settings')
    const saved = getSetting('claudeExecutable')
    const owner = (await owners())()
    const answer = owner.run(() => getClaudeAuthStatusAsync(nextProfile())); await tick()
    try {
      await expect(owner.close()).rejects.toThrow('cleanup is unconfirmed')
      await answer
      setSetting('claudeExecutable', 'bundled')
      await expect(resolveClaudeExecutableAsync()).rejects.toThrow('cleanup is unconfirmed')
      expect(resolverLookups).toBe(1); expect(resolverVersions).toBe(0)
    } finally { setSetting('claudeExecutable', saved) }
  })
  it('settings retain a failed version slot and bounded shutdown until real pipe witnesses arrive', async () => {
    const { readClaudeVersion } = await import('../proxy/models')
    const { createClaudeProbeOwner } = await import('../proxy/claudeProbeOwnership')
    const owner = createClaudeProbeOwner()
    const pending = owner.run(new AbortController().signal, () => readClaudeVersion(ownedExecutable, 10))
    void pending.catch(() => undefined)
    await expect(pending).rejects.toThrow('cleanup is unconfirmed')
    expect(resolverVersions).toBe(1)
    await expect(owner.close()).rejects.toThrow('cleanup is unconfirmed')
    await expect(owner.close()).rejects.toThrow('cleanup is unconfirmed')
    await expect(readClaudeVersion(ownedExecutable, 10)).rejects.toThrow('cleanup is unconfirmed')
    expect(resolverVersions).toBe(1)
    resolverChildren[0]!.callback(null, { stdout: '2.1.999 (Claude Code)', stderr: '' })
    resolverChildren[0]!.witnesses(); await tick()
  })
})
