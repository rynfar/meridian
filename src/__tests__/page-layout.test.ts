/**
 * The page layout setting.
 *
 * Two promises are pinned here. A contained page (the default) carries no
 * layout attribute, so none of the wide rules apply and nobody who never
 * touches the setting sees a change. A wide one carries the attribute every
 * page's CSS keys off, on every HTML route, so a page that skips
 * withSavedLayout fails here rather than quietly staying narrow.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const { createProxyServer } = await import("../proxy/server")
const { getSetting } = await import("../settings")
const { PAGE_LAYOUTS, resolvePageLayout, withPageLayout } = await import("../telemetry/pageLayout")
const { landingHtml } = await import("../telemetry/landing")
const { providerPageHtml } = await import("../telemetry/providerPage")

type TestApp = { fetch: (r: Request) => Response | Promise<Response> }

const PAGES = ["/", "/profiles", "/settings", "/telemetry", "/plugins", "/providers"]

describe("page layout", () => {
  it("anything but a known layout means contained", () => {
    expect(resolvePageLayout(undefined)).toBe("contained")
    expect(resolvePageLayout("wide")).toBe("wide")
    for (const value of ["WIDE", "full", "", 1, null, {}]) expect(resolvePageLayout(value)).toBe("contained")
  })

  it("serves a contained page unchanged", () => {
    expect(withPageLayout(landingHtml, "contained")).toBe(landingHtml)
  })

  it("marks the root element of a wide page, and nothing else", () => {
    const wide = withPageLayout(landingHtml, "wide")
    expect(wide.startsWith('<!DOCTYPE html>\n<html data-layout="wide" lang="en">')).toBe(true)
    expect(wide.replace(' data-layout="wide"', "")).toBe(landingHtml)
  })

  it("leaves a lowercase doctype alone", () => {
    expect(withPageLayout(providerPageHtml, "wide").startsWith('<!doctype html><html data-layout="wide" lang="en">')).toBe(true)
  })
})

describe("layout settings routes", () => {
  let dir: string
  let app: TestApp
  let savedConfigDir: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-layout-settings-"))
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
    await (await app.fetch(new Request("http://localhost/settings/api/layout"))).json() as { layout: string; layouts: string[] }

  const put = (body: unknown) =>
    app.fetch(new Request("http://localhost/settings/api/layout", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }))

  const page = async (path: string) => {
    const response = await app.fetch(new Request(`http://localhost${path}`, { headers: { Accept: "text/html" } }))
    expect(response.status, `${path} status`).toBe(200)
    return await response.text()
  }

  it("is contained until someone chooses otherwise, and says what it accepts", async () => {
    expect(await get()).toEqual({ layout: "contained", layouts: [...PAGE_LAYOUTS] })
    for (const path of PAGES) expect(await page(path), path).not.toContain("<html data-layout")
  })

  it("saves wide, reads it back, and serves every page wide", async () => {
    const response = await put({ layout: "wide" })

    expect(response.status).toBe(200)
    expect((await response.json() as { layout: string }).layout).toBe("wide")
    expect(getSetting("layout")).toBe("wide")
    expect((await get()).layout).toBe("wide")
    for (const path of PAGES) expect(await page(path), path).toContain('<html data-layout="wide"')
  })

  it("null unsets the setting, which puts every page back", async () => {
    await put({ layout: "wide" })

    expect((await (await put({ layout: null })).json() as { layout: string }).layout).toBe("contained")
    expect(getSetting("layout")).toBeUndefined()
    for (const path of PAGES) expect(await page(path), path).not.toContain("<html data-layout")
  })

  it("rejects an unknown layout without changing the saved one", async () => {
    await put({ layout: "wide" })

    const response = await put({ layout: "huge" })

    expect(response.status).toBe(400)
    expect(getSetting("layout")).toBe("wide")
  })

  it("answers a malformed or non-object body with 400, not 500", async () => {
    expect((await put("{not json")).status).toBe(400)
    expect((await put(null)).status).toBe(400)
    expect((await put(["wide"])).status).toBe(400)
  })

  it("treats a hand-edited unknown value as contained", async () => {
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ layout: "huge" }))

    expect((await get()).layout).toBe("contained")
    expect(await page("/")).not.toContain("<html data-layout")
  })
})
