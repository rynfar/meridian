/**
 * MERIDIAN_CREDENTIALS_READONLY — a second instance running beside a
 * production one against the SAME credential files must never be able to
 * corrupt them.
 *
 * Every test injects its own credential store or a throwaway config dir.
 * Nothing here may touch the developer's real ~/.claude credentials: the
 * no-argument forms of refreshOAuthToken/ensureFreshToken/startBackgroundRefresh
 * resolve the REAL platform store and would refresh live tokens, so they are
 * never called without an explicit store.
 *
 * Credential values throughout are fabricated placeholders.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  isCredentialsReadOnly,
  logCredentialsModeBanner,
  resetCredentialsModeBanner,
} from "../proxy/credentialsMode"
import {
  createPlatformCredentialStore,
  ensureFreshToken,
  isBackgroundRefreshActive,
  refreshOAuthToken,
  resetInflightRefresh,
  startBackgroundRefresh,
  stopBackgroundRefresh,
  type CredentialStore,
} from "../proxy/tokenRefresh"
import { createFileDesignTokenStore } from "../proxy/design"

const FLAG = "MERIDIAN_CREDENTIALS_READONLY"

const FAKE_CREDENTIALS = {
  claudeAiOauth: {
    accessToken: "placeholder-access-token",
    refreshToken: "placeholder-refresh-token",
    expiresAt: Date.now() + 60 * 60 * 1000,
  },
}

function tempDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `meridian-readonly-${label}-`))
}

/** Capture console.error/warn so the loud refusal can be asserted on. */
function captureConsole() {
  const originalError = console.error
  const originalWarn = console.warn
  const errors: string[] = []
  const warns: string[] = []
  console.error = (...args: unknown[]) => { errors.push(args.join(" ")) }
  console.warn = (...args: unknown[]) => { warns.push(args.join(" ")) }
  return {
    errors,
    warns,
    restore() { console.error = originalError; console.warn = originalWarn },
  }
}

describe("isCredentialsReadOnly", () => {
  afterEach(() => {
    delete process.env[FLAG]
    delete process.env.CLAUDE_PROXY_CREDENTIALS_READONLY
  })

  it("is off when the variable is unset", () => {
    expect(isCredentialsReadOnly()).toBe(false)
  })

  it("is on for the documented truthy spellings", () => {
    for (const value of ["1", "true", "yes"]) {
      process.env[FLAG] = value
      expect(isCredentialsReadOnly()).toBe(true)
    }
  })

  it("is off for falsy and unrecognized values", () => {
    for (const value of ["0", "false", "no", "", "maybe"]) {
      process.env[FLAG] = value
      expect(isCredentialsReadOnly()).toBe(false)
    }
  })

  it("honours the legacy CLAUDE_PROXY_ alias like every other MERIDIAN_ var", () => {
    process.env.CLAUDE_PROXY_CREDENTIALS_READONLY = "1"
    expect(isCredentialsReadOnly()).toBe(true)
  })
})

describe("credential store write refusal", () => {
  let dir: string

  beforeEach(() => { dir = tempDir("store") })

  afterEach(() => {
    delete process.env[FLAG]
    rmSync(dir, { recursive: true, force: true })
  })

  it("refuses the write, leaves the file untouched, and logs loudly", async () => {
    const file = join(dir, ".credentials.json")
    const onDisk = JSON.stringify(FAKE_CREDENTIALS)
    writeFileSync(file, onDisk)

    process.env[FLAG] = "1"
    const store = createPlatformCredentialStore({ claudeConfigDir: dir })
    const cap = captureConsole()
    let written: boolean
    try {
      written = await store.write({
        claudeAiOauth: { ...FAKE_CREDENTIALS.claudeAiOauth, accessToken: "replacement-token" },
      })
    } finally {
      cap.restore()
    }

    expect(written).toBe(false)
    expect(readFileSync(file, "utf-8")).toBe(onDisk)
    expect(cap.errors.length).toBe(1)
    expect(cap.errors[0]).toContain("REFUSED credential write")
    expect(cap.errors[0]).toContain(FLAG)
  })

  it("never names a credential value in the refusal", async () => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify(FAKE_CREDENTIALS))
    process.env[FLAG] = "1"
    const store = createPlatformCredentialStore({ claudeConfigDir: dir })
    const cap = captureConsole()
    try {
      await store.write(FAKE_CREDENTIALS)
    } finally {
      cap.restore()
    }

    const logged = cap.errors.join("\n")
    expect(logged).not.toContain(FAKE_CREDENTIALS.claudeAiOauth.accessToken)
    expect(logged).not.toContain(FAKE_CREDENTIALS.claudeAiOauth.refreshToken)
  })

  it("still reads — that is how a rotation by the other instance is picked up", async () => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify(FAKE_CREDENTIALS))
    process.env[FLAG] = "1"
    const store = createPlatformCredentialStore({ claudeConfigDir: dir })

    const read = await store.read()
    expect(read?.claudeAiOauth?.accessToken).toBe(FAKE_CREDENTIALS.claudeAiOauth.accessToken)
  })

  it("writes normally when the flag is absent", async () => {
    const file = join(dir, ".credentials.json")
    const store = createPlatformCredentialStore({ claudeConfigDir: dir })

    expect(await store.write(FAKE_CREDENTIALS)).toBe(true)
    expect(existsSync(file)).toBe(true)
  })
})

describe("refresh initiation", () => {
  let originalFetch: typeof globalThis.fetch
  let fetchCalls: number

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchCalls = 0
    globalThis.fetch = ((..._args: unknown[]): Promise<Response> => {
      fetchCalls++
      throw new Error("no test may reach Anthropic's OAuth endpoint")
    }) as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    delete process.env[FLAG]
    resetInflightRefresh()
    stopBackgroundRefresh()
  })

  function expiredStore(): CredentialStore {
    return {
      refreshKey: "file:/nonexistent/test-store",
      async read() {
        return { claudeAiOauth: { ...FAKE_CREDENTIALS.claudeAiOauth, expiresAt: Date.now() - 1000 } }
      },
      async write() { return true },
    }
  }

  it("refreshOAuthToken makes no network call at all", async () => {
    process.env[FLAG] = "1"
    const cap = captureConsole()
    let result: boolean
    try {
      result = await refreshOAuthToken(expiredStore())
    } finally {
      cap.restore()
    }

    expect(result).toBe(false)
    // The refusal must sit ABOVE the round trip: a refresh_token grant rotates
    // the token server-side, so merely calling the endpoint could invalidate
    // the copy the other instance is using.
    expect(fetchCalls).toBe(0)
    expect(cap.errors[0]).toContain("REFUSED credential write")
  })

  it("ensureFreshToken reports staleness instead of refreshing, and stays quiet", async () => {
    process.env[FLAG] = "1"
    const cap = captureConsole()
    let result: boolean
    try {
      result = await ensureFreshToken(expiredStore())
    } finally {
      cap.restore()
    }

    expect(result).toBe(false)
    expect(fetchCalls).toBe(0)
    // Runs before every SDK request — must not log per request.
    expect(cap.errors.length).toBe(0)
  })

  it("ensureFreshToken still confirms a token that is simply valid", async () => {
    process.env[FLAG] = "1"
    const store: CredentialStore = {
      refreshKey: "file:/nonexistent/test-store",
      async read() { return FAKE_CREDENTIALS },
      async write() { return true },
    }
    expect(await ensureFreshToken(store)).toBe(true)
    expect(fetchCalls).toBe(0)
  })

  it("startBackgroundRefresh does not arm the scheduler", () => {
    process.env[FLAG] = "1"
    startBackgroundRefresh(expiredStore())
    expect(isBackgroundRefreshActive()).toBe(false)
  })

  it("startBackgroundRefresh arms normally when the flag is absent", () => {
    const store: CredentialStore = {
      refreshKey: "file:/nonexistent/test-store",
      async read() { return FAKE_CREDENTIALS },
      async write() { return true },
    }
    startBackgroundRefresh(store)
    expect(isBackgroundRefreshActive()).toBe(true)
    stopBackgroundRefresh()
    expect(isBackgroundRefreshActive()).toBe(false)
  })
})

describe("design token store", () => {
  let dir: string

  beforeEach(() => { dir = tempDir("design") })

  afterEach(() => {
    delete process.env[FLAG]
    rmSync(dir, { recursive: true, force: true })
  })

  // defaultDesignTokenPath() ignores MERIDIAN_CONFIG_DIR, so a second instance
  // writes the FIRST instance's design token however its config dir is set.
  it("refuses the write and leaves no file behind", async () => {
    const file = join(dir, "design-token.json")
    process.env[FLAG] = "1"
    const store = createFileDesignTokenStore(file)

    const cap = captureConsole()
    try {
      await store.write({ accessToken: "placeholder-design-token", expiresAt: Date.now() + 3600_000 })
    } finally {
      cap.restore()
    }

    expect(existsSync(file)).toBe(false)
    expect(cap.errors[0]).toContain("REFUSED credential write")
  })

  it("writes normally when the flag is absent", async () => {
    const file = join(dir, "design-token.json")
    const store = createFileDesignTokenStore(file)
    await store.write({ accessToken: "placeholder-design-token", expiresAt: Date.now() + 3600_000 })
    expect(existsSync(file)).toBe(true)
  })
})

describe("startup banner", () => {
  afterEach(() => {
    delete process.env[FLAG]
    resetCredentialsModeBanner()
  })

  it("announces the mode once", () => {
    process.env[FLAG] = "1"
    resetCredentialsModeBanner()
    const cap = captureConsole()
    try {
      logCredentialsModeBanner()
      logCredentialsModeBanner()
    } finally {
      cap.restore()
    }

    expect(cap.warns.length).toBe(1)
    expect(cap.warns[0]).toContain("CREDENTIALS READ-ONLY MODE")
    expect(cap.warns[0]).toContain(FLAG)
  })

  it("says nothing when the flag is absent", () => {
    resetCredentialsModeBanner()
    const cap = captureConsole()
    try {
      logCredentialsModeBanner()
    } finally {
      cap.restore()
    }
    expect(cap.warns.length).toBe(0)
  })
})

// The fourth gated behaviour — auth-status cache invalidation on credential
// mtime — is tested in models-auth-status.test.ts, which runs as its own
// `bun test` invocation. It has to: four files in the main run replace
// ../proxy/models via the globally-scoped mock.module, so the real cache is
// only observable in an isolated invocation.
