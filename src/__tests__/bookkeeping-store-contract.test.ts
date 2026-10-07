import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import Database from "libsql"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as store from "../proxy/sessionStore"
import { initializeSessionBookkeeping, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { BookkeepingTextParameterError, connectionFor } from "../proxy/session/bookkeeping/connection"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { STORE_META_KEY } from "../proxy/session/bookkeeping/legacyCodec"
import { withStoreWrite } from "../proxy/session/bookkeeping/storeScope"

let directory: string
let handle: BookkeepingHandle | undefined
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-store-contract-")))
  store.setSessionStoreBackendForTest(null)
  store.setSessionStoreDir(directory)
})
afterEach(() => {
  store.setSessionStoreBackendForTest(null)
  handle?.close()
  handle = undefined
  store.setSessionStoreDir(null)
  rmSync(directory, { recursive: true, force: true })
})
async function migrate() {
  await migrateBookkeeping(directory, { writersStopped: true })
  handle = initializeSessionBookkeeping(directory)
  store.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
}
async function cli(command: string) {
  const result = spawnSync("node", ["dist/session-bookkeeping.js", command,
    "--session-dir", directory, "--json"], { encoding: "utf8", timeout: 30_000 })
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  return { code: result.status, output: JSON.parse(result.stdout) }
}

it("rejects scalar NUL before SQL writes, including owner tokens and locator paths", async () => {
  await migrate()
  const db = connectionFor(directory).db!
  const prepare = spyOn(db, "prepare")
  try {
    for (const operation of [
      () => store.storeSharedSession("key\0suffix", "id"),
      () => store.storeSharedSession("key", "id\0suffix"),
      () => store.blockPriorityAttempt("route", "owner\0suffix"),
      () => store.releasePriorityAttempt("route", "owner\0suffix"),
      () => store.storeSharedSession("key", "id", undefined, undefined, undefined,
        undefined, undefined, undefined, undefined, undefined, { sessionId: "id", configDir: `${directory}\0suffix` }),
    ]) {
      prepare.mockClear()
      expect(operation).toThrow(BookkeepingTextParameterError)
      expect(prepare.mock.calls.some(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
      expect(store.readSessionStoreSnapshot()).toEqual({})
      expect(handle!.reader.all("SELECT * FROM fence_slots")).toEqual([])
    }
  } finally { prepare.mockRestore() }
})

it("round-trips NUL payload through store and export; changed imports never revive legacy bytes", async () => {
  store.storeSharedSession("key", "old", 1, undefined, ["before"])
  await migrate()
  expect(handle!.reader.get("SELECT key FROM legacy_exports WHERE kind='mapping'")?.key).toBe("key")
  expect(store.storeSharedSession("key", "new", 2, undefined, ["before\0after"])).not.toBe(false)
  const result = store.lookupSharedSessionResult("key")
  expect(result.status === "found" && result.session.messageHashes).toEqual(["before\0after"])
  expect(handle!.reader.get("SELECT key FROM legacy_exports WHERE kind='mapping'")).toBeUndefined()
  handle!.close()
  handle = undefined
  expect((await cli("export-json")).code).toBe(0)
  const document = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
  expect(document.key.claudeSessionId).toBe("new")
  expect(document.key.messageHashes).toEqual(["before\0after"])
})

it("migrates the real reserved NUL metadata key without treating it as a mapping", async () => {
  store.storeSharedSession("key", "id")
  const original = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
  expect(STORE_META_KEY).toBe("\0meridian-session-store")
  expect(original[STORE_META_KEY]).toBeDefined()
  await migrate()
  expect(handle!.reader.all("SELECT key FROM mappings")).toEqual([{ key: "key" }])
  handle!.close()
  handle = undefined
  expect((await cli("export-json")).code).toBe(0)
  expect(JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))).toEqual(original)
})

it("facade lookup sees uncommitted store writes and returns copies, not aliases", async () => {
  await migrate()
  withStoreWrite(directory, () => {
    store.storeSharedSession("key", "id", 1, undefined, ["original"], undefined, undefined,
      undefined, undefined, undefined, { configDir: directory, sessionId: "id" })
    const result = store.lookupSharedSessionResult("key")
    if (result.status !== "found") throw new Error("uncommitted write not visible")
    result.session.messageHashes![0] = "mutated"
    result.session.currentTranscript!.configDir = "/mutated"
    const reread = store.lookupSharedSessionResult("key")
    expect(reread.status === "found" && reread.session.messageHashes).toEqual(["original"])
    expect(reread.status === "found" && reread.session.currentTranscript?.configDir).toBe(directory)
    return false
  })
  expect(store.lookupSharedSessionResult("key").status).toBe("missing")
})

it("never aliases caller-owned store locators or returned lookup/snapshot objects", async () => {
  await migrate()
  const locator = { configDir: directory, sessionId: "id" }
  expect(store.storeSharedSession("key", "id", 1, undefined, ["original"], undefined,
    undefined, undefined, undefined, undefined, locator)).not.toBe(false)
  const original = structuredClone(store.readSessionStoreSnapshot())
  locator.configDir = "/caller-mutated"
  locator.sessionId = "caller-mutated"
  expect(store.readSessionStoreSnapshot()).toEqual(original)

  const lookup = store.lookupSharedSessionResult("key")
  if (lookup.status !== "found") throw new Error("stored mapping not found")
  lookup.session.currentTranscript!.configDir = "/lookup-mutated"
  lookup.session.messageHashes![0] = "lookup-mutated"
  lookup.session.claudeSessionId = "lookup-mutated"
  expect(store.readSessionStoreSnapshot()).toEqual(original)

  const snapshot = store.readSessionStoreSnapshot()
  snapshot.key!.currentTranscript!.sessionId = "snapshot-mutated"
  snapshot.key!.messageHashes!.push("snapshot-mutated")
  delete snapshot.key
  expect(store.readSessionStoreSnapshot()).toEqual(original)
  expect(store.lookupSharedSessionResult("key")).toMatchObject({ status: "found", session: original.key })
})

it("inspect refuses a reduced experimental schema with corrupt/5 and export guidance", async () => {
  await migrate()
  handle!.close()
  handle = undefined
  const db = new Database(join(directory, "session-bookkeeping.sqlite"))
  try { db.exec("DROP TABLE legacy_exports") } finally { db.close() }
  const result = await cli("inspect")
  expect(result.code).toBe(5)
  expect(result.output.phase).toBe("corrupt")
  expect(result.output.error).toContain("export with the build that created it, then migrate")
})
