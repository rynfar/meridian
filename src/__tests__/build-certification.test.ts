import { afterEach, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import { closeSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { acquireBuildLock, buildStore, certifyBuild, readCertifiedBuild } from "../proxy/buildArtifacts"
import { captureBuildRuntime } from "../proxy/buildRuntime"
import { BuildProvenanceError } from "../proxy/buildSnapshot"
import { canCertifyBuild } from "../../scripts/build"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Test Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Test Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } })
  if (result.status !== 0) throw new Error("Fixture Git command failed")
}
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "meridian-build-test-"))
  roots.push(root)
  writeFileSync(join(root, "package.json"), '{"version":"1.2.3"}')
  writeFileSync(join(root, ".gitignore"), "dist/\n")
  writeFileSync(join(root, "input.ts"), "export const value = 1\n")
  for (const args of [["init", "-b", "main"], ["add", "."], ["commit", "-m", "fixture"], ["tag", "meridian-v1.2.3"]]) git(root, ...args)
  return root
}
function output(root: string): void {
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "dist/server.js"), "export const server = true\n")
  writeFileSync(join(root, "dist/chunk.js"), "export const shared = true\n")
}
function runtime(root: string, embedded?: unknown) {
  return captureBuildRuntime({ root, modulePath: pathToFileURL(join(root, embedded ? "dist/server.js" : "src/proxy/server.ts")).href, embedded })
}

describe("certified local builds", () => {
  test("preflight permits archive fallback only for unavailable Git provenance", () => {
    const root = fixture()
    expect(canCertifyBuild(root)).toBe(true)
    const archive = mkdtempSync(join(tmpdir(), "meridian-build-archive-"))
    roots.push(archive)
    expect(canCertifyBuild(archive)).toBe(false)
    writeFileSync(join(archive, ".git"), "gitdir: /nonexistent-meridian-git-dir")
    expect(canCertifyBuild(archive)).toBe(false)
    writeFileSync(join(root, "package.json"), "invalid-json")
    expect(() => canCertifyBuild(root)).toThrow()
  })
  test("unstamped dist preserves the legacy launcher shape without observing disk", () => {
    const env = { MERIDIAN_BUILD_SOURCE: "dev", MERIDIAN_BUILD_SHA: "launcher-sha", MERIDIAN_BUILD_BRANCH: "launcher-branch", MERIDIAN_BUILD_DIRTY: "1" }
    const loaded = captureBuildRuntime({ root: "/missing-build-root", modulePath: "file:///archive/dist/server.js", env, background: true })
    env.MERIDIAN_BUILD_SHA = "changed"
    expect(loaded.info("1.2.3")).toEqual({ source: "dev", version: "1.2.3", sha: "launcher-sha", branch: "launcher-branch", dirty: true })
    for (let i = 0; i < 100; i++) expect(loaded.status().state).toBe("unknown")
  })
  test("uncertified embedded candidates retain launcher metadata without a counter", () => {
    const loaded = captureBuildRuntime({ root: "/missing-build-root", modulePath: "file:///archive/dist/server.js", embedded: { invalid: true }, env: { MERIDIAN_BUILD_SHA: "launcher-sha", MERIDIAN_BUILD_BRANCH: "launcher-branch", MERIDIAN_BUILD_DIRTY: "1" }, background: true })
    expect(loaded.info()).toMatchObject({ sha: "launcher-sha", branch: "launcher-branch", dirty: true, kind: "artifact", certification: "unknown" })
    expect(loaded.info().counter).toBeUndefined()
    expect(loaded.status().state).toBe("unknown")
  })
  test("background production mode freezes the real source startup snapshot", async () => {
    const root = fixture()
    const loaded = captureBuildRuntime({ root, modulePath: pathToFileURL(join(root, "src/proxy/server.ts")).href, background: true })
    const initial = loaded.info()
    expect(initial).toMatchObject({ kind: "source", branch: "main", releaseVersion: "1.2.3", dirty: false })
    expect(initial.sha).toMatch(/^[a-f0-9]{40}$/)
    expect(initial.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(initial.counter).toBeUndefined()
    writeFileSync(join(root, "input.ts"), "changed after startup")
    expect(loaded.info()).toEqual(initial)
    expect(loaded.status().state).toBe("unknown")
    const deadline = performance.now() + 5000
    while (loaded.status().state === "unknown" && performance.now() < deadline) await new Promise<void>(resolve => setImmediate(resolve))
    expect(loaded.status().state).toBe("source-changed")
    expect(loaded.info()).toEqual(initial)
  })
  test("a source tree whose fingerprint does not fit its budget still reports the commit it runs", () => {
    const root = fixture()
    // Over the per-file cap, so the fingerprint gives up exactly as it does when a loaded host runs out of time.
    const oversized = join(root, "oversized.bin")
    closeSync(openSync(oversized, "w"))
    truncateSync(oversized, 65 * 1024 * 1024)
    const info = runtime(root).info()
    expect(info).toMatchObject({ kind: "source", branch: "main", dirty: true })
    expect(info.sha).toBe(spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim())
    expect(info.sourceHash).toBeUndefined()
  })
  test("a directory nested in an unrelated repository reports no commit", () => {
    const nested = join(fixture(), "nested")
    mkdirSync(nested)
    writeFileSync(join(nested, "package.json"), '{"version":"9.9.9"}')
    expect(runtime(nested).info().sha).toBeUndefined()
  })
  test("a reachable tag older than package.json is not reported as the release base", () => {
    const root = fixture()
    writeFileSync(join(root, "package.json"), '{"version":"1.3.0"}')
    git(root, "commit", "-am", "release 1.3.0 without a fetched tag")
    const info = runtime(root).info()
    expect(info.releaseVersion).toBeUndefined()
    expect(info.displayVersion).toBe("1.3.0+source")
    git(root, "tag", "meridian-v1.3.0")
    expect(runtime(root).info()).toMatchObject({ releaseVersion: "1.3.0", displayVersion: "1.3.0+source" })
  })
  test("reads do not create a store or adopt an unrelated parent worktree", () => {
    const root = fixture()
    const store = buildStore(root)
    expect(() => readCertifiedBuild(root)).toThrow()
    expect(existsSync(store)).toBe(false)
    const nested = join(root, "nested")
    mkdirSync(nested)
    expect(() => readCertifiedBuild(nested)).toThrow("invalid")
    expect(existsSync(store)).toBe(false)
  })
  test("dead process claims are recovered without using lock age", () => {
    const root = fixture()
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" })
    const store = buildStore(root)
    mkdirSync(join(store, `owner-${child.pid}-00000000-0000-4000-8000-000000000000`), { recursive: true })
    expect(certifyBuild(root, () => output(root)).build.counter).toBe(1)
  })
  test("builder waits for a live owner to release instead of failing immediately", async () => {
    const root = fixture()
    const modulePath = new URL("../proxy/buildLock.ts", import.meta.url).href
    const child = spawn(process.execPath, ["-e", `import {acquireBuildLock} from ${JSON.stringify(modulePath)}; const release=acquireBuildLock(${JSON.stringify(buildStore(root))}); process.stdout.write('ready'); setTimeout(()=>{release()},150)`], { stdio: ["ignore", "pipe", "pipe"] })
    const exited = once(child, "exit")
    try {
      await once(child.stdout, "data")
      expect(certifyBuild(root, () => output(root)).build.counter).toBe(1)
      expect((await exited)[0]).toBe(0)
    } finally { child.kill() }
  })
  test("manifest publication failure does not consume a successful counter", () => {
    const root = fixture()
    expect(() => certifyBuild(root, () => {
      output(root)
      mkdirSync(join(root, "dist/build-provenance.json"))
    })).toThrow()
    expect(certifyBuild(root, () => output(root)).build.counter).toBe(1)
  })
  test("ledger promotion failure leaves the manifest uncertified and does not count", () => {
    const root = fixture()
    const blockedRecord = join(buildStore(root), "1.json")
    expect(() => certifyBuild(root, () => {
      output(root)
      mkdirSync(blockedRecord)
    })).toThrow()
    expect(() => readCertifiedBuild(root)).toThrow()
    rmSync(blockedRecord, { recursive: true })
    expect(certifyBuild(root, () => output(root)).build.counter).toBe(1)
  })
  test("read validation creates no claim that can block a builder", () => {
    const root = fixture()
    certifyBuild(root, () => output(root))
    for (let i = 0; i < 5; i++) readCertifiedBuild(root)
    expect(certifyBuild(root, () => output(root)).build.counter).toBe(2)
  })
  test("labels the reachable release branch SHA and dirty state", () => {
    const root = fixture()
    writeFileSync(join(root, "input.ts"), "changed")
    const result = certifyBuild(root, () => output(root))
    expect(result.build.displayVersion).toBe(`v1.2.3-1-main-${result.build.sha.slice(0, 8)}-dirty`)
  })
  test("counts only successful gates and retains the stream across dist deletion", () => {
    const root = fixture()
    const first = certifyBuild(root, () => output(root))
    expect(first.build.counter).toBe(1)
    expect(() => certifyBuild(root, () => { throw new BuildProvenanceError("gate") })).toThrow()
    const second = certifyBuild(root, () => output(root))
    expect(second.build.counter).toBe(2)
    expect(second.build.counterScope).toBe(first.build.counterScope)
    expect(second.build.attemptId).not.toBe(first.build.attemptId)
    expect(readCertifiedBuild(root)).toEqual(second)
  })
  test("captures dirty input but refuses input changes during gates", () => {
    const root = fixture()
    writeFileSync(join(root, "input.ts"), "export const value = 2\n")
    expect(certifyBuild(root, () => output(root)).build.dirty).toBe(true)
    expect(() => certifyBuild(root, () => {
      output(root)
      writeFileSync(join(root, "input.ts"), "export const value = 3\n")
    })).toThrow("inputs-changed")
    expect(certifyBuild(root, () => output(root)).build.counter).toBe(2)
  })
  test("keeps loaded identity immutable while refreshing and detecting rollback", () => {
    const root = fixture()
    const first = certifyBuild(root, () => output(root))
    const loaded = runtime(root, first.build)
    const firstRaw = readFileSync(join(root, "dist/build-provenance.json"), "utf8")
    const second = certifyBuild(root, () => output(root))
    const newer = runtime(root, second.build)
    expect(loaded.status().state).toBe("behind")
    expect(loaded.status().buildsBehind).toBe(1)
    expect(loaded.info().attemptId).toBe(first.build.attemptId)
    writeFileSync(join(root, "dist/build-provenance.json"), firstRaw)
    expect(newer.status().state).toBe("rollback")
  })
  test("rejects modified split chunks and a mismatched embedded attempt", () => {
    const root = fixture()
    const build = certifyBuild(root, () => output(root))
    expect(runtime(root, { ...build.build, attemptId: "00000000-0000-4000-8000-000000000000" }).info().certification).toBe("unknown")
    writeFileSync(join(root, "dist/chunk.js"), "tampered")
    expect(() => readCertifiedBuild(root)).toThrow("invalid")
  })
  test("reports building without stealing the lock or deleting artifacts", () => {
    const root = fixture()
    const build = certifyBuild(root, () => output(root))
    const loaded = runtime(root, build.build)
    const release = acquireBuildLock(buildStore(root))
    try {
      expect(loaded.status().state).toBe("building")
      expect(() => certifyBuild(root, () => output(root))).toThrow("building")
      expect(readFileSync(join(root, "dist/server.js"), "utf8")).toContain("server")
    } finally { release() }
  })
  test("source runs ignore nearby dist and preserve their startup snapshot", () => {
    const root = fixture()
    certifyBuild(root, () => output(root))
    const loaded = runtime(root)
    expect(loaded.info().kind).toBe("source")
    expect(loaded.info().counter).toBeUndefined()
    writeFileSync(join(root, "input.ts"), "changed")
    expect(loaded.status().state).toBe("source-changed")
    expect(loaded.info().dirty).toBe(false)
  })
  test("linked worktrees have independent counter scopes", () => {
    const a = fixture()
    const b = mkdtempSync(join(tmpdir(), "meridian-linked-build-test-"))
    roots.push(b)
    const result = spawnSync("git", ["worktree", "add", "--detach", b, "HEAD"], { cwd: a, encoding: "utf8" })
    expect(result.status).toBe(0)
    expect(certifyBuild(a, () => output(a)).build.counterScope).not.toBe(certifyBuild(b, () => output(b)).build.counterScope)
  })
  test("reports missing after a failed attempt rather than adopting its candidate", () => {
    const root = fixture()
    const build = certifyBuild(root, () => output(root))
    const loaded = runtime(root, build.build)
    expect(() => certifyBuild(root, () => { output(root); throw new BuildProvenanceError("gate") })).toThrow()
    expect(loaded.status().state).toBe("missing")
    expect(loaded.info().counter).toBe(1)
  })
  test("refuses a corrupt success record before deleting dist", () => {
    const root = fixture()
    certifyBuild(root, () => output(root))
    writeFileSync(join(buildStore(root), "1.json"), "not-json")
    expect(() => certifyBuild(root, () => output(root))).toThrow()
    expect(readFileSync(join(root, "dist/server.js"), "utf8")).toContain("server")
  })
  test("npm ignores packaged metadata and later environment changes", () => {
    const env = { MERIDIAN_BUILD_SOURCE: "dev", MERIDIAN_BUILD_SHA: "original" }
    const loaded = captureBuildRuntime({ root: "/missing", modulePath: "file:///node_modules/meridian/dist/server.js", embedded: { counter: 55 }, env })
    env.MERIDIAN_BUILD_SHA = "changed"
    expect(loaded.local).toBe(false)
    expect(loaded.info("1.2.3", "1.2.4")).toMatchObject({ source: "npm", version: "1.2.3", latest: "1.2.4", updateAvailable: true, sha: "original" })
    expect(loaded.info().counter).toBeUndefined()
  })
})
