/**
 * The transcript retention settings API behind the /settings page.
 *
 * What the page relies on: retention is off until someone sets it, a save
 * round-trips through settings.json, an invalid value is refused without
 * touching what is saved, 0 or null turns it back off, and an env override is
 * reported so the form does not imply that a saved value applies when the
 * environment outranks it.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { createProxyServer } = await import("../proxy/server")
const { getSetting } = await import("../settings")
const { settingsPageHtml } = await import("../telemetry/settingsPage")

type TestApp = { fetch: (request: Request) => Response | Promise<Response> }

interface TranscriptSettingsResponse {
  saved: number | null
  effective: { days: number; source: string }
  envOverride: boolean
  envSources: { transcriptRetentionDays: { name: string; value: string | null; use: string } | null }
  default: number
  limits: { min: number; max: number }
}

const ENV_KEYS = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_TRANSCRIPT_RETENTION_DAYS", "CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS"]

describe("transcript retention settings routes", () => {
  let dir: string
  let app: TestApp
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-transcript-settings-"))
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = dir
    app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function get(): Promise<TranscriptSettingsResponse> {
    const response = await app.fetch(new Request("http://localhost/settings/api/transcripts"))
    expect(response.status).toBe(200)
    return await response.json() as TranscriptSettingsResponse
  }

  function put(body: unknown, headers: Record<string, string> = { "Content-Type": "application/json" }): Promise<Response> {
    return Promise.resolve(app.fetch(new Request("http://localhost/settings/api/transcripts", {
      method: "PUT",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })))
  }

  it("reports retention off when nothing is saved", async () => {
    expect(await get()).toEqual({
      saved: null,
      effective: { days: 0, source: "default" },
      envOverride: false,
      envSources: { transcriptRetentionDays: null },
      default: 0,
      limits: { min: 1, max: 3650 },
    })
  })

  it("is never cached", async () => {
    const read = await app.fetch(new Request("http://localhost/settings/api/transcripts"))
    expect(read.headers.get("cache-control")).toBe("no-store")
    expect((await put({ transcriptRetentionDays: 3 })).headers.get("cache-control")).toBe("no-store")
  })

  describe("browser writes", () => {
    it("refuses a page on another origin", async () => {
      const response = await put({ transcriptRetentionDays: 1 }, { "Content-Type": "application/json", Origin: "https://evil.example" })
      expect(response.status).toBe(403)
      expect(getSetting("transcriptRetentionDays")).toBeUndefined()
    })

    it("refuses a cross-site text/plain write, the kind a form can send without a preflight", async () => {
      const response = await put(JSON.stringify({ transcriptRetentionDays: 1 }), { "Content-Type": "text/plain", Origin: "http://attacker.test" })
      expect(response.status).toBe(403)
      expect(getSetting("transcriptRetentionDays")).toBeUndefined()
    })

    it("refuses an opaque origin and a different port", async () => {
      for (const origin of ["null", "http://localhost:9999"]) {
        expect((await put({ transcriptRetentionDays: 1 }, { "Content-Type": "application/json", Origin: origin })).status).toBe(403)
      }
      expect(getSetting("transcriptRetentionDays")).toBeUndefined()
    })

    it("accepts this server's own page", async () => {
      const response = await put({ transcriptRetentionDays: 12 }, { "Content-Type": "application/json", Origin: "http://localhost" })
      expect(response.status).toBe(200)
      expect(getSetting("transcriptRetentionDays")).toBe(12)
    })
  })

  it("round-trips a saved period through settings.json", async () => {
    const response = await put({ transcriptRetentionDays: 7 })
    expect(response.status).toBe(200)
    expect(((await response.json()) as TranscriptSettingsResponse).effective).toEqual({ days: 7, source: "settings" })
    expect(getSetting("transcriptRetentionDays")).toBe(7)
    const state = await get()
    expect(state.saved).toBe(7)
    expect(state.effective).toEqual({ days: 7, source: "settings" })
  })

  it("turns retention off with 0 or null, leaving nothing saved", async () => {
    for (const off of [0, null]) {
      await put({ transcriptRetentionDays: 9 })
      expect(getSetting("transcriptRetentionDays")).toBe(9)
      expect((await put({ transcriptRetentionDays: off })).status).toBe(200)
      expect(getSetting("transcriptRetentionDays")).toBeUndefined()
      const state = await get()
      expect(state.saved).toBeNull()
      expect(state.effective).toEqual({ days: 0, source: "default" })
    }
  })

  it("refuses a value it cannot use and leaves the saved one alone", async () => {
    await put({ transcriptRetentionDays: 14 })
    for (const bad of [-1, 2.5, 3651, "30", true, 1e9]) {
      const response = await put({ transcriptRetentionDays: bad })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain("between 1 and 3650")
    }
    expect((await put("not json")).status).toBe(400)
    expect((await put([30])).status).toBe(400)
    expect(getSetting("transcriptRetentionDays")).toBe(14)
  })

  it("reports an env override, which keeps winning over a later save", async () => {
    process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "21"
    await put({ transcriptRetentionDays: 7 })
    const state = await get()
    expect(state.saved).toBe(7)
    expect(state.envOverride).toBe(true)
    expect(state.effective).toEqual({ days: 21, source: "env" })
  })

  it("lets the env pin retention off over a saved period", async () => {
    await put({ transcriptRetentionDays: 7 })
    process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "0"
    const state = await get()
    expect(state.saved).toBe(7)
    expect(state.envOverride).toBe(true)
    expect(state.effective).toEqual({ days: 0, source: "env" })
  })

  it("is the API the settings page loads and saves through", () => {
    expect(settingsPageHtml).toContain('id="transcripts-card"')
    expect(settingsPageHtml).toContain("fetch('/settings/api/transcripts'")
    expect(settingsPageHtml).toContain("loadTranscripts();")
  })
})
