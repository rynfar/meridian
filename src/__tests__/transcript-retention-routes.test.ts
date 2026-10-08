/**
 * The transcript retention settings API behind the /settings page.
 *
 * What the page relies on: a save round-trips through settings.json, an
 * invalid value is refused without touching what is saved, null returns to the
 * default, and an env override is reported so the form does not imply that a
 * saved value applies when the environment outranks it.
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
  default: number
  limits: { min: number; max: number }
}

const ENV_KEYS = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_TRANSCRIPT_RETENTION_DAYS"]

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

  function put(body: unknown): Promise<Response> {
    return Promise.resolve(app.fetch(new Request("http://localhost/settings/api/transcripts", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })))
  }

  it("reports the 30-day default when nothing is saved", async () => {
    expect(await get()).toEqual({
      saved: null,
      effective: { days: 30, source: "default" },
      envOverride: false,
      default: 30,
      limits: { min: 0, max: 3650 },
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

  it("saves 0 as off, and null returns to the default", async () => {
    await put({ transcriptRetentionDays: 0 })
    expect((await get()).effective).toEqual({ days: 0, source: "settings" })

    await put({ transcriptRetentionDays: null })
    expect(getSetting("transcriptRetentionDays")).toBeUndefined()
    const state = await get()
    expect(state.saved).toBeNull()
    expect(state.effective).toEqual({ days: 30, source: "default" })
  })

  it("refuses a value it cannot use and leaves the saved one alone", async () => {
    await put({ transcriptRetentionDays: 14 })
    for (const bad of [-1, 2.5, 3651, "30", true]) {
      const response = await put({ transcriptRetentionDays: bad })
      expect(response.status).toBe(400)
      expect(((await response.json()) as { error: string }).error).toContain("between 0 and 3650")
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

  it("is the API the settings page loads and saves through", () => {
    expect(settingsPageHtml).toContain('id="transcripts-card"')
    expect(settingsPageHtml).toContain("fetch('/settings/api/transcripts'")
    expect(settingsPageHtml).toContain("loadTranscripts();")
  })
})
