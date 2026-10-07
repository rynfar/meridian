import { afterEach, beforeEach, expect, it } from "bun:test"
import Database from "libsql"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  initializeSessionBookkeeping,
  withBookkeepingRead,
  withBookkeepingWrite,
  withBookkeepingWriteAsync,
  BookkeepingMaintenanceRequiredError,
  BookkeepingCommitUncertainError,
  BookkeepingBusyError,
} from "../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { assertSupportedFilesystem } from "../proxy/session/bookkeeping/connection"
import { allocateResource, compareAndSwapResourceState } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import {
  readMapping, validateMappingPins, captureMappingPinsValidation,
} from "../proxy/session/bookkeeping/mappings"
import { insertMapping } from "../proxy/session/bookkeeping/resourceImport"
import { openForMaintenance } from "../proxy/session/bookkeeping/maintenance"
import type {
  CanonicalTranscriptLocator,
  TranscriptLocator,
  BookkeepingTransaction,
  BookkeepingReader,
} from "../proxy/session/bookkeeping/types"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"
import { SessionLifecycleCorruptError } from "../proxy/session/lifecycleErrors"

type AssertFalse<T extends false> = T
type RawLocatorRejected = AssertFalse<TranscriptLocator extends CanonicalTranscriptLocator ? true : false>
type MappingLocator = NonNullable<Parameters<typeof insertMapping>[2]["currentTranscript"]>
type RawMappingRejected = AssertFalse<TranscriptLocator extends MappingLocator ? true : false>

let directory: string, handle: BookkeepingHandle
let locator: CanonicalTranscriptLocator
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-review-"))
  handle = initializeSessionBookkeeping(directory)
  locator = canonicalizeLocator({ configDir: directory, sessionId: "c" })
})
afterEach(() => {
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})
const fields = { state: "live" as const, createdAt: 1, updatedAt: 1, attempts: 0 }
const write = <T>(callback: (tx: BookkeepingTransaction) => T) =>
  withBookkeepingWrite(directory, { scope: "store" }, callback)

it("a live connection retains the WAL DMS byte-range lock after startup and another local handle", () => {
  const probe = () => spawnSync("python3", ["-c", `
import errno,fcntl,os,sys
fd=os.open(sys.argv[1],os.O_RDWR)
try:
  fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB,1,128,os.SEEK_SET)
except OSError as e:
  if e.errno not in (errno.EACCES,errno.EAGAIN): raise
  sys.exit(73)
sys.exit(0)
`, `${handle.path}-shm`], { encoding: "utf8", timeout: 5000 })
  expect(probe().status).toBe(73)
  const second = initializeSessionBookkeeping(directory)
  second.close()
  expect(probe().status).toBe(73)
})

it("END, END TRANSACTION and discarded statement tails cannot commit a rejected callback", () => {
  for (const sql of ["END", "END TRANSACTION", "SELECT 1; DELETE FROM resources", "SELECT 1; ;"]) {
    expect(() => write((tx) => {
      allocateResource(tx, locator, fields)
      tx.run(sql)
      return false
    })).toThrow()
    expect(handle.reader.get("SELECT count(*) AS n FROM resources")?.n).toBe(0)
  }
  expect(write((tx) => { tx.run("SELECT 1; \n"); return false })).toBe(false)
})

it("automatic transaction rollback poisons rather than allowing later autocommit writes", () => {
  handle.close()
  let injected = false
  handle = initializeSessionBookkeeping(directory, {
    executeTransaction(db, sql) {
      db.exec(sql)
      if (sql === "BEGIN IMMEDIATE" && !injected) {
        injected = true
        db.exec(`CREATE TEMP TRIGGER abort_update BEFORE UPDATE ON resources
          BEGIN SELECT RAISE(ROLLBACK,'injected automatic rollback'); END`)
      }
    },
  })
  expect(() => write((tx) => {
    const resource = allocateResource(tx, locator, fields)
    tx.run("UPDATE resources SET state='retired' WHERE key=?", resource.key)
  })).toThrow("lost its transaction")
  write((tx) => expect(tx.get("SELECT count(*) AS n FROM resources")?.n).toBe(0))
})

it("canonical locators cannot be mutated into pins for a different directory", () => {
  const key = resourceKey(locator)
  expect(Object.isFrozen(locator)).toBe(true)
  expect(Reflect.set(locator, "configDir", join(directory, "other"))).toBe(false)
  write((tx) => insertMapping(tx, "immutable", {
    claudeSessionId: locator.sessionId, createdAt: 1, lastUsedAt: 1, messageCount: 0,
    currentTranscript: locator,
  }))
  expect(handle.reader.get("SELECT resource_key FROM mapping_pins")?.resource_key).toBe(key)
})

it("COMMIT busy is typed and async admission never replays its callback", async () => {
  handle.close()
  let calls = 0
  handle = initializeSessionBookkeeping(directory, {
    executeTransaction(db, sql) {
      if (sql === "COMMIT") throw Object.assign(new Error("busy commit"), { code: "SQLITE_BUSY" })
      db.exec(sql)
    },
  })
  await expect(withBookkeepingWriteAsync(directory, {}, (tx) => {
    calls++
    allocateResource(tx, locator, fields)
  })).rejects.toBeInstanceOf(BookkeepingBusyError)
  expect(calls).toBe(1)
  expect(handle.reader.get("SELECT count(*) AS n FROM resources")?.n).toBe(0)
})

it("a formerly absent lexical directory becoming a symlink requires recanonicalize", () => {
  const missing = join(directory, "later")
  const original = canonicalizeLocator({ configDir: missing, sessionId: "later" })
  write((tx) => insertMapping(tx, "later", {
    claudeSessionId: "later", createdAt: 1, lastUsedAt: 1, messageCount: 0, currentTranscript: original,
  }))
  symlinkSync(directory, missing)
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow(BookkeepingMaintenanceRequiredError)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recanonicalize")
  let observed: unknown
  try {
    initializeSessionBookkeeping(directory)
  } catch (error) {
    observed = error
  }
  expect(observed).toBeInstanceOf(BookkeepingMaintenanceRequiredError)
  expect(observed).not.toBeInstanceOf(SessionLifecycleCorruptError)
})

it("startup validation pages histories by key and does not retain a whole table", () => {
  write((tx) => {
    for (let i = 0; i < 270; i++) insertMapping(tx, `key${i.toString().padStart(3, "0")}`, {
      claudeSessionId: "c", createdAt: 1, lastUsedAt: 1, messageCount: 1, messageHashes: ["x".repeat(4096)],
    })
  })
  const pages: number[] = []
  withBookkeepingRead(directory, (reader) => {
    const checked: BookkeepingReader = {
      get: (sql, ...args) => reader.get(sql, ...args),
      all(sql, ...args) {
        const rows = reader.all(sql, ...args)
        if (sql.includes("history_json")) {
          expect(sql).toContain("ORDER BY m.key LIMIT 128")
          expect(rows.length).toBeLessThanOrEqual(128)
          pages.push(rows.length)
        }
        return rows
      },
    }
    captureMappingPinsValidation(checked)()
  })
  expect(pages).toEqual([128, 128, 14, 0])
})

for (const mode of ["no-open", "close-fault", "close-direct-fault"] as const) {
  it(`process safety: ${mode}`, async () => {
    const build = await buildNodeFixture("bookkeeping-safety.ts", "safety.mjs", directory)
    expect(build.success).toBe(true)
    const childDirectory = join(directory, "child")
    mkdirSync(childDirectory, { mode: 0o700 })
    const child = spawnSync("node", [join(directory, "safety.mjs"), mode, childDirectory], {
      encoding: "utf8", timeout: 10000,
    })
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
  })
}

for (const suffix of ["", "-wal"]) {
  it(`FIFO ${suffix || "main"} refuses promptly instead of blocking open`, async () => {
    handle.close()
    const build = await buildNodeFixture("bookkeeping-safety.ts", "safety.mjs", directory)
    expect(build.success).toBe(true)
    const path = join(directory, `session-bookkeeping.sqlite${suffix}`)
    rmSync(path, { force: true })
    expect(spawnSync("mkfifo", [path]).status).toBe(0)
    const child = spawnSync("node", [join(directory, "safety.mjs"), "startup", directory], {
      encoding: "utf8", timeout: 5000,
    })
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
  })
}

it("runtime allocator fences deletion/recreation without accepting caller-supplied generations", () => {
  const first = write((tx) => allocateResource(tx, locator, fields))
  write((tx) => tx.run("DELETE FROM resources WHERE key=?", first.key))
  const second = write((tx) => allocateResource(tx, locator, fields))
  expect(first.generation).not.toBe(second.generation)
  expect(write((tx) => compareAndSwapResourceState(tx, first.key, first.generation, 1, "retired", 2))).toBe(
    false,
  )
  const injected = { ...fields, generation: first.generation, rowVersion: 1 }
  expect(() => write((tx) => allocateResource(tx, locator, injected))).toThrow("cannot accept")
})

it("canonical symlink pin is the resource key and legacy payload mismatch fails startup", () => {
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  const canonical = canonicalizeLocator({ configDir: alias, sessionId: "c" })
  const resource = write((tx) => allocateResource(tx, locator, fields))
  write((tx) =>
    insertMapping(tx, "key", {
      claudeSessionId: "c",
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      currentTranscript: canonical,
    }),
  )
  expect(handle.reader.get("SELECT resource_key FROM mapping_pins")?.resource_key).toBe(resource.key)
  expect(resourceKey(canonical)).toBe(resource.key)
  validateMappingPins(handle.reader)
  write((tx) => {
    tx.run("UPDATE mappings SET current_locator_json=NULL")
    tx.run("DELETE FROM mapping_pins")
  })
  expect(withBookkeepingRead(directory, (reader) => readMapping(reader, "key"))?.currentTranscript).toEqual(
    canonical,
  )
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("metadata/payload mismatch")
})

for (const scope of ["write", "read"] as const) {
  it(`poisons on failed ${scope} rollback and preserves both errors`, () => {
    handle.close()
    let fail = true
    handle = initializeSessionBookkeeping(directory, {
      executeTransaction(db, sql) {
        if (sql === "ROLLBACK" && fail) {
          fail = false
          throw new Error("rollback fault")
        }
        db.exec(sql)
      },
    })
    let caught: unknown
    const callback = () => {
      throw new Error("original callback fault")
    }
    try {
      if (scope === "write") write(callback)
      else withBookkeepingRead(directory, callback)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.map(String)).toEqual([
      "Error: original callback fault",
      "Error: rollback fault",
    ])
    expect(write((tx) => tx.run("INSERT INTO fence_slots VALUES('store','next',1)"))).toBe(1)
  })
}

it("runtime rejects PREPARED and legacy names while maintenance opens only its expected phase", () => {
  handle.close()
  const db = new Database(handle.path)
  db.exec("UPDATE schema_meta SET phase='PREPARED'")
  db.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow(BookkeepingMaintenanceRequiredError)
  writeFileSync(join(directory, "sessions.json"), "{}")
  handle = openForMaintenance(directory, { expectPhase: "PREPARED" })
  expect(handle.reader.get("SELECT phase FROM schema_meta")?.phase).toBe("PREPARED")
})

it("startup checks the real canonical pin key, not just matching corrupted raw aliases", () => {
  const alias = join(directory, "alias")
  symlinkSync(directory, alias)
  write((tx) =>
    insertMapping(tx, "key", {
      claudeSessionId: "c",
      generationId: "g",
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      currentTranscript: locator,
    }),
  )
  const raw = { sessionId: "c", configDir: alias }
  write((tx) => {
    tx.run("UPDATE mappings SET current_locator_json=?", JSON.stringify(raw))
    tx.run("UPDATE mapping_pins SET resource_key=?", resourceKey(raw))
  })
  handle.close()
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recanonicalize")
})

it("reader capability cannot perform writes or transaction-control and seam replacement is explicit error", () => {
  expect(() => initializeSessionBookkeeping(directory, { executeTransaction() {} })).toThrow("already open")
  write(() => {
    expect(() => handle.reader.get("SELECT 1")).toThrow("transaction reader")
    withBookkeepingRead(directory, (reader) => {
      expect("run" in reader).toBe(false)
      expect("afterCommit" in reader).toBe(false)
    })
  })
  for (const sql of [
    "BEGIN",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT a",
    "RELEASE a",
    "ATTACH 'x' AS a",
    "DETACH a",
    "PRAGMA user_version=2",
    "VACUUM",
  ]) {
    expect(() => write((tx) => tx.run(sql))).toThrow("transaction-control")
  }
})

it("filesystem allowlist rejects unverified transports and directory modes are not silently repaired", () => {
  const previous = process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS
  delete process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS
  try {
    for (const type of [0x65735546, 0x01021997, 0x6969]) {
      expect(() => assertSupportedFilesystem(type, "linux")).toThrow("unsupported")
    }
    for (const type of [0xef53, 0x58465342, 0x9123683e, 0x01021994]) {
      expect(() => assertSupportedFilesystem(type, "linux")).not.toThrow()
    }
    process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS = "1"
    expect(() => assertSupportedFilesystem(0x65735546, "linux")).not.toThrow()
  } finally {
    if (previous === undefined) delete process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS
    else process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS = previous
  }
  handle.close()
  chmodSync(directory, 0o755)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("already be private")
  chmodSync(directory, 0o700)
})

for (const code of ["SQLITE_NOMEM", "SQLITE_CORRUPT", "SQLITE_CANTOPEN", "SQLITE_PROTOCOL", "OTHER"]) {
  it(`treats COMMIT ${code} as unknown, but recovery does not scan all data`, async () => {
    handle.close()
    let fail = true
    handle = initializeSessionBookkeeping(directory, {
      executeTransaction(db, sql) {
        if (sql === "COMMIT" && fail) {
          fail = false
          db.exec("COMMIT")
          throw Object.assign(new Error(code), { code })
        }
        db.exec(sql)
      },
    })
    await expect(
      withBookkeepingWriteAsync(directory, {}, (tx) => {
        tx.run("UPDATE bookkeeping_counts SET value=9 WHERE kind='mappings'")
      }),
    ).rejects.toBeInstanceOf(BookkeepingCommitUncertainError)
    // Deliberately damaged counts: fast recovery validates format, not the full data set.
    expect(write(() => 42)).toBe(42)
    handle.close()
    expect(() => initializeSessionBookkeeping(directory)).toThrow("counters")
  })
}

it("two simultaneous initializers publish a complete schema; dead linked bootstrap aliases require exclusive recovery", async () => {
  handle.close()
  for (const name of readdirSync(directory)) rmSync(join(directory, name), { recursive: true, force: true })
  const build = await buildNodeFixture("bookkeeping-bootstrap.ts", "bootstrap.mjs", directory)
  expect(build.success).toBe(true)
  const script = join(directory, "bootstrap.mjs")
  const children = [0, 1].map(() =>
    spawn("node", [script, directory], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }),
  )
  const exited = children.map(
    (child) =>
      new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve)
        child.once("error", reject)
      }),
  )
  const ready = children.map((child, index) => Promise.race([
    new Promise<void>((resolve) => child.once("message", () => resolve())),
    exited[index]!.then(code => { throw new Error(`initializer exited before ready: ${code}`) }),
  ]))
  const timer = setTimeout(() => children.forEach((child) => child.kill("SIGTERM")), 10000)
  try {
    await Promise.all(ready)
    children.forEach((child) => child.send("start"))
    expect(await Promise.all(exited)).toEqual([0, 0])
  } finally {
    clearTimeout(timer)
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGTERM")
    })
    await Promise.allSettled(exited)
  }
  const safety = await Bun.build({
    entrypoints: [resolve("src/__tests__/fixtures/bookkeeping-safety.ts")],
    target: "node", naming: "safety.mjs", outdir: directory, external: ["libsql"],
  })
  expect(safety.success).toBe(true)
  const orphan = spawnSync("node", [join(directory, "safety.mjs"), "orphan", directory])
  expect(orphan.status).toBe(0)
  expect(() => initializeSessionBookkeeping(directory)).toThrow("recover-bootstrap")
  const { recoverBootstrapAliases } = await import("../proxy/session/bookkeeping/bootstrapRecovery")
  recoverBootstrapAliases(directory, { writersStopped: true })
  handle = initializeSessionBookkeeping(directory)
  expect(readdirSync(directory).some((name) => name.includes(".tmp-"))).toBe(false)
  expect(handle.reader.get("PRAGMA user_version")?.user_version).toBe(1)
}, 15000)

it("a holder exits and releases its transaction when its IPC parent disconnects", async () => {
  const build = await buildNodeFixture("bookkeeping-contention.ts", "holder.mjs", directory)
  expect(build.success).toBe(true)
  const child = spawn("node", [join(directory, "holder.mjs"), directory, "holder"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  let stderr = ""
  child.stderr?.on("data", chunk => { stderr += String(chunk) })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", resolve); child.once("error", reject)
  })
  const timer = setTimeout(() => child.kill("SIGTERM"), 4000)
  try {
    await Promise.race([
      new Promise<void>(resolve => child.once("message", () => resolve())),
      exited.then(() => { throw new Error(`holder exited before lock: ${stderr}`) }),
    ])
    child.disconnect()
    expect(await exited).toBe(0)
    expect(stderr).toBe("")
    expect(write(() => "admitted")).toBe("admitted")
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGTERM")
    await exited.catch(() => undefined)
  }
})
