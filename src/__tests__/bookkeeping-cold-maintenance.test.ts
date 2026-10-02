import { afterEach, beforeEach, expect, it } from "bun:test"
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import Database from "libsql"
import { initializeBookkeepingSchema } from "../proxy/session/bookkeeping/schema"
import { acquireMaintenanceGuard, assertGuardHeld, MAINTENANCE_GUARD_FILENAME } from "../proxy/session/bookkeeping/guard"
import { retireFile, resumeRetirements } from "../proxy/session/bookkeeping/privateRetirement"
import { recoverGuardRetirements } from "../proxy/session/bookkeeping/guardRecovery"
import { initializeSessionBookkeeping } from "../proxy/session/bookkeeping/database"
import { inspectBookkeeping } from "../proxy/session/bookkeeping/inspect"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { runBookkeepingCli } from "../proxy/session/bookkeeping/cli"
import { readJournal, SOURCE_NAMES } from "../proxy/session/bookkeeping/maintenanceJournal"
import { parseLegacyStoreForMaintenance } from "../proxy/session/bookkeeping/legacyCodec"
import { initializeProxyBookkeeping } from "../proxy/session/bookkeeping/runtime"
import { setSessionStoreDir } from "../proxy/sessionStore"
import { registerLiveTranscript } from "../proxy/session/bookkeeping/lifecycleRegisterSql"
import { insertResourceLease } from "../proxy/session/bookkeeping/resources"
import { withBookkeepingWrite } from "../proxy/session/bookkeeping/transaction"
import { resourceKey } from "../proxy/session/bookkeeping/locator"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"

let root: string, directory: string, child: string
const handles: Array<{ close(): void }> = []
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "bookkeeping-cold-"))
  directory = join(root, "sessions")
  mkdirSync(directory, { mode: 0o700 })
  expect((await buildNodeFixture("bookkeeping-cold-guard.ts", "guard.mjs", root)).success).toBe(true)
  child = join(root, "guard.mjs")
})
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.close()
  rmSync(root, { recursive: true, force: true })
})
const probe = () => spawnSync("node", [child, directory, "probe"], { encoding: "utf8" })

it("never retires a published guard, including ordinary refused-cleanup paths", () => {
  const guard = acquireMaintenanceGuard(directory)
  handles.push(guard)
  const identity = lstatSync(guard.path)
  expect(probe().status).toBe(73)
  expect(() => retireFile(guard.path, randomUUID(), identity)).toThrow("never be retired")
  assertGuardHeld(guard, "exclusive")
  expect(lstatSync(guard.path).ino).toBe(identity.ino)
  expect(probe().status).toBe(73)
  guard.close()
  const reopened = acquireMaintenanceGuard(directory)
  handles.push(reopened)
  expect(() => retireFile(guard.path, randomUUID(), identity)).toThrow("never be retired")
  assertGuardHeld(reopened, "exclusive")
  expect(probe().status).toBe(73)
  reopened.close()
  expect(probe().status).toBe(0)
})

it("fails closed on real SIGKILL retirement intent, then restores only original coordination identity", () => {
  expect(spawnSync("node", [child, directory, "crash-intent"]).signal).toBe("SIGKILL")
  const source = join(directory, MAINTENANCE_GUARD_FILENAME), identity = lstatSync(source)
  expect(() => acquireMaintenanceGuard(directory)).toThrow("unsafe legacy")
  expect(() => resumeRetirements(directory)).toThrow("unsafe legacy")
  expect(lstatSync(source).ino).toBe(identity.ino)
  expect(() => recoverGuardRetirements(directory, { writersStopped: false })).toThrow("writers-stopped")
  recoverGuardRetirements(directory, { writersStopped: true })
  expect(lstatSync(source).ino).toBe(identity.ino)
  const guard = acquireMaintenanceGuard(directory)
  handles.push(guard)
  expect(probe().status).toBe(73)
  guard.close()
  expect(probe().status).toBe(0)
})

it("interrupted capture is recoverable, but a different public guard can never be overwritten", () => {
  expect(spawnSync("node", [child, directory, "crash-intent"]).signal).toBe("SIGKILL")
  const source = join(directory, MAINTENANCE_GUARD_FILENAME)
  const name = readdirSync(directory).find(n => n.startsWith(MAINTENANCE_GUARD_FILENAME + ".deletion-intent"))!
  const intent = JSON.parse(readFileSync(join(directory, name), "utf8")) as { private: string }
  const identity = lstatSync(source)
  renameSync(source, intent.private)
  expect(() => acquireMaintenanceGuard(directory)).toThrow("unsafe legacy")
  expect(existsSync(source)).toBe(false)
  writeFileSync(source, "foreign", { mode: 0o600 })
  expect(() => recoverGuardRetirements(directory, { writersStopped: true })).toThrow("identity changed")
  expect(existsSync(intent.private)).toBe(true)
  // Test cleanup removes only the synthetic foreign file; operators use recovery, never manual unlink.
  rmSync(source)
  recoverGuardRetirements(directory, { writersStopped: true })
  expect(lstatSync(source).ino).toBe(identity.ino)
  expect(probe().status).toBe(0)
})

it("same-process inspection refuses main/guard hardlink aliases without dropping OS exclusion", async () => {
  writeFileSync(join(directory, "sessions.json"), "{}", { mode: 0o600 })
  await migrateBookkeeping(directory, { writersStopped: true })
  const handle = initializeSessionBookkeeping(directory)
  handles.push(handle)
  expect(probe().status).toBe(73)
  const alias = join(root, "alias")
  mkdirSync(alias, { mode: 0o700 })
  for (const name of ["session-bookkeeping.sqlite", MAINTENANCE_GUARD_FILENAME])
    linkSync(join(directory, name), join(alias, name))
  for (const path of [directory, alias]) {
    expect(() => inspectBookkeeping(path)).toThrow("same-process inspection")
    expect(probe().status).toBe(73)
  }
  expect(handle.reader.get("SELECT phase FROM schema_meta")?.phase).toBe("READY")
  handle.close()
  for (const name of ["session-bookkeeping.sqlite", MAINTENANCE_GUARD_FILENAME]) rmSync(join(alias, name))
  expect(inspectBookkeeping(directory).phase).toBe("ready")
  expect(probe().status).toBe(0)
})

it.each(["key-nul", "createdAt-fraction", "messageCount-fraction"])("validates actual import representation before barriers (%s)", async kind => {
  const key = kind === "key-nul" ? "bad\u0000key" : "key"
  const row = { claudeSessionId: "sdk", createdAt: kind === "createdAt-fraction" ? 1.5 : 1,
    lastUsedAt: 2, messageCount: kind === "messageCount-fraction" ? 1.5 : 0 }
  const bytes = JSON.stringify({ [key]: row })
  expect(parseLegacyStoreForMaintenance(bytes).sessions[key]).toBeDefined()
  writeFileSync(join(directory, "sessions.json"), bytes, { mode: 0o600 })
  await expect(migrateBookkeeping(directory, { writersStopped: true })).rejects.toThrow("mapping")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(bytes)
  expect(readJournal(directory)).toBeUndefined()
  for (const name of ["session-bookkeeping.sqlite", ...SOURCE_NAMES.map(name => name + ".lock")])
    expect(existsSync(join(directory, name))).toBe(false)
})

it("fresh READY has common provenance and denies the real legacy JSON lock protocol in another Node process", () => {
  const legacy = join(root, "legacy-control")
  mkdirSync(legacy, { mode: 0o700 })
  expect(spawnSync("node", [child, legacy, "legacy-write"]).status).toBe(0)
  expect(existsSync(join(legacy, "sessions.json"))).toBe(true)
  const handle = initializeSessionBookkeeping(directory)
  handles.push(handle)
  expect(readJournal(directory)?.phase).toBe("READY")
  expect(spawnSync("node", [child, directory, "legacy-write"]).status).toBe(73)
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  const inspected = spawnSync("node", [child, directory, "inspect"], { encoding: "utf8" })
  expect(inspected.status).toBe(0)
  expect(JSON.parse(inspected.stdout).phase).toBe("ready")
  expect(handle.reader.get("SELECT migration_id FROM schema_meta")?.migration_id).toBe(readJournal(directory)?.id)
  handle.close()
  expect(exportBookkeepingJson(directory).phase).toBe("EXPORTED")
})

it("never adopts an unjournaled database even with our exact READY schema", async () => {
  acquireMaintenanceGuard(directory).close()
  const path = join(directory, "session-bookkeeping.sqlite")
  writeFileSync(path, "", { mode: 0o600 })
  const db = new Database(path)
  db.exec("BEGIN IMMEDIATE")
  initializeBookkeepingSchema(db, true)
  db.exec("COMMIT")
  db.close()
  const bytes = readFileSync(path)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("owned provenance")
  await expect(migrateBookkeeping(directory, { writersStopped: true })).rejects.toThrow("implicit adoption")
  expect(readFileSync(path)).toEqual(bytes)
  expect(readJournal(directory)).toBeUndefined()
})

it.each(["fresh:PREPARED", "fresh:barrier:session-gc.json", "fresh:BARRIERS", "fresh:database-published", "fresh:READY"])
  ("crash %s resumes only through the durable protocol", async point => {
    const killed = spawnSync("node", [child, directory, "fresh"], { env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: point } })
    expect(killed.signal).toBe("SIGKILL")
    if (point !== "fresh:READY") expect(() => initializeSessionBookkeeping(directory)).toThrow("migration in progress")
    expect((await migrateBookkeeping(directory, { writersStopped: true })).phase).toBe("READY")
    const handle = initializeSessionBookkeeping(directory)
    handles.push(handle)
    expect(spawnSync("node", [child, directory, "legacy-write"]).status).toBe(73)
    handle.close()
    expect(inspectBookkeeping(directory).phase).toBe("ready")
  })

it("terminal export permits same-build JSON, but incomplete/forged authority never does", async () => {
  initializeSessionBookkeeping(directory).close()
  const saved = process.env.MERIDIAN_BOOKKEEPING
  setSessionStoreDir(directory)
  process.env.MERIDIAN_BOOKKEEPING = "json"
  try {
    await expect(initializeProxyBookkeeping()).rejects.toThrow("explicit maintenance")
    const exported = exportBookkeepingJson(directory)
    expect(await initializeProxyBookkeeping()).toBeUndefined()
    writeFileSync(join(directory, "sessions.json.lock"), "meridian-bookkeeping-barrier-v1", { mode: 0o600 })
    await expect(initializeProxyBookkeeping()).rejects.toThrow("explicit maintenance")
    rmSync(join(directory, "sessions.json.lock"))
    writeFileSync(join(directory, `session-bookkeeping.sqlite.exported-${exported.id}`), "tampered", { mode: 0o600 })
    await expect(initializeProxyBookkeeping()).rejects.toThrow()
  } finally {
    setSessionStoreDir(null)
    if (saved === undefined) delete process.env.MERIDIAN_BOOKKEEPING
    else process.env.MERIDIAN_BOOKKEEPING = saved
  }
})

it("JSON startup preserves ordinary legacy lock directories and publication hardlinks, but denies orphan barriers", async () => {
  const saved = process.env.MERIDIAN_BOOKKEEPING
  setSessionStoreDir(directory)
  process.env.MERIDIAN_BOOKKEEPING = "json"
  try {
    const lock = join(directory, "session-gc.json.lock"), candidate = join(directory, "legacy-candidate")
    writeFileSync(candidate, '{"legacy":"owner"}', { mode: 0o600 })
    linkSync(candidate, lock)
    expect(await initializeProxyBookkeeping()).toBeUndefined()
    rmSync(lock)
    mkdirSync(lock, { mode: 0o700 })
    expect(await initializeProxyBookkeeping()).toBeUndefined()
    rmSync(lock, { recursive: true })
    writeFileSync(lock, 'meridian-bookkeeping-barrier-v1', { mode: 0o600 })
    await expect(initializeProxyBookkeeping()).rejects.toThrow("explicit maintenance")
  } finally {
    setSessionStoreDir(null)
    if (saved === undefined) delete process.env.MERIDIAN_BOOKKEEPING
    else process.env.MERIDIAN_BOOKKEEPING = saved
  }
})

it("READY unknown go gate requires stopped-child attestation and journaled archival before export", async () => {
  initializeSessionBookkeeping(directory).close()
  mkdirSync(join(directory, "deletion-gates"), { mode: 0o700 })
  const name = `deletion-gates/${randomUUID()}.go`, file = join(directory, name)
  writeFileSync(file, "go\n", { mode: 0o600 })
  expect(await runBookkeepingCli(["export-json", "--session-dir", directory, "--json"])).toBe(4)
  expect(existsSync(file)).toBe(true)
  expect(await runBookkeepingCli(["export-json", "--session-dir", directory, "--writers-stopped", "--json"])).toBe(0)
  expect(existsSync(file)).toBe(false)
  const journal = readJournal(directory)!
  expect(journal.residues?.some(row => row.path === name)).toBe(true)
  expect(readFileSync(join(directory, "bookkeeping-cycles", journal.id, "residue", name), "utf8")).toBe("go\n")
})

it.each(["linked", "captured"])("stopped post-READY archival resumes after real SIGKILL (%s)", point => {
  initializeSessionBookkeeping(directory).close()
  mkdirSync(join(directory, "deletion-gates"), { mode: 0o700 })
  const basename = `${randomUUID()}.go`, name = `deletion-gates/${basename}`
  writeFileSync(join(directory, name), "go\n", { mode: 0o600 })
  const crash = point === "linked" ? `residue:linked:${name}` : `retire:captured:${basename}`
  expect(spawnSync("node", [child, directory, "export-stopped"], { env: { ...process.env, MERIDIAN_BOOKKEEPING_TEST_CRASH: crash } }).signal).toBe("SIGKILL")
  expect(spawnSync("node", [child, directory, "export-stopped"]).status).toBe(0)
  const journal = readJournal(directory)!
  expect(readFileSync(join(directory, "bookkeeping-cycles", journal.id, "residue", name), "utf8")).toBe("go\n")
  expect(readdirSync(join(directory, "deletion-gates"))).toEqual([])
  expect(inspectBookkeeping(directory).phase).toBe("exported")
})

it("stopped attestation never overrides a live or indeterminate SDK owner", async () => {
  const handle = initializeSessionBookkeeping(directory)
  handles.push(handle)
  const locator = await registerLiveTranscript({ configDir: directory, sessionId: "live-owner" }, { storeDir: directory })
  const owner = captureProcessIncarnation()
  if (!owner) throw new Error("owner incarnation unavailable")
  withBookkeepingWrite(directory, {}, tx => insertResourceLease(tx, resourceKey(locator), {
    token: randomUUID(), owner, createdAt: Date.now(),
  }))
  handle.close()
  mkdirSync(join(directory, "deletion-gates"), { mode: 0o700 })
  const file = join(directory, "deletion-gates", `${randomUUID()}.go`)
  writeFileSync(file, "go\n", { mode: 0o600 })
  expect(() => exportBookkeepingJson(directory, { writersStopped: true })).toThrow("stop all writers")
  expect(existsSync(file)).toBe(true)
  expect(readJournal(directory)?.residues ?? []).toEqual([])
})
