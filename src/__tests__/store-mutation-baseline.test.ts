import { afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setSessionStoreDir, storeSharedSession, withLegacyStoreMaintenanceLock } from "../proxy/sessionStore"
import { rewriteFullStore } from "./fixtures/full-document-store-rewrite"

let directory: string
const entry = { claudeSessionId: "会話", createdAt: 1, lastUsedAt: 2, messageCount: 0,
  extension: { text: "🔐 café", unknown: null } }
const original = JSON.stringify({ ["\u0000meridian-session-store"]: { version: 1, slots: {} }, ["profile:会話"]: entry })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "full-store-家庭-"))
  setSessionStoreDir(directory)
  writeFileSync(join(directory, "sessions.json"), original, { mode: 0o600 })
})
afterEach(() => { setSessionStoreDir(null); rmSync(directory, { recursive: true, force: true }) })

function trace(operation: () => void): string[] {
  const events: string[] = []
  const paths = new Map<number, string>()
  const kind = (path: string) => path === directory ? "directory"
    : path.includes("sessions.json.lock.candidate-") ? "lock-temp"
    : path.endsWith("sessions.json.lock") ? "lock"
    : path.includes("sessions.json.tmp-") ? "data-temp" : "data"
  const open = fs.openSync, sync = fs.fsyncSync, link = fs.linkSync, rename = fs.renameSync, unlink = fs.unlinkSync
  const spies = [
    spyOn(fs, "openSync").mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args); paths.set(fd, String(args[0])); return fd
    }),
    spyOn(fs, "fsyncSync").mockImplementation(fd => { events.push(`sync:${kind(paths.get(fd)!)}`); sync(fd) }),
    spyOn(fs, "linkSync").mockImplementation((from, to) => {
      events.push(`link:${kind(String(from))}->${kind(String(to))}`); link(from, to)
    }),
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      events.push(`rename:${kind(String(from))}->${kind(String(to))}`); rename(from, to)
    }),
    spyOn(fs, "unlinkSync").mockImplementation(path => { events.push(`unlink:${kind(String(path))}`); unlink(path) }),
  ]
  try { operation() } finally { spies.reverse().forEach(spy => spy.mockRestore()) }
  return events
}

it("matches actual legacy mutation durability/order, rather than the one-sync comparison", () => {
  const before = trace(() => {
    const parsed = JSON.parse(readFileSync(join(directory, "sessions.json"), "utf8"))
    const fd = fs.openSync(join(directory, "old-comparison"), "w", 0o600)
    fs.writeFileSync(fd, JSON.stringify(parsed)); fs.fsyncSync(fd); fs.closeSync(fd)
  })
  expect(before.filter(event => event.startsWith("sync:"))).toHaveLength(1)
  const baseline = trace(() => rewriteFullStore(directory))
  expect(baseline).toEqual([
    "sync:lock-temp", "link:lock-temp->lock", "unlink:lock-temp", "sync:data-temp",
    "rename:data-temp->data", "sync:directory", "unlink:lock",
  ])
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(original)
  expect(fs.statSync(join(directory, "sessions.json")).mode & 0o777).toBe(0o600)
  storeSharedSession("warm", "seed", 0)
  const warm = trace(() => { storeSharedSession("warm", "replacement", 0) })
  expect(warm).toEqual(baseline)
  expect(baseline.filter(event => event.startsWith("sync:"))).toHaveLength(3)
})

it("refuses the existing shared lock and leaves bytes intact without leaking a candidate", () => {
  withLegacyStoreMaintenanceLock(directory, () => {
    expect(() => rewriteFullStore(directory)).toThrow("timed out waiting for")
    expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(original)
  })
  expect(readdirSync(directory)).toEqual(["sessions.json"])
})

it("preserves write failure cause/cleanup and the legacy best-effort directory flush", () => {
  const failure = new Error("rename refused")
  const rename = spyOn(fs, "renameSync").mockImplementation(() => { throw failure })
  let caught: unknown
  try { rewriteFullStore(directory) } catch (error) { caught = error } finally { rename.mockRestore() }
  expect(caught).toBeInstanceOf(Error)
  expect((caught as Error).cause).toBe(failure)
  expect((caught as Error).message).toBe("[sessionStore] write failed: rename refused")
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(original)
  expect(readdirSync(directory)).toEqual(["sessions.json"])
  const sync = fs.fsyncSync
  const directoryFailure = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    if (fs.fstatSync(fd).isDirectory()) throw new Error("directory sync unavailable")
    sync(fd)
  })
  try { expect(() => rewriteFullStore(directory)).not.toThrow() } finally { directoryFailure.mockRestore() }
  expect(readFileSync(join(directory, "sessions.json"), "utf8")).toBe(original)
  expect(readdirSync(directory)).toEqual(["sessions.json"])
})
