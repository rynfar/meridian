/**
 * "Is this instance current?" — the registry half of build provenance.
 *
 * Meridian is long-lived, installed globally, and updated by hand. Instances
 * therefore sit on old versions for weeks without anyone noticing: a real
 * install on the maintainer's own machine was found nine days and three
 * releases stale, missing a fix for a bug that billed users for a discarded
 * model turn on every tool call. Nothing surfaced that, because nothing looked.
 *
 * So this looks — once a day, cached to disk, with a hard timeout, and never on
 * the request path. The answer lands in `/health` as `build.latest`, which the
 * site header already polls.
 *
 * Failure is always silent and always non-fatal. An offline instance keeps
 * reporting the last version it knew about rather than dropping the field,
 * because "I last saw 1.62.7" is more useful than nothing and cannot be
 * mistaken for "you are current".
 *
 * Opt out entirely with `MERIDIAN_NO_UPDATE_CHECK=1`.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { env, envBool } from "../env"
import { compareVersions } from "./buildInfo"

const PACKAGE_NAME = "@rynfar/meridian"
const DEFAULT_REGISTRY_URL = `https://registry.npmjs.org/-/package/${PACKAGE_NAME}/dist-tags`
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 5000

interface CacheFile {
  latest: string
  checkedAt: number
}

export interface UpdateCheckOptions {
  /** Cache location. Overridable so tests never touch the real cache. */
  cachePath?: string
  ttlMs?: number
  now?: () => number
  /** Injected in tests; the default hits the npm registry. */
  fetchLatest?: () => Promise<string | undefined>
  /** Called when a check resolves a version we did not already have. */
  onResolved?: (latest: string) => void
}

function defaultCachePath(): string {
  return env("UPDATE_CHECK_PATH") ?? join(homedir(), ".cache", "meridian", "update-check.json")
}

/** Registry lookup. Resolves undefined on any failure — never throws. */
async function fetchLatestFromRegistry(): Promise<string | undefined> {
  const url = env("UPDATE_CHECK_URL") ?? DEFAULT_REGISTRY_URL
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as { latest?: unknown }
    return typeof body?.latest === "string" ? body.latest : undefined
  } catch {
    return undefined
  }
}

async function readCache(path: string): Promise<CacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CacheFile>
    if (typeof parsed?.latest !== "string" || typeof parsed?.checkedAt !== "number") return undefined
    return { latest: parsed.latest, checkedAt: parsed.checkedAt }
  } catch {
    return undefined
  }
}

async function writeCache(path: string, value: CacheFile): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(value), "utf8")
  } catch {
    // A read-only or full cache dir costs us one extra registry hit per start.
  }
}

/**
 * Resolve the newest published version, preferring a fresh disk cache.
 *
 * Returns a stale cached value when the registry is unreachable — see the
 * module header for why that beats returning nothing.
 */
export async function checkForUpdate(options: UpdateCheckOptions = {}): Promise<string | undefined> {
  if (envBool("NO_UPDATE_CHECK")) return undefined

  const cachePath = options.cachePath ?? defaultCachePath()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const cached = await readCache(cachePath)

  if (cached && now() - cached.checkedAt < ttlMs && now() >= cached.checkedAt) {
    return cached.latest
  }

  const fetched = await (options.fetchLatest ?? fetchLatestFromRegistry)()
  if (!fetched) return cached?.latest

  // Registries can serve a stale mirror; never let one walk the known-latest
  // backwards, which would flip a genuine "update available" back to false.
  if (cached && compareVersions(fetched, cached.latest) < 0) return cached.latest

  await writeCache(cachePath, { latest: fetched, checkedAt: now() })
  return fetched
}

// --- Process-wide singleton used by the server ---

let latestVersion: string | undefined
let refreshTimer: ReturnType<typeof setInterval> | undefined

/** The last resolved published version, or undefined if not yet known. */
export function getLatestVersion(): string | undefined {
  return latestVersion
}

/**
 * Begin checking for updates in the background.
 *
 * Callers do not await this — startup never waits on the registry. The
 * returned promise settles after the first check purely so tests can act on a
 * resolved value instead of polling. The interval is unref'd so it cannot keep
 * a short-lived embedder's process alive.
 */
export function startUpdateCheck(options: UpdateCheckOptions = {}): Promise<void> {
  if (envBool("NO_UPDATE_CHECK") || refreshTimer) return Promise.resolve()

  const run = () =>
    checkForUpdate(options).then((latest) => {
      if (!latest || latest === latestVersion) return
      latestVersion = latest
      options.onResolved?.(latest)
    })

  const first = run()
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  refreshTimer = setInterval(() => void run(), ttlMs)
  refreshTimer.unref?.()
  return first
}

/** Stop the background refresh (shutdown, and between tests). */
export function stopUpdateCheck(): void {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = undefined
  latestVersion = undefined
}
