import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { clearSessionCache, lookupSession, storeSession } from "../proxy/session/cache"
import { getSessionStoreDir, lookupSharedSessionResult, setSessionStoreBackendForTest,
  setSessionStoreDir } from "../proxy/sessionStore"
import { initializeSessionBookkeeping, connectionFor, type BookkeepingHandle }
  from "../proxy/session/bookkeeping/connection"
import { NativeDatabase } from "../proxy/session/bookkeeping/nativeDatabase"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { withBookkeepingWrite, withBookkeepingWriteAsync } from "../proxy/session/bookkeeping/transaction"
import { lifecycleCommitInjection } from "./fixtures/bookkeeping-lifecycle-injection"

const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "answer" }]
const incoming = [...messages, { role: "user", content: "next" }]
const cwd = "/workspace/clear-completion"
let directory: string, previous: string, handle: BookkeepingHandle
let injection: ReturnType<typeof lifecycleCommitInjection>

beforeEach(async () => {
  previous = getSessionStoreDir()
  directory = realpathSync(mkdtempSync(join(tmpdir(), "cache-clear-completion-")))
  injection = lifecycleCommitInjection()
  handle = initializeSessionBookkeeping(directory, { executeTransaction: injection.executeTransaction })
  setSessionStoreDir(directory)
  setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  await clearSessionCache()
})

afterEach(async () => {
  await clearSessionCache()
  setSessionStoreBackendForTest(null)
  setSessionStoreDir(previous)
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})

// Exercise the public degraded-read fallback rather than exposing either private LRU.
function cachedId(key: string | undefined): string | undefined {
  setSessionStoreBackendForTest({ ...sqliteSessionStoreBackend,
    lookupSharedSessionResult: () => ({ status: "error", error: new Error("store unavailable") }) })
  try {
    const result = lookupSession(key, incoming, cwd)
    return result.type === "continuation" ? result.session.claudeSessionId : undefined
  } finally {
    setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  }
}

it("returns an awaited completion behind a native writer, before later FIFO publications", async () => {
  storeSession("old", messages, "old-sdk", cwd)
  storeSession(undefined, messages, "fingerprint-sdk", cwd)
  const blocker = new NativeDatabase(handle.path)
  blocker.exec("BEGIN IMMEDIATE")
  const earlier = withBookkeepingWriteAsync(directory, { scope: "store", lockWaitMs: 2000 }, () => {
    storeSession("earlier", messages, "earlier-sdk", cwd)
  })
  const completion: Promise<void> = clearSessionCache()
  const later = withBookkeepingWriteAsync(directory, { scope: "store", lockWaitMs: 2000 }, () => {
    storeSession("later", messages, "later-sdk", cwd)
  })
  try {
    expect(completion).toBeInstanceOf(Promise)
    expect(cachedId("old")).toBeUndefined()
    expect(cachedId(undefined)).toBeUndefined()
    let completed = false
    void completion.then(() => { completed = true })
    await delay(10)
    expect(completed).toBe(false)
    expect(connectionFor(directory).pending).toBe(3)
    expect(() => handle.close()).toThrow("admission")
    blocker.exec("ROLLBACK")
    await Promise.all([earlier, completion, later])
    expect(connectionFor(directory).pending).toBe(0)
    expect(lookupSharedSessionResult("old").status).toBe("missing")
    expect(lookupSharedSessionResult("earlier").status).toBe("missing")
    expect(lookupSharedSessionResult("later").status).toBe("found")
    expect(cachedId("earlier")).toBeUndefined()
    expect(cachedId(undefined)).toBeUndefined()
    expect(cachedId("later")).toBe("later-sdk")
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK")
    await Promise.allSettled([earlier, completion, later])
    blocker.close()
  }
})

for (const key of ["key", undefined]) {
  it(`${key ?? "fingerprint"}: failed nested cleanup fences older hooks and preserves later hooks`, async () => {
    setSessionStoreBackendForTest({ ...sqliteSessionStoreBackend,
      clearSharedSessions: () => { throw new Error("cleanup unavailable") } })
    let completion: Promise<void> | undefined
    try {
      withBookkeepingWrite(directory, { scope: "publication" }, () => {
        storeSession(key, messages, "before-clear-sdk", cwd)
        completion = clearSessionCache()
        storeSession("later", messages, "after-clear-sdk", cwd)
        return true
      })
      await completion
    } finally {
      setSessionStoreBackendForTest(sqliteSessionStoreBackend)
    }
    expect(cachedId(key)).toBeUndefined()
    expect(cachedId("later")).toBe("after-clear-sdk")
    // Best effort does not claim that a failed durable clear removed the mapping.
    const durable = lookupSession(key, incoming, cwd)
    expect(durable.type).toBe("continuation")
    if (durable.type === "continuation") expect(durable.session.claudeSessionId).toBe("before-clear-sdk")
  })

  it(`${key ?? "fingerprint"}: clears memory immediately even when its outer write rolls back`, async () => {
    storeSession(key, messages, "old-sdk", cwd)
    let completion: Promise<void> | undefined
    expect(withBookkeepingWrite(directory, { scope: "publication" }, () => {
      storeSession(key, messages, "uncommitted-sdk", cwd)
      completion = clearSessionCache()
      return false
    })).toBe(false)
    expect(cachedId(key)).toBeUndefined()
    await completion
    expect(lookupSession(key, incoming, cwd).type).toBe("continuation")
  })

  it(`${key ?? "fingerprint"}: an older commit hook cannot restore cleared memory`, async () => {
    let completion: Promise<void> | undefined
    withBookkeepingWrite(directory, { scope: "publication" }, () => {
      storeSession(key, messages, "before-clear-sdk", cwd)
      completion = clearSessionCache()
      return true
    })
    await completion
    expect(cachedId(key)).toBeUndefined()
    expect(lookupSession(key, incoming, cwd).type).toBe("diverged")
  })

  it(`${key ?? "fingerprint"}: retains a publication after clear in the same synchronous scope`, async () => {
    let completion: Promise<void> | undefined
    withBookkeepingWrite(directory, { scope: "publication" }, () => {
      storeSession(key, messages, "before-clear-sdk", cwd)
      completion = clearSessionCache()
      storeSession(key, messages, "after-clear-sdk", cwd)
      return true
    })
    await completion
    expect(cachedId(key)).toBe("after-clear-sdk")
  })

  for (const fault of ["busy-before", "ioerr-before", "ioerr-after"] as const) {
    it(`${key ?? "fingerprint"}: ${fault} keeps cleanup best effort without restoring old memory`, async () => {
      storeSession(key, messages, "old-sdk", cwd)
      injection.arm(fault)
      await expect(clearSessionCache()).resolves.toBeUndefined()
      expect(injection.hits).toBe(1)
      expect(cachedId(key)).toBeUndefined()
      expect(lookupSession(key, incoming, cwd).type).toBe(fault === "ioerr-after" ? "diverged" : "continuation")
    })
  }
}

it("JSON returns the approved completion type and clears the durable mapping when awaited", async () => {
  setSessionStoreBackendForTest(null)
  setSessionStoreDir(join(directory, "json-control"))
  try {
    await storeSession("json", messages, "json-sdk", cwd)
    expect(lookupSharedSessionResult("json").status).toBe("found")
    const completion: Promise<void> = clearSessionCache()
    expect(completion).toBeInstanceOf(Promise)
    await completion
    expect(lookupSharedSessionResult("json").status).toBe("missing")
  } finally {
    setSessionStoreDir(directory)
    setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  }
})
