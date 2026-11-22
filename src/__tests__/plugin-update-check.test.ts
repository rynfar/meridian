/**
 * Plugin update check — real filesystem, injected clock and fetch.
 *
 * Two things matter: a plugin's package is read from what is actually
 * installed beside the file Meridian loaded (and a lone file is never passed
 * off as some package), and the registry is asked politely — once per package
 * per interval however many plugins share it, with a failure kept on its own
 * package instead of failing the pass.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  checkPluginPackages,
  clearPluginUpdates,
  findPluginPackage,
  getPluginUpdates,
  refreshPluginUpdates,
  trackPlugins,
} from "../proxy/pluginUpdateCheck"
import { stopUpdateCheck } from "../proxy/updateCheck"

const REGISTRY_ENV = ["MERIDIAN_UPDATE_CHECK_URL", "MERIDIAN_UPDATE_CHECK_REGISTRY"] as const
const savedEnv: Record<string, string | undefined> = {}

let dir: string
let cachePath: string

beforeEach(() => {
  for (const key of REGISTRY_ENV) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  dir = mkdtempSync(join(tmpdir(), "meridian-plugin-update-"))
  cachePath = join(dir, "cache", "plugin-update-check.json")
  clearPluginUpdates()
  trackPlugins([])
})

afterEach(() => {
  clearPluginUpdates()
  trackPlugins([])
  for (const key of REGISTRY_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** Install a fake package and return its entry file. */
function installPackage(root: string, manifest: Record<string, unknown>, entry = "dist/index.js"): string {
  const name = String(manifest.name ?? "anon")
  const pkg = join(root, "node_modules", ...name.split("/"))
  mkdirSync(join(pkg, entry, ".."), { recursive: true })
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest))
  writeFileSync(join(pkg, entry), "export default { name: 'x' }\n")
  return join(pkg, entry)
}

function countingFetch(versions: Record<string, string | Error>) {
  const calls: string[] = []
  return {
    calls,
    fetchLatest: async (name: string) => {
      calls.push(name)
      const answer = versions[name]
      if (answer instanceof Error) throw answer
      if (answer === undefined) throw new Error("registry answered 404")
      return answer
    },
  }
}

describe("findPluginPackage", () => {
  test("reads the name and installed version of the package a plugin file belongs to", () => {
    const entry = installPackage(dir, { name: "@acme/meridian-plugin-x", version: "0.2.1" })
    expect(findPluginPackage(entry)).toEqual({ package: { name: "@acme/meridian-plugin-x", version: "0.2.1" } })
  })

  test("looks past a nameless build marker in dist/", () => {
    const entry = installPackage(dir, { name: "plain-plugin", version: "1.0.0" })
    writeFileSync(join(entry, "..", "package.json"), JSON.stringify({ type: "module" }))
    expect(findPluginPackage(entry)).toEqual({ package: { name: "plain-plugin", version: "1.0.0" } })
  })

  test("a lone file in the plugin directory is not checkable, even under a directory with a package.json", () => {
    const pluginDir = join(dir, "config", "plugins")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(dir, "config", "package.json"), JSON.stringify({ name: "someone-elses-project", version: "9.0.0" }))
    writeFileSync(join(pluginDir, "local.js"), "export default { name: 'local' }\n")

    const found = findPluginPackage(join(pluginDir, "local.js"), [pluginDir])
    expect(found).toEqual({ reason: "not installed from an npm package" })
  })

  test("a private package is reported as such, not checked", () => {
    const entry = installPackage(dir, { name: "in-house", version: "1.0.0", private: true })
    expect(findPluginPackage(entry)).toEqual({ reason: "in-house is a private package" })
  })

  test("a package without a version cannot be compared", () => {
    const entry = installPackage(dir, { name: "no-version" })
    expect(findPluginPackage(entry)).toEqual({ reason: "no-version declares no version" })
  })

  test("a package.json that is valid JSON but not an object is reported, not thrown on", () => {
    for (const [index, body] of ["null", "[]", "\"text\"", "42"].entries()) {
      const entry = installPackage(join(dir, `odd-${index}`), { name: `odd-${index}`, version: "1.0.0" })
      const manifest = join(entry, "..", "..", "package.json")
      writeFileSync(manifest, body)
      expect(findPluginPackage(entry)).toEqual({ reason: `${manifest} is not a JSON object` })
    }
  })

  test("records a publishConfig registry and tolerates a malformed publishConfig", () => {
    const named = installPackage(join(dir, "a"), { name: "elsewhere", version: "1.0.0", publishConfig: { registry: "https://npm.example.com/" } })
    expect(findPluginPackage(named)).toEqual({ package: { name: "elsewhere", version: "1.0.0", publishRegistry: "https://npm.example.com/" } })
    const odd = installPackage(join(dir, "b"), { name: "odd-config", version: "1.0.0", publishConfig: null })
    expect(findPluginPackage(odd)).toEqual({ package: { name: "odd-config", version: "1.0.0" } })
  })
})

describe("checkPluginPackages", () => {
  test("asks once per package, then serves the cache until the interval passes", async () => {
    let now = 1_000_000
    const { calls, fetchLatest } = countingFetch({ a: "1.1.0", b: "2.0.0" })
    const options = { cachePath, fetchLatest, now: () => now, ttlMs: 60_000 }

    expect(await checkPluginPackages(["a", "b", "a"], options)).toEqual({
      a: { latest: "1.1.0", checkedAt: now },
      b: { latest: "2.0.0", checkedAt: now },
    })
    expect(calls).toEqual(["a", "b"])

    now += 30_000
    await checkPluginPackages(["a", "b"], options)
    expect(calls).toEqual(["a", "b"])

    now += 31_000
    await checkPluginPackages(["a", "b"], options)
    expect(calls).toEqual(["a", "b", "a", "b"])
  })

  test("a failing package records its error and keeps its last known version; the others still resolve", async () => {
    let now = 1_000_000
    const versions: Record<string, string | Error> = { a: "1.1.0", b: "2.0.0" }
    const { fetchLatest } = countingFetch(versions)
    const options = { cachePath, fetchLatest, now: () => now, ttlMs: 60_000 }
    await checkPluginPackages(["a", "b"], options)

    versions.a = new Error("The operation timed out.")
    now += 61_000
    const result = await checkPluginPackages(["a", "b"], options)

    expect(result.a).toEqual({ latest: "1.1.0", checkedAt: now, error: "The operation timed out." })
    expect(result.b).toEqual({ latest: "2.0.0", checkedAt: now })
    expect(JSON.parse(readFileSync(cachePath, "utf8")).packages.a.error).toBe("The operation timed out.")
  })

  test("a stale mirror cannot walk the known-latest backwards", async () => {
    let now = 1_000_000
    const versions: Record<string, string> = { a: "1.2.0" }
    const { fetchLatest } = countingFetch(versions)
    const options = { cachePath, fetchLatest, now: () => now, ttlMs: 60_000 }
    await checkPluginPackages(["a"], options)

    versions.a = "1.1.0"
    now += 61_000
    expect((await checkPluginPackages(["a"], options)).a?.latest).toBe("1.2.0")
  })

  test("switched off mid-pass, it makes no further request", async () => {
    let enabled = true
    const calls: string[] = []
    const fetchLatest = async (name: string) => {
      calls.push(name)
      enabled = false
      return "1.0.0"
    }
    await checkPluginPackages(["a", "b"], { cachePath, fetchLatest, enabled: () => enabled })
    expect(calls).toEqual(["a"])
  })

  test("no packages means no file access and no request", async () => {
    const { calls, fetchLatest } = countingFetch({})
    expect(await checkPluginPackages([], { cachePath, fetchLatest })).toEqual({})
    expect(calls).toEqual([])
  })
})

describe("getPluginUpdates", () => {
  test("joins each loaded plugin to its package's answer", async () => {
    const pluginDir = join(dir, "plugins")
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, "local.js"), "export default { name: 'local' }\n")
    const behind = installPackage(join(dir, "v1"), { name: "behind", version: "0.2.0" })
    const current = installPackage(join(dir, "v2"), { name: "current", version: "1.0.0" })
    const broken = installPackage(join(dir, "v3"), { name: "unpublished", version: "0.1.0" })
    trackPlugins([
      { name: "behind", path: behind, status: "active" },
      { name: "current", path: current, status: "active" },
      { name: "unpublished", path: broken, status: "error" },
      { name: "local", path: join(pluginDir, "local.js"), status: "active" },
    ], [pluginDir])

    const { fetchLatest } = countingFetch({ behind: "0.3.0", current: "1.0.0" })
    await refreshPluginUpdates({ cachePath, fetchLatest, now: () => 5 })

    expect(getPluginUpdates()).toEqual([
      { name: "behind", path: behind, status: "active", checkable: true, package: "behind", installed: "0.2.0", latest: "0.3.0", updateAvailable: true, checkedAt: 5 },
      { name: "current", path: current, status: "active", checkable: true, package: "current", installed: "1.0.0", latest: "1.0.0", updateAvailable: false, checkedAt: 5 },
      { name: "unpublished", path: broken, status: "error", checkable: true, package: "unpublished", installed: "0.1.0", checkedAt: 5, error: "registry answered 404" },
      { name: "local", path: join(pluginDir, "local.js"), status: "active", checkable: false, reason: "not installed from an npm package" },
    ])
  })

  test("a pass in flight when the check is cleared does not publish afterwards", async () => {
    const entry = installPackage(dir, { name: "late", version: "0.1.0" })
    trackPlugins([{ name: "late", path: entry, status: "active" }])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = refreshPluginUpdates({ cachePath, fetchLatest: async () => { await gate; return "0.2.0" } })

    clearPluginUpdates()
    release()
    await pending
    expect(getPluginUpdates()[0]?.latest).toBeUndefined()
  })
})

describe("which registry plugin package names go to", () => {
  test("a mirror for Meridian's own check without a plugin registry checks no plugin", async () => {
    process.env.MERIDIAN_UPDATE_CHECK_URL = "https://mirror.internal/meridian/dist-tags"
    const entry = installPackage(dir, { name: "mirrored", version: "1.0.0" })
    trackPlugins([{ name: "mirrored", path: entry, status: "active" }])
    const { calls, fetchLatest } = countingFetch({ mirrored: "2.0.0" })

    await refreshPluginUpdates({ cachePath, fetchLatest })

    expect(calls).toEqual([])
    expect(getPluginUpdates()).toEqual([{
      name: "mirrored",
      path: entry,
      status: "active",
      checkable: false,
      reason: "set MERIDIAN_UPDATE_CHECK_REGISTRY to check plugins through your mirror",
      package: "mirrored",
      installed: "1.0.0",
    }])
  })

  test("naming the plugin registry beside the mirror checks plugins through it", async () => {
    process.env.MERIDIAN_UPDATE_CHECK_URL = "https://mirror.internal/meridian/dist-tags"
    process.env.MERIDIAN_UPDATE_CHECK_REGISTRY = "https://mirror.internal/npm/"
    const entry = installPackage(dir, { name: "mirrored", version: "1.0.0" })
    trackPlugins([{ name: "mirrored", path: entry, status: "active" }])
    const { calls, fetchLatest } = countingFetch({ mirrored: "2.0.0" })

    await refreshPluginUpdates({ cachePath, fetchLatest })

    expect(calls).toEqual(["mirrored"])
    expect(getPluginUpdates()[0]).toMatchObject({ checkable: true, latest: "2.0.0", updateAvailable: true })
  })

  test("a package published to another registry is not checkable; one published to the configured registry is", async () => {
    const elsewhere = installPackage(join(dir, "a"), { name: "elsewhere", version: "1.0.0", publishConfig: { registry: "https://npm.example.com" } })
    const npmjs = installPackage(join(dir, "b"), { name: "on-npmjs", version: "1.0.0", publishConfig: { registry: "https://registry.npmjs.org/" } })
    trackPlugins([
      { name: "elsewhere", path: elsewhere, status: "active" },
      { name: "on-npmjs", path: npmjs, status: "active" },
    ])
    const { calls, fetchLatest } = countingFetch({ elsewhere: "9.0.0", "on-npmjs": "1.1.0" })

    await refreshPluginUpdates({ cachePath, fetchLatest })

    expect(calls).toEqual(["on-npmjs"])
    const [first, second] = getPluginUpdates()
    expect(first).toMatchObject({
      checkable: false,
      reason: "elsewhere is published to https://npm.example.com, not https://registry.npmjs.org",
      package: "elsewhere",
      installed: "1.0.0",
    })
    expect(first?.latest).toBeUndefined()
    expect(second).toMatchObject({ checkable: true, latest: "1.1.0" })
  })

  test("the configured registry decides which publishConfig registries match", async () => {
    process.env.MERIDIAN_UPDATE_CHECK_REGISTRY = "https://npm.example.com/"
    const entry = installPackage(dir, { name: "elsewhere", version: "1.0.0", publishConfig: { registry: "https://npm.example.com" } })
    trackPlugins([{ name: "elsewhere", path: entry, status: "active" }])
    const { calls, fetchLatest } = countingFetch({ elsewhere: "1.0.0" })

    await refreshPluginUpdates({ cachePath, fetchLatest })

    expect(calls).toEqual(["elsewhere"])
    expect(getPluginUpdates()[0]?.checkable).toBe(true)
  })

  test("a package published to public npm is checked through a configured mirror", async () => {
    process.env.MERIDIAN_UPDATE_CHECK_REGISTRY = "https://mirror.example.com/npm/"
    const publicPkg = installPackage(join(dir, "a"), { name: "on-npmjs", version: "1.0.0", publishConfig: { registry: "https://registry.npmjs.org/" } })
    const internal = installPackage(join(dir, "b"), { name: "internal", version: "1.0.0", publishConfig: { registry: "https://npm.corp.example" } })
    trackPlugins([
      { name: "on-npmjs", path: publicPkg, status: "active" },
      { name: "internal", path: internal, status: "active" },
    ])
    const { calls, fetchLatest } = countingFetch({ "on-npmjs": "1.1.0", internal: "2.0.0" })

    await refreshPluginUpdates({ cachePath, fetchLatest })

    expect(calls).toEqual(["on-npmjs"])
    const [first, second] = getPluginUpdates()
    expect(first).toMatchObject({ checkable: true, latest: "1.1.0", updateAvailable: true })
    expect(second).toMatchObject({ checkable: false, reason: "internal is published to https://npm.corp.example, not https://mirror.example.com/npm" })
  })
})

describe("bounded passes", () => {
  const names = Array.from({ length: 10 }, (_, i) => `pkg-${i}`)

  test("at most four lookups are in flight at once", async () => {
    let inFlight = 0
    let peak = 0
    const fetchLatest = async () => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await Bun.sleep(5)
      inFlight--
      return "1.0.0"
    }
    const result = await checkPluginPackages(names, { cachePath, fetchLatest })
    expect(Object.keys(result)).toHaveLength(10)
    expect(peak).toBe(4)
  })

  test("one deadline bounds the whole pass; what it cut short is recorded and nothing more is asked", async () => {
    const calls: string[] = []
    const fetchLatest = (name: string) => {
      calls.push(name)
      return new Promise<string>(() => {})
    }
    const started = Date.now()
    const result = await checkPluginPackages(names, { cachePath, fetchLatest, deadlineMs: 100, now: () => 7 })

    expect(Date.now() - started).toBeLessThan(1000)
    expect(calls).toHaveLength(4)
    for (const name of names) expect(result[name]).toMatchObject({ checkedAt: 7, error: expect.any(String) })
    expect(Object.keys(JSON.parse(readFileSync(cachePath, "utf8")).packages)).toHaveLength(10)
  })

  test("a registry that never answers holds a pass no longer than its deadline", async () => {
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
      const started = Date.now()
      const result = await checkPluginPackages(names, { cachePath, registry: `http://127.0.0.1:${hanging.port}`, deadlineMs: 200 })
      expect(Date.now() - started).toBeLessThan(2000)
      expect(hits.length).toBeLessThanOrEqual(4)
      expect(result["pkg-0"]?.error).toBeString()
    } finally {
      hanging.stop(true)
    }
  })

  test("clearing cancels a pass in flight without recording the cancelled lookups", async () => {
    const entry = installPackage(dir, { name: "slow", version: "0.1.0" })
    trackPlugins([{ name: "slow", path: entry, status: "active" }])
    const pending = refreshPluginUpdates({ cachePath, fetchLatest: () => new Promise<string>(() => {}) })
    await Bun.sleep(10)

    const started = Date.now()
    clearPluginUpdates()
    await pending

    expect(Date.now() - started).toBeLessThan(500)
    expect(getPluginUpdates()[0]?.checkedAt).toBeUndefined()
    expect(() => readFileSync(cachePath, "utf8")).toThrow()
  })

  test("one pass at a time: requests during a pass share one queued pass that sees the latest plugins", async () => {
    const first = installPackage(join(dir, "a"), { name: "first", version: "1.0.0" })
    const added = installPackage(join(dir, "b"), { name: "added", version: "1.0.0" })
    trackPlugins([{ name: "first", path: first, status: "active" }])
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: string[] = []
    let inFlight = 0
    let peak = 0
    const fetchLatest = async (name: string) => {
      calls.push(name)
      inFlight++
      peak = Math.max(peak, inFlight)
      await gate
      inFlight--
      return "2.0.0"
    }
    const options = { cachePath, fetchLatest }

    const running = refreshPluginUpdates(options)
    await Bun.sleep(10)
    trackPlugins([{ name: "first", path: first, status: "active" }, { name: "added", path: added, status: "active" }])
    const queued = refreshPluginUpdates(options)
    expect(refreshPluginUpdates(options)).toBe(queued)
    expect(calls).toEqual(["first"])

    release()
    await Promise.all([running, queued])

    expect(calls).toEqual(["first", "added"])
    expect(peak).toBe(1)
    expect(getPluginUpdates().map((plugin) => plugin.latest)).toEqual(["2.0.0", "2.0.0"])
  })
})

describe("stopUpdateCheck", () => {
  test("forgets the tracked plugins, so a later start checks nothing left from before", () => {
    const entry = installPackage(dir, { name: "left-over", version: "1.0.0" })
    trackPlugins([{ name: "left-over", path: entry, status: "active" }])
    expect(getPluginUpdates()).toHaveLength(1)

    stopUpdateCheck()

    expect(getPluginUpdates()).toEqual([])
  })
})
