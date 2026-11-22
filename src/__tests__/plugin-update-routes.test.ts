/**
 * Plugin updates through the running proxy: plugins.json loads real plugin
 * files, `/settings/api/updates` reports each one, and the registry is a
 * loopback stand-in that counts every request it receives.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { createProxyServer } = await import("../proxy/server")
const { stopUpdateCheck } = await import("../proxy/updateCheck")
const { trackPlugins } = await import("../proxy/pluginUpdateCheck")
const { setSetting } = await import("../settings")

interface PluginUpdate {
  name: string
  checkable: boolean
  package?: string
  installed?: string
  latest?: string
  updateAvailable?: boolean
  error?: string
  reason?: string
}

let requested: string[] = []
const published: Record<string, string> = {}
let registry: ReturnType<typeof Bun.serve>

beforeAll(() => {
  registry = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request) => {
      const path = new URL(request.url).pathname
      requested.push(path)
      const name = path.match(/^\/-\/package\/(.+)\/dist-tags$/)?.[1]
      if (name && published[name]) return Response.json({ latest: published[name] })
      if (path === "/meridian/dist-tags") return Response.json({ latest: "1.62.7" })
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(() => {
  registry.stop(true)
})

describe("plugin updates on /settings/api/updates", () => {
  let dir: string
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    "MERIDIAN_CONFIG_DIR",
    "MERIDIAN_NO_UPDATE_CHECK",
    "MERIDIAN_UPDATE_CHECK_PATH",
    "MERIDIAN_UPDATE_CHECK_URL",
    "MERIDIAN_UPDATE_CHECK_REGISTRY",
    "MERIDIAN_PLUGIN_UPDATE_CHECK_PATH",
  ]

  function installPlugin(name: string, version: string): string {
    const pkg = join(dir, "installs", name, "node_modules", name)
    mkdirSync(join(pkg, "dist"), { recursive: true })
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version }))
    writeFileSync(join(pkg, "dist", "index.js"), `export default { name: ${JSON.stringify(name)}, version: ${JSON.stringify(version)} }\n`)
    return join(pkg, "dist", "index.js")
  }

  function writePluginsJson(paths: string[]): void {
    writeFileSync(join(dir, "plugins.json"), JSON.stringify({ plugins: paths.map((path) => ({ path, enabled: true })) }))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-plugin-update-routes-"))
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
    process.env.MERIDIAN_CONFIG_DIR = dir
    process.env.MERIDIAN_UPDATE_CHECK_PATH = join(dir, "update-check.json")
    process.env.MERIDIAN_UPDATE_CHECK_URL = `http://127.0.0.1:${registry.port}/meridian/dist-tags`
    process.env.MERIDIAN_UPDATE_CHECK_REGISTRY = `http://127.0.0.1:${registry.port}`
    process.env.MERIDIAN_PLUGIN_UPDATE_CHECK_PATH = join(dir, "plugin-update-check.json")
    mkdirSync(join(dir, "plugins"), { recursive: true })
    writeFileSync(join(dir, "plugins", "local.js"), "export default { name: 'local' }\n")
    requested = []
    for (const key of Object.keys(published)) delete published[key]
    stopUpdateCheck()
  })

  afterEach(() => {
    stopUpdateCheck()
    trackPlugins([])
    setSetting("checkForUpdates", undefined)
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function startProxy() {
    const proxy = createProxyServer({ port: 0, host: "127.0.0.1", version: "1.62.7", silent: true })
    if (proxy.initPlugins) await proxy.initPlugins()
    const app = proxy.app as { fetch: (r: Request) => Response | Promise<Response> }
    const call = (path: string, init?: RequestInit) => app.fetch(new Request(`http://localhost${path}`, init))
    const put = async (body: unknown) =>
      (await (await call("/settings/api/updates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })).json()) as { plugins: PluginUpdate[] }
    const get = async () => (await (await call("/settings/api/updates")).json()) as { plugins: PluginUpdate[] }
    return { call, put, get }
  }

  const byName = (plugins: PluginUpdate[], name: string) => plugins.find((plugin) => plugin.name === name)

  it("lists every loaded plugin, but asks the registry nothing while the check is off", async () => {
    writePluginsJson([installPlugin("meridian-plugin-behind", "0.2.0")])
    published["meridian-plugin-behind"] = "0.3.0"
    const { get } = await startProxy()

    const { plugins } = await get()

    expect(byName(plugins, "meridian-plugin-behind")).toMatchObject({ checkable: true, installed: "0.2.0" })
    expect(byName(plugins, "meridian-plugin-behind")?.latest).toBeUndefined()
    expect(byName(plugins, "local")).toMatchObject({ checkable: false, reason: "not installed from an npm package" })
    expect(requested).toEqual([])
  })

  it("switching on checks each plugin's package with Meridian's own, and reports what it found", async () => {
    writePluginsJson([installPlugin("meridian-plugin-behind", "0.2.0"), installPlugin("meridian-plugin-current", "1.0.0"), installPlugin("meridian-plugin-gone", "0.1.0")])
    published["meridian-plugin-behind"] = "0.3.0"
    published["meridian-plugin-current"] = "1.0.0"
    const { put } = await startProxy()

    const { plugins } = await put({ checkForUpdates: true })

    expect(byName(plugins, "meridian-plugin-behind")).toMatchObject({ package: "meridian-plugin-behind", installed: "0.2.0", latest: "0.3.0", updateAvailable: true })
    expect(byName(plugins, "meridian-plugin-current")).toMatchObject({ installed: "1.0.0", latest: "1.0.0", updateAvailable: false })
    expect(byName(plugins, "meridian-plugin-gone")).toMatchObject({ installed: "0.1.0", error: "registry answered 404" })
    expect(requested.sort()).toEqual([
      "/-/package/meridian-plugin-behind/dist-tags",
      "/-/package/meridian-plugin-current/dist-tags",
      "/-/package/meridian-plugin-gone/dist-tags",
      "/meridian/dist-tags",
    ])
  })

  it("a plugin added by a reload is checked at once, and one already checked comes from the cache", async () => {
    const first = installPlugin("meridian-plugin-first", "1.0.0")
    writePluginsJson([first])
    published["meridian-plugin-first"] = "1.0.0"
    published["meridian-plugin-added"] = "2.0.0"
    const { put, get, call } = await startProxy()
    await put({ checkForUpdates: true })
    requested = []

    writePluginsJson([first, installPlugin("meridian-plugin-added", "1.5.0")])
    await call("/plugins/reload", { method: "POST" })
    for (let i = 0; i < 50 && !byName((await get()).plugins, "meridian-plugin-added")?.latest; i++) await Bun.sleep(10)

    expect(byName((await get()).plugins, "meridian-plugin-added")).toMatchObject({ installed: "1.5.0", latest: "2.0.0", updateAvailable: true })
    expect(requested).toEqual(["/-/package/meridian-plugin-added/dist-tags"])
  })

  it("switching off forgets what the plugin check found, and keeps listing the plugins", async () => {
    writePluginsJson([installPlugin("meridian-plugin-behind", "0.2.0")])
    published["meridian-plugin-behind"] = "0.3.0"
    const { put, get } = await startProxy()
    await put({ checkForUpdates: true })

    const { plugins } = await put({ checkForUpdates: false })

    expect(byName(plugins, "meridian-plugin-behind")?.latest).toBeUndefined()
    expect(byName(plugins, "meridian-plugin-behind")?.installed).toBe("0.2.0")
    expect(byName((await get()).plugins, "meridian-plugin-behind")).toMatchObject({ checkable: true, installed: "0.2.0" })
  })

  it("a mirror for Meridian's check without a plugin registry sends no plugin name anywhere", async () => {
    delete process.env.MERIDIAN_UPDATE_CHECK_REGISTRY
    writePluginsJson([installPlugin("meridian-plugin-behind", "0.2.0")])
    published["meridian-plugin-behind"] = "0.3.0"
    const { put } = await startProxy()

    const { plugins } = await put({ checkForUpdates: true })

    expect(byName(plugins, "meridian-plugin-behind")).toMatchObject({
      checkable: false,
      reason: "set MERIDIAN_UPDATE_CHECK_REGISTRY to check plugins through your mirror",
      installed: "0.2.0",
    })
    expect(requested).toEqual(["/meridian/dist-tags"])
  })

  it("a reload over a package.json that is not an object still answers, listing the plugin as not checkable", async () => {
    const { call, get } = await startProxy()
    const entry = installPlugin("meridian-plugin-odd", "1.0.0")
    const manifest = join(entry, "..", "..", "package.json")
    writeFileSync(manifest, "null")
    writePluginsJson([entry])

    const response = await call("/plugins/reload", { method: "POST" })

    expect(response.status).toBe(200)
    expect(byName((await get()).plugins, "meridian-plugin-odd")).toMatchObject({ checkable: false, reason: `${manifest} is not a JSON object` })
  })

  it("switching on answers within about one fetch timeout when the registry never responds", async () => {
    const hits: string[] = []
    const hanging = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        hits.push(new URL(request.url).pathname)
        return new Promise<Response>(() => {})
      },
    })
    try {
      process.env.MERIDIAN_UPDATE_CHECK_URL = `http://127.0.0.1:${hanging.port}/meridian/dist-tags`
      process.env.MERIDIAN_UPDATE_CHECK_REGISTRY = `http://127.0.0.1:${hanging.port}`
      writePluginsJson(Array.from({ length: 6 }, (_, i) => installPlugin(`meridian-plugin-${i}`, "1.0.0")))
      const { put } = await startProxy()

      const started = Date.now()
      const { plugins } = await put({ checkForUpdates: true })
      const elapsed = Date.now() - started

      // Serially that is 7 × 5s; four at a time without a pass deadline, 10s.
      expect(elapsed).toBeLessThan(8000)
      // Meridian's own lookup plus the first four plugin lookups; the rest were never sent.
      expect(hits.length).toBeLessThanOrEqual(5)
      for (let i = 0; i < 6; i++) expect(byName(plugins, `meridian-plugin-${i}`)?.error).toBeString()
    } finally {
      hanging.stop(true)
    }
  }, 15_000)
})
