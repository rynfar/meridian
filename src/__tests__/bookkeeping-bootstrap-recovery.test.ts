import { afterEach, beforeEach, expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"
import { resumeRetirements } from "../proxy/session/bookkeeping/privateRetirement"
import { runBookkeepingCli } from "../proxy/session/bookkeeping/cli"
import { inspectBookkeeping } from "../proxy/session/bookkeeping/inspect"
import { observeMaintenancePhases } from "../proxy/session/bookkeeping/maintenanceJournal"
import { assertDeadBootstrapAliases, bootstrapResidues, createBootstrapPath } from "../proxy/session/bookkeeping/bootstrapOwner"
import { BookkeepingBusyError } from "../proxy/session/bookkeeping/storagePaths"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/connection"
import { recoverBootstrapAliases } from "../proxy/session/bookkeeping/bootstrapRecovery"

let root: string, directory: string, fixture: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bootstrap-window-")))
  directory = join(root, "state")
  mkdirSync(directory, { mode: 0o700 })
  expect((await buildNodeFixture("bookkeeping-bootstrap-window.ts", "window.mjs", root)).success).toBe(true)
  fixture = join(root, "window.mjs")
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
const hash = () => Object.fromEntries(readdirSync(directory).map(name => [name,
  lstatSync(join(directory, name)).isFile() ? createHash("sha256").update(readFileSync(join(directory, name))).digest("hex") : "directory"]))

it.each([
  ["migrate", "session-bookkeeping.sqlite"],
  ["migrate", "session-bookkeeping-maintenance.sqlite"],
  ["fresh", "session-bookkeeping.sqlite"],
])("real SIGKILL bootstrap %s/%s resumes to READY through CLI only", async (mode, name) => {
  if (mode === "migrate") writeFileSync(join(directory, "sessions.json"), "{}", { mode: 0o600 })
  const killed = spawnSync("node", [fixture, mode, directory, name])
  expect(killed.signal).toBe("SIGKILL")
  const pub = join(directory, name), identity = lstatSync(pub)
  expect(identity.nlink).toBe(2)
  const before = hash()
  const inspection = inspectBookkeeping(directory)
  expect(inspection.temporary.some(row => row.kind === "bootstrap-alias" && row.verdict === "dead-incarnation")).toBe(true)
  expect(hash()).toEqual(before) // read-only inspect must not heal or rewrite anything
  expect(await runBookkeepingCli(["migrate", "--session-dir", directory, "--writers-stopped", "--json"])).toBe(0)
  expect(lstatSync(pub).ino).toBe(identity.ino)
  expect(lstatSync(pub).nlink).toBe(1)
  expect(inspectBookkeeping(directory).phase).toBe("ready")
  expect(readdirSync(directory).some(name => name.includes(".tmp-"))).toBe(false)
})

const id = "12345678-1234-4234-8234-123456789abc"
it.each([
  "x".repeat(66), "x".repeat(73),
  `session-bookkeeping-maintenance.sqlite.tmp-12345-${id}`,
  `session-bookkeeping.sqlite.exported-${id}`,
  `session-bookkeeping.sqlite-wal.exported-${id}`,
  `session-gc.json.lock.candidate-12345-${id}`,
  "界".repeat(85), "💾".repeat(63),
  "x".repeat(238) + ".deletion-intent",
])("NAME_MAX interrupted retirement resumes bounded UTF-8 private names: %s", name => {
  writeFileSync(join(directory, name), "payload", { mode: 0o600 })
  expect(spawnSync("node", [fixture, "retire", directory, name]).signal).toBe("SIGKILL")
  for (const file of readdirSync(directory)) expect(Buffer.byteLength(file)).toBeLessThanOrEqual(255)
  resumeRetirements(directory)
  expect(readdirSync(directory)).toEqual([])
})

it("live bootstrap ownership is not overridden by stopped attestation", async () => {
  const handle = initializeSessionBookkeeping(directory)
  const path = handle.path
  handle.close()
  const temporary = createBootstrapPath(path)
  linkSync(path, temporary)
  const inspection = inspectBookkeeping(directory)
  expect(inspection.temporary[0]?.kind).toBe("bootstrap-alias")
  expect(inspection.temporary[0]?.verdict).not.toBe("dead-incarnation")
  expect(await runBookkeepingCli(["recover-bootstrap", "--session-dir", directory, "--writers-stopped", "--json"])).not.toBe(0)
  expect(lstatSync(path).nlink).toBe(2)
})

it("foreign inode and missing-owner bootstrap aliases fail closed without touching data", () => {
  const path = join(directory, "session-bookkeeping.sqlite")
  writeFileSync(path, "foreign", { mode: 0o600 })
  const temporary = createBootstrapPath(path)
  linkSync(path, temporary)
  rmSync(temporary + ".owner.json")
  expect(bootstrapResidues(path)[0]?.verdict).toBe("unknown")
  expect(() => recoverBootstrapAliases(directory, { writersStopped: true })).toThrow("ambiguous")
  expect(readFileSync(path, "utf8")).toBe("foreign")
  rmSync(temporary)
  writeFileSync(temporary, "different inode", { mode: 0o600 })
  const alias = join(directory, "unknown-link")
  linkSync(path, alias)
  expect(() => bootstrapResidues(path)).toThrow("no matching owner")
  expect(existsSync(alias)).toBe(true)
})

// The guard inspects aliases after seeing a second link. A concurrent bootstrap
// that removed its alias in between is busy, so startup retries it.
it("a bootstrap that finished after the second link was seen is busy, not ambiguous", () => {
  const path = join(directory, "session-bookkeeping.sqlite")
  writeFileSync(path, "published", { mode: 0o600 })
  expect(() => assertDeadBootstrapAliases(path)).toThrow(BookkeepingBusyError)
  expect(readFileSync(path, "utf8")).toBe("published")
})

it("first-guard alias cleanup keeps actual cross-process EXCLUSIVE exclusion throughout retirement", async () => {
  writeFileSync(join(directory, "sessions.json"), "{}", { mode: 0o600 })
  const name = "session-bookkeeping-maintenance.sqlite"
  expect(spawnSync("node", [fixture, "migrate", directory, name]).signal).toBe("SIGKILL")
  expect((await Bun.build({ entrypoints: [resolve("src/__tests__/fixtures/bookkeeping-cold-guard.ts")],
    target: "node", naming: "probe.mjs", outdir: root, external: ["libsql"] })).success).toBe(true)
  let controls = 0
  const stop = observeMaintenancePhases(point => {
    if (point.startsWith(`retire:captured:${name}.tmp-`) && !point.includes(".owner.json")) {
      controls++
      expect(spawnSync("node", [join(root, "probe.mjs"), directory, "probe"]).status).toBe(73)
    }
  })
  try { recoverBootstrapAliases(directory, { writersStopped: true }) } finally { stop() }
  expect(controls).toBe(1)
  expect(spawnSync("node", [join(root, "probe.mjs"), directory, "probe"]).status).toBe(0)
})

it.each(["directory", "directory-with-child", "symlink", "fifo"] as const)
  ("nonregular main path is rejected before bootstrap-alias classification (%s)", kind => {
    const handle = initializeSessionBookkeeping(directory), path = handle.path
    handle.close()
    rmSync(path)
    const target = join(directory, "untouched-target")
    writeFileSync(target, "unchanged", { mode: 0o600 })
    if (kind === "directory" || kind === "directory-with-child") {
      mkdirSync(path, { mode: 0o700 })
      if (kind === "directory-with-child") mkdirSync(join(path, "child"), { mode: 0o700 })
      expect(lstatSync(path).nlink).toBeGreaterThan(1)
    } else if (kind === "symlink") {
      const result = spawnSync("ln", ["-s", target, path])
      expect(result.status).toBe(0)
    } else expect(spawnSync("mkfifo", [path]).status).toBe(0)
    const identity = lstatSync(path)
    let failure: unknown
    try { initializeSessionBookkeeping(directory).close() } catch (error) { failure = error }
    expect(failure).toBeInstanceOf(Error)
    const message = String(failure)
    expect(message).toContain("regular")
    expect(message).not.toContain("bootstrap alias")
    expect(message).not.toContain("recover-bootstrap")
    expect(lstatSync(path).ino).toBe(identity.ino)
    expect(readFileSync(target, "utf8")).toBe("unchanged")
  })
