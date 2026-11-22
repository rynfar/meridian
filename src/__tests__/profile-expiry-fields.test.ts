/**
 * Credentialless HTTP gate for the four profile-expiry fields on
 * GET /profiles/list. Credential stores and native/SDK/network boundaries are
 * injected; this does not prove real Keychain, file-store, provider or client
 * operation.
 */
import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, mock, spyOn } from "bun:test"
import type { ClaudeAuthStatus } from "../proxy/models"
import type { ProfileConfig } from "../proxy/profiles"
import type { CredentialStore, CredentialsFile } from "../proxy/tokenRefresh"

const selfPath = fileURLToPath(import.meta.url)
const scenarios = [
  "stores",
  "isolation",
  "presence",
  "timestamps",
  "warning",
  "replacement",
  "single-snapshot",
  "provenance",
] as const
type Scenario = (typeof scenarios)[number]

function isScenario(value: string | undefined): value is Scenario {
  return typeof value === "string" && (scenarios as readonly string[]).includes(value)
}

interface WorkerSummary {
  result: string
  scenario: Scenario
  requests: number
  assertions: number
  nativeCalls: number
  sdkCalls: number
  networkCalls: number
  storeReads: number
  backend: string
  actualNative: boolean
  actualProvider: boolean
}

interface StoreState {
  value: CredentialsFile | null
  reads: number
  throws: boolean
  reader?: (count: number) => CredentialsFile | null
  store: CredentialStore
}

interface CacheState {
  lastCheckedAt: number
  lastSuccessAt: number
  isFailure: boolean
}

interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>
}

const arg = process.argv[2]

if (!isScenario(arg)) {
  it("the four profile expiry fields preserve HTTP identity, auth and credential boundaries", async () => {
    const controls: Array<{ scenario: Scenario; exit: number; result?: WorkerSummary }> = []
    for (const name of scenarios) {
      const child = Bun.spawn([process.execPath, selfPath, name], {
        env: { ...process.env }, stdout: "pipe", stderr: "pipe",
      })
      const timer = setTimeout(() => child.kill(), 20_000)
      try {
        const [stdout, stderr, exit] = await Promise.all([
          new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
        ])
        expect({ scenario: name, exit, stderr }).toEqual({ scenario: name, exit: 0, stderr: "" })
        const result = JSON.parse(stdout) as WorkerSummary
        controls.push({ scenario: name, exit, result })
      } finally {
        clearTimeout(timer)
      }
    }
    expect(controls).toHaveLength(8)
    const assertions = controls.reduce((total, control) => total + (control.result?.assertions ?? 0), 0)
    expect(assertions).toBeGreaterThan(100)
    expect(
      controls.every(
        control =>
          control.exit === 0
          && control.result?.result === "PASS"
          && control.result.actualNative === false
          && control.result.actualProvider === false
          && control.result.nativeCalls === 0
          && control.result.sdkCalls === 0
          && control.result.networkCalls === 0,
      ),
    ).toBe(true)
  }, 40_000)
} else {
  const scenario: Scenario = arg
  const root = mkdtempSync(join(tmpdir(), "meridian-profile-expiry-"))
  const originalFetch = globalThis.fetch
  const restores: Array<() => void> = []
  let assertions = 0
  let requests = 0
  let nativeCalls = 0
  let sdkCalls = 0
  let networkCalls = 0
  const check = (condition: unknown, message: string) => { assertions++; assert(condition, message) }
  const equal = (actual: unknown, expected: unknown, message: string) => { assertions++; assert.deepEqual(actual, expected, message) }
  try {
    for (const key of Object.keys(process.env)) {
      if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_)/.test(key)) delete process.env[key]
    }
    Object.assign(process.env, {
      MERIDIAN_CONFIG_DIR: join(root, "config"),
      MERIDIAN_SESSION_DIR: join(root, "sessions"),
      MERIDIAN_TELEMETRY_PERSIST: "0",
      MERIDIAN_NO_UPDATE_CHECK: "1",
      MERIDIAN_CREDENTIALS_READONLY: "1",
    })
    const refuseNative = () => { nativeCalls++; throw new Error("Unexpected native command in mock-store HTTP gate") }
    mock.module("node:child_process", () => ({
      ...childProcess,
      exec: refuseNative,
      execSync: refuseNative,
      execFile: refuseNative,
      execFileSync: refuseNative,
      fork: refuseNative,
      spawn: refuseNative,
      spawnSync: refuseNative,
    }))
    globalThis.fetch = Object.assign(
      (): Promise<Response> => { networkCalls++; throw new Error("Unexpected external request in mock-store HTTP gate") },
      { preconnect: originalFetch.preconnect },
    )
    // Source build provenance normally probes git during import. That unrelated
    // boundary is a fixed fixture here so the native-command trap stays strict.
    mock.module("../proxy/buildRuntime", () => ({
      buildRuntime: { local: false, info: () => ({ version: "synthetic", source: "npm" }), status: () => ({ state: "unknown" }) },
    }))
    const { setLoggerMock } = await import("./loggerMock")
    setLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_context: unknown, fn: () => unknown) => fn() }))
    const { setSdkMock } = await import("./sdkMock")
    setSdkMock(() => ({
      query: () => { sdkCalls++; throw new Error("Profile metadata must not query a model") },
      createSdkMcpServer: () => ({}),
      tool: () => ({}),
    }), "profile-expiry-fields-gate")
    const models = await import("../proxy/models")
    const tokens = await import("../proxy/tokenRefresh")
    const organizations = await import("../proxy/organizationName")
    const clock = Date.UTC(2026, 9, 4, 12)
    const DAY = 86_400_000
    const HOUR = 3_600_000
    const clockSpy = spyOn(Date, "now").mockReturnValue(clock)
    restores.push(() => clockSpy.mockRestore())
    const statusById = new Map<string, ClaudeAuthStatus | null>()
    const cacheById = new Map<string, CacheState>()
    const stores = new Map<string, StoreState>()
    const requestedStores: string[] = []
    const authSpy = spyOn(models, "getClaudeAuthStatusAsync").mockImplementation(async (id?: string) =>
      statusById.has(id ?? "default") ? statusById.get(id ?? "default") ?? null : { loggedIn: true })
    const cacheSpy = spyOn(models, "getAuthCacheInfo").mockImplementation((id?: string) =>
      cacheById.get(id ?? "default") ?? { lastCheckedAt: clock - 1000, lastSuccessAt: clock - 1000, isFailure: false })
    const storeSpy = spyOn(tokens, "createPlatformCredentialStore").mockImplementation(options => {
      const dir = options?.claudeConfigDir ?? "default"
      requestedStores.push(dir)
      const registered = stores.get(dir)
      check(Boolean(registered), "Profile selected an unregistered credential store")
      return registered!.store
    })
    const organizationSpy = spyOn(organizations, "refreshOrganizationNameSoon").mockImplementation(() => {})
    restores.push(
      () => authSpy.mockRestore(),
      () => cacheSpy.mockRestore(),
      () => storeSpy.mockRestore(),
      () => organizationSpy.mockRestore(),
    )
    const { createProxyServer } = await import("../proxy/server")
    const { resetActiveProfile } = await import("../proxy/profiles")
    const expiryFields = ["refreshTokenExpiresAt", "daysUntilRenewal", "renewalRequiredSoon", "accessTokenExpiresAt"] as const
    const historyFields = ["authObtainedAt", "authObtainedVia", "lastRefreshAt", "firstUnauthedAt", "unauthedReason"] as const
    // Duplicate-account and post-sign-in status, reported for every profile
    // (owner-approved 2026-10-26, #1446; see the API contract).
    const statusFields = ["duplicateOf", "duplicateBasis", "factsRefresh"] as const
    const baseFields = [
      "id", "type", "isActive", "email", "subscriptionType", "organizationName", "rateLimitTier",
      "seatTier", "allowance", "allowanceWeight", "planLabel", "accountType", "planName", "loggedIn",
      "lastCheckedAt", "lastSuccessAt", "authProvenance", "credentialDir",
    ]
    const credential = (
      deadline: unknown = clock + 2 * DAY,
      accessExpiry: unknown = clock + HOUR,
      accessToken = "synthetic-access",
    ): CredentialsFile => {
      const file: CredentialsFile = {
        claudeAiOauth: {
          accessToken,
          refreshToken: "synthetic-refresh",
          expiresAt: clock + HOUR,
          subscriptionType: "max",
          rateLimitTier: "default_claude_max_20x",
        },
      }
      if (accessExpiry === undefined) Reflect.deleteProperty(file.claudeAiOauth, "expiresAt")
      else Reflect.set(file.claudeAiOauth, "expiresAt", accessExpiry)
      if (deadline !== undefined) Reflect.set(file.claudeAiOauth, "refreshTokenExpiresAt", deadline)
      return file
    }
    const emptyCredentialsObject = (): CredentialsFile => {
      const file = credential()
      Reflect.deleteProperty(file, "claudeAiOauth")
      return file
    }
    const fixture = (name: string, value: CredentialsFile | null = credential()) => {
      const dir = name === "default" ? "default" : join(root, name)
      const state: StoreState = {
        value,
        reads: 0,
        throws: false,
        reader: undefined,
        store: {
          refreshKey: `mock-store:${dir}`,
          read: async () => {
            state.reads++
            if (state.throws) throw new Error("Synthetic store unavailable")
            return state.reader ? state.reader(state.reads) : state.value
          },
          write: async () => { throw new Error("Profile metadata must not write credentials") },
        },
      }
      stores.set(dir, state)
      return { dir, state }
    }
    const profile = (id: string, dir: string, extras: Partial<ProfileConfig> = {}): ProfileConfig => ({
      id,
      type: "claude-max",
      ...(dir !== "default" ? { claudeConfigDir: dir } : {}),
      ...extras,
    })
    const open = (profiles: ProfileConfig[]): FetchApp => {
      resetActiveProfile()
      return createProxyServer({ profiles, defaultProfile: profiles[0]!.id, silent: true }).app
    }
    const list = async (app: FetchApp, profiles: ProfileConfig[]): Promise<Array<Record<string, unknown>>> => {
      requests++
      const response = await app.fetch(new Request("http://localhost/profiles/list"))
      equal(response.status, 200, "Profile list route failed")
      const raw = await response.text()
      check(!/synthetic-access|synthetic-refresh/.test(raw), "Profile response leaked credential values")
      const body = JSON.parse(raw) as { profiles: Array<Record<string, unknown>>; activeProfile: string }
      equal(body.profiles.map(item => item.id), profiles.map(item => item.id), "Profile identity/order changed")
      equal(body.activeProfile, profiles[0]!.id, "Active profile identity changed")
      for (let i = 0; i < profiles.length; i++) {
        const item = body.profiles[i]!
        const input = profiles[i]!
        for (const field of expiryFields) check(Object.hasOwn(item, field), `Four-field expiry contract missing ${field}`)
        for (const field of historyFields) check(!Object.hasOwn(item, field), `Unapproved history field ${field} appeared`)
        equal(
          Object.keys(item).sort(),
          [...baseFields, ...expiryFields, ...statusFields, ...(input.aliases ? ["aliases"] : [])].sort(),
          "Profile response changed fields beyond the approved expiry (four) and #1446 duplicate/factsRefresh (three) additions",
        )
        equal(item.type, input.type ?? "claude-max", "Existing profile type changed")
        equal(item.isActive, i === 0, "Existing active-profile flag changed")
        if (input.aliases) equal(item.aliases, input.aliases, "Existing aliases changed")
      }
      check(!existsSync(join(root, "config", "auth-lifecycle.json")), "Profile polling persisted unapproved lifetime history")
      return body.profiles
    }
    const facts = (item: Record<string, unknown>, deadline: unknown, accessExpiry: unknown, warnDays = 3) => {
      const known = typeof deadline === "number" && Number.isFinite(deadline) && deadline > 0 && deadline <= 8.64e15
      const accessKnown = typeof accessExpiry === "number" && Number.isFinite(accessExpiry) && accessExpiry > 0 && accessExpiry <= 8.64e15
      // JSON serializes the ceil of a sub-day past expiry (-0) as ordinary 0.
      const rounded = known ? Math.ceil((deadline - clock) / DAY) : null
      const days = Object.is(rounded, -0) ? 0 : rounded
      equal(
        expiryFields.map(field => item[field]),
        [known ? deadline : null, days, Boolean(known && days !== null && days <= warnDays), accessKnown ? accessExpiry : null],
        "Current stored expiry facts were not reported together",
      )
    }

    if (scenario === "stores") {
      const own = fixture("own", credential(clock + 9 * DAY, clock + HOUR))
      const shared = fixture("shared", credential(clock + 2 * DAY, clock + 2 * HOUR))
      const defaultStore = fixture("default", credential(clock + 5 * DAY, clock + 3 * HOUR))
      const profiles = [
        profile("own", own.dir, { aliases: ["former-own"] }),
        profile("shared-a", shared.dir),
        profile("shared-b", shared.dir),
        profile("default", defaultStore.dir),
      ]
      // Build the server first: construction reads the clock too, and only the
      // listing's own reads should see the advancing clock.
      const app = open(profiles)
      let nowCalls = 0
      clockSpy.mockImplementation(() => (nowCalls++ === 0 ? clock : clock + 10 * DAY))
      const items = await list(app, profiles)
      clockSpy.mockReturnValue(clock)
      check(nowCalls > 1, "Multiple-profile listing did not advance the synthetic clock after capturing response time")
      facts(items[0]!, clock + 9 * DAY, clock + HOUR)
      facts(items[1]!, clock + 2 * DAY, clock + 2 * HOUR)
      facts(items[2]!, clock + 2 * DAY, clock + 2 * HOUR)
      facts(items[3]!, clock + 5 * DAY, clock + 3 * HOUR)
      equal(requestedStores, [own.dir, shared.dir, shared.dir, "default"], "Profiles did not resolve their own/shared/default store")
      for (const item of items) equal([item.loggedIn, item.authProvenance], [true, "live"], "Expiry metadata changed existing authentication")
      equal(items.map(item => item.credentialDir), [own.dir, shared.dir, shared.dir, null], "Credential-sharing identity changed")
    } else if (scenario === "isolation") {
      const profiles: ProfileConfig[] = [
        { id: "api", type: "api", apiKey: "synthetic-api-key" },
        { id: "setup", type: "oauth-token", oauthToken: "synthetic-setup-token" },
        { id: "inferred-setup", oauthToken: "synthetic-setup-token" },
      ]
      const items = await list(open(profiles), profiles)
      for (const item of items) {
        facts(item, undefined, undefined)
        equal(item.loggedIn, true, "Unrelated stored grant demoted supplied credentials")
        equal(item.credentialDir, null, "Supplied credential became shareable native state")
      }
      equal(requestedStores, [], "API/setup-token metadata accessed a native credential store")
      statusById.set("api", { loggedIn: false })
      const second = await list(open(profiles), profiles)
      equal(second[0]!.loggedIn, false, "Absent expiry facts made an unauthenticated API profile healthy")
      equal(requestedStores, [], "API/setup-token negative control accessed a native store")
    } else if (scenario === "presence") {
      const cases: Array<[string, CredentialsFile | null, boolean, boolean]> = [
        ["null", null, false, true],
        ["throws", null, true, true],
        ["empty", { claudeAiOauth: { accessToken: "", refreshToken: "synthetic-refresh", expiresAt: 0 } }, false, false],
        ["no-oauth", emptyCredentialsObject(), false, false],
      ]
      for (const [name, value, throws, expected] of cases) {
        const { dir, state } = fixture(name, value)
        state.throws = throws
        const profiles = [profile(name, dir)]
        const [item] = await list(open(profiles), profiles)
        equal(item!.loggedIn, expected, "Unknown stored state was confused with a successfully empty credential")
        equal(item!.authProvenance, "live", "Store observation changed auth-status provenance")
        facts(item!, undefined, undefined)
      }
    } else if (scenario === "timestamps") {
      const { dir, state } = fixture("timestamps")
      const profiles = [profile("timestamps", dir)]
      const app = open(profiles)
      for (const value of [
        undefined, null, "1791115200000", NaN, Infinity, -Infinity, 1e100, 8.64e15 + 1, 0, -1,
        clock - HOUR, clock + HOUR, clock + HOUR + 0.25, 8.64e15,
      ]) {
        state.value = credential(value, value)
        if (value === undefined) {
          Reflect.deleteProperty(state.value.claudeAiOauth, "refreshTokenExpiresAt")
          Reflect.deleteProperty(state.value.claudeAiOauth, "expiresAt")
        }
        const [item] = await list(app, profiles)
        facts(item!, value, value)
        equal(item!.loggedIn, true, "Timestamp metadata changed usable-token presence")
        equal(item!.authProvenance, "live", "Timestamp metadata changed auth provenance")
      }
    } else if (scenario === "warning") {
      const { dir, state } = fixture("warning")
      const profiles = [profile("warning", dir)]
      const app = open(profiles)
      const cases: Array<[number, number]> = [
        [3, 3], [3 + 1 / DAY, 3], [2.5, 2.5], [2, 2.5], [0.5, 0],
        [0, 0], [-0.5, 0], [-1, 0], [1, 1.5], [1.5, 1.5],
      ]
      for (const [days, warnDays] of cases) {
        process.env.MERIDIAN_AUTH_RENEWAL_WARN_DAYS = String(warnDays)
        state.value = credential(clock + days * DAY, clock + HOUR)
        const [item] = await list(app, profiles)
        facts(item!, clock + days * DAY, clock + HOUR, warnDays)
        equal(item!.loggedIn, true, "Expired renewal metadata marked a serving account logged out")
      }
    } else if (scenario === "replacement") {
      const { dir, state } = fixture("replacement", credential(clock + 29 * DAY))
      const profiles = [profile("stable", dir, { aliases: ["stable-old-name"] })]
      const app = open(profiles)
      for (const days of [29, 28, 28, 30, undefined] as const) {
        state.value = credential(days === undefined ? undefined : clock + days * DAY, clock + 2 * HOUR)
        if (days === undefined) Reflect.deleteProperty(state.value.claudeAiOauth, "refreshTokenExpiresAt")
        const [item] = await list(app, profiles)
        facts(item!, days === undefined ? undefined : clock + days * DAY, clock + 2 * HOUR)
        equal(
          [item!.loggedIn, item!.authProvenance, item!.credentialDir],
          [true, "live", dir],
          "Credential replacement changed authentication or stable profile identity",
        )
      }
    } else if (scenario === "single-snapshot") {
      const { dir, state } = fixture("snapshot", credential(clock + 29 * DAY))
      const profiles = [profile("snapshot", dir)]
      await tokens.getStoredPlanFields(state.store)
      state.reads = 0
      state.reader = count =>
        count === 1
          ? credential(clock + 2 * DAY, clock + HOUR)
          : credential(clock + 30 * DAY, clock + 2 * HOUR, "")
      const [item] = await list(open(profiles), profiles)
      equal(state.reads, 1, "Presence and the two expiries were read from different stored snapshots")
      facts(item!, clock + 2 * DAY, clock + HOUR)
      equal(item!.loggedIn, true, "A second store read demoted the first available snapshot")
    } else if (scenario === "provenance") {
      const cases: Array<[string, ClaudeAuthStatus | null, CacheState, boolean, string]> = [
        ["live-out", { loggedIn: false }, { lastCheckedAt: clock, lastSuccessAt: 0, isFailure: false }, false, "live"],
        ["cached", { loggedIn: true }, { lastCheckedAt: clock, lastSuccessAt: clock - HOUR, isFailure: true }, true, "cached"],
        ["never", null, { lastCheckedAt: clock, lastSuccessAt: 0, isFailure: true }, false, "never"],
      ]
      for (const [name, auth, cache, loggedIn, provenance] of cases) {
        const { dir } = fixture(name, credential(clock - HOUR, clock + HOUR))
        statusById.set(name, auth)
        cacheById.set(name, cache)
        const profiles = [profile(name, dir)]
        const [item] = await list(open(profiles), profiles)
        equal([item!.loggedIn, item!.authProvenance], [loggedIn, provenance], "Expiry fields replaced existing auth evidence")
        equal(
          [item!.lastCheckedAt, item!.lastSuccessAt],
          [cache.lastCheckedAt, cache.lastSuccessAt || null],
          "Existing auth check timestamps changed",
        )
        facts(item!, clock - HOUR, clock + HOUR)
      }
    }
    equal(nativeCalls, 0, "Mock-store HTTP gate executed a native command")
    equal(sdkCalls, 0, "Profile metadata reached the SDK/model")
    equal(networkCalls, 0, "Mock-store HTTP gate made an external request")
    console.log(JSON.stringify({
      result: "PASS",
      scenario,
      requests,
      assertions,
      nativeCalls,
      sdkCalls,
      networkCalls,
      storeReads: [...stores.values()].reduce((total, state) => total + state.reads, 0),
      backend: "mock-store",
      actualNative: false,
      actualProvider: false,
    }))
  } finally {
    for (const restore of restores.reverse()) restore()
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}
