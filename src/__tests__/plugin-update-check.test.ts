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

let dir: string
let cachePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "meridian-plugin-update-"))
  cachePath = join(dir, "cache", "plugin-update-check.json")
  clearPluginUpdates()
  trackPlugins([])
})

afterEach(() => {
  clearPluginUpdates()
  trackPlugins([])
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
