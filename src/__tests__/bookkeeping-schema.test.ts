import { afterEach, beforeEach, expect, it } from "bun:test"
import Database from "libsql"
import { createHash } from "node:crypto"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
  readFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import {
  BOOKKEEPING_FILENAME,
  initializeSessionBookkeeping,
  withBookkeepingWrite,
  type BookkeepingHandle,
} from "../proxy/session/bookkeeping/database"
import {
  compareAndSwapMapping,
  LOOKUP_CLAUDE_SQL,
  PIN_LOOKUP_SQL,
  readMapping,
  readMappingGeneration,
  readSessionTranscriptPins,
} from "../proxy/session/bookkeeping/mappings"
import {
  compareAndSwapResourceState,
  allocateResource,
  insertResourceLease,
  readResource,
  readResourceLease,
  readRetiredPage,
  RETIRED_PAGE_SQL,
} from "../proxy/session/bookkeeping/resources"
import { importResource as insertResource } from "../proxy/session/bookkeeping/resourceImport"
import { insertMapping } from "../proxy/session/bookkeeping/resourceImport"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { tmpdir } from "node:os"
import { RESOURCE_STATES } from "../proxy/session/bookkeeping/schema"
import type {
  BookkeepingTransaction,
  CanonicalStoredSession as StoredSession,
  BookkeepingResource as TranscriptResource,
} from "../proxy/session/bookkeeping/types"
import type { ProcessIncarnation } from "../proxy/session/processIncarnation"

let directory: string
let handle: BookkeepingHandle
const owner: ProcessIncarnation = {
  version: 1,
  pid: 123,
  hostId: "a".repeat(64),
  bootId: "00000000-0000-0000-0000-000000000001",
  startId: "10",
  startIdKind: "linux-proc-start-ticks",
}
const mapping = (id = "c"): StoredSession => ({
  claudeSessionId: id,
  createdAt: 1,
  lastUsedAt: 2,
  messageCount: 0,
})
function resource(id = "c"): TranscriptResource {
  const locator = canonicalizeLocator({ sessionId: id, configDir: directory })
  const key = resourceKey(locator)
  return {
    key,
    generation: `r:${key}:1`,
    locator,
    state: "live",
    createdAt: 1,
    updatedAt: 2,
    attempts: 0,
    rowVersion: 1,
  }
}
const write = <T>(fn: (tx: BookkeepingTransaction) => T): T => {
  const result = withBookkeepingWrite(directory, { scope: "store" }, fn)
  for (const state of RESOURCE_STATES)
    expect(
      handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind=?", `resources:${state}`)?.value,
    ).toBe(handle.reader.get("SELECT count(*) AS n FROM resources WHERE state=?", state)?.n)
  for (const table of ["mappings", "priority_assignments", "priority_attempts"])
    expect(handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind=?", table)?.value).toBe(
      handle.reader.get(`SELECT count(*) AS n FROM ${table}`)?.n,
    )
  return result
}
beforeEach(() => {
  const root = tmpdir()
  mkdirSync(root, { recursive: true })
  directory = mkdtempSync(join(root, "schema-"))
  handle = initializeSessionBookkeeping(directory)
})
afterEach(() => {
  handle?.close()
  rmSync(directory, { recursive: true, force: true })
})

it("opens private FULL/WAL/foreign-key database and reuses canonical directory identity", () => {
  expect(handle.reader.get("PRAGMA journal_mode")?.journal_mode).toBe("wal")
  expect(handle.reader.get("PRAGMA synchronous")?.synchronous).toBe(2)
  expect(handle.reader.get("PRAGMA foreign_keys")?.foreign_keys).toBe(1)
  expect(handle.reader.get("PRAGMA busy_timeout")?.timeout).toBe(0)
  expect(handle.reader.get("PRAGMA wal_autocheckpoint")?.wal_autocheckpoint).toBe(0)
  for (const suffix of ["", "-wal", "-shm"]) expect(statSync(handle.path + suffix).mode & 0o777).toBe(0o600)
  expect(statSync(directory).mode & 0o777).toBe(0o700)
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  const second = initializeSessionBookkeeping(alias)
  expect(second.path).toBe(handle.path)
  handle.close()
  expect(() => handle.reader.get("SELECT 1")).toThrow("closed")
  expect(second.reader.get("PRAGMA user_version")?.user_version).toBe(1)
  second.close()
  handle = initializeSessionBookkeeping(directory)
  expect(() => handle.reader.get("DELETE FROM mappings RETURNING key")).toThrow("cannot mutate")
})

it("rejects symlinks, nonregular DBs and unsafe companion files without modifying their targets", () => {
  handle.close()
  const original = readFileSync(handle.path)
  rmSync(handle.path)
  const target = join(directory, "target")
  writeFileSync(target, "untouched")
  symlinkSync(target, handle.path)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("regular")
  rmSync(handle.path)
  mkdirSync(handle.path)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("regular")
  rmSync(handle.path, { recursive: true })
  writeFileSync(handle.path, original, { mode: 0o600 })
  rmSync(handle.path + "-wal", { force: true })
  symlinkSync(target, handle.path + "-wal")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("regular")
})

it("refuses legacy directories rather than silently creating an empty authority", () => {
  handle.close()
  writeFileSync(join(directory, "sessions.json"), "{}")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("offline migration")
})

for (const bytes of ["", "not a SQLite database"]) {
  it(`does not initialize an existing ${bytes ? "corrupt" : "zero-byte"} database as a fresh store`, () => {
    handle.close()
    for (const suffix of ["", "-wal", "-shm"]) rmSync(handle.path + suffix, { force: true })
    writeFileSync(handle.path, bytes)
    expect(() => initializeSessionBookkeeping(directory)).toThrow()
  })
}

for (const sql of [
  "PRAGMA user_version=2",
  "PRAGMA application_id=123",
  "UPDATE schema_meta SET phase='IMPORTING'",
  "DROP INDEX pins_resource",
  "UPDATE bookkeeping_counts SET value=4 WHERE kind='mappings'",
]) {
  it(`fails closed on schema/counter mismatch: ${sql}`, () => {
    handle.close()
    const db = new Database(join(directory, BOOKKEEPING_FILENAME))
    try {
      db.exec(sql)
    } finally {
      db.close()
    }
    expect(() => initializeSessionBookkeeping(directory)).toThrow()
  })
}

it("checks safe integer/state/deletion fields, lease identity, publication restrictions and FKs", () => {
  const r = resource()
  write((tx) => insertResource(tx, r))
  for (const sql of [
    "UPDATE resources SET attempts=-1",
    "UPDATE resources SET attempts=0.5",
    "UPDATE resources SET updated_at=9007199254740992",
    "UPDATE resources SET state='unknown'",
    "UPDATE resources SET deletion_token='unsafe'",
    "UPDATE resources SET state='deleting',deletion_executor_json='{}'",
    "INSERT INTO fence_slots VALUES('wrong','a',1)",
    "INSERT INTO fence_slots VALUES('store','a',-1)",
    "INSERT INTO fence_slots VALUES('lifecycle','a',0)",
    "INSERT INTO mapping_pins VALUES('missing','current','key',NULL)",
    "INSERT INTO priority_attempts VALUES('route',2,NULL,NULL,NULL,NULL,NULL,'g',1)",
    "INSERT INTO priority_rollbacks VALUES('missing','key','g')",
  ])
    expect(() => write((tx) => tx.run(sql))).toThrow()
  expect(() => write((tx) => insertResource(tx, { ...r, key: "wrong" }))).toThrow("key/generation")
  expect(() =>
    write((tx) =>
      insertResourceLease(tx, r.key, { token: "bad", owner: { ...owner, pid: 0 }, createdAt: 1 }),
    ),
  ).toThrow("incarnation")
  expect(() =>
    write((tx) =>
      insertResourceLease(tx, r.key, {
        token: "bad",
        owner,
        executor: owner,
        purpose: "publication",
        createdAt: 1,
      }),
    ),
  ).toThrow()
  expect(() =>
    write((tx) =>
      insertResourceLease(tx, r.key, { token: "bad", owner, executorRecoverable: false, createdAt: 1 }),
    ),
  ).toThrow()
  expect(() => write((tx) => tx.run("UPDATE resources SET next_attempt_at=?", NaN))).toThrow("safe integers")
  expect(() =>
    write((tx) => tx.run("UPDATE resources SET next_attempt_at=?", Number.MAX_SAFE_INTEGER + 1)),
  ).toThrow("safe integers")
  expect(readResource(handle.reader, r.key)).toEqual(r)
})

it("round-trips optional NULLs and false independently, including legacy deleting without executor", () => {
  const r = { ...resource(), state: "deleting" as const }
  write((tx) => {
    insertResource(tx, r)
    insertResourceLease(tx, r.key, { token: "unarmed", owner, createdAt: 1 })
    insertResourceLease(tx, r.key, {
      token: "armed",
      owner,
      executor: owner,
      executorRecoverable: false,
      createdAt: 1,
    })
  })
  expect(readResource(handle.reader, r.key)).toEqual({ ...r, rowVersion: 3 })
  expect(readResourceLease(handle.reader, r.key, "unarmed")).toEqual({
    token: "unarmed",
    owner,
    createdAt: 1,
  })
  expect(readResourceLease(handle.reader, r.key, "armed")?.executorRecoverable).toBe(false)
  expect(
    handle.reader.get("SELECT project_dir,deletion_executor_json FROM resources WHERE key=?", r.key),
  ).toEqual({ project_dir: null, deletion_executor_json: null })
})

it("trigger counts equal COUNT across inserts, all state transitions, updates and cascaded deletes", () => {
  const r = resource()
  const check = () => {
    for (const state of RESOURCE_STATES)
      expect(
        handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind=?", `resources:${state}`)?.value,
      ).toBe(handle.reader.get("SELECT count(*) AS n FROM resources WHERE state=?", state)?.n)
    for (const table of ["mappings", "priority_assignments", "priority_attempts"])
      expect(handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind=?", table)?.value).toBe(
        handle.reader.get(`SELECT count(*) AS n FROM ${table}`)?.n,
      )
  }
  check()
  write((tx) => {
    insertResource(tx, r)
    insertMapping(tx, "key", { ...mapping(), currentTranscript: r.locator })
    insertResourceLease(tx, r.key, { token: "t", owner, createdAt: 1 })
    tx.run("INSERT INTO priority_assignments VALUES('route','p','digest',1,'key','g','r',1,1)")
    tx.run("INSERT INTO priority_attempts VALUES('route',0,NULL,NULL,NULL,NULL,NULL,'g',1)")
    tx.run("INSERT INTO priority_rollbacks VALUES('route','key','g')")
  })
  check()
  for (const state of RESOURCE_STATES) {
    write((tx) => tx.run("UPDATE resources SET state=?", state))
    check()
  }
  write((tx) => {
    tx.run("DELETE FROM resources")
    tx.run("DELETE FROM mappings")
    tx.run("DELETE FROM priority_assignments")
    tx.run("DELETE FROM priority_attempts")
  })
  check()
  for (const table of ["mapping_pins", "mapping_history", "resource_leases", "priority_rollbacks"])
    expect(handle.reader.get(`SELECT count(*) AS n FROM ${table}`)?.n).toBe(0)
  expect(handle.reader.get("SELECT count(*) AS n FROM fence_slots")?.n).toBe(2)
})

it("preserves the exact legacy JSON property order, unknown fields and generation digest", () => {
  const entry = { unknown: { z: 1, a: 2 }, messageHashes: [], ...mapping(), sdkMessageUuids: [null, "uuid"] }
  write((tx) => insertMapping(tx, "key", entry))
  expect(JSON.stringify(readMapping(handle.reader, "key"))).toBe(JSON.stringify(entry))
  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  expect(readMappingGeneration(handle.reader, "key")).toBe(
    `p:${hash("key")}:legacy-${hash(JSON.stringify(entry))}`,
  )
  expect(handle.reader.get("SELECT encoding FROM mapping_history")?.encoding).toBe("legacy-entry")
  const old = readMappingGeneration(handle.reader, "key")
  write((tx) => expect(compareAndSwapMapping(tx, "key", old, { ...entry, generationId: "new" })).toBe(true))
  expect(handle.reader.get("SELECT encoding FROM mapping_history")?.encoding).toBe("history")
})

it("round-trips absent history arrays vs empty arrays vs null UUID members, with no aliases", () => {
  const cases: Array<[string, Partial<StoredSession>]> = [
    ["absent", {}],
    ["empty", { messageHashes: [], messageBlockHashes: [], sdkMessageUuids: [] }],
    ["null", { sdkMessageUuids: [null, "u"] }],
  ]
  for (const [key, extra] of cases) {
    const entry: StoredSession = { ...mapping(), generationId: key, ...extra }
    write((tx) => insertMapping(tx, key, entry))
    expect(readMapping(handle.reader, key)).toEqual(entry)
  }
  const r = resource()
  write((tx) => insertMapping(tx, "pin", { ...mapping(), currentTranscript: r.locator }))
  const pins = readSessionTranscriptPins(handle.reader)
  expect(pins).toEqual([r.locator])
  pins[0]!.sessionId = "mutated"
  expect(readSessionTranscriptPins(handle.reader)).toEqual([r.locator])
})

it("rejects stale present generations and missing-key ABA, retaining both independent fence namespaces", () => {
  const absent = readMappingGeneration(handle.reader, "key")
  write((tx) =>
    expect(compareAndSwapMapping(tx, "key", absent, { ...mapping(), generationId: "one" })).toBe(true),
  )
  const first = readMappingGeneration(handle.reader, "key")
  write((tx) =>
    expect(compareAndSwapMapping(tx, "key", first, { ...mapping(), generationId: "two" })).toBe(true),
  )
  write((tx) => expect(compareAndSwapMapping(tx, "key", first)).toBe(false))
  const second = readMappingGeneration(handle.reader, "key")
  write((tx) => expect(compareAndSwapMapping(tx, "key", second)).toBe(true))
  write((tx) =>
    expect(compareAndSwapMapping(tx, "key", absent, { ...mapping(), generationId: "three" })).toBe(false),
  )
  const r = resource()
  write((tx) => insertResource(tx, r))
  write((tx) => expect(compareAndSwapResourceState(tx, r.key, r.generation, 1, "retired", 3)).toBe(true))
  write((tx) => expect(compareAndSwapResourceState(tx, r.key, r.generation, 1, "live", 4)).toBe(false))
  write((tx) => tx.run("DELETE FROM resources WHERE key=?", r.key))
  const next = write((tx) =>
    allocateResource(tx, r.locator, { state: "live", createdAt: 3, updatedAt: 3, attempts: 0 }),
  )
  expect(Number(next.generation.split(":").at(-1))).toBeGreaterThan(Number(r.generation.split(":").at(-1)))
  write((tx) => expect(compareAndSwapResourceState(tx, r.key, r.generation, 1, "retired", 5)).toBe(false))
})

it("uses covering indexes for bounded oldest-retired, due, winner lookup and pins without histories", () => {
  const explain = (sql: string, ...params: Array<string | number>) =>
    handle.reader
      .all(`EXPLAIN QUERY PLAN ${sql}`, ...params)
      .map((row) => row.detail)
      .join(" ")
  expect(explain(RETIRED_PAGE_SQL, 0, "", 128)).toContain("retired_order")
  expect(explain(RETIRED_PAGE_SQL, 0, "", 128)).not.toContain("TEMP B-TREE")
  expect(
    explain("SELECT key FROM resources WHERE state='retired' AND coalesce(next_attempt_at,0)<=?", 10),
  ).toContain("resources_due")
  expect(explain(LOOKUP_CLAUDE_SQL, "c")).toContain("mappings_claude")
  expect(explain(PIN_LOOKUP_SQL, "r", "g")).toContain("pins_resource")
  for (let n = 0; n < 4; n++) {
    const next = resource(String(n))
    write((tx) =>
      insertResource(tx, {
         ...next,
        state: "retired",
        updatedAt: n + 1,
        nextAttemptAt: n === 0 ? 1000 : 0,
      }),
    )
  }
  const page = readRetiredPage(handle.reader, 0, "", 2)
  expect(page.map((row) => row.updated_at)).toEqual([1, 2])
  expect(readRetiredPage(handle.reader, 2, String(page[1]!.key), 2).map((row) => row.updated_at)).toEqual([
    3, 4,
  ])
  expect(() => readRetiredPage(handle.reader, 0, "", 129)).toThrow("bounded")
})

it("refuses inconsistent derived pins on startup, rather than ignoring a no-FK discrepancy", () => {
  const locator = resource().locator
  write((tx) => insertMapping(tx, "pin", { ...mapping(), currentTranscript: locator }))
  write((tx) => tx.run("UPDATE mapping_pins SET resource_key='corrupt'"))
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("pin projection")
})

it("refuses a resource whose generation exceeds its durable fence", () => {
  const r = resource()
  write((tx) => insertResource(tx, r))
  write((tx) => tx.run("UPDATE fence_slots SET counter=1 WHERE namespace='lifecycle'"))
  write((tx) => tx.run("UPDATE resources SET generation=? WHERE key=?", `r:${r.key}:2`, r.key))
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("fence")
})

it("refuses missing histories at startup and extra history fields on hydration", () => {
  write((tx) => insertMapping(tx, "key", { ...mapping(), generationId: "g" }))
  write((tx) => tx.run("UPDATE mapping_history SET history_json=?", '{"claudeSessionId":"override"}'))
  expect(() => readMapping(handle.reader, "key")).toThrow("unexpected mapping history")
  write((tx) => tx.run("DELETE FROM mapping_history"))
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("history/encoding")
})

it("guards SQL mutation style and bumps resource CAS versions for every lease mutation", () => {
  const root = resolve("src/proxy/session/bookkeeping")
  for (const name of readdirSync(root).filter((name) => name.endsWith(".ts"))) {
    expect(readFileSync(join(root, name), "utf8")).not.toMatch(/\bREPLACE\b/i)
  }
  const r = resource()
  write((tx) => {
    insertResource(tx, r)
    insertResourceLease(tx, r.key, { token: "t", owner, createdAt: 1 })
  })
  expect(readResource(handle.reader, r.key)?.rowVersion).toBe(2)
  write((tx) => tx.run("UPDATE resource_leases SET created_at=2 WHERE resource_key=?", r.key))
  expect(readResource(handle.reader, r.key)?.rowVersion).toBe(3)
  write((tx) => expect(compareAndSwapResourceState(tx, r.key, r.generation, 2, "retired", 3)).toBe(false))
  write((tx) => tx.run("DELETE FROM resource_leases WHERE resource_key=?", r.key))
  expect(readResource(handle.reader, r.key)?.rowVersion).toBe(4)
  write((tx) => expect(compareAndSwapResourceState(tx, r.key, r.generation, 4, "retired", 3)).toBe(true))
  expect(
    handle.reader.get("SELECT value FROM bookkeeping_counts WHERE kind='resources:retired'")?.value,
  ).toBe(handle.reader.get("SELECT count(*) AS n FROM resources WHERE state='retired'")?.n)
  handle.close()
  handle = initializeSessionBookkeeping(directory)
})
