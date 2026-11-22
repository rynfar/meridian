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
 *
 * Package names leave the machine only for the registry the operator chose:
 * an instance pointed at a mirror for Meridian's own check, with no registry
 * named for plugins, checks no plugin rather than asking the public one, and a
 * package published to another registry is not checkable. A pass is bounded
 * by one fetch timeout however many plugins are loaded, and only one runs at
 * a time. See src/proxy/plugins/SPEC.md.
 */
import { readFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { env } from "../env"
import { compareVersions, isUpdateAvailable } from "./buildInfo"

const DEFAULT_REGISTRY = "https://registry.npmjs.org"
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
/** One deadline for the whole pass, the same as one Meridian lookup. */
const PASS_DEADLINE_MS = 5000
/** Lookups in flight at once within a pass. */
const CONCURRENCY = 4
/** dist/index.js sits one or two levels under its package root; a few more covers nested builds. */
const MAX_PACKAGE_DEPTH = 4
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const MIRROR_WITHOUT_REGISTRY = "set MERIDIAN_UPDATE_CHECK_REGISTRY to check plugins through your mirror"

export interface PluginPackage {
  name: string
  version: string
  /** `publishConfig.registry`, when the package names one. */
  publishRegistry?: string
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
  /** Injected in tests; the default asks the registry. Throws to record a failure. */
  fetchLatest?: (packageName: string, signal: AbortSignal) => Promise<string>
  /** Rechecked before any request, so switching the check off mid-pass stops it. */
  enabled?: () => boolean
  /** Registry base URL for the default lookup; a pass passes the configured one. */
  registry?: string
  /** Deadline for the whole pass; a lookup still pending then is recorded as failed. */
  deadlineMs?: number
  /** Cancels the pass: nothing more is asked, and a cancelled lookup records nothing. */
  signal?: AbortSignal
}

interface CacheFile {
  packages: Record<string, PackageCheck>
}

function defaultCachePath(): string {
  return env("PLUGIN_UPDATE_CHECK_PATH") ?? join(homedir(), ".cache", "meridian", "plugin-update-check.json")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readManifest(file: string): PackageLookup | undefined {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { reason: `${file} is not valid JSON` }
  }
  if (!isRecord(parsed)) return { reason: `${file} is not a JSON object` }
  // A package.json without a name is a build marker such as {"type":"module"}
  // in dist/, not the package root: keep looking above it.
  if (typeof parsed.name !== "string") return undefined
  if (parsed.private === true) return { reason: `${parsed.name} is a private package` }
  if (!NPM_NAME.test(parsed.name)) return { reason: `${parsed.name} is not an npm package name` }
  if (typeof parsed.version !== "string") return { reason: `${parsed.name} declares no version` }
  const publishRegistry = isRecord(parsed.publishConfig) && typeof parsed.publishConfig.registry === "string"
    ? parsed.publishConfig.registry
    : undefined
  return { package: { name: parsed.name, version: parsed.version, ...(publishRegistry ? { publishRegistry } : {}) } }
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

/**
 * The registry plugin packages are checked against, or why none may be asked.
 *
 * `MERIDIAN_UPDATE_CHECK_URL` alone means the operator routes Meridian's own
 * check through a mirror; a registry for plugins cannot be derived from that
 * URL, and the public one is exactly what they routed around.
 */
export function pluginRegistry(): { registry: string } | { reason: string } {
  const configured = env("UPDATE_CHECK_REGISTRY")
  if (configured) return { registry: configured.replace(/\/+$/, "") }
  if (env("UPDATE_CHECK_URL")) return { reason: MIRROR_WITHOUT_REGISTRY }
  return { registry: DEFAULT_REGISTRY }
}

function registryKey(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "")
  try {
    const parsed = new URL(trimmed)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`
  } catch {
    return trimmed
  }
}

/** Why a package cannot be checked against `registry`, or undefined when it can. */
function registryMismatch(pkg: PluginPackage, registry: string): string | undefined {
  if (!pkg.publishRegistry) return undefined
  const published = registryKey(pkg.publishRegistry)
  if (published === registryKey(DEFAULT_REGISTRY) || published === registryKey(registry)) return undefined
  return `${pkg.name} is published to ${pkg.publishRegistry}, not ${registry}`
}

/** Registry lookup of one package's `latest` dist-tag. Throws with a readable reason. */
async function fetchLatestFromRegistry(registry: string, packageName: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${registry.replace(/\/+$/, "")}/-/package/${packageName}/dist-tags`, {
    headers: { accept: "application/json" },
    signal,
  })
  if (!response.ok) throw new Error(`registry answered ${response.status}`)
  const body = (await response.json()) as { latest?: unknown }
  if (typeof body?.latest !== "string") throw new Error("registry lists no latest version")
  return body.latest
}

/** `work`, or the signal's reason as soon as it aborts, whichever comes first. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    work.then(resolvePromise, rejectPromise).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function describeFailure(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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
 * One request per package whose cached answer is older than the TTL, at most
 * CONCURRENCY at once, all under one deadline. A failure — including a lookup
 * the deadline cut short — is stored on its package with the last known
 * version kept, and retried at the next interval rather than at once.
 */
export async function checkPluginPackages(
  packageNames: readonly string[],
  options: PluginUpdateCheckOptions = {},
): Promise<Record<string, PackageCheck>> {
  const names = [...new Set(packageNames)]
  if (names.length === 0) return {}
  const enabled = options.enabled ?? (() => true)
  const cancelled = () => options.signal?.aborted === true
  if (!enabled() || cancelled()) return {}

  const cachePath = options.cachePath ?? defaultCachePath()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const registry = options.registry ?? DEFAULT_REGISTRY
  const fetchLatest = options.fetchLatest ?? ((name: string, signal: AbortSignal) => fetchLatestFromRegistry(registry, name, signal))
  const cache = await readCache(cachePath)
  const due = names.filter((name) => {
    const cached = cache[name]
    return !(cached && now() - cached.checkedAt < ttlMs && now() >= cached.checkedAt)
  })
  let fetched = false

  if (due.length > 0) {
    const deadline = AbortSignal.timeout(options.deadlineMs ?? PASS_DEADLINE_MS)
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
    let next = 0
    const worker = async () => {
      while (next < due.length && enabled() && !cancelled()) {
        const name = due[next++]!
        const cached = cache[name]
        try {
          // Past the deadline nothing more is asked; the package records the timeout.
          if (signal.aborted) throw signal.reason
          const latest = await untilAborted(fetchLatest(name, signal), signal)
          // A stale mirror must not walk the known-latest backwards.
          const kept = cached?.latest && compareVersions(latest, cached.latest) < 0 ? cached.latest : latest
          cache[name] = { latest: kept, checkedAt: now() }
          fetched = true
        } catch (err) {
          // Cancelled, not failed: the next pass asks again.
          if (cancelled()) return
          cache[name] = {
            ...(cached?.latest ? { latest: cached.latest } : {}),
            checkedAt: now(),
            error: describeFailure(err),
          }
          fetched = true
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, due.length) }, worker))
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
let running: { promise: Promise<void>; controller: AbortController } | undefined
let queued: Promise<void> | undefined

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

/** The package a tracked plugin is checked as, or why it cannot be. */
function checkTarget(lookup: PackageLookup, registry: { registry: string } | { reason: string }): { package: PluginPackage } | { reason: string; package?: PluginPackage } {
  if (!("package" in lookup)) return lookup
  if ("reason" in registry) return { reason: registry.reason, package: lookup.package }
  const mismatch = registryMismatch(lookup.package, registry.registry)
  return mismatch ? { reason: mismatch, package: lookup.package } : lookup
}

async function runPass(options: PluginUpdateCheckOptions, signal: AbortSignal): Promise<void> {
  const started = generation
  const registry = pluginRegistry()
  if ("reason" in registry) return
  const names = tracked.flatMap(({ lookup }) => {
    const target = checkTarget(lookup, registry)
    return "reason" in target ? [] : [target.package.name]
  })
  const checked = await checkPluginPackages(names, { registry: registry.registry, ...options, signal })
  if (started !== generation) return
  results = { ...results, ...checked }
}

/**
 * Check every tracked plugin's package and publish the answers.
 *
 * One pass at a time: a request while one runs is served by a single pass
 * queued behind it, so a reload during a pass still sees its new plugins.
 */
export function refreshPluginUpdates(options: PluginUpdateCheckOptions = {}): Promise<void> {
  if (!running) {
    const controller = new AbortController()
    const promise = runPass(options, controller.signal).finally(() => {
      if (running?.controller === controller) running = undefined
    })
    running = { promise, controller }
    return promise
  }
  if (queued) return queued
  const started = generation
  const next: Promise<void> = running.promise.then(() => {
    if (queued === next) queued = undefined
    if (started !== generation) return
    return refreshPluginUpdates(options)
  })
  queued = next
  return next
}

/**
 * Forget published answers and cancel a pass in flight (the check was
 * switched off, or between tests). Tracked plugins stay.
 */
export function clearPluginUpdates(): void {
  running?.controller.abort()
  running = undefined
  queued = undefined
  results = {}
  generation++
}

/** Forget the tracked plugins as well (shutdown, and between tests). */
export function resetPluginUpdates(): void {
  clearPluginUpdates()
  tracked = []
}

/** Every loaded plugin with what the last check found for its package. */
export function getPluginUpdates(): PluginUpdate[] {
  const registry = pluginRegistry()
  return tracked.map(({ name, path, status, lookup }) => {
    const base = { name, path, status }
    const target = checkTarget(lookup, registry)
    if ("reason" in target) {
      return {
        ...base,
        checkable: false,
        reason: target.reason,
        ...(target.package ? { package: target.package.name, installed: target.package.version } : {}),
      }
    }
    const { name: packageName, version: installed } = target.package
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
