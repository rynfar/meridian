import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { recanonicalizeBookkeeping } from "../proxy/session/bookkeeping/recanonicalize"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import { openForMaintenance } from "../proxy/session/bookkeeping/maintenance"
import { acquireMaintenanceGuard } from "../proxy/session/bookkeeping/guard"
import { getStoredSessionGeneration } from "../proxy/session/bookkeeping/legacyCodec"
import { readMappingGeneration } from "../proxy/session/bookkeeping/mappings"
import { resourceKey } from "../proxy/session/bookkeeping/locator"

let directory: string
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-recanonicalize-")))
  for (const name of ["first", "second"]) mkdirSync(join(directory, name))
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
const entry = () => ({ unknown: { z: 1, a: 2 }, claudeSessionId: "session", createdAt: 1,
  lastUsedAt: 2, messageCount: 1, sdkMessageUuids: [null, "uuid"],
  currentTranscript: { configDir: directory, projectDir: join(directory, "alias"), sessionId: "session" } })
const source = (name: string, value: unknown) => {
  writeFileSync(join(directory, name), JSON.stringify(value), { mode: 0o600 })
}
function alias(target: string): void {
  rmSync(join(directory, "alias"), { force: true })
  symlinkSync(join(directory, target), join(directory, "alias"))
}
const migrate = () => migrateBookkeeping(directory, { writersStopped: true })
function projection() {
  const guard = acquireMaintenanceGuard(directory)
  try {
    const handle = openForMaintenance(directory, { expectPhase: "READY", guard, skipRealpathAudit: true })
    try {
      return {
        mappings: handle.reader.all("SELECT * FROM mappings ORDER BY key"),
        history: handle.reader.all("SELECT * FROM mapping_history ORDER BY mapping_key"),
        pins: handle.reader.all("SELECT * FROM mapping_pins ORDER BY mapping_key,slot"),
        resources: handle.reader.all("SELECT * FROM resources ORDER BY key"),
        fences: handle.reader.all("SELECT * FROM fence_slots ORDER BY namespace,slot"),
      }
    } finally { handle.close() }
  } finally { guard.close() }
}

it("repairs only the mapping projection and keeps exact raw bytes, digest, pins and fences", async () => {
  alias("first")
  const original = entry()
  source("sessions.json", { entry: original })
  await migrate()
  const before = projection()
  alias("second")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recanonicalize")
  expect(recanonicalizeBookkeeping(directory)).toEqual({ mappings: 1 })
  const after = projection()
  expect(after.history).toEqual(before.history)
  expect(after.history[0]?.history_json).toBe(JSON.stringify(original))
  expect(after.pins).toEqual(before.pins)
  expect(after.resources).toEqual(before.resources)
  expect(after.fences).toEqual(before.fences)
  expect(JSON.parse(String(after.mappings[0]?.current_locator_json)).projectDir).toBe(join(directory, "second"))
  const handle = initializeSessionBookkeeping(directory)
  try {
    expect(readMappingGeneration(handle.reader, "entry")).toBe(getStoredSessionGeneration(original, "entry"))
  } finally { handle.close() }
  expect(recanonicalizeBookkeeping(directory)).toEqual({ mappings: 0 })
})

it("repairs current and previous modern projections without touching history or generation", async () => {
  const missing = join(directory, "alias")
  const modern = { ...entry(), generationId: "modern-generation", previousClaudeSessionId: "previous",
    previousTranscript: { configDir: directory, projectDir: missing, sessionId: "previous" } }
  source("sessions.json", { modern })
  await migrate()
  const before = projection()
  alias("second")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recanonicalize")
  expect(recanonicalizeBookkeeping(directory)).toEqual({ mappings: 1 })
  const after = projection()
  expect(after.history).toEqual(before.history)
  expect(after.pins).toEqual(before.pins)
  for (const column of ["current_locator_json", "previous_locator_json"]) {
    expect(JSON.parse(String(after.mappings[0]?.[column])).projectDir).toBe(join(directory, "second"))
  }
  const handle = initializeSessionBookkeeping(directory)
  try { expect(readMappingGeneration(handle.reader, "modern")).toBe(getStoredSessionGeneration(modern, "modern")) }
  finally { handle.close() }
})

it("refuses mapping resource-key drift atomically; export still preserves the raw entry", async () => {
  alias("first")
  const good = entry()
  const bad = { ...entry(), currentTranscript: { configDir: join(directory, "alias"), sessionId: "session" } }
  source("sessions.json", { a: good, z: bad })
  await migrate()
  const before = projection()
  alias("second")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recanonicalize")
  expect(() => recanonicalizeBookkeeping(directory)).toThrow("export-json, correct paths, then migrate again")
  expect(projection()).toEqual(before)
  expect(exportBookkeepingJson(directory).phase).toBe("EXPORTED")
  const exported = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
  expect(JSON.stringify(exported.z)).toBe(JSON.stringify(bad))
})

it("refuses standalone resource rekeying, preserving generation and counters without any mappings", async () => {
  const locator = { configDir: join(directory, "alias"), sessionId: "session" }
  const key = resourceKey(locator)
  source("session-gc.json", { version: 1, resources: {
    [key]: { key, locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0 },
  } })
  await migrate()
  const before = projection()
  alias("first")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recanonicalize")
  expect(() => recanonicalizeBookkeeping(directory)).toThrow("resource generations cannot be rekeyed")
  expect(projection()).toEqual(before)
  expect(exportBookkeepingJson(directory).phase).toBe("EXPORTED")
})

it("does not bypass structural corruption while relaxing only the realpath audit", async () => {
  alias("first")
  source("sessions.json", { entry: entry() })
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try {
    withBookkeepingWrite(directory, {}, (tx) => tx.run(
      "UPDATE mappings SET current_locator_json=?",
      JSON.stringify({ ...entry().currentTranscript, sessionId: "other" }),
    ))
  } finally { handle.close() }
  expect(() => recanonicalizeBookkeeping(directory)).toThrow("identity/payload mismatch")
})

it("refuses while runtime holds the shared guard", async () => {
  await migrate()
  const handle = initializeSessionBookkeeping(directory)
  try { expect(() => recanonicalizeBookkeeping(directory)).toThrow("stop all proxies") }
  finally { handle.close() }
})

it("refuses a foreign caller uid before touching database or guard", async () => {
  await migrate()
  if (!process.getuid) throw new Error("uid test requires POSIX")
  const main = readFileSync(join(directory, "session-bookkeeping.sqlite"))
  const guard = readFileSync(join(directory, "session-bookkeeping-maintenance.sqlite"))
  const uid = process.getuid()
  const spy = spyOn(process, "getuid").mockReturnValue(uid + 1)
  try { expect(() => recanonicalizeBookkeeping(directory)).toThrow("not an owned regular path") }
  finally { spy.mockRestore() }
  expect(readFileSync(join(directory, "session-bookkeeping.sqlite"))).toEqual(main)
  expect(readFileSync(join(directory, "session-bookkeeping-maintenance.sqlite"))).toEqual(guard)
})
