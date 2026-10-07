import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as facade from "../proxy/sessionStore"
import { BookkeepingBusyError, initializeSessionBookkeeping, withBookkeepingWrite }
  from "../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { withStoreRead, withStoreWrite } from "../proxy/session/bookkeeping/storeScope"
import { activeStoreBackend } from "../proxy/session/bookkeeping/storeBackend"
import {
  getSessionStoreDir, readSessionTranscriptPins, setSessionStoreBackendForTest, setSessionStoreDir, storeSharedSession,
} from "../proxy/sessionStore"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

let directory: string
let handles: BookkeepingHandle[]
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-store-seam-")))
  handles = []
  setSessionStoreBackendForTest(null)
})
afterEach(() => {
  setSessionStoreBackendForTest(null)
  setSessionStoreDir(null)
  for (const handle of handles.reverse()) handle.close()
  rmSync(directory, { recursive: true, force: true })
})

it("keeps JSON as the default and returns copied locators from the additive pin API", () => {
  setSessionStoreDir(directory)
  expect(activeStoreBackend()).toBeUndefined()
  storeSharedSession("key", "session", 0, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, { configDir: directory, sessionId: "session" })
  const pins = readSessionTranscriptPins()
  expect(pins).toEqual([{ configDir: directory, sessionId: "session" }])
  pins[0]!.configDir = "/changed"
  expect(readSessionTranscriptPins()[0]!.configDir).toBe(directory)
  expect(JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8")).key.claudeSessionId).toBe("session")
})

it("joins an explicit publication once, reads its writes, and defers hooks until commit", () => {
  const statements: string[] = []
  handles.push(initializeSessionBookkeeping(directory, { executeTransaction: (db, sql) => {
    statements.push(sql)
    db.exec(sql)
  } }))
  let committed = false
  withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(directory, (tx) => {
      tx.run("INSERT INTO fence_slots VALUES('store','abcd',1)")
      tx.afterCommit(() => { committed = true })
    })
    expect(withStoreRead(directory, (reader) => reader.get("SELECT counter FROM fence_slots")?.counter)).toBe(1)
    expect(committed).toBe(false)
  })
  expect(committed).toBe(true)
  expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
})

it("discards hooks and staged changes when the publication returns false", () => {
  handles.push(initializeSessionBookkeeping(directory))
  let hooks = 0
  expect(withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(directory, (tx) => {
      tx.run("INSERT INTO fence_slots VALUES('store','abcd',1)")
      tx.afterCommit(() => { hooks++ })
    })
    return false
  })).toBe(false)
  expect(hooks).toBe(0)
  expect(withStoreRead(directory, (reader) => reader.get("SELECT count(*) AS n FROM fence_slots")?.n)).toBe(0)
})

it("refuses facade identity changes in read/write scopes and releases the guard after failure", () => {
  handles.push(initializeSessionBookkeeping(directory))
  setSessionStoreDir(directory)
  for (const scope of ["read", "write"]) {
    const check = () => {
      expect(() => setSessionStoreDir(null)).toThrow("cannot change session store identity")
      expect(() => setSessionStoreBackendForTest(null)).toThrow("cannot change session store identity")
      expect(getSessionStoreDir()).toBe(directory)
      throw new Error("rollback")
    }
    expect(() => scope === "read" ? withStoreRead(directory, check) : withStoreWrite(directory, check))
      .toThrow("rollback")
  }
  setSessionStoreDir(null)
  setSessionStoreBackendForTest(null)
})

it("rejects cross-database store admission before mutation", () => {
  const other = join(directory, "other")
  handles.push(initializeSessionBookkeeping(directory), initializeSessionBookkeeping(other))
  let entered = false
  expect(() => withBookkeepingWrite(directory, { scope: "publication" }, () => {
    withStoreWrite(other, () => { entered = true })
  })).toThrow("cross-database publication")
  expect(entered).toBe(false)
})

it("does not fall back to JSON inside an SQL publication when no SQL backend was installed", () => {
  handles.push(initializeSessionBookkeeping(directory))
  setSessionStoreDir(directory)
  expect(() => withStoreWrite(directory, () => storeSharedSession("key", "session")))
    .toThrow("JSON session store cannot run inside a bookkeeping transaction")
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
})

it("returns typed overload without sleeping when a real child holds BEGIN IMMEDIATE", async () => {
  const handle = initializeSessionBookkeeping(directory)
  handles.push(handle)
  expect(Object.values(handle.reader.get("PRAGMA busy_timeout")!)).toEqual([0])
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(${JSON.stringify(handle.path)});
    db.exec('BEGIN IMMEDIATE');
    process.send('locked');
    process.on('disconnect', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`busy holder exited before ready: ${code}: ${stderr}`)
    })])
    const sleeping = spyOn(Atomics, "wait").mockImplementation(() => { throw new Error("sync sleep forbidden") })
    let entered = false
    const start = performance.now()
    try {
      try {
        withStoreWrite(directory, () => { entered = true })
        throw new Error("busy mutation unexpectedly admitted")
      } catch (error) {
        expect(error).toBeInstanceOf(BookkeepingBusyError)
        expect(error).toBeInstanceOf(SessionLifecycleLockError)
      }
      expect(sleeping).not.toHaveBeenCalled()
      expect(entered).toBe(false)
      writeBenchArtifact("store-scope-busy.json", { elapsedMs: performance.now() - start, entered, busyTimeout: 0 })
    } finally { sleeping.mockRestore() }
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      if (child.connected) child.disconnect()
      else child.kill("SIGKILL")
      await exited
    }
  }
}, 20000)

it("preserves the portable JSON store API, fenced CAS and replacement lineage", () => {
  setSessionStoreDir(directory)
  const missing: facade.SharedSessionLookupResult = facade.lookupSharedSessionResult("contract")
  expect(missing.status).toBe("missing")
  const locator: facade.TranscriptLocator = { configDir: directory, sessionId: "first" }
  const first: facade.StoredSessionGeneration | false = facade.storeSharedSession("contract", "first", 2,
    "lineage", ["human", "assistant"], [null, "assistant-uuid"], undefined, [["block"]], null, null,
    locator, undefined, null)
  expect(typeof first).toBe("string")
  const found: facade.SharedSessionLookupResult = facade.lookupSharedSessionResult("contract")
  expect(found.status).toBe("found")
  if (found.status !== "found" || typeof first !== "string") throw new Error("expected mapping")
  expect(found.generation).toBe(first)
  expect(found.session.sdkMessageUuids).toEqual([null, "assistant-uuid"])
  expect(found.session.currentTranscript).toEqual(locator)
  const before = readFileSync(join(directory, "sessions.json"), "utf8")
  expect(facade.storeSharedSession("contract", "rejected", 0, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, null)).toBe(false)
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(before)
  const second = facade.storeSharedSession("contract", "second", 3, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, { configDir: directory, sessionId: "second" }, locator, first)
  expect(typeof second).toBe("string")
  expect(second).not.toBe(first)
  const snapshot: Record<string, facade.StoredSession> = facade.readSessionStoreSnapshot()
  expect(snapshot.contract?.previousClaudeSessionId).toBe("first")
  expect(snapshot.contract?.previousTranscript).toEqual(locator)
  expect(facade.lookupSharedSessionByClaudeId("second")?.claudeSessionId).toBe("second")
  expect(facade.readSessionTranscriptPins()).toHaveLength(2)
  expect(facade.evictSharedSession("contract", first)).toBe(false)
  if (typeof second !== "string") throw new Error("expected replacement")
  expect(facade.evictSharedSession("contract", second)).toBe(true)
  expect(facade.lookupSharedSession("contract")).toBeUndefined()
  expect(facade.lookupSharedSessionResult("contract").status).toBe("missing")
  expect(facade.readSessionStoreSnapshot()).toEqual({})
})
