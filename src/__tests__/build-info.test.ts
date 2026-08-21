/**
 * Build provenance — pure unit tests, no mocks.
 *
 * The claim this module makes to a user is "you are out of date" or "this is
 * not a release". Both are load-bearing: the first tells someone to reinstall,
 * the second tells them the version string in front of them is not evidence.
 * A false positive on either is worse than staying silent, so the comparison
 * has to fail closed on anything it does not understand.
 */
import { describe, expect, test } from "bun:test"
import {
  compareVersions,
  describeBuildDrift,
  detectBuildSource,
  getBuildInfo,
  isUpdateAvailable,
  parseVersion,
} from "../proxy/buildInfo"

describe("parseVersion", () => {
  test("parses plain and prerelease versions, with or without a v prefix", () => {
    expect(parseVersion("1.62.7")).toEqual({ major: 1, minor: 62, patch: 7, prerelease: [] })
    expect(parseVersion("v1.62.7")).toEqual({ major: 1, minor: 62, patch: 7, prerelease: [] })
    expect(parseVersion("2.0.0-rc.1")).toEqual({ major: 2, minor: 0, patch: 0, prerelease: ["rc", "1"] })
    // Build metadata is not part of precedence and is discarded.
    expect(parseVersion("1.0.0+build.5")).toEqual({ major: 1, minor: 0, patch: 0, prerelease: [] })
  })

  test("rejects anything that is not a semver triple", () => {
    for (const bad of ["", "latest", "1.62", "1.62.x", "not-a-version", "1.2.3.4", "{}"]) {
      expect(parseVersion(bad), bad).toBeNull()
    }
  })
})

describe("compareVersions", () => {
  test("orders by major, then minor, then patch", () => {
    expect(compareVersions("1.62.7", "2.0.0")).toBe(-1)
    expect(compareVersions("1.62.7", "1.63.0")).toBe(-1)
    expect(compareVersions("1.62.7", "1.62.8")).toBe(-1)
    expect(compareVersions("1.63.0", "1.62.9")).toBe(1)
    expect(compareVersions("1.62.7", "1.62.7")).toBe(0)
  })

  test("does not compare version segments as strings", () => {
    // The bug this guards: "1.9.0" > "1.10.0" under lexical comparison, which
    // would tell every user on 1.9.x that they are already current forever.
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1)
    expect(compareVersions("1.62.7", "1.100.0")).toBe(-1)
    expect(compareVersions("9.0.0", "10.0.0")).toBe(-1)
  })

  test("a prerelease has lower precedence than its release", () => {
    expect(compareVersions("2.0.0-rc.1", "2.0.0")).toBe(-1)
    expect(compareVersions("2.0.0", "2.0.0-rc.1")).toBe(1)
    expect(compareVersions("2.0.0-rc.1", "2.0.0-rc.2")).toBe(-1)
    expect(compareVersions("2.0.0-alpha", "2.0.0-beta")).toBe(-1)
    // Numeric identifiers rank below alphanumeric ones, per semver.
    expect(compareVersions("2.0.0-1", "2.0.0-alpha")).toBe(-1)
    // A longer identifier set wins when the shared prefix is equal.
    expect(compareVersions("2.0.0-rc.1", "2.0.0-rc.1.1")).toBe(-1)
  })

  test("unparseable input compares equal so callers fail closed", () => {
    expect(compareVersions("garbage", "1.62.7")).toBe(0)
    expect(compareVersions("1.62.7", "garbage")).toBe(0)
    expect(compareVersions("", "")).toBe(0)
  })
})

describe("isUpdateAvailable", () => {
  test("true only when the registry is strictly ahead", () => {
    expect(isUpdateAvailable("1.62.7", "1.63.0")).toBe(true)
    expect(isUpdateAvailable("1.62.7", "1.62.7")).toBe(false)
  })

  test("a build ahead of the registry is not an available update", () => {
    // An unreleased local build must not be told to downgrade to `latest`.
    expect(isUpdateAvailable("1.63.0", "1.62.7")).toBe(false)
  })

  test("never claims an update from missing or malformed input", () => {
    expect(isUpdateAvailable(undefined, "1.63.0")).toBe(false)
    expect(isUpdateAvailable("1.62.7", undefined)).toBe(false)
    expect(isUpdateAvailable("1.62.7", "")).toBe(false)
    expect(isUpdateAvailable("1.62.7", "not-a-version")).toBe(false)
  })
})

describe("detectBuildSource", () => {
  test("a node_modules path is an npm install", () => {
    expect(detectBuildSource("file:///Users/x/.volta/tools/image/packages/@rynfar/meridian/lib/node_modules/@rynfar/meridian/dist/server.js")).toBe("npm")
    expect(detectBuildSource("/app/node_modules/@rynfar/meridian/dist/server.js")).toBe("npm")
  })

  test("a checkout path is a local build", () => {
    expect(detectBuildSource("file:///Users/x/repos/meridian/dist/server.js")).toBe("local")
    expect(detectBuildSource("/Users/x/repos/meridian/src/proxy/server.ts")).toBe("local")
  })

  test("an explicit stamp wins over path detection", () => {
    expect(detectBuildSource("/app/node_modules/@rynfar/meridian/dist/server.js", "dev")).toBe("dev")
    expect(detectBuildSource("/Users/x/repos/meridian/dist/server.js", "npm")).toBe("npm")
  })

  test("an unrecognized stamp falls back to path detection rather than trusting it", () => {
    expect(detectBuildSource("/app/node_modules/m/dist/server.js", "production")).toBe("npm")
    expect(detectBuildSource("/Users/x/repos/meridian/dist/server.js", "")).toBe("local")
  })
})

describe("getBuildInfo", () => {
  const npmPath = "/app/node_modules/@rynfar/meridian/dist/server.js"
  const repoPath = "/Users/x/repos/meridian/dist/server.js"

  test("a bare npm install reports source and version only", () => {
    const build = getBuildInfo({ version: "1.62.7", modulePath: npmPath, env: {} })
    expect(build).toEqual({ source: "npm", version: "1.62.7" })
  })

  test("omits update fields entirely until the registry answers", () => {
    // Absent, not `false` — "we have not checked" and "you are current" are
    // different claims, and the header renders them differently.
    const build = getBuildInfo({ version: "1.62.7", modulePath: npmPath, env: {} })
    expect(build).not.toHaveProperty("latest")
    expect(build).not.toHaveProperty("updateAvailable")
  })

  test("surfaces launcher stamps when present", () => {
    const build = getBuildInfo({
      version: "1.62.7",
      modulePath: repoPath,
      env: {
        MERIDIAN_BUILD_SOURCE: "dev",
        MERIDIAN_BUILD_SHA: "f664db51aa",
        MERIDIAN_BUILD_BRANCH: "feat/thing",
        MERIDIAN_BUILD_DIRTY: "1",
      },
    })
    expect(build).toEqual({
      source: "dev",
      version: "1.62.7",
      sha: "f664db51aa",
      branch: "feat/thing",
      dirty: true,
    })
  })

  test("reports a resolved update", () => {
    const build = getBuildInfo({ version: "1.62.7", modulePath: npmPath, latest: "1.63.0", env: {} })
    expect(build.latest).toBe("1.63.0")
    expect(build.updateAvailable).toBe(true)
  })

  test("reports being current without claiming an update", () => {
    const build = getBuildInfo({ version: "1.63.0", modulePath: npmPath, latest: "1.63.0", env: {} })
    expect(build.latest).toBe("1.63.0")
    expect(build.updateAvailable).toBe(false)
  })

  test("blank stamps are treated as absent, not as empty strings", () => {
    const build = getBuildInfo({
      version: "1.62.7",
      modulePath: npmPath,
      env: { MERIDIAN_BUILD_SHA: "   ", MERIDIAN_BUILD_BRANCH: "" },
    })
    expect(build).not.toHaveProperty("sha")
    expect(build).not.toHaveProperty("branch")
  })
})

describe("describeBuildDrift", () => {
  test("says nothing about a current npm install", () => {
    expect(describeBuildDrift({ source: "npm", version: "1.63.0", latest: "1.63.0", updateAvailable: false }))
      .toBeUndefined()
    expect(describeBuildDrift({ source: "npm", version: "1.63.0" })).toBeUndefined()
  })

  test("warns that a non-npm build's version is not evidence", () => {
    const message = describeBuildDrift({
      source: "dev",
      version: "1.62.7",
      branch: "feat/thing",
      sha: "f664db51aabbcc",
      dirty: true,
    })
    expect(message).toContain("dev build")
    expect(message).toContain("feat/thing")
    expect(message).toContain("f664db51")
    expect(message).toContain("uncommitted changes")
    expect(message).toContain("not proof of what is running")
  })

  test("reports an available update on an npm install", () => {
    expect(describeBuildDrift({ source: "npm", version: "1.62.7", latest: "1.63.0", updateAvailable: true }))
      .toBe("update available: 1.62.7 → 1.63.0")
  })

  test("drops the version warning when there is no version to be misled by", () => {
    // Library embedders may never pass one; warning about a string they never
    // saw is noise on every start.
    const message = describeBuildDrift({ source: "local", version: "unknown" })
    expect(message).toBe("running a local build")
    expect(describeBuildDrift({ source: "local", version: "" })).toBe("running a local build")
  })

  test("build-source drift outranks an available update", () => {
    // Telling someone running uncommitted code to `npm i -g` is the wrong
    // instruction; the provenance problem is the one to report.
    const message = describeBuildDrift({ source: "local", version: "1.62.7", latest: "1.63.0", updateAvailable: true })
    expect(message).toContain("local build")
    expect(message).not.toContain("update available")
  })
})
