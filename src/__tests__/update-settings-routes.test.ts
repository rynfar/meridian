/**
 * The update-check settings API.
 *
 * The contract worth pinning here is consent: nothing contacts the registry
 * until someone turns this on, the env opt-out overrules a stored yes, and the
 * switch acts on the RUNNING proxy rather than the next start — an operator who
 * turns the check off and still sees "update available" in the header has been
 * told a stale thing by a setting that claimed to apply.
 *
 * The registry is a loopback stand-in that counts every request it receives,
 * so these tests exercise the real fetch path without leaving the machine.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { createProxyServer } = await import("../proxy/server")
const { getLatestVersion, startUpdateCheck, stopUpdateCheck } = await import("../proxy/updateCheck")
const { getSetting, setSetting } = await import("../settings")

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

interface UpdateSettingsResponse {
  checkForUpdates: boolean
  envOptOut: boolean
  enabled: boolean
  build: { version?: string; source?: string; latest?: string; updateAvailable?: boolean }
}

let registryHits = 0
let registryLatest = "1.99.0"
let registry: ReturnType<typeof Bun.serve>

beforeAll(() => {
  registry = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => {
      registryHits++
      return Response.json({ latest: registryLatest })
    },
  })
})

afterAll(() => {
  registry.stop(true)
})

describe("update settings routes", () => {
  let dir: string
  let app: TestApp
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    "MERIDIAN_CONFIG_DIR",
    "MERIDIAN_NO_UPDATE_CHECK",
    "MERIDIAN_UPDATE_CHECK_PATH",
    "MERIDIAN_UPDATE_CHECK_URL",
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-update-settings-"))
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = dir
    process.env.MERIDIAN_UPDATE_CHECK_PATH = join(dir, "update-check.json")
    process.env.MERIDIAN_UPDATE_CHECK_URL = `http://127.0.0.1:${registry.port}/dist-tags`
    registryHits = 0
    registryLatest = "1.99.0"
    stopUpdateCheck()
    app = createProxyServer({ port: 0, host: "127.0.0.1", version: "1.62.7", silent: true }).app
  })

  afterEach(() => {
    stopUpdateCheck()
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async (): Promise<UpdateSettingsResponse> =>
    await (await app.fetch(new Request("http://localhost/settings/api/updates"))).json() as UpdateSettingsResponse

  const put = (body: unknown) =>
    app.fetch(new Request("http://localhost/settings/api/updates", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }))

  it("reports the running version, and is off until asked", async () => {
    const state = await get()

    expect(state.build.version).toBe("1.62.7")
    expect(state.checkForUpdates).toBe(false)
    expect(state.enabled).toBe(false)
  })

  it("refuses a null settings body without changing the disabled setting", async () => {
    expect((await put(null)).status).toBe(400)
    expect((await get()).enabled).toBe(false)
  })

  it("makes no registry request while off, whatever reads the state", async () => {
    await startUpdateCheck()
    await get()
    await put({ checkForUpdates: false })

    expect(registryHits).toBe(0)
    expect((await get()).build.latest).toBeUndefined()
  })

  it("switching on checks now and answers with the result", async () => {
    const response = await put({ checkForUpdates: true })
    const state = (await response.json()) as UpdateSettingsResponse

    expect(response.status).toBe(200)
    expect(state.checkForUpdates).toBe(true)
    expect(state.enabled).toBe(true)
    expect(getSetting("checkForUpdates")).toBe(true)
    expect(registryHits).toBe(1)
    expect(state.build.latest).toBe("1.99.0")
    // Running from this checkout, so the source is local — and a checkout is
    // still told a newer release exists.
    expect(state.build.source).toBe("local")
    expect(state.build.updateAvailable).toBe(true)
  })

  it("a current version is reported as current, not as an update", async () => {
    registryLatest = "1.62.7"
    const state = (await (await put({ checkForUpdates: true })).json()) as UpdateSettingsResponse

    expect(state.build.latest).toBe("1.62.7")
    expect(state.build.updateAvailable).toBe(false)
  })

  it("switching off stops the live check, not only the stored setting", async () => {
    await put({ checkForUpdates: true })
    expect(getLatestVersion()).toBe("1.99.0")

    const state = (await (await put({ checkForUpdates: false })).json()) as UpdateSettingsResponse

    expect(getLatestVersion()).toBeUndefined()
    expect(state.build.latest).toBeUndefined()
    expect(state.enabled).toBe(false)
  })

  it("null unsets the setting rather than storing a false", async () => {
    setSetting("checkForUpdates", true)

    await put({ checkForUpdates: null })

    expect(getSetting("checkForUpdates")).toBeUndefined()
  })

  it("rejects a non-boolean instead of storing it", async () => {
    const response = await put({ checkForUpdates: "yes" })

    expect(response.status).toBe(400)
    expect(getSetting("checkForUpdates")).toBeUndefined()
  })

  it("answers a malformed body with 400, not 500", async () => {
    expect((await put("{not json")).status).toBe(400)
  })

  it("the env opt-out overrules an enabled setting and makes no request", async () => {
    process.env.MERIDIAN_NO_UPDATE_CHECK = "1"

    const state = (await (await put({ checkForUpdates: true })).json()) as UpdateSettingsResponse

    expect(state.checkForUpdates).toBe(true)
    expect(state.envOptOut).toBe(true)
    expect(state.enabled).toBe(false)
    expect(registryHits).toBe(0)
    // The response keeps its documented fields (api-contract.md, including the
    // #1445 plugins list); no envSource is added, the page names the variable itself.
    expect(Object.keys(state).sort()).toEqual(["build", "checkForUpdates", "enabled", "envOptOut", "plugins"])
  })
})
