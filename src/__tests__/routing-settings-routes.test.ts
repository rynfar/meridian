/**
 * GET /settings/api/routing: beside the resolved mode and pool order it
 * reports what is saved and which env var outranks each, so the settings page
 * can say what is in use, where it comes from and what happens to the saved
 * value.
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

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

interface EnvSourceBody { name: string; value: string | null; secret: boolean }

interface RoutingSettingsResponse {
  routing: string
  profileOrder: string[]
  saved: { routing: string | null; profileOrder: string[] | null }
  envOverride: { routing: boolean; profileOrder: boolean }
  envSources: { routing: EnvSourceBody | null; profileOrder: EnvSourceBody | null }
}

const PROFILES = [
  { id: "work", claudeConfigDir: "/tmp/meridian-routing-settings-work" },
  { id: "personal", claudeConfigDir: "/tmp/meridian-routing-settings-personal" },
]

describe("routing settings route", () => {
  let dir: string
  let app: TestApp
  const savedEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = ["MERIDIAN_CONFIG_DIR", "MERIDIAN_ROUTING", "MERIDIAN_PROFILE_ORDER"]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-routing-settings-"))
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = dir
    app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true, profiles: PROFILES, defaultProfile: "work" }).app
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async (): Promise<RoutingSettingsResponse> => {
    const res = await app.fetch(new Request("http://localhost/settings/api/routing"))
    expect(res.status).toBe(200)
    return await res.json() as RoutingSettingsResponse
  }

  it("with no env var set, reports the saved values and no env source", async () => {
    setSetting("routing", "sticky")
    setSetting("profileOrder", ["personal", "work"])

    const body = await get()
    expect(body.routing).toBe("sticky")
    expect(body.profileOrder).toEqual(["personal", "work"])
    expect(body.saved).toEqual({ routing: "sticky", profileOrder: ["personal", "work"] })
    expect(body.envSources).toEqual({ routing: null, profileOrder: null })
  })

  it("reports nothing saved as null", async () => {
    const body = await get()
    expect(body.saved).toEqual({ routing: null, profileOrder: null })
  })

  it("names MERIDIAN_ROUTING and its value beside the saved mode it outranks", async () => {
    setSetting("routing", "sticky")
    process.env.MERIDIAN_ROUTING = "priority"

    const body = await get()
    expect(body.routing).toBe("priority")
    expect(body.saved.routing).toBe("sticky")
    expect(body.envSources.routing).toEqual({ name: "MERIDIAN_ROUTING", value: "priority", secret: false })
  })

  it("names an empty MERIDIAN_ROUTING, which still outranks the saved mode", async () => {
    setSetting("routing", "sticky")
    process.env.MERIDIAN_ROUTING = ""

    const body = await get()
    // The resolver reads `MERIDIAN_ROUTING ?? saved`, so "" wins and parses as active.
    expect(body.routing).toBe("active")
    expect(body.saved.routing).toBe("sticky")
    expect(body.envSources.routing).toEqual({ name: "MERIDIAN_ROUTING", value: "", secret: false })
  })

  it("names MERIDIAN_PROFILE_ORDER and its value beside the saved order it outranks", async () => {
    setSetting("routing", "priority")
    setSetting("profileOrder", ["work", "personal"])
    process.env.MERIDIAN_PROFILE_ORDER = "personal,work"

    const body = await get()
    expect(body.profileOrder).toEqual(["personal", "work"])
    expect(body.saved.profileOrder).toEqual(["work", "personal"])
    expect(body.envSources.profileOrder).toEqual({ name: "MERIDIAN_PROFILE_ORDER", value: "personal,work", secret: false })
    expect(body.envSources.routing).toBeNull()
  })

  it("does not credit a blank MERIDIAN_PROFILE_ORDER, which the saved order outranks", async () => {
    setSetting("profileOrder", ["personal", "work"])
    process.env.MERIDIAN_PROFILE_ORDER = "  "

    const body = await get()
    expect(body.profileOrder).toEqual(["personal", "work"])
    expect(body.envSources.profileOrder).toBeNull()
  })
})
