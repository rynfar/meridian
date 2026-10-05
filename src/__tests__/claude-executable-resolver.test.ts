/**
 * Unit tests for `resolveClaudeExecutable` — the pure resolver underlying
 * `resolveClaudeExecutableAsync`. These tests inject mock dependencies so
 * we can simulate Windows behavior, missing binaries, broken stubs, and
 * various PATH-lookup edge cases without touching the real filesystem.
 *
 * Covers the issue space documented in #417 (Windows resolver) and #445
 * (postinstall-broken stub).
 */
import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname, delimiter } from "path"
import {
  probeClaudeVersion,
  probeClaudeVersionSync,
  resolveClaudeExecutable,
  resolveClaudeExecutableWithSource,
  resolveClaudeExecutableSync,
} from "../proxy/models"

// `path.join` produces backslashed paths on Windows and slash-separated paths
// on POSIX. Tests use `J(...)` and `BIN(pkgJson, ...rest)` everywhere a path
// is constructed so expected values match exactly what the resolver builds via
// the host's `path.join`, regardless of platform. (Capital names avoid
// shadowing the common `p =>` arg name.)
const J = (...parts: string[]) => join(...parts)
const BIN = (pkgJson: string, ...rest: string[]) => join(dirname(pkgJson), ...rest)

type Deps = Parameters<typeof resolveClaudeExecutable>[0]

/**
 * Builds a minimal-deps stub for a single test case. Each filesystem
 * predicate / package resolution / exec call is configurable; defaults
 * mimic an empty environment where everything misses.
 */
function makeDeps(overrides: Partial<NonNullable<Deps>> = {}): NonNullable<Deps> {
  return {
    existsSync: () => false,
    statSync: () => ({ size: 0 }),
    exec: async () => ({ stdout: "" }),
    execLookupSync: () => "",
    resolvePackage: (specifier) => {
      throw new Error(`mock: not configured to resolve ${specifier}`)
    },
    envGet: () => undefined,
    platform: "darwin",
    arch: "arm64",
    isBun: false,
    ...overrides,
  }
}

describe("resolveClaudeExecutable: env override", () => {
  it("returns MERIDIAN_CLAUDE_PATH when set and the file exists", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/custom/claude" : undefined),
      existsSync: (p) => p === "/custom/claude",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/custom/claude")
  })

  it("falls through when MERIDIAN_CLAUDE_PATH is set but the file is missing", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/nope" : undefined),
      existsSync: () => false,
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("ignores empty string env value", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "" : undefined),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: bundled binary with stub-size guard", () => {
  it("returns the bundled binary when it exists and is the real ~200 MB binary", async () => {
    const pkgJson = "/lib/node_modules/@anthropic-ai/claude-code/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 213_404_000 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe(expectedBin)
  })

  it("skips the bundled binary when it is the ~500 byte stub (postinstall failed)", async () => {
    // This is the issue #445 scenario: install.cjs threw, the stub was
    // never replaced. Resolver must NOT hand back the broken stub.
    const pkgJson = "/m/claude-code/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 512 }), // stub
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("treats files at the 4 KB threshold as a stub (boundary check)", async () => {
    // Only the bundled package resolves; subsequent steps must miss so
    // the test isolates the stub-guard behavior.
    const pkgJson = "/m/claude-code/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 4096 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("treats files just above 4 KB as a real binary", async () => {
    const pkgJson = "/m/claude-code/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 4097 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe(expectedBin)
  })

  it("falls through when the package itself can't be resolved", async () => {
    const deps = makeDeps({
      resolvePackage: () => {
        throw new Error("not found")
      },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: platform-specific peer package", () => {
  it("falls back to claude-code-darwin-arm64 when bundled stub is broken", async () => {
    // Simulates issue #445 on macOS: bundled stub is 500 bytes (skipped),
    // but the platform-specific package binary is intact (~200 MB).
    const bundledPkg = "/m/claude-code/package.json"
    const platformPkg = "/m/claude-code-darwin-arm64/package.json"
    const stubPath = BIN(bundledPkg, "bin", "claude.exe")
    const platformBin = BIN(platformPkg, "claude")
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return bundledPkg
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return platformPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === stubPath || p === platformBin,
      statSync: () => ({ size: 500 }), // bundled is stub
    })
    expect(await resolveClaudeExecutable(deps)).toBe(platformBin)
  })

  it("uses claude.exe filename on win32-x64", async () => {
    const platformPkg = "/m/claude-code-win32-x64/package.json"
    const platformBin = BIN(platformPkg, "claude.exe")
    const deps = makeDeps({
      platform: "win32",
      arch: "x64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-win32-x64/package.json") return platformPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === platformBin,
    })
    expect(await resolveClaudeExecutable(deps)).toBe(platformBin)
  })

  it("works on win32-arm64 too", async () => {
    const platformPkg = "/m/claude-code-win32-arm64/package.json"
    const platformBin = BIN(platformPkg, "claude.exe")
    const deps = makeDeps({
      platform: "win32",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-win32-arm64/package.json") return platformPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === platformBin,
    })
    expect(await resolveClaudeExecutable(deps)).toBe(platformBin)
  })

  it("on linux, also tries the -musl variant", async () => {
    const muslPkg = "/m/claude-code-linux-x64-musl/package.json"
    const muslBin = BIN(muslPkg, "claude")
    const deps = makeDeps({
      platform: "linux",
      arch: "x64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-linux-x64/package.json") throw new Error("not installed")
        if (s === "@anthropic-ai/claude-code-linux-x64-musl/package.json") return muslPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === muslBin,
    })
    expect(await resolveClaudeExecutable(deps)).toBe(muslBin)
  })

  it("returns null when no platform package resolves", async () => {
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: () => { throw new Error("not installed") },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: PATH lookup", () => {
  it("uses `where` on Windows", async () => {
    let capturedCmd = ""
    const deps = makeDeps({
      platform: "win32",
      arch: "x64",
      exec: async (cmd) => {
        capturedCmd = cmd
        return { stdout: "C:\\Users\\me\\nodejs\\claude.exe\r\n" }
      },
      existsSync: (p) => p === "C:\\Users\\me\\nodejs\\claude.exe",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("C:\\Users\\me\\nodejs\\claude.exe")
    expect(capturedCmd).toBe("where claude")
  })

  it("uses `which` on POSIX", async () => {
    let capturedCmd = ""
    const deps = makeDeps({
      platform: "darwin",
      exec: async (cmd) => {
        capturedCmd = cmd
        return { stdout: "/usr/local/bin/claude\n" }
      },
      existsSync: (p) => p === "/usr/local/bin/claude",
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/usr/local/bin/claude")
    expect(capturedCmd).toBe("which claude")
  })

  it("on Windows, picks the first existing path from a multi-line `where` output", async () => {
    const deps = makeDeps({
      platform: "win32",
      exec: async () => ({
        stdout:
          "C:\\Old\\nodejs\\claude.exe\r\n" +
          "C:\\Users\\me\\nodejs\\claude.exe\r\n" +
          "C:\\Other\\claude.exe\r\n",
      }),
      existsSync: (p) =>
        p === "C:\\Users\\me\\nodejs\\claude.exe" || p === "C:\\Other\\claude.exe",
    })
    // First match-and-exists wins.
    expect(await resolveClaudeExecutable(deps)).toBe("C:\\Users\\me\\nodejs\\claude.exe")
  })

  it("on Windows, filters out mingw-style paths emitted by Git-for-Windows `which.exe`", async () => {
    // This is the exact #417 reporter-described case: Git Bash's `which`
    // emits `/c/...` style paths that Node's `existsSync` rejects.
    // Our implementation uses `where` (cmd builtin), but ALSO defends
    // against ever feeding a /-prefixed path to existsSync on Windows.
    const deps = makeDeps({
      platform: "win32",
      exec: async () => ({ stdout: "/c/nvm4w/nodejs/claude\r\n" }),
      // existsSync would return false for the mingw path anyway, but
      // assert we never try it.
      existsSync: (p) => {
        if (p.startsWith("/c/")) {
          throw new Error("must not call existsSync with mingw-style path on Windows")
        }
        return false
      },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("returns null when the lookup command throws", async () => {
    const deps = makeDeps({
      exec: async () => {
        throw new Error("which: command not found")
      },
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("returns null when stdout is empty", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })

  it("returns null when stdout has only whitespace", async () => {
    const deps = makeDeps({
      exec: async () => ({ stdout: "\n   \r\n  \n" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: legacy SDK cli.js (bun only)", () => {
  it("returns the SDK cli.js when running under bun", async () => {
    const sdkIndex = "/m/claude-agent-sdk/index.js"
    const expectedCli = J(dirname(sdkIndex), "cli.js")
    const deps = makeDeps({
      isBun: true,
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk") return sdkIndex
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedCli,
    })
    expect(await resolveClaudeExecutable(deps)).toBe(expectedCli)
  })

  it("skips the SDK cli.js when not under bun (won't exec js as binary)", async () => {
    const deps = makeDeps({
      isBun: false,
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk") return "/m/claude-agent-sdk/index.js"
        throw new Error("not configured")
      },
      existsSync: () => true, // even if file exists, skip it on non-bun
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

describe("resolveClaudeExecutable: priority ordering", () => {
  for (const sync of [false, true]) {
    it(`shares the lookup/probe budget across Windows candidates (${sync ? "sync" : "async"})`, async () => {
      let now = 0
      const calls: Array<{ candidate: string; timeoutMs: number | undefined }> = []
      const warnings: string[] = []
      const output = "C:\\First\\claude.exe\nC:\\Second\\claude.exe\nC:\\Third\\claude.exe\n"
      const lookup = () => { now += 2_000; return output }
      const probe = (candidate: string, timeoutMs?: number) => {
        calls.push({ candidate, timeoutMs })
        now += calls.length === 1 ? 30_000 : (timeoutMs ?? 45_000)
        return { usable: false as const, reason: "no answer" }
      }
      const deps = makeDeps({
        platform: "win32", existsSync: () => true,
        statSync: () => ({ size: 200_000_000 }),
        resolvePackage: () => "/m/cc/package.json",
        exec: async () => ({ stdout: lookup() }),
        execLookupSync: lookup,
        probeClaude: async (candidate, timeoutMs) => probe(candidate, timeoutMs),
        probeClaudeSync: probe,
        now: () => now,
        warn: message => warnings.push(message),
      })
      const resolved = sync ? resolveClaudeExecutableSync(deps) : await resolveClaudeExecutableWithSource(deps)
      expect(resolved?.source).toBe("bundled")
      expect(calls).toEqual([
        { candidate: "C:\\First\\claude.exe", timeoutMs: 43_000 },
        { candidate: "C:\\Second\\claude.exe", timeoutMs: 13_000 },
      ])
      expect(now).toBe(45_000)
      expect(warnings.at(-1)).toContain("45s PATH lookup/probe budget is exhausted")
    })
  }

  it("keeps the packaged fallback when the PATH entry cannot run Claude, and says why", async () => {
    const bundledPkg = "/m/cc/package.json"
    const warnings: string[] = []
    const refused = { usable: false as const, reason: "`--version` exited with code 1" }
    const deps = makeDeps({
      existsSync: () => true,
      statSync: () => ({ size: 200_000_000 }),
      resolvePackage: () => bundledPkg,
      exec: async () => ({ stdout: "/mise/shims/claude\n" }),
      execLookupSync: () => "/mise/shims/claude\n",
      probeClaude: async candidate => { expect(candidate).toBe("/mise/shims/claude"); return refused },
      probeClaudeSync: candidate => { expect(candidate).toBe("/mise/shims/claude"); return refused },
      warn: message => { warnings.push(message) },
    })
    const expected = { path: BIN(bundledPkg, "bin", "claude.exe"), source: "bundled" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
    const passedOver = "[PROXY] Not using the claude found on PATH at /mise/shims/claude: `--version` exited with code 1. " +
      "Falling back to the next Claude Code installation; set MERIDIAN_CLAUDE_PATH to choose one explicitly."
    expect(warnings).toEqual([passedOver, passedOver])
  })

  it("tries the next Windows PATH candidate after a broken launcher", async () => {
    const output = "C:\\Broken\\claude.cmd\r\nC:\\Native\\claude.exe\r\n"
    const verdict = (candidate: string) => candidate.endsWith(".exe")
      ? { usable: true as const }
      : { usable: false as const, reason: "`--version` exited with code 1" }
    const deps = makeDeps({
      platform: "win32", existsSync: () => true,
      exec: async () => ({ stdout: output }), execLookupSync: () => output,
      probeClaude: async candidate => verdict(candidate),
      probeClaudeSync: verdict,
    })
    const expected = { path: "C:\\Native\\claude.exe", source: "path-lookup" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
  })

  it("keeps a PATH entry that was slow to answer, and says how long it took", async () => {
    const warnings: string[] = []
    const slow = { usable: true as const, elapsedMs: 31_000 }
    const deps = makeDeps({
      existsSync: () => true,
      statSync: () => ({ size: 200_000_000 }),
      resolvePackage: () => "/m/cc/package.json",
      exec: async () => ({ stdout: "/opt/homebrew/bin/claude\n" }),
      execLookupSync: () => "/opt/homebrew/bin/claude\n",
      probeClaude: async () => slow,
      probeClaudeSync: () => slow,
      warn: message => { warnings.push(message) },
    })
    const expected = { path: "/opt/homebrew/bin/claude", source: "path-lookup" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
    const tookLong = "[PROXY] The claude found on PATH at /opt/homebrew/bin/claude took 31.0s to answer `--version`, likely a cold start; using it."
    expect(warnings).toEqual([tookLong, tookLong])
  })

  it("env override beats every other source", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/explicit/claude" : undefined),
      existsSync: () => true, // every other source would also "succeed"
      resolvePackage: () => "/some/other/path/package.json",
      statSync: () => ({ size: 213_404_000 }),
    })
    expect(await resolveClaudeExecutable(deps)).toBe("/explicit/claude")
  })

  it("PATH installation beats a real bundled binary and platform package", async () => {
    const bundledPkg = "/m/cc/package.json"
    const expectedBin = BIN(bundledPkg, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return bundledPkg
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return "/m/cc-d-a/package.json"
        throw new Error("not configured")
      },
      existsSync: () => true,
      statSync: () => ({ size: 213_404_000 }), // bundled is real
      exec: async () => ({ stdout: "/usr/local/bin/claude\n" }),
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({ path: "/usr/local/bin/claude", source: "path-lookup" })
  })

  it("PATH installation beats the platform package when bundled is a stub", async () => {
    const bundledPkg = "/m/cc/package.json"
    const platformPkg = "/m/cc-d-a/package.json"
    const platformBin = BIN(platformPkg, "claude")
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return bundledPkg
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return platformPkg
        throw new Error("not configured")
      },
      existsSync: () => true,
      statSync: () => ({ size: 500 }), // stub
      exec: async () => ({ stdout: "/usr/local/bin/claude\n" }),
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({ path: "/usr/local/bin/claude", source: "path-lookup" })
  })

  it("returns null when ALL sources miss", async () => {
    const deps = makeDeps({
      envGet: () => undefined,
      resolvePackage: () => { throw new Error("nope") },
      existsSync: () => false,
      exec: async () => ({ stdout: "" }),
    })
    expect(await resolveClaudeExecutable(deps)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The operator's executable preference (Settings, Claude Code Executable).
// System is the order above; bundled puts the packaged copy first; custom
// runs a chosen path. Both resolvers must agree, so the profile CLI and the
// server run the same binary.
// ---------------------------------------------------------------------------

describe("resolveClaudeExecutable: executable preference", () => {
  const bundledPkg = "/m/cc/package.json"
  const bundledBin = BIN(bundledPkg, "bin", "claude.exe")
  const onPath = "/usr/local/bin/claude"
  /** A real bundled binary and a usable `claude` on PATH, so only the preference decides. */
  const bothAvailable = (overrides: Partial<NonNullable<Deps>> = {}) => makeDeps({
    resolvePackage: (s) => {
      if (s === "@anthropic-ai/claude-code/package.json") return bundledPkg
      throw new Error("not configured")
    },
    existsSync: () => true,
    statSync: () => ({ size: 213_404_000 }),
    exec: async () => ({ stdout: `${onPath}\n` }),
    execLookupSync: () => `${onPath}\n`,
    ...overrides,
  })

  it("system, the default, prefers the PATH installation", async () => {
    const expected = { path: onPath, source: "path-lookup" as const }
    for (const deps of [bothAvailable(), bothAvailable({ preference: () => ({ mode: "system" }) })]) {
      expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
      expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
    }
  })

  it("bundled prefers the packaged copy over a usable PATH installation", async () => {
    const deps = bothAvailable({ preference: () => ({ mode: "bundled" }) })
    const expected = { path: bundledBin, source: "bundled" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
  })

  it("bundled falls back to PATH when no packaged copy is installed", async () => {
    const deps = bothAvailable({
      preference: () => ({ mode: "bundled" }),
      resolvePackage: () => { throw new Error("not installed") },
    })
    const expected = { path: onPath, source: "path-lookup" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
  })

  it("custom runs the chosen path ahead of PATH and the packaged copy", async () => {
    const deps = bothAvailable({ preference: () => ({ mode: "custom", customPath: "/opt/claude-next/claude" }) })
    const expected = { path: "/opt/claude-next/claude", source: "custom" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
  })

  it("a custom path that has gone falls back to the system order, and says so", async () => {
    const warnings: string[] = []
    const deps = bothAvailable({
      preference: () => ({ mode: "custom", customPath: "/opt/removed/claude" }),
      existsSync: p => p !== "/opt/removed/claude",
      warn: message => warnings.push(message),
    })
    const expected = { path: onPath, source: "path-lookup" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain("/opt/removed/claude")
  })

  it("MERIDIAN_CLAUDE_PATH outranks every preference", async () => {
    for (const preference of [{ mode: "bundled" as const }, { mode: "custom" as const, customPath: "/opt/claude-next/claude" }]) {
      const deps = bothAvailable({
        preference: () => preference,
        envGet: n => (n === "MERIDIAN_CLAUDE_PATH" ? "/explicit/claude" : undefined),
      })
      const expected = { path: "/explicit/claude", source: "env" as const }
      expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
      expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// resolveClaudeExecutableWithSource — same resolver, but the result also
// reports which step produced the hit. Used at startup logging and in /health
// so users can self-diagnose "wrong claude got picked" without playing
// detective on their PATH (closes diagnostic gap from issue #478).
// ---------------------------------------------------------------------------

describe("resolveClaudeExecutableWithSource", () => {
  it("reports source 'env' when MERIDIAN_CLAUDE_PATH wins", async () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/custom/claude" : undefined),
      existsSync: (p) => p === "/custom/claude",
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({
      path: "/custom/claude",
      source: "env",
    })
  })

  it("reports source 'bundled' when claude-code/bin/claude.exe wins", async () => {
    const pkgJson = "/m/cc/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 200_000_000 }), // real binary
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({
      path: expectedBin,
      source: "bundled",
    })
  })

  it("reports source 'platform-package' when peer pkg wins after bundled stub", async () => {
    const platformPkg = "/m/cc-d-a/package.json"
    const platformBin = BIN(platformPkg, "claude")
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return platformPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === platformBin,
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({
      path: platformBin,
      source: "platform-package",
    })
  })

  it("reports source 'path-lookup' when which/where claude wins", async () => {
    const deps = makeDeps({
      platform: "linux",
      resolvePackage: () => { throw new Error("not installed") },
      existsSync: (p) => p === "/usr/local/bin/claude",
      exec: async () => ({ stdout: "/usr/local/bin/claude\n" }),
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({
      path: "/usr/local/bin/claude",
      source: "path-lookup",
    })
  })

  it("reports source 'legacy-cli-js' when only the SDK cli.js fallback hits", async () => {
    const sdkPkg = "/m/sdk/package.json"
    const cliJs = BIN(sdkPkg, "cli.js")
    const deps = makeDeps({
      isBun: true,
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-agent-sdk") return sdkPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === cliJs,
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual({
      path: cliJs,
      source: "legacy-cli-js",
    })
  })

  it("returns null when every source misses (matches resolveClaudeExecutable)", async () => {
    const deps = makeDeps({
      envGet: () => undefined,
      resolvePackage: () => { throw new Error("nope") },
      existsSync: () => false,
      exec: async () => ({ stdout: "" }),
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveClaudeExecutableSync — synchronous subset used by CLI commands
// (`meridian profile list`, etc.) that can't await. Shares async precedence
// through a bounded synchronous PATH lookup. Closes the diagnostic gap
// from #478 where Stefan's auth-status checks failed because they spawned
// `claude` via shell PATH instead of routing through the resolver.
// ---------------------------------------------------------------------------

describe("resolveClaudeExecutableSync", () => {
  it("selects the same PATH executable for synchronous auth and async requests", async () => {
    const pkgJson = "/m/cc/package.json"
    const deps = makeDeps({
      existsSync: () => true,
      statSync: () => ({ size: 200_000_000 }),
      resolvePackage: () => pkgJson,
      exec: async () => ({ stdout: "/mise/shims/claude\n" }),
      execLookupSync: (command, args) => {
        expect(command).toBe("which")
        expect(args).toEqual(["claude"])
        return "/mise/shims/claude\n"
      },
    })
    const expected = { path: "/mise/shims/claude", source: "path-lookup" as const }
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
  })

  it("retains packaged fallback after either PATH lookup throws", async () => {
    const pkgJson = "/m/cc/package.json"
    const expected = { path: BIN(pkgJson, "bin", "claude.exe"), source: "bundled" as const }
    const deps = makeDeps({
      existsSync: p => p === expected.path,
      statSync: () => ({ size: 200_000_000 }),
      resolvePackage: () => pkgJson,
      exec: async () => { throw new Error("lookup unavailable") },
      execLookupSync: () => { throw new Error("lookup unavailable") },
    })
    expect(await resolveClaudeExecutableWithSource(deps)).toEqual(expected)
    expect(resolveClaudeExecutableSync(deps)).toEqual(expected)
  })

  it("filters unusable Windows lookup paths identically in both resolvers", async () => {
    const output = "/c/incorrect/claude\r\nC:\\Missing\\claude.exe\r\nC:\\Tools\\claude.exe\r\n"
    const deps = makeDeps({
      platform: "win32",
      existsSync: p => p === "C:\\Tools\\claude.exe",
      exec: async () => ({ stdout: output }),
      execLookupSync: (command, args) => {
        expect(command).toBe("where")
        expect(args).toEqual(["claude"])
        return output
      },
    })
    expect(resolveClaudeExecutableSync(deps)).toEqual(await resolveClaudeExecutableWithSource(deps))
    expect(resolveClaudeExecutableSync(deps)?.source).toBe("path-lookup")
  })

  it("reports source 'env' when MERIDIAN_CLAUDE_PATH wins", () => {
    const deps = makeDeps({
      envGet: (n) => (n === "MERIDIAN_CLAUDE_PATH" ? "/custom/claude" : undefined),
      existsSync: (p) => p === "/custom/claude",
    })
    expect(resolveClaudeExecutableSync(deps)).toEqual({
      path: "/custom/claude",
      source: "env",
    })
  })

  it("reports source 'bundled' when claude-code/bin/claude.exe wins", () => {
    const pkgJson = "/m/cc/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 200_000_000 }),
    })
    expect(resolveClaudeExecutableSync(deps)).toEqual({
      path: expectedBin,
      source: "bundled",
    })
  })

  it("reports source 'platform-package' when peer pkg wins after bundled stub", () => {
    const platformPkg = "/m/cc-d-a/package.json"
    const platformBin = BIN(platformPkg, "claude")
    const deps = makeDeps({
      platform: "darwin",
      arch: "arm64",
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code-darwin-arm64/package.json") return platformPkg
        throw new Error("not configured")
      },
      existsSync: (p) => p === platformBin,
    })
    expect(resolveClaudeExecutableSync(deps)).toEqual({
      path: platformBin,
      source: "platform-package",
    })
  })

  it("returns null when all sources miss", () => {
    const deps = makeDeps({
      envGet: () => undefined,
      resolvePackage: () => { throw new Error("nope") },
      existsSync: () => false,
    })
    expect(resolveClaudeExecutableSync(deps)).toBeNull()
  })

  it("does not call the asynchronous lookup from synchronous CLI auth", () => {
    // The sync resolver should not even *try* to call exec — that's the
    // whole reason it exists. Pin the contract: pass an exec that throws
    // and assert resolution still works via bundled.
    const pkgJson = "/m/cc/package.json"
    const expectedBin = BIN(pkgJson, "bin", "claude.exe")
    const deps = makeDeps({
      resolvePackage: (s) => {
        if (s === "@anthropic-ai/claude-code/package.json") return pkgJson
        throw new Error("not configured")
      },
      existsSync: (p) => p === expectedBin,
      statSync: () => ({ size: 200_000_000 }),
      exec: async () => { throw new Error("sync resolver must not call exec") },
    })
    expect(resolveClaudeExecutableSync(deps)).toEqual({
      path: expectedBin,
      source: "bundled",
    })
  })
})

// ---------------------------------------------------------------------------
// PATH candidates that are real processes: what `--version` takes and says
// ---------------------------------------------------------------------------

describe.skipIf(process.platform === "win32")("PATH probe against a real binary", () => {
  let dir = ""
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "meridian-claude-probe-test-")) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  async function script(path: string, body: string, mode = 0o755): Promise<string> {
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, mode)
    return path
  }

  it("keeps a claude on PATH that takes longer than 2s to answer --version, in both resolvers", async () => {
    // A ~220 MB binary paging itself back in under memory pressure answers
    // late but correctly; the installation chosen must not depend on that.
    const binDir = join(dir, "cold-bin")
    await mkdir(binDir)
    const claude = await script(join(binDir, "claude"), 'sleep 2.5\necho "2.1.284 (Claude Code)"')
    const savedPath = process.env.PATH
    process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`
    try {
      const expected = { path: claude, source: "path-lookup" as const }
      expect(await resolveClaudeExecutableWithSource()).toEqual(expected)
      expect(resolveClaudeExecutableSync()).toEqual(expected)
    } finally {
      process.env.PATH = savedPath
    }
  }, 20_000)

  it("says why a candidate is passed over: no answer in time, a failed run, or output that is not Claude Code", async () => {
    const hung = await script(join(dir, "hung"), "exec sleep 10")
    const failing = await script(join(dir, "failing"), "exit 3")
    const shim = await script(join(dir, "shim"), "echo 'mise ERROR no version is set for claude'")
    const silent = await script(join(dir, "silent"), "true")
    const notExecutable = await script(join(dir, "not-executable"), "true", 0o644)
    const probes = [
      probeClaudeVersion,
      async (candidate: string, timeoutMs?: number) => probeClaudeVersionSync(candidate, timeoutMs),
    ]
    for (const probe of probes) {
      expect(await probe(hung, 300)).toEqual({ usable: false, reason: "no answer to `--version` within 0.3s" })
      expect(await probe(failing)).toEqual({ usable: false, reason: "`--version` exited with code 3" })
      expect(await probe(shim)).toEqual({
        usable: false,
        reason: '`--version` printed "mise ERROR no version is set for claude", which is not a Claude Code version',
      })
      expect(await probe(silent)).toEqual({ usable: false, reason: "`--version` printed nothing" })
      expect(await probe(notExecutable)).toEqual({ usable: false, reason: "it could not be run (EACCES)" })
    }
  })

  it("accepts a candidate that answers like Claude Code and reports how long it took", async () => {
    const claude = await script(join(dir, "claude-ok"), 'echo "2.1.284 (Claude Code)"')
    expect(await probeClaudeVersion(claude)).toEqual({ usable: true, elapsedMs: expect.any(Number) })
    expect(probeClaudeVersionSync(claude)).toEqual({ usable: true, elapsedMs: expect.any(Number) })
  })
})
