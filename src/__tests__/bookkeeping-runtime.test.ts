import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"
import {
  bookkeepingMode, initializeProxyBookkeeping, retainProxyBookkeeping, admitSessionStoreWrite,
} from "../proxy/session/bookkeeping/runtime"
import { initializeSessionBookkeeping, type BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { activeStoreBackend } from "../proxy/session/bookkeeping/storeBackend"
import { activeLifecycleBackend } from "../proxy/session/bookkeeping/lifecycleBackend"
import { setSessionStoreDir, storeSharedSession, lookupSharedSession, readSessionTranscriptPins,
  lookupSharedSessionResult, lookupPriorityAssignmentResult, storeSharedSessionAndPriorityAssignment,
  rollbackSharedSessionAndPriorityAssignment } from "../proxy/sessionStore"
import { resourceKey } from "../proxy/session/bookkeeping/locator"
import { registerLiveTranscript, runGc } from "../proxy/sessionLifecycle"
import { connectionFor } from "../proxy/session/bookkeeping/connection"

let directory: string
const handles: BookkeepingHandle[] = []
let saved: string | undefined
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-runtime-"))
  saved = process.env.MERIDIAN_BOOKKEEPING
  process.env.MERIDIAN_BOOKKEEPING = "sqlite"
  setSessionStoreDir(directory)
})
afterEach(() => {
  for (const handle of handles.splice(0).reverse()) handle.close()
  setSessionStoreDir(null)
  if (saved === undefined) delete process.env.MERIDIAN_BOOKKEEPING
  else process.env.MERIDIAN_BOOKKEEPING = saved
  rmSync(directory, { recursive: true, force: true })
})

it("requires explicit initialization for synchronous embedders and validates the mode", () => {
  expect(() => retainProxyBookkeeping()).toThrow("initializeSessionBookkeeping")
  expect(() => bookkeepingMode({ MERIDIAN_BOOKKEEPING: "typo" })).toThrow("json or sqlite")
  expect(bookkeepingMode({})).toBe("json")
})

it("installs both complete ports and retains the connection until the last owner closes", async () => {
  const initialized = await initializeProxyBookkeeping()
  if (!initialized) throw new Error("SQL startup missing")
  handles.push(initialized)
  const retained = retainProxyBookkeeping()
  if (!retained) throw new Error("SQL retention missing")
  handles.push(retained)
  expect(activeStoreBackend()).toBeDefined()
  expect(activeLifecycleBackend()).toBeDefined()
  expect(() => setSessionStoreDir(directory)).toThrow("proxies are running")
  initialized.close()
  expect(await admitSessionStoreWrite(() => storeSharedSession("key", "sdk"))).not.toBe(false)
  expect(lookupSharedSession("key")?.claudeSessionId).toBe("sdk")
  expect(readSessionTranscriptPins()).toEqual([])
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  retained.close()
  expect(activeStoreBackend()).toBeUndefined()
  expect(activeLifecycleBackend()).toBeUndefined()
  const reopened = initializeSessionBookkeeping(directory)
  handles.push(reopened)
  expect(reopened.reader.get("SELECT count(*) AS n FROM mappings")?.n).toBe(1)
})

it("releases only a nonfinal owner during admission while the last owner retains its guard", async () => {
  const first = await initializeProxyBookkeeping()
  const second = retainProxyBookkeeping()
  if (!first || !second) throw new Error("SQL owners missing")
  handles.push(first, second)
  const pending = admitSessionStoreWrite(() => storeSharedSession("active-owner", "sdk"))
  expect(() => first.close()).not.toThrow()
  expect(() => second.close()).toThrow("cannot close during transaction/admission")
  await pending
  expect(lookupSharedSession("active-owner")?.claudeSessionId).toBe("sdk")
  second.close()
  expect(activeStoreBackend()).toBeUndefined()
})

it("does not import legacy data implicitly and permits only explicit offline migration", async () => {
  process.env.MERIDIAN_BOOKKEEPING = "json"
  storeSharedSession("legacy", "sdk-legacy")
  const bytes = readFileSync(join(directory, "sessions.json"), "utf8")
  process.env.MERIDIAN_BOOKKEEPING = "sqlite"
  await expect(initializeProxyBookkeeping()).rejects.toThrow("offline migration")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(bytes)
  expect(existsSync(join(directory, "session-bookkeeping.sqlite"))).toBe(false)
  await migrateBookkeeping(directory, { writersStopped: true })
  const handle = await initializeProxyBookkeeping()
  if (!handle) throw new Error("SQL startup missing")
  handles.push(handle)
  expect(lookupSharedSession("legacy")?.claudeSessionId).toBe("sdk-legacy")
  handle.close()
  process.env.MERIDIAN_BOOKKEEPING = "json"
  expect(() => retainProxyBookkeeping()).toThrow("explicit maintenance")
})

it("refuses corrupt SQLite rather than creating JSON or a fresh database", async () => {
  writeFileSync(join(directory, "session-bookkeeping.sqlite"), "not sqlite", { mode: 0o600 })
  await expect(initializeProxyBookkeeping()).rejects.toThrow()
  expect(existsSync(join(directory, "sessions.json"))).toBe(false)
  expect(readFileSync(join(directory, "session-bookkeeping.sqlite"), "utf8")).toBe("not sqlite")
})

it("migration priority rollback inside production admission preserves both canonical pins and GC protection", async () => {
  const real = join(directory, "real"), alias = join(directory, "alias")
  mkdirSync(real)
  symlinkSync(real, alias)
  const registeredOld = await registerLiveTranscript({ configDir: alias, sessionId: "old" }, { storeDir: directory })
  const registeredPrior = await registerLiveTranscript({ configDir: alias, sessionId: "prior" }, { storeDir: directory })
  const old = { ...registeredOld, configDir: alias }
  const prior = { ...registeredPrior, configDir: alias }
  const entry = { claudeSessionId: "old", createdAt: 1, lastUsedAt: 2, messageCount: 1,
    currentTranscript: old, previousClaudeSessionId: "prior", previousTranscript: prior }
  writeFileSync(join(directory, "sessions.json"), JSON.stringify({ key: entry }), { mode: 0o600 })
  await migrateBookkeeping(directory, { writersStopped: true })
  const handle = await initializeProxyBookkeeping()
  if (!handle) throw new Error("SQL startup missing")
  handles.push(handle)
  const raw = handle.reader.get("SELECT history_json FROM mapping_history WHERE mapping_key='key'")?.history_json
  expect(JSON.parse(String(raw))).toEqual(entry)
  const mapping = lookupSharedSessionResult("key"), route = lookupPriorityAssignmentResult("route")
  if (mapping.status === "error" || !mapping.generation || route.status === "error") throw new Error("lookup failed")
  const publication = await admitSessionStoreWrite(() => storeSharedSessionAndPriorityAssignment({
    key: "key", claudeSessionId: "new", messageCount: 2, expectedMappingGeneration: mapping.generation!,
    lineageHash: "new-lineage", messageHashes: [], messageBlockHashes: [],
    priority: { routeKey: "route", profileId: "profile", lastHumanTurnDigest: "a".repeat(43),
      lastHumanTurnIssuedAt: 1, expectedAssignmentGeneration: route.generation },
  }))
  if (!publication) throw new Error("publication failed")
  const rolledBack = await admitSessionStoreWrite(() => rollbackSharedSessionAndPriorityAssignment({
    key: "key", routeKey: "route", expectedMappingGeneration: publication.mappingGeneration,
    expectedAssignmentGeneration: publication.assignmentGeneration,
    previousMapping: publication.previousMapping, previousAssignment: publication.previousAssignment,
  }))
  expect(rolledBack).not.toBe(false)
  const canonical = realpathSync(real)
  expect(handle.reader.all("SELECT slot,resource_key,generation FROM mapping_pins WHERE mapping_key='key' ORDER BY slot"))
    .toEqual([{ slot: "current", resource_key: resourceKey({ ...old, configDir: canonical }), generation: old.lifecycleGeneration ?? null },
      { slot: "previous", resource_key: resourceKey({ ...prior, configDir: canonical }), generation: prior.lifecycleGeneration ?? null }])
  let deletedOld = false
  await runGc([], { storeDir: directory, retiredGraceMs: 0, deleter: async locator => {
    if (locator.sessionId === "old") deletedOld = true
  } })
  expect(deletedOld).toBe(false)
  expect(handle.reader.get("SELECT state FROM resources WHERE key=?", resourceKey({ ...old, configDir: canonical }))?.state)
    .toBe("live")
})

it("default directory addressing performs no filesystem discovery inside production store admission", async () => {
  setSessionStoreDir(null)
  const env = [process.env.MERIDIAN_SESSION_DIR, process.env.CLAUDE_PROXY_SESSION_DIR]
  delete process.env.MERIDIAN_SESSION_DIR
  delete process.env.CLAUDE_PROXY_SESSION_DIR
  const home = spyOn(os, "homedir").mockReturnValue(directory)
  let exists: ReturnType<typeof spyOn> | undefined
  try {
    const handle = await initializeProxyBookkeeping()
    if (!handle) throw new Error("SQL startup missing")
    handles.push(handle)
    const resolved = join(directory, ".cache", "meridian")
    const original = fs.existsSync
    const accesses: string[] = []
    exists = spyOn(fs, "existsSync").mockImplementation(path => {
      if (connectionFor(resolved).scope === "write") accesses.push(String(path))
      return original(path)
    })
    expect(await admitSessionStoreWrite(() => storeSharedSession("default", "sdk"))).not.toBe(false)
    expect(accesses).toEqual([])
  } finally {
    exists?.mockRestore()
    home.mockRestore()
    for (const [index, key] of ["MERIDIAN_SESSION_DIR", "CLAUDE_PROXY_SESSION_DIR"].entries()) {
      if (env[index] === undefined) delete process.env[key]
      else process.env[key] = env[index]
    }
  }
})

it("pays a large limit reduction in bounded pre-listen pages without hydrating a full store", async () => {
  const sessions = Object.fromEntries(Array.from({ length: 270 }, (_, index) => [`key-${index}`, {
    claudeSessionId: `sdk-${index}`, createdAt: 1, lastUsedAt: index + 1, messageCount: 0,
  }]))
  writeFileSync(join(directory, "sessions.json"), JSON.stringify(sessions), { mode: 0o600 })
  await migrateBookkeeping(directory, { writersStopped: true })
  const previous = process.env.MERIDIAN_MAX_STORED_SESSIONS
  process.env.MERIDIAN_MAX_STORED_SESSIONS = "2"
  try {
    const handle = await initializeProxyBookkeeping()
    if (!handle) throw new Error("SQL startup missing")
    handles.push(handle)
    expect(handle.reader.get("SELECT count(*) AS n FROM mappings")?.n).toBe(2)
    expect(lookupSharedSession("key-268")?.claudeSessionId).toBe("sdk-268")
    expect(lookupSharedSession("key-269")?.claudeSessionId).toBe("sdk-269")
    expect(lookupSharedSession("key-0")).toBeUndefined()
    expect(handle.reader.get("SELECT sum(counter) AS n FROM fence_slots WHERE namespace='store'")?.n).toBe(268)
  } finally {
    if (previous === undefined) delete process.env.MERIDIAN_MAX_STORED_SESSIONS
    else process.env.MERIDIAN_MAX_STORED_SESSIONS = previous
  }
})

it("async-admits real production store operations against another Node writer without blocking timers", async () => {
  const handle = await initializeProxyBookkeeping()
  if (!handle) throw new Error("SQL startup missing")
  handles.push(handle)
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout=0'); db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    process.stdin.resume(); process.stdin.once('data', () => { db.exec('ROLLBACK'); db.close(); process.exit(0) });
  `, handle.path], { stdio: ["pipe", "pipe", "pipe"] })
  const exit = once(child, "exit")
  const ticks: number[] = []
  let timer: ReturnType<typeof setInterval> | undefined
  try {
    const [bytes] = await once(child.stdout, "data")
    expect(String(bytes)).toContain("locked")
    timer = setInterval(() => ticks.push(performance.now()), 5)
    const started = performance.now()
    await expect(admitSessionStoreWrite(() => storeSharedSession("blocked", "sdk"), { lockWaitMs: 150 }))
      .rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(performance.now() - started).toBeGreaterThanOrEqual(140)
    expect(ticks.length).toBeGreaterThanOrEqual(20)
    expect(lookupSharedSession("blocked")).toBeUndefined()
    child.stdin.write("release")
    expect((await exit)[0]).toBe(0)
    expect(await admitSessionStoreWrite(() => storeSharedSession("after", "sdk"))).not.toBe(false)
  } finally {
    if (timer) clearInterval(timer)
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await exit
    }
  }
})
