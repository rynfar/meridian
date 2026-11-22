/**
 * Process-lifetime lock and gate files are not fsynced.
 *
 * Each of these files only matters while the process that wrote it lives. A
 * process crash leaves their contents in the page cache, where every other
 * process reads them. Only an OS crash or power loss can lose the contents,
 * and then every holder is dead too: recovery reclaims a session-gc lock it
 * cannot parse once it predates the current boot. Each fsync here used to
 * cost ~250 ms of journal wait on a loaded filesystem, hundreds of times a
 * minute.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as fsPromises from "node:fs/promises"
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir, uptime } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import * as durableFileSystem from "../proxy/session/durableFileSystem"
import { createSdkProcessGate } from "../proxy/session/sdkProcessGate"
import {
  abandonFork,
  createInitializedSidecarLockCandidate,
  prepareFork,
  runGc,
} from "../proxy/sessionLifecycle"

const roots: string[] = []
function root(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** Every file and directory fsync the code under test asks for, by path. */
async function recordSyncs<T>(operation: () => Promise<T>): Promise<{ result: T; synced: string[] }> {
  const synced: string[] = []
  const realOpen = fsPromises.open
  const openSpy = spyOn(fsPromises, "open").mockImplementation(async (...args: Parameters<typeof realOpen>) => {
    const handle = await realOpen(...args)
    const path = String(args[0])
    const sync = handle.sync.bind(handle)
    const datasync = handle.datasync.bind(handle)
    handle.sync = async () => { synced.push(path); return sync() }
    handle.datasync = async () => { synced.push(path); return datasync() }
    return handle
  })
  const realSyncDirectory = durableFileSystem.syncDirectoryDurably
  const directorySpy = spyOn(durableFileSystem, "syncDirectoryDurably").mockImplementation(async (path) => {
    synced.push(path)
    return realSyncDirectory(path)
  })
  try {
    return { result: await operation(), synced }
  } finally {
    openSpy.mockRestore()
    directorySpy.mockRestore()
  }
}

describe("process-lifetime lock and gate files", () => {
  test("a session-gc lock candidate is written without fsync", async () => {
    const dir = root("meridian-fsync-sidecar-")
    const lock = join(dir, "session-gc.json.lock")
    const { result: candidate, synced } = await recordSyncs(() =>
      createInitializedSidecarLockCandidate(lock, "this-owner\n"))
    expect(await candidate.publish()).toBe(true)
    await candidate.discard()
    expect(synced).toEqual([])
  })

  test("an SDK process gate is published without fsync", async () => {
    const gates = join(root("meridian-fsync-sdk-gate-"), "sdk-process-gates")
    const { synced } = await recordSyncs(async () => {
      const gate = await createSdkProcessGate(gates, async () => undefined)
      const child = gate.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", "process.stdin.pipe(process.stdout)"],
        env: { ...process.env },
        signal: new AbortController().signal,
      })
      const output = new Promise<string>((resolve) => {
        child.stdout.once("data", (chunk) => resolve(chunk.toString()))
      })
      child.stdin.write("gated\n")
      expect(await output).toBe("gated\n")
      child.stdin.end()
      expect(await gate.closeAndJoin()).toBe(true)
    })
    expect(synced.filter((path) => path.startsWith(gates))).toEqual([])
  })

  test("a session deletion gate is opened without fsync", async () => {
    const dir = root("meridian-fsync-deletion-")
    const storeDir = join(dir, "store")
    const sdkPath = join(dir, "stub-sdk.mjs")
    writeFileSync(sdkPath, "export async function deleteSession() {}\n")
    const options = {
      storeDir,
      preparedGraceMs: 0,
      retiredGraceMs: 0,
      lockWaitMs: 2_000,
      lockRetryMs: 5,
      sdkModuleUrl: pathToFileURL(sdkPath).href,
    }
    const locator = { sessionId: "fsync-deletion", configDir: join(dir, "config"), projectDir: join(dir, "project") }
    await abandonFork(await prepareFork(locator, options), options)

    const { result, synced } = await recordSyncs(() => runGc([], options))
    expect(result.deleted).toBe(1)
    expect(synced.filter((path) => path.includes("deletion-gates"))).toEqual([])
  }, 30_000)
})

describe("crash recovery without lock fsyncs", () => {
  test("reclaims an unreadable session-gc lock left by an earlier boot", async () => {
    const storeDir = root("meridian-fsync-preboot-")
    const lock = join(storeDir, "session-gc.json.lock")
    // What a power loss leaves of an unsynced lock: its size, not its data.
    writeFileSync(lock, "\0".repeat(180), { mode: 0o600 })
    const beforeBoot = (Date.now() - uptime() * 1000 - 3_600_000) / 1000
    utimesSync(lock, beforeBoot, beforeBoot)

    const locator = { sessionId: "after-power-loss", configDir: join(storeDir, "config"), projectDir: join(storeDir, "project") }
    await prepareFork(locator, { storeDir, lockWaitMs: 2_000, lockRetryMs: 1, lockStaleMs: 10 })
    expect(readdirSync(storeDir).filter((name) => name.startsWith("session-gc.json.lock"))).toEqual([])
  })

  test("keeps an unreadable session-gc lock written during this boot", async () => {
    const storeDir = root("meridian-fsync-thisboot-")
    const lock = join(storeDir, "session-gc.json.lock")
    writeFileSync(lock, "\0".repeat(180), { mode: 0o600 })
    const stale = (Date.now() - 60_000) / 1000
    utimesSync(lock, stale, stale)

    const locator = { sessionId: "blocked", configDir: join(storeDir, "config"), projectDir: join(storeDir, "project") }
    await expect(prepareFork(locator, { storeDir, lockWaitMs: 20, lockRetryMs: 1, lockStaleMs: 10 }))
      .rejects.toThrow("timed out waiting for")
  })
})
