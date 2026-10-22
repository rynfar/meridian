/**
 * "Is each plugin current?" — the question updateCheck.ts asks for Meridian
 * itself, asked of every loaded plugin that comes from an npm package.
 *
 * A plugin is installed and updated by hand just like Meridian, and a stale
 * one goes unnoticed for the same reason: nothing looks. Some plugins are not
 * optional extras — a prompt scrub that keeps a client's requests accepted
 * fails every turn once it falls behind what the API expects — so the
 * instance that loads them is the natural place to say they are behind.
 *
 * Nothing here is specific to any plugin. A plugin's package is found the way
 * Node finds it: the nearest package.json above the file Meridian loaded,
 * which names the package and the version installed. A plugin that is a lone
 * file (dropped into the plugin directory, or a private package) has no
 * registry entry to compare with and is reported as not checkable.
 *
 * Restraint matches the Meridian check: it runs only behind the same
 * `checkForUpdates` setting and in the same background pass, asks for one
 * package's dist-tags at most once per interval however many plugins share
 * it, caches the answers to disk, and records a failure on the package it
 * belongs to instead of throwing. A failed check keeps the last version it
 * knew, for the same reason updateCheck.ts does.
 */
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { env } from "../env"
import { compareVersions, isUpdateAvailable } from "./buildInfo"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000
/** dist/index.js sits one or two levels under its package root; a few more covers nested builds. */
const MAX_PACKAGE_DEPTH = 4
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export interface PluginPackage {
  name: string
  version: string
}

export type PackageLookup = { package: PluginPackage } | { reason: string }

/** What one package's last check found. `checkedAt` is the last attempt, successful or not. */
export interface PackageCheck {
  latest?: string
  checkedAt: number
  error?: string
}

export interface PluginUpdate {
  /** The plugin's name as Meridian lists it. */
  name: string
  path: string
  status: string
  checkable: boolean
  /** Why it is not checkable. */
  reason?: string
  package?: string
  installed?: string
  latest?: string
  updateAvailable?: boolean
  checkedAt?: number
  error?: string
}

export interface PluginUpdateCheckOptions {
  /** Cache location. Overridable so tests never touch the real cache. */
  cachePath?: string
  ttlMs?: number
  now?: () => number
  /** Injected in tests; the default asks the npm registry. Throws to record a failure. */
  fetchLatest?: (packageName: string) => Promise<string>
  /** Rechecked before any request, so switching the check off mid-pass stops it. */
  enabled?: () => boolean
}

interface CacheFile {
  packages: Record<string, PackageCheck>
}

function defaultCachePath(): string {
  return env("PLUGIN_UPDATE_CHECK_PATH") ?? join(homedir(), ".cache", "meridian", "plugin-update-check.json")
}

function readManifest(file: string): PackageLookup | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  let parsed: { name?: unknown; version?: unknown; private?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return { reason: `${file} is not valid JSON` }
  }
  // A package.json without a name is a build marker such as {"type":"module"}
  // in dist/, not the package root: keep looking above it.
  if (typeof parsed.name !== "string") return undefined
  if (parsed.private === true) return { reason: `${parsed.name} is a private package` }
  if (!NPM_NAME.test(parsed.name)) return { reason: `${parsed.name} is not an npm package name` }
  if (typeof parsed.version !== "string") return { reason: `${parsed.name} declares no version` }
  return { package: { name: parsed.name, version: parsed.version } }
}

/**
 * The package a plugin file belongs to: the nearest package.json above it
 * that names one.
 *
 * The search never reaches the home directory, the plugin directory, or
 * anything above them: a package.json there describes whatever else lives in
 * that directory, not a plugin dropped into it.
 */
export function findPluginPackage(pluginPath: string, stopAt: readonly string[] = []): PackageLookup {
  const stops = [homedir(), ...stopAt].map((dir) => resolve(dir))
  const isStop = (dir: string) => stops.some((stop) => stop === dir || stop.startsWith(dir.endsWith(sep) ? dir : dir + sep))
  let dir = dirname(resolve(pluginPath))
  for (let depth = 0; depth < MAX_PACKAGE_DEPTH && !isStop(dir); depth++) {
    const found = readManifest(join(dir, "package.json"))
    if (found) return found
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return { reason: "not installed from an npm package" }
}

/** Registry lookup of one package's `latest` dist-tag. Throws with a readable reason. */
async function fetchLatestFromRegistry(packageName: string): Promise<string> {
  const registry = (env("UPDATE_CHECK_REGISTRY") ?? DEFAULT_REGISTRY).replace(/\/+$/, "")
  const response = await fetch(`${registry}/-/package/${packageName}/dist-tags`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`registry answered ${response.status}`)
  const body = (await response.json()) as { latest?: unknown }
  if (typeof body?.latest !== "string") throw new Error("registry lists no latest version")
  return body.latest
}

async function readCache(path: string): Promise<Record<string, PackageCheck>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>
    const packages: Record<string, PackageCheck> = {}
    for (const [name, entry] of Object.entries(parsed?.packages ?? {})) {
      if (typeof entry?.checkedAt !== "number") continue
      packages[name] = {
        checkedAt: entry.checkedAt,
        ...(typeof entry.latest === "string" ? { latest: entry.latest } : {}),
        ...(typeof entry.error === "string" ? { error: entry.error } : {}),
      }
    }
    return packages
  } catch {
    return {}
  }
}

async function writeCache(path: string, packages: Record<string, PackageCheck>): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ packages } satisfies CacheFile), "utf8")
  } catch {
    // A read-only or full cache dir costs one extra request per package per start.
  }
}

/**
 * Resolve `latest` for each package, preferring a fresh disk cache.
 *
 * One request per package whose cached answer is older than the TTL, made one
 * at a time. A failure is stored on its package with the last known version
 * kept, and retried at the next interval rather than at once.
 */
export async function checkPluginPackages(
  packageNames: readonly string[],
  options: PluginUpdateCheckOptions = {},
): Promise<Record<string, PackageCheck>> {
  const names = [...new Set(packageNames)]
  if (names.length === 0) return {}
  const enabled = options.enabled ?? (() => true)
  if (!enabled()) return {}

  const cachePath = options.cachePath ?? defaultCachePath()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const fetchLatest = options.fetchLatest ?? fetchLatestFromRegistry
  const cache = await readCache(cachePath)
  let fetched = false

  for (const name of names) {
    const cached = cache[name]
    if (cached && now() - cached.checkedAt < ttlMs && now() >= cached.checkedAt) continue
    if (!enabled()) break
    fetched = true
    try {
      const latest = await fetchLatest(name)
      // A stale mirror must not walk the known-latest backwards.
      const kept = cached?.latest && compareVersions(latest, cached.latest) < 0 ? cached.latest : latest
      cache[name] = { latest: kept, checkedAt: now() }
    } catch (err) {
      cache[name] = {
        ...(cached?.latest ? { latest: cached.latest } : {}),
        checkedAt: now(),
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }

  if (fetched) await writeCache(cachePath, cache)
  return Object.fromEntries(names.filter((name) => cache[name]).map((name) => [name, cache[name]!]))
}

// --- Process-wide state used by the server ---

interface TrackedPlugin {
  name: string
  path: string
  status: string
  lookup: PackageLookup
}

let tracked: TrackedPlugin[] = []
let results: Record<string, PackageCheck> = {}
// Bumped by every clear, so a pass still in flight when the check is switched
// off cannot publish its answers afterwards.
let generation = 0

/**
 * Record the plugins currently loaded, at start and after every reload.
 * `stopAt` names directories whose package.json never describes a plugin
 * (the plugin directory).
 */
export function trackPlugins(
  plugins: ReadonlyArray<{ name: string; path: string; status: string }>,
  stopAt: readonly string[] = [],
): void {
  tracked = plugins.map(({ name, path, status }) => ({ name, path, status, lookup: findPluginPackage(path, stopAt) }))
}

/** Check every tracked plugin's package and publish the answers. */
export async function refreshPluginUpdates(options: PluginUpdateCheckOptions = {}): Promise<void> {
  const started = generation
  const names = tracked.flatMap(({ lookup }) => ("package" in lookup ? [lookup.package.name] : []))
  const checked = await checkPluginPackages(names, options)
  if (started !== generation) return
  results = { ...results, ...checked }
}

/** Forget published answers (the check was switched off, or between tests). Tracked plugins stay. */
export function clearPluginUpdates(): void {
  results = {}
  generation++
}

/** Every loaded plugin with what the last check found for its package. */
export function getPluginUpdates(): PluginUpdate[] {
  return tracked.map(({ name, path, status, lookup }) => {
    const base = { name, path, status }
    if (!("package" in lookup)) return { ...base, checkable: false, reason: lookup.reason }
    const { name: packageName, version: installed } = lookup.package
    const check = results[packageName]
    return {
      ...base,
      checkable: true,
      package: packageName,
      installed,
      ...(check?.latest ? { latest: check.latest, updateAvailable: isUpdateAvailable(installed, check.latest) } : {}),
      ...(check ? { checkedAt: check.checkedAt } : {}),
      ...(check?.error ? { error: check.error } : {}),
    }
  })
}
