/**
 * bin/meridian-launchd.sh — the launcher that keeps a service from drifting.
 *
 * Covered here are the two behaviours that are silent when they break:
 *
 * 1. A corrupt rate-limit stamp must not disable the update check. The stamp
 *    feeds shell arithmetic, and under `set -u` a non-numeric value aborts the
 *    function — which would leave the check permanently off while the bad file
 *    sits there, i.e. exactly the drift the launcher exists to prevent, with no
 *    symptom other than never updating again.
 *
 * 2. It always execs the *installed* package, never the checkout, unless a dev
 *    build was explicitly requested.
 *
 * The script is driven for real (a fake `meridian` on PATH, a temp HOME, and a
 * registry URL pointing at a closed port so nothing touches the network).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "..", "..", "bin", "meridian-launchd.sh")
const REPO = join(import.meta.dir, "..", "..")

// POSIX shell only; the Linux CI job runs the suite, Windows has its own smoke job.
const describePosix = process.platform === "win32" ? describe.skip : describe

let home: string
let bin: string
let marker: string

/** A stand-in for the installed CLI that records that it was the one exec'd. */
async function installFakeMeridian(version: string): Promise<void> {
  await mkdir(bin, { recursive: true })
  const path = join(bin, "meridian")
  await writeFile(
    path,
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "${version}"; exit 0; fi
echo "EXECED=$0" > "${marker}"
echo "BUILD_SOURCE=\${MERIDIAN_BUILD_SOURCE:-unset}" >> "${marker}"
exit 0
`,
    "utf8",
  )
  await chmod(path, 0o755)
}

function runLauncher(env: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: [SCRIPT],
    cwd: REPO,
    env: {
      HOME: home,
      // Fake CLI first, then the real toolchain so `node` still resolves.
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      // Closed port — the registry lookup fails fast instead of hitting npm.
      MERIDIAN_UPDATE_CHECK_URL: "http://127.0.0.1:1/dist-tags",
      ...env,
    },
  })
}

const stampPath = () => join(home, ".cache", "meridian", "launcher-update-check")

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "meridian-launcher-"))
  bin = join(home, "bin")
  marker = join(home, "marker.txt")
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describePosix("meridian-launchd.sh", () => {
  test("execs the installed package, not the checkout", async () => {
    await installFakeMeridian("1.62.7")
    const result = runLauncher()

    expect(result.exitCode).toBe(0)
    const recorded = await readFile(marker, "utf8")
    expect(recorded).toContain(join(bin, "meridian"))
    expect(recorded).not.toContain("dist/cli.js")
    // Stamped explicitly rather than left to path detection.
    expect(recorded).toContain("BUILD_SOURCE=npm")
  })

  test("a corrupt stamp does not permanently disable the update check", async () => {
    await installFakeMeridian("1.62.7")
    await mkdir(join(home, ".cache", "meridian"), { recursive: true })

    for (const corrupt of ["garbage", "", "   ", "12abc"]) {
      await writeFile(stampPath(), corrupt, "utf8")
      const result = runLauncher()

      expect(result.exitCode, `stamp=${JSON.stringify(corrupt)}`).toBe(0)
      // Recovered: the check ran and rewrote the stamp with a real timestamp.
      const rewritten = (await readFile(stampPath(), "utf8")).trim()
      expect(rewritten, `stamp=${JSON.stringify(corrupt)}`).toMatch(/^\d+$/)
      // And it still started the proxy rather than dying on the bad file.
      expect(await readFile(marker, "utf8")).toContain("meridian")
    }
  })

  test("a fresh stamp suppresses the check without blocking startup", async () => {
    await installFakeMeridian("1.62.7")
    await mkdir(join(home, ".cache", "meridian"), { recursive: true })
    const fresh = String(Math.floor(Date.now() / 1000))
    await writeFile(stampPath(), fresh, "utf8")

    const result = runLauncher()
    expect(result.exitCode).toBe(0)
    // Untouched — the rate limit held.
    expect((await readFile(stampPath(), "utf8")).trim()).toBe(fresh)
  })

  test("MERIDIAN_NO_SELF_UPDATE skips the check but still starts", async () => {
    await installFakeMeridian("1.62.7")
    const result = runLauncher({ MERIDIAN_NO_SELF_UPDATE: "1" })

    expect(result.exitCode).toBe(0)
    expect(await readFile(marker, "utf8")).toContain("meridian")
    // No stamp written, because no check was attempted.
    expect(existsSync(stampPath())).toBe(false)
  })

  test("an unbuilt dev checkout fails loudly instead of falling back to the release", async () => {
    // Run a copy of the script from a directory with no dist/, so REPO_DIR
    // resolves somewhere unbuilt. Deliberately NOT the real checkout: there
    // the dev path would exec a proxy and block until it was killed, which on
    // a machine with a free port means hanging forever.
    await installFakeMeridian("1.62.7")
    const fakeRepoBin = join(home, "checkout", "bin")
    await mkdir(fakeRepoBin, { recursive: true })
    const copied = join(fakeRepoBin, "meridian-launchd.sh")
    await writeFile(copied, await readFile(SCRIPT, "utf8"), "utf8")
    await chmod(copied, 0o755)

    const result = Bun.spawnSync({
      cmd: [copied],
      env: { HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`, MERIDIAN_DEV_BUILD: "1" },
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("run 'npm run build' first")
    // Never silently serves the installed release when a dev build was asked for.
    expect(existsSync(marker)).toBe(false)
  })
})
