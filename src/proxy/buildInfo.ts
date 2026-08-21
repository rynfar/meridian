/**
 * Build provenance — what code is this process actually running?
 *
 * `/health` used to report `require("package.json").version` and nothing else.
 * That string is identical on a released tag and on a feature branch built from
 * the same commit, so an instance running uncommitted code reported the same
 * version as the published release. Drift was not merely unnoticed, it was
 * unobservable: a monitor, a downstream plugin, and the operator all saw
 * "1.62.7" whatever the working tree contained.
 *
 * This module answers the question the version string cannot: where did this
 * code come from, and is it current? `source` is derived (no configuration
 * required, so it is honest for every npm install); `sha`/`branch`/`dirty` are
 * stamped by whatever launches the process, and are simply absent otherwise.
 *
 * Pure module — every export is a function of its arguments plus `process.env`.
 * No I/O, no imports from server.ts or session/. The registry lookup that
 * supplies `latest` lives in updateCheck.ts.
 */

/**
 * Where the running code came from.
 * - `npm`   — resolved out of a node_modules install; version is trustworthy
 * - `local` — running from a checkout or a build output next to sources
 * - `dev`   — explicitly stamped as a development build by the launcher
 */
export type BuildSource = "npm" | "local" | "dev"

export interface BuildInfo {
  source: BuildSource
  /**
   * package.json version. Proof of what is running ONLY when source is "npm" —
   * otherwise it is the version the tree was last released at, which says
   * nothing about the commits on top of it.
   */
  version: string
  /** Commit the build came from, when the launcher stamped one. */
  sha?: string
  branch?: string
  /** True when the stamped tree had uncommitted changes at launch. */
  dirty?: boolean
  /** Newest published version, from the cached registry check. */
  latest?: string
  /** `latest` is strictly newer than `version`. Absent when unknown. */
  updateAvailable?: boolean
}

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  prerelease: string[]
}

const CORE_VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** Parse a semver string. Returns null for anything unrecognized. */
export function parseVersion(value: string): ParsedVersion | null {
  const match = CORE_VERSION.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  }
}

/** Semver identifier precedence: numeric < alphanumeric, numeric compares as a number. */
function comparePrereleaseIdentifiers(a: string[], b: string[]): number {
  // A version with a prerelease has LOWER precedence than one without.
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i]
    const right = b[i]
    // A larger set of identifiers wins when all preceding ones are equal.
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) return Number(left) < Number(right) ? -1 : 1
    if (leftNumeric) return -1
    if (rightNumeric) return 1
    return left < right ? -1 : 1
  }
  return 0
}

/**
 * Compare two semver strings: -1 if a < b, 1 if a > b, 0 if equal.
 *
 * Unparseable input compares equal, which makes every caller fail closed —
 * a malformed registry response must never be read as "you are out of date".
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  if (left.major !== right.major) return left.major < right.major ? -1 : 1
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1
  return comparePrereleaseIdentifiers(left.prerelease, right.prerelease)
}

/**
 * Is `latest` strictly newer than `current`?
 *
 * False when either is missing or unparseable, and false when the running
 * build is AHEAD of the registry — a local build of an unreleased commit is
 * drift worth reporting, but it is not an available update.
 */
export function isUpdateAvailable(current: string | undefined, latest: string | undefined): boolean {
  if (!current || !latest) return false
  return compareVersions(latest, current) > 0
}

/**
 * Derive the build source from the path this module was loaded from.
 *
 * Deliberately path-derived rather than configured: the overwhelming majority
 * of installs never set an env var, and a provenance field that only works when
 * someone remembers to populate it is the very failure this module exists to
 * fix. An explicit `MERIDIAN_BUILD_SOURCE` stamp still wins when present.
 */
export function detectBuildSource(modulePath: string, stamped?: string): BuildSource {
  if (stamped === "npm" || stamped === "local" || stamped === "dev") return stamped
  return modulePath.includes("node_modules") ? "npm" : "local"
}

function parseDirty(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  return value === "1" || value === "true" || value === "yes"
}

/**
 * Assemble the build block. `latest` comes from the caller (updateCheck's
 * cache) so this module stays free of I/O and its tests need no mocks.
 */
export function getBuildInfo(input: {
  version: string
  modulePath: string
  latest?: string
  env?: NodeJS.ProcessEnv
}): BuildInfo {
  const env = input.env ?? process.env
  const source = detectBuildSource(input.modulePath, env.MERIDIAN_BUILD_SOURCE)
  const sha = env.MERIDIAN_BUILD_SHA?.trim() || undefined
  const branch = env.MERIDIAN_BUILD_BRANCH?.trim() || undefined
  const dirty = parseDirty(env.MERIDIAN_BUILD_DIRTY)

  return {
    source,
    version: input.version,
    ...(sha ? { sha } : {}),
    ...(branch ? { branch } : {}),
    ...(dirty !== undefined ? { dirty } : {}),
    ...(input.latest ? { latest: input.latest } : {}),
    ...(input.latest ? { updateAvailable: isUpdateAvailable(input.version, input.latest) } : {}),
  }
}

/**
 * One-line human summary for the startup log — the operator-facing half of
 * this feature. Returns undefined when there is nothing worth saying (a
 * current npm install), so a healthy start stays quiet.
 */
export function describeBuildDrift(build: BuildInfo): string | undefined {
  if (build.source !== "npm") {
    const parts = [`running a ${build.source} build`]
    if (build.branch) parts.push(`branch ${build.branch}`)
    if (build.sha) parts.push(build.sha.slice(0, 8))
    if (build.dirty) parts.push("with uncommitted changes")
    // An embedder that never passed a version has no version string to be
    // misled by, so the warning about one would be noise.
    const suffix = build.version && build.version !== "unknown"
      ? ` — reported version ${build.version} is the tree's last release, not proof of what is running`
      : ""
    return `${parts.join(", ")}${suffix}`
  }
  if (build.updateAvailable) {
    return `update available: ${build.version} → ${build.latest}`
  }
  return undefined
}
