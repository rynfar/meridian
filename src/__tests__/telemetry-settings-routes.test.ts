/**
 * The telemetry settings API, and the precedence chain behind it.
 *
 * These settings are unlike every other one served from /settings: the stores
 * are built once at startup, so saving a value changes nothing until a
 * restart. The contract that matters is therefore not "the value round-trips"
 * but "the response distinguishes what was saved, what a start would use, and
 * what the running proxy is actually doing" — a UI that cannot tell those
 * apart is one that quietly claims a change already landed.
 */
import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

mock.module("../logger", () => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

const { createProxyServer } = await import("../proxy/server")
const { resolveTelemetryConfig } = await import("../telemetry")
const { setSetting, TELEMETRY_SETTING_LIMITS } = await import("../settings")

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

interface TelemetrySettingsResponse {
  saved: Record<string, unknown>
  wanted: { persist: boolean; retentionDays: number; telemetrySize: number; diagnosticLogSize: number; dbPath: string }
  effective: { kind: string; held: number; capacity?: number; diagnosticLogCapacity: number | null }
  envOverride: Record<string, boolean>
  pendingRestart: string[]
  supervision: { kind: string; restartCommand: string | null }
  limits: typeof TELEMETRY_SETTING_LIMITS
}

describe("telemetry settings routes", () => {
  let dir: string
  let app: TestApp
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    "MERIDIAN_TELEMETRY_PERSIST",
    "MERIDIAN_TELEMETRY_RETENTION_DAYS",
    "MERIDIAN_TELEMETRY_SIZE",
    "MERIDIAN_DIAGNOSTIC_LOG_SIZE",
    "MERIDIAN_TELEMETRY_DB",
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-telemetry-settings-"))
    savedEnv.MERIDIAN_CONFIG_DIR = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = dir
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    app = createProxyServer({ port: 0, host: "127.0.0.1" }).app
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async (): Promise<TelemetrySettingsResponse> => {
    const res = await app.fetch(new Request("http://localhost/settings/api/telemetry"))
    expect(res.status).toBe(200)
    return await res.json() as TelemetrySettingsResponse
  }
  const put = (body: unknown) =>
    app.fetch(new Request("http://localhost/settings/api/telemetry", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }))

  it("reports saved, wanted and effective separately", async () => {
    const body = await get()
    expect(body.saved.telemetryPersist).toBeNull()
    expect(body.wanted.persist).toBe(false)
    expect(body.effective.kind).toBe("memory")
    expect(body.pendingRestart).toEqual([])
  })

  it("names the key that needs a restart, and does not touch the running store", async () => {
    const before = await get()
    expect(before.effective.kind).toBe("memory")

    expect((await put({ telemetryPersist: true })).status).toBe(200)

    const after = await get()
    expect(after.saved.telemetryPersist).toBe(true)
    expect(after.wanted.persist).toBe(true)
    // The whole point: the intent changed, the running store did NOT.
    expect(after.effective.kind).toBe("memory")
    expect(after.pendingRestart).toContain("telemetryPersist")
  })

  it("says a restart is required in the PUT response itself", async () => {
    const res = await put({ telemetryRetentionDays: 30 })
    expect(res.status).toBe(200)
    const body = await res.json() as { success: boolean; restartRequired: boolean }
    expect(body.success).toBe(true)
    expect(body.restartRequired).toBe(true)
  })

  it("reports only the backend flip when the backend itself is pending", async () => {
    // Retention against a ring buffer's capacity compares two different things,
    // so a pending flip must not also claim the numbers disagree.
    await put({ telemetryPersist: true, telemetryRetentionDays: 90 })
    const body = await get()
    expect(body.pendingRestart).toEqual(["telemetryPersist"])
  })

  it("flags a ring size that no longer matches the running store", async () => {
    await put({ telemetrySize: 7777 })
    const body = await get()
    expect(body.wanted.telemetrySize).toBe(7777)
    expect(body.pendingRestart).toContain("telemetrySize")
  })

  it("clears a setting when sent null, returning to the default", async () => {
    await put({ telemetryRetentionDays: 90 })
    expect((await get()).saved.telemetryRetentionDays).toBe(90)

    await put({ telemetryRetentionDays: null })
    const body = await get()
    expect(body.saved.telemetryRetentionDays).toBeNull()
    expect(body.wanted.retentionDays).toBe(7)
  })

  it("rejects values outside the advertised limits, with the limits in the message", async () => {
    const tooBig = TELEMETRY_SETTING_LIMITS.telemetrySize.max + 1
    const res = await put({ telemetrySize: tooBig })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toContain(String(TELEMETRY_SETTING_LIMITS.telemetrySize.max))
  })

  it("rejects a non-integer size rather than silently truncating it", async () => {
    expect((await put({ telemetrySize: 100.5 })).status).toBe(400)
    expect((await put({ telemetrySize: "1000" })).status).toBe(400)
  })

  it("rejects a non-boolean persist flag", async () => {
    expect((await put({ telemetryPersist: "yes" })).status).toBe(400)
  })

  it("rejects malformed JSON", async () => {
    const res = await app.fetch(new Request("http://localhost/settings/api/telemetry", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: "{not json",
    }))
    expect(res.status).toBe(400)
  })

  it("advertises the same limits the validator enforces", async () => {
    const body = await get()
    expect(body.limits).toEqual(TELEMETRY_SETTING_LIMITS)
  })

  it("marks a setting an env var outranks, so the form can say the value is inert", async () => {
    setSetting("telemetryRetentionDays", 90)
    process.env.MERIDIAN_TELEMETRY_RETENTION_DAYS = "3"

    const body = await get()
    expect(body.saved.telemetryRetentionDays).toBe(90)
    expect(body.wanted.retentionDays).toBe(3)
    expect(body.envOverride.telemetryRetentionDays).toBe(true)
  })
})

describe("telemetry config precedence", () => {
  let dir: string
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-telemetry-precedence-"))
    savedEnv.MERIDIAN_CONFIG_DIR = process.env.MERIDIAN_CONFIG_DIR
    savedEnv.MERIDIAN_TELEMETRY_PERSIST = process.env.MERIDIAN_TELEMETRY_PERSIST
    savedEnv.MERIDIAN_TELEMETRY_SIZE = process.env.MERIDIAN_TELEMETRY_SIZE
    process.env.MERIDIAN_CONFIG_DIR = dir
    delete process.env.MERIDIAN_TELEMETRY_PERSIST
    delete process.env.MERIDIAN_TELEMETRY_SIZE
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it("falls back to the default when neither env nor a setting is present", () => {
    expect(resolveTelemetryConfig().persist).toBe(false)
    expect(resolveTelemetryConfig().telemetrySize).toBe(1000)
  })

  it("uses the saved setting when no env var is set", () => {
    setSetting("telemetryPersist", true)
    setSetting("telemetrySize", 250)
    expect(resolveTelemetryConfig().persist).toBe(true)
    expect(resolveTelemetryConfig().telemetrySize).toBe(250)
  })

  it("lets an explicit env var OFF beat a saved ON", () => {
    // The reason persist is not read with envBool: it cannot tell "unset" from
    // "=0", which would let a checkbox in a browser override an operator's
    // explicit MERIDIAN_TELEMETRY_PERSIST=0 in a unit file.
    setSetting("telemetryPersist", true)
    process.env.MERIDIAN_TELEMETRY_PERSIST = "0"
    expect(resolveTelemetryConfig().persist).toBe(false)
  })

  it("lets an env var beat a saved size", () => {
    setSetting("telemetrySize", 250)
    process.env.MERIDIAN_TELEMETRY_SIZE = "64"
    expect(resolveTelemetryConfig().telemetrySize).toBe(64)
  })

  it("puts the database inside MERIDIAN_CONFIG_DIR, not beside another instance's", () => {
    // Two instances given separate config dirs so they do not share state were
    // both handed ~/.config/meridian/telemetry.db, so one dashboard counted the
    // other's requests.
    expect(resolveTelemetryConfig().dbPath).toBe(join(dir, "telemetry.db"))
  })

  it("still lets MERIDIAN_TELEMETRY_DB name the file outright", () => {
    process.env.MERIDIAN_TELEMETRY_DB = "/tmp/explicitly-elsewhere.db"
    try {
      expect(resolveTelemetryConfig().dbPath).toBe("/tmp/explicitly-elsewhere.db")
    } finally {
      delete process.env.MERIDIAN_TELEMETRY_DB
    }
  })
})
