/**
 * The header settings API, and what it changes in /health.
 *
 * Consent is the contract worth pinning: /health answers without the API key,
 * so the hostname reaches it only while the operator has asked for it, and
 * switching it off takes it out again on the running proxy.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"

const { createProxyServer } = await import("../proxy/server")
const { getSetting, setSetting } = await import("../settings")

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

describe("header settings routes", () => {
  let dir: string
  let app: TestApp
  let savedConfigDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-header-settings-"))
    savedConfigDir = process.env.MERIDIAN_CONFIG_DIR
    process.env.MERIDIAN_CONFIG_DIR = dir
    app = createProxyServer({ port: 0, host: "127.0.0.1", silent: true }).app
  })

  afterEach(() => {
    if (savedConfigDir === undefined) delete process.env.MERIDIAN_CONFIG_DIR
    else process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    rmSync(dir, { recursive: true, force: true })
  })

  const get = async () =>
    await (await app.fetch(new Request("http://localhost/settings/api/header"))).json() as { showHostname: boolean; hostname: string }

  const put = (body: unknown) =>
    app.fetch(new Request("http://localhost/settings/api/header", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }))

  const healthHostname = async () =>
    (await (await app.fetch(new Request("http://localhost/health"))).json() as { hostname?: string }).hostname

  it("is off until asked, and names this machine for the settings page either way", async () => {
    expect(await get()).toEqual({ showHostname: false, hostname: hostname() })
    expect(await healthHostname()).toBeUndefined()
  })

  it("switching on stores it and puts the hostname in /health; switching off takes it out", async () => {
    const on = await put({ showHostname: true })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ showHostname: true, hostname: hostname() })
    expect(getSetting("showHostname")).toBe(true)
    expect(await healthHostname()).toBe(hostname())

    await put({ showHostname: false })
    expect(getSetting("showHostname")).toBe(false)
    expect(await healthHostname()).toBeUndefined()
  })

  it("reads a value set in settings.json by hand", async () => {
    setSetting("showHostname", true)
    expect((await get()).showHostname).toBe(true)
    expect(await healthHostname()).toBe(hostname())
  })

  it("null unsets the setting rather than storing a false", async () => {
    setSetting("showHostname", true)
    await put({ showHostname: null })
    expect(getSetting("showHostname")).toBeUndefined()
    expect(await healthHostname()).toBeUndefined()
  })

  it("rejects a non-boolean and a malformed body without storing anything", async () => {
    expect((await put({ showHostname: "yes" })).status).toBe(400)
    expect((await put("{not json")).status).toBe(400)
    expect((await put(null)).status).toBe(400)
    expect(getSetting("showHostname")).toBeUndefined()
  })
})
