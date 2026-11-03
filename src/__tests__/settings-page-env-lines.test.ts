/**
 * The env-override lines the settings page renders, from env var to text.
 *
 * Runs the page's own loaders (the inline script of settingsPageHtml) against
 * the real settings routes, with a stub document that records each card's
 * markup, so what is asserted is what an operator reads for a given
 * environment.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { installLoggerMock } from "./loggerMock"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

installLoggerMock(() => ({
  claudeLog: () => {},
  withClaudeLogContext: (_ctx: unknown, fn: () => unknown) => fn(),
}))

const { createProxyServer } = await import("../proxy/server")
const { setSetting } = await import("../settings")
const { settingsPageHtml } = await import("../telemetry/settingsPage")

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

interface StubElement {
  innerHTML: string
  addEventListener: () => void
  querySelectorAll: () => StubElement[]
}

type Loader = () => Promise<void>
interface PageLoaders { loadTelemetry: Loader; loadUpdates: Loader; loadRouting: Loader; loadTranscripts: Loader }

/** The page script up to its start-up calls, evaluated with a stub DOM. */
function pageLoaders(app: TestApp, cards: Map<string, StubElement>): PageLoaders {
  const start = settingsPageHtml.indexOf("<script>\nvar envOverrideText")
  const end = settingsPageHtml.indexOf("\nloadConfig();", start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const script = settingsPageHtml.slice(start + "<script>".length, end)
  const document = {
    getElementById(id: string): StubElement {
      let element = cards.get(id)
      if (!element) {
        element = { innerHTML: "", addEventListener: () => {}, querySelectorAll: () => [] }
        cards.set(id, element)
      }
      return element
    },
  }
  const fetch = (url: string) => app.fetch(new Request(`http://localhost${url}`))
  const build = new Function("document", "fetch", `${script}\nreturn { loadTelemetry, loadUpdates, loadRouting, loadTranscripts };`)
  return build(document, fetch) as PageLoaders
}

/** The text of every env-override line in a card's markup. */
function envLines(html: string): string[] {
  return [...html.matchAll(/<div class="setting-env"[^>]*>([^<]*)<\/div>/g)].map(match => match[1]!)
}

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-settings-page-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-settings-page-personal" },
]

describe("settings page env-override lines", () => {
  let dir: string
  let app: TestApp
  let cards: Map<string, StubElement>
  let page: PageLoaders
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    "MERIDIAN_CONFIG_DIR",
    "MERIDIAN_TELEMETRY_PERSIST",
    "MERIDIAN_TELEMETRY_RETENTION_DAYS",
    "MERIDIAN_TELEMETRY_SIZE",
    "MERIDIAN_DIAGNOSTIC_LOG_SIZE",
    "CLAUDE_PROXY_TELEMETRY_PERSIST",
    "CLAUDE_PROXY_TELEMETRY_RETENTION_DAYS",
    "CLAUDE_PROXY_TELEMETRY_SIZE",
    "CLAUDE_PROXY_DIAGNOSTIC_LOG_SIZE",
    "MERIDIAN_NO_UPDATE_CHECK",
    "CLAUDE_PROXY_NO_UPDATE_CHECK",
    "MERIDIAN_UPDATE_CHECK_PATH",
    "MERIDIAN_UPDATE_CHECK_URL",
    "MERIDIAN_ROUTING",
    "MERIDIAN_PROFILE_ORDER",
    "MERIDIAN_TRANSCRIPT_RETENTION_DAYS",
    "CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS",
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-settings-page-"))
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = dir
    // Never reach a real registry, whatever the update setting says.
    process.env.MERIDIAN_UPDATE_CHECK_PATH = join(dir, "update-check.json")
    process.env.MERIDIAN_UPDATE_CHECK_URL = "http://127.0.0.1:9/unreachable"
    app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles: PROFILES, defaultProfile: "work" }).app
    cards = new Map()
    page = pageLoaders(app, cards)
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const telemetryLines = async () => {
    await page.loadTelemetry()
    return envLines(cards.get("telemetry-body")?.innerHTML ?? "")
  }

  it("a numeric retention variable outranks the saved setting", async () => {
    setSetting("telemetryRetentionDays", 14)
    process.env.MERIDIAN_TELEMETRY_RETENTION_DAYS = "30"
    expect(await telemetryLines())
      .toEqual(["In use: 30 days, from MERIDIAN_TELEMETRY_RETENTION_DAYS=30 (env); saved setting 14 days is ignored"])
  })

  it("a retention variable that is not a number leaves the saved setting in use, and says so", async () => {
    setSetting("telemetryRetentionDays", 14)
    process.env.MERIDIAN_TELEMETRY_RETENTION_DAYS = "abc"
    expect(await telemetryLines())
      .toEqual(["MERIDIAN_TELEMETRY_RETENTION_DAYS is set but not a valid number (abc); saved setting 14 days used"])
  })

  it("an empty retention variable leaves the saved setting in use, and says so", async () => {
    setSetting("telemetryRetentionDays", 14)
    process.env.MERIDIAN_TELEMETRY_RETENTION_DAYS = ""
    expect(await telemetryLines())
      .toEqual(["MERIDIAN_TELEMETRY_RETENTION_DAYS is set but empty; saved setting 14 days used"])
  })

  it("an empty ring size variable, legacy name included, leaves the saved setting in use", async () => {
    setSetting("telemetrySize", 3000)
    process.env.MERIDIAN_TELEMETRY_SIZE = ""
    expect(await telemetryLines()).toEqual(["MERIDIAN_TELEMETRY_SIZE is set but empty; saved setting 3,000 rows used"])

    delete process.env.MERIDIAN_TELEMETRY_SIZE
    process.env.CLAUDE_PROXY_TELEMETRY_SIZE = ""
    expect(await telemetryLines()).toEqual(["CLAUDE_PROXY_TELEMETRY_SIZE is set but empty; saved setting 3,000 rows used"])
  })

  it("an unusable ring size variable outranks the saved setting with the default, and says why", async () => {
    setSetting("telemetrySize", 3000)
    process.env.CLAUDE_PROXY_TELEMETRY_SIZE = "lots"
    expect(await telemetryLines()).toEqual([
      "In use: 1,000 rows (default), from CLAUDE_PROXY_TELEMETRY_SIZE=lots (env, not a positive number); saved setting 3,000 rows is ignored",
    ])
  })

  it("the update opt-out names its variable over a saved on, and an explicitly saved off as off", async () => {
    process.env.MERIDIAN_NO_UPDATE_CHECK = "1"
    setSetting("checkForUpdates", true)
    await page.loadUpdates()
    expect(envLines(cards.get("updates-body")?.innerHTML ?? ""))
      .toEqual(["In use: off, no update checks, from MERIDIAN_NO_UPDATE_CHECK (env); saved setting on is ignored"])

    setSetting("checkForUpdates", false)
    await page.loadUpdates()
    const lines = envLines(cards.get("updates-body")?.innerHTML ?? "")
    expect(lines).toEqual(["In use: off, no update checks, from MERIDIAN_NO_UPDATE_CHECK (env); this setting is off as well"])
    expect(lines.join("")).not.toContain("no setting saved here")
  })

  it("the routing mode and pool order name the variables that outrank them", async () => {
    setSetting("routing", "sticky")
    setSetting("profileOrder", ["work", "personal"])
    process.env.MERIDIAN_ROUTING = "priority"
    process.env.MERIDIAN_PROFILE_ORDER = "personal,work"
    await page.loadRouting()
    expect(envLines(cards.get("routing-body")?.innerHTML ?? "")).toEqual([
      "In use: priority, from MERIDIAN_ROUTING=priority (env); saved setting sticky is ignored",
      "In use: personal, work, from MERIDIAN_PROFILE_ORDER=personal,work (env); saved setting work, personal is ignored",
    ])
  })

  describe("transcript retention card", () => {
    const transcriptsCard = async () => {
      await page.loadTranscripts()
      return cards.get("transcripts-body")?.innerHTML ?? ""
    }

    it("renders through the shared setting row and reads off by default", async () => {
      const html = await transcriptsCard()
      expect(html).toContain('<div class="setting-row">')
      expect(html).toContain('id="tr-days"')
      expect(html).toContain("now: off, nothing is deleted")
      expect(envLines(html)).toEqual([])
    })

    it("shows the saved period in use", async () => {
      setSetting("transcriptRetentionDays", 45)
      const html = await transcriptsCard()
      expect(html).toContain('value="45"')
      expect(html).toContain("now: Claude Code deletes its files older than 45 days")
    })

    it("a period variable outranks the saved setting", async () => {
      setSetting("transcriptRetentionDays", 45)
      process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "7"
      expect(envLines(await transcriptsCard()))
        .toEqual(["In use: 7 days, from MERIDIAN_TRANSCRIPT_RETENTION_DAYS=7 (env); saved setting 45 days is ignored"])
    })

    it("a variable set to 0 pins retention off over the saved setting", async () => {
      setSetting("transcriptRetentionDays", 45)
      process.env.MERIDIAN_TRANSCRIPT_RETENTION_DAYS = "0"
      const html = await transcriptsCard()
      expect(html).toContain("now: off, nothing is deleted")
      expect(envLines(html))
        .toEqual(["In use: off, from MERIDIAN_TRANSCRIPT_RETENTION_DAYS=0 (env); saved setting 45 days is ignored"])
    })

    it("an unusable variable, legacy name included, leaves the saved setting or off in use, and says so", async () => {
      process.env.CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS = "forever"
      expect(envLines(await transcriptsCard()))
        .toEqual(["CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS is set but not a valid number (forever); default off used"])
      setSetting("transcriptRetentionDays", 45)
      expect(envLines(await transcriptsCard()))
        .toEqual(["CLAUDE_PROXY_TRANSCRIPT_RETENTION_DAYS is set but not a valid number (forever); saved setting 45 days used"])
    })

    it("says plainly that it is off by default and what Claude Code deletes when on", () => {
      const start = settingsPageHtml.indexOf("Transcript Retention</h1>")
      const end = settingsPageHtml.indexOf('id="transcripts-card"', start)
      expect(start).toBeGreaterThanOrEqual(0)
      const copy = settingsPageHtml.slice(start, end).replace(/<[^>]+>/g, "").replace(/\s+/g, " ")
      expect(copy).toContain("Off by default.")
      expect(copy).toContain("deletes all of its files older than that in each profile directory")
      for (const kind of [
        "including conversations Meridian still maps, which then replay from the client's history",
        "file history", "plans", "tasks", "uploads", "shell snapshots", "debug logs", "backups",
      ]) expect(copy).toContain(kind)
    })
  })
})
