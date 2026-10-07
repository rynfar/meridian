import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSessionCache, evictSession, finalizePrioritySessionPublication, getSessionByClaudeId,
  lookupSession, rollbackPrioritySessionPublication, storeSession, type PrioritySessionPublication }
  from "../proxy/session/cache"
import { claimPriorityAttempt, evictSharedSession, getSessionStoreDir, lookupPriorityAssignmentResult, lookupSharedSessionResult,
  setSessionStoreBackendForTest, setSessionStoreDir } from "../proxy/sessionStore"
import { initializeSessionBookkeeping, withBookkeepingRead, withBookkeepingWrite, type BookkeepingHandle }
  from "../proxy/session/bookkeeping/database"
import { sqliteSessionStoreBackend } from "../proxy/session/bookkeeping/sqliteStoreBackend"
import { BookkeepingBusyError } from "../proxy/session/bookkeeping/connection"
import { BookkeepingCommitUncertainError } from "../proxy/session/bookkeeping/transaction"
import { lifecycleCommitInjection } from "./fixtures/bookkeeping-lifecycle-injection"
import { getConversationFingerprint } from "../proxy/session/fingerprint"

const messages = [{ role: "user", content: "hello" }, { role: "assistant", content: "answer" }]
const incoming = [...messages, { role: "user", content: "next" }]
const directoryHint = "/workspace"
let directory: string, previousDirectory: string, handle: BookkeepingHandle
let injection: ReturnType<typeof lifecycleCommitInjection>
let transactionStatements: string[]
beforeEach(() => {
  previousDirectory = getSessionStoreDir()
  directory = realpathSync(mkdtempSync(join(tmpdir(), "cache-publication-")))
  injection = lifecycleCommitInjection()
  transactionStatements = []
  handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    transactionStatements.push(sql)
    injection.executeTransaction(db, sql)
  } })
  setSessionStoreDir(directory)
  setSessionStoreBackendForTest(sqliteSessionStoreBackend)
  clearSessionCache()
})
afterEach(() => {
  clearSessionCache()
  setSessionStoreBackendForTest(null)
  setSessionStoreDir(previousDirectory)
  handle.close()
  rmSync(directory, { recursive: true, force: true })
})

// Observe the production cache's existing degraded-store fallback, not private LRU state.
function cachedId(key: string | undefined): string | undefined {
  setSessionStoreBackendForTest({ ...sqliteSessionStoreBackend,
    lookupSharedSessionResult: () => ({ status: "error", error: new Error("read unavailable") }) })
  try {
    const result = lookupSession(key, incoming, directoryHint)
    return result.type === "continuation" ? result.session.claudeSessionId : undefined
  } finally { setSessionStoreBackendForTest(sqliteSessionStoreBackend) }
}
function publication(): PrioritySessionPublication {
  const routeKey = "route"
  const lookup = lookupPriorityAssignmentResult(routeKey)
  if (lookup.status === "error") throw lookup.error
  const claim = claimPriorityAttempt({ routeKey, expectedAssignmentGeneration: lookup.generation,
    turn: { turnId: "a".repeat(43), issuedAt: 1000 } })
  if (!claim) throw new Error("claim failed")
  const claimed = lookupPriorityAssignmentResult(routeKey)
  if (claimed.status === "error") throw claimed.error
  return { routeKey, profileId: "profile", lastHumanTurnDigest: "a".repeat(43), lastHumanTurnIssuedAt: 1000,
    attemptOwnerToken: claim.ownerToken, expectedAssignmentGeneration: claimed.generation }
}
function publish(priority: PrioritySessionPublication) {
  const lookup = lookupSharedSessionResult("key")
  if (lookup.status === "error") throw lookup.error
  return storeSession("key", messages, "new", directoryHint, undefined, undefined, undefined, undefined,
    undefined, undefined, lookup.generation, priority)
}
function clearSharedMapping(key: string | undefined): void {
  expect(evictSharedSession(key ?? getConversationFingerprint(messages, directoryHint))).toBe(true)
}

describe("cache effects follow durable SQLite COMMIT", () => {
  for (const key of ["key", undefined]) {
    it(`${key ?? "fingerprint"}: a foreign initialized transaction rejects before cache fallback or touch`, () => {
      const otherDirectory = realpathSync(mkdtempSync(join(tmpdir(), "cache-foreign-")))
      const otherHandle = initializeSessionBookkeeping(otherDirectory)
      const originalNow = Date.now
      try {
        storeSession(key, messages, "cached-B", directoryHint)
        setSessionStoreBackendForTest({ ...sqliteSessionStoreBackend,
          lookupSharedSessionResult: () => ({ status: "error", error: new Error("read unavailable") }) })
        const cached = lookupSession(key, incoming, directoryHint)
        if (cached.type !== "continuation") throw new Error("cached B mapping missing")
        const lastAccess = cached.session.lastAccess
        setSessionStoreBackendForTest(sqliteSessionStoreBackend)
        Date.now = () => lastAccess + 1000
        expect(withBookkeepingWrite(otherDirectory, { scope: "publication" }, () => {
          let failure: unknown
          try { lookupSession(key, incoming, directoryHint) } catch (error) { failure = error }
          // Check the observable cache object as well as rejection: a swallowed error must not touch it.
          expect(cached.session.lastAccess).toBe(lastAccess)
          expect(failure).toBeInstanceOf(Error)
          expect((failure as Error).message).toBe("cross-database publication is forbidden")
          return false
        })).toBe(false)
        expect(cached.session.lastAccess).toBe(lastAccess)
      } finally {
        Date.now = originalNow
        setSessionStoreBackendForTest(sqliteSessionStoreBackend)
        otherHandle.close()
        rmSync(otherDirectory, { recursive: true, force: true })
      }
    })
    it(`${key ?? "fingerprint"}: transaction read errors never fall back to LRU`, () => {
      storeSession(key, messages, "old", directoryHint)
      setSessionStoreBackendForTest({ ...sqliteSessionStoreBackend,
        lookupSharedSessionResult: () => ({ status: "error", error: new Error("read unavailable") }) })
      expect(withBookkeepingWrite(directory, { scope: "publication" }, () =>
        lookupSession(key, incoming, directoryHint))).toEqual({ type: "diverged", reason: "not-found" })
      expect(withBookkeepingRead(directory, () => lookupSession(key, incoming, directoryHint)))
        .toEqual({ type: "diverged", reason: "not-found" })
      setSessionStoreBackendForTest(sqliteSessionStoreBackend)
      expect(cachedId(key)).toBe("old")
    })
    it(`${key ?? "fingerprint"}: success publishes only after COMMIT and reads its own writes`, () => {
      storeSession(key, messages, "old", directoryHint)
      const start = transactionStatements.length
      withBookkeepingWrite(directory, { scope: "publication" }, () => {
        expect(storeSession(key, messages, "new", directoryHint)).not.toBe(false)
        const result = lookupSession(key, incoming, directoryHint)
        expect(result.type).toBe("continuation")
        if (result.type === "continuation") expect(result.session.claudeSessionId).toBe("new")
        expect(getSessionByClaudeId("new")?.claudeSessionId).toBe("new")
        expect(transactionStatements.slice(start)).toEqual(["BEGIN IMMEDIATE"])
        return true
      })
      expect(transactionStatements.slice(start)).toEqual(["BEGIN IMMEDIATE", "COMMIT"])
      expect(cachedId(key)).toBe("new")
    })
    it(`${key ?? "fingerprint"}: a standalone cache lookup opens only the store's one read transaction`, () => {
      storeSession(key, messages, "old", directoryHint)
      const start = transactionStatements.length
      expect(lookupSession(key, incoming, directoryHint).type).toBe("continuation")
      expect(transactionStatements.slice(start)).toEqual(["BEGIN", "COMMIT"])
    })
    for (const outcome of ["throw", "false", "busy-before", "ioerr-before", "ioerr-after"] as const) {
      it(`${key ?? "fingerprint"}: ${outcome} discards writes and lookup cache effects`, () => {
        storeSession(key, messages, "old", directoryHint)
        const operation = () => withBookkeepingWrite(directory, { scope: "publication" }, () => {
          expect(storeSession(key, messages, "new", directoryHint)).not.toBe(false)
          lookupSession(key, incoming, directoryHint)
          getSessionByClaudeId("old")
          if (outcome === "throw") throw new Error("callback failed")
          return outcome !== "false"
        })
        if (outcome === "false") expect(operation()).toBe(false)
        else {
          if (outcome !== "throw") injection.arm(outcome)
          expect(operation).toThrow(outcome === "throw" ? "callback failed"
            : outcome === "busy-before" ? BookkeepingBusyError : BookkeepingCommitUncertainError)
        }
        expect(cachedId(key)).toBe("old")
        const result = lookupSession(key, incoming, directoryHint)
        if (result.type !== "continuation") throw new Error("durable mapping missing")
        expect(result.session.claudeSessionId).toBe(outcome === "ioerr-after" ? "new" : "old")
      })
    }
    for (const root of ["evict", "clear", "missing-lookup", "missing-claude-id"] as const) {
      it(`${key ?? "fingerprint"}: ${root} invalidation rolls back`, () => {
        storeSession(key, messages, "old", directoryHint)
        expect(withBookkeepingWrite(directory, { scope: "publication" }, () => {
          if (root === "clear") clearSessionCache()
          else if (root === "missing-claude-id" || root === "missing-lookup") {
            clearSharedMapping(key)
            if (root === "missing-claude-id") expect(getSessionByClaudeId("old")).toBeUndefined()
          } else evictSession(key, directoryHint, messages)
          if (root === "missing-lookup") expect(lookupSession(key, incoming, directoryHint))
            .toEqual({ type: "diverged", reason: "not-found" })
          return false
        })).toBe(false)
        expect(cachedId(key)).toBe("old")
      })
    }
    for (const root of ["evict", "clear"] as const) {
      for (const fault of [undefined, "busy-before", "ioerr-before", "ioerr-after"] as const) {
        it(`${key ?? "fingerprint"}: ${root} × ${fault ?? "COMMIT"} publishes invalidation only on success`, () => {
          storeSession(key, messages, "old", directoryHint)
          const operation = () => withBookkeepingWrite(directory, { scope: "publication" }, () => {
            if (root === "clear") clearSessionCache()
            else expect(evictSession(key, directoryHint, messages)).toBe(true)
            return true
          })
          if (fault) {
            injection.arm(fault)
            expect(operation).toThrow(fault === "busy-before" ? BookkeepingBusyError : BookkeepingCommitUncertainError)
          } else expect(operation()).toBe(true)
          expect(cachedId(key)).toBe(fault ? "old" : undefined)
          const result = lookupSession(key, incoming, directoryHint)
          expect(result.type).toBe(!fault || fault === "ioerr-after" ? "diverged" : "continuation")
        })
      }
    }
  }
  for (const outcome of ["success", "throw", "false", "busy-before", "ioerr-before", "ioerr-after"] as const) {
    it(`priority publication: ${outcome} updates authority only after COMMIT`, () => {
      storeSession("key", messages, "old", directoryHint)
      const priority = publication(), before = structuredClone(priority)
      const operation = () => withBookkeepingWrite(directory, { scope: "publication" }, () => {
        expect(publish(priority)).not.toBe(false)
        expect(priority).toEqual(before)
        if (outcome === "throw") throw new Error("callback failed")
        return outcome !== "false"
      })
      if (outcome === "success" || outcome === "false") expect(operation()).toBe(outcome === "success")
      else {
        if (outcome !== "throw") injection.arm(outcome)
        expect(operation).toThrow(outcome === "throw" ? "callback failed"
          : outcome === "busy-before" ? BookkeepingBusyError : BookkeepingCommitUncertainError)
      }
      if (outcome === "success") {
        expect(priority.rollback).toBeDefined()
        expect(priority.expectedAssignmentGeneration).not.toBe(before.expectedAssignmentGeneration)
      } else expect(priority).toEqual(before)
    })
  }
  for (const root of ["finalize", "rollback"] as const) for (const commit of [true, false]) {
    it(`priority ${root}: authority changes only on ${commit ? "COMMIT" : "rollback"}`, () => {
      storeSession("key", messages, "old", directoryHint)
      const priority = publication()
      expect(publish(priority)).not.toBe(false)
      const before = structuredClone(priority)
      expect(withBookkeepingWrite(directory, { scope: "publication" }, () => {
        const result = root === "finalize" ? finalizePrioritySessionPublication(priority)
          : rollbackPrioritySessionPublication("key", messages, directoryHint, priority)
        expect(result).not.toBe(false)
        expect(priority).toEqual(before)
        return commit
      })).toBe(commit)
      if (commit) expect(priority.rollback).toBeUndefined()
      else expect(priority).toEqual(before)
      expect(cachedId("key")).toBe(commit && root === "rollback" ? "old" : "new")
    })
  }
  for (const root of ["finalize", "rollback"] as const) {
    for (const fault of ["busy-before", "ioerr-before", "ioerr-after"] as const) {
      it(`priority ${root}: ${fault} does not revoke in-memory authority`, () => {
        storeSession("key", messages, "old", directoryHint)
        const priority = publication()
        expect(publish(priority)).not.toBe(false)
        const before = structuredClone(priority)
        injection.arm(fault)
        expect(() => withBookkeepingWrite(directory, { scope: "publication" }, () =>
          root === "finalize" ? finalizePrioritySessionPublication(priority)
            : rollbackPrioritySessionPublication("key", messages, directoryHint, priority)))
          .toThrow(fault === "busy-before" ? BookkeepingBusyError : BookkeepingCommitUncertainError)
        expect(priority).toEqual(before)
        expect(cachedId("key")).toBe("new")
        const durable = lookupSharedSessionResult("key")
        if (durable.status !== "found") throw new Error("durable mapping missing")
        expect(durable.session.claudeSessionId).toBe(root === "rollback" && fault === "ioerr-after" ? "old" : "new")
      })
    }
  }
})
