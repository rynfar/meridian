import { expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as lifecycle from "../proxy/sessionLifecycle"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"
import { initializeSessionBookkeeping, withBookkeepingRead, withBookkeepingWrite }
  from "../proxy/session/bookkeeping/database"
import { connectionFor, BookkeepingBusyError } from "../proxy/session/bookkeeping/connection"
import { BookkeepingCommitUncertainError } from "../proxy/session/bookkeeping/transaction"
import { sqliteLifecycleBackend as backend } from "../proxy/session/bookkeeping/lifecycleSql"
import { retryDeferredLeaseReleases } from "../proxy/session/bookkeeping/lifecycleLeasesSql"
import { claimDeletion, attachDeletionExecutor, finishDeletion, runDeletionPhase }
  from "../proxy/session/bookkeeping/lifecycleDeletionSql"
import { lifecycleCommitInjection, type LifecycleCommitFault } from "./fixtures/bookkeeping-lifecycle-injection"
import { expectedDurable, type EffectName, type InjectionSnapshot }
  from "./fixtures/bookkeeping-lifecycle-injection-effects"
import { observeLifecycleState } from "./fixtures/bookkeeping-lifecycle-observer"
import { writeMappingRow } from "../proxy/session/bookkeeping/mappings"
import { persistedCanonicalLocator } from "../proxy/session/bookkeeping/locator"

/** Write ordinal of the faulted COMMIT, the committed transactions before it inside the same
 * operation, the durable effect of the faulted transaction itself once its COMMIT happened,
 * and what a clean repeat of the whole operation commits after a rolled-back fault. */
interface Path { ordinal?: number; committedBefore?: EffectName[]; faulted: EffectName; retry?: EffectName[] }
const paths: Record<string, Path> = {
  acquire: { faulted: "acquire" }, attachExecutor: { faulted: "attachExecutor" }, release: { faulted: "release" },
  releaseJoined: { faulted: "releaseJoined" }, retryDeferred: { faulted: "retryDeferred" },
  prepare: { faulted: "prepare" }, preparePublication: { faulted: "preparePublication" }, ensure: { faulted: "ensure" },
  register: { faulted: "register" }, commit: { faulted: "commit" }, abandon: { faulted: "abandon" },
  publish: { faulted: "publish" }, attachPinned: { faulted: "attachPinned" }, claimDeletion: { faulted: "claimDeletion" },
  attachDeletion: { faulted: "attachDeletion" }, finishDeletion: { faulted: "finishDeletion" },
  reconcileRescue: { faulted: "reconcileRescue" },
  // Write 1 is the rescue page, which commits no change in this fixture; write 2 is the retirement page.
  reconcileRetire: { ordinal: 2, faulted: "reconcileRetire" },
  "runGc: reconcile retire page": { ordinal: 2, faulted: "reconcileRetire",
    retry: ["reconcileRetire", "claimDeletion", "finishDeletion"] },
  // Deletion phase of the public runGc: writes 3 and 4 are the claim and the finish of the first candidate.
  "runGc: deletion claim": { ordinal: 3, committedBefore: ["reconcileRetire"], faulted: "claimDeletion" },
  "runGc: deletion finish": { ordinal: 4, committedBefore: ["reconcileRetire", "claimDeletion"], faulted: "finishDeletion" },
  runDeletionPhase: { faulted: "claimDeletion", retry: ["claimDeletion", "finishDeletion"] },
}
const publication = (method: string) => method === "publish" || method === "attachPinned"
const runGcDeletion = (method: string) => method.startsWith("runGc: deletion")

for (const [method, path] of Object.entries(paths)) for (const point of ["busy-before", "ioerr-before", "ioerr-after"] as const) {
  it(`${method} × ${point}: typed outcome, durable snapshot, hooks, reopen`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "lifecycle-injection-")))
    const injection = lifecycleCommitInjection()
    const handle = initializeSessionBookkeeping(directory, injection)
    // Setup runs at 1000, the faulted operation at 2000: every timestamp it writes is observable.
    let clock = 1000, deletions = 0
    const options = { storeDir: directory, now: () => clock, retiredGraceMs: 0 }
    const deleter = async () => { deletions++ }
    const owner = captureProcessIncarnation()!
    const input = { configDir: directory, sessionId: "target" }
    const context = { key: lifecycle.getTranscriptResourceKey(input), locator: { ...input }, owner, now: 2000 }
    let hooks = 0, callbacks = 0
    const publish = () => withBookkeepingWrite(directory, { scope: "store" }, tx => {
      callbacks++
      writeMappingRow(tx, "mapping", { claudeSessionId: input.sessionId, createdAt: 1000,
        lastUsedAt: 1000, messageCount: 0, currentTranscript: persistedCanonicalLocator(input) })
      tx.afterCommit(() => { hooks++ }); return true
    })
    const snapshot = (): InjectionSnapshot => ({ ledger: observeLifecycleState(directory, true),
      pins: withBookkeepingRead(directory, reader => reader.all("SELECT * FROM mapping_pins ORDER BY mapping_key,slot")) })
    try {
      let operation: () => Promise<unknown>
      if (["prepare", "preparePublication", "ensure", "register", "attachPinned"].includes(method)) {
        operation = () => {
          if (method === "prepare") return backend.prepareFork(input, options)
          if (method === "preparePublication") return backend.prepareForkForPublication(input, options)
          if (method === "ensure") return backend.ensureTranscriptJournaled(input, options)
          if (method === "register") return backend.registerLiveTranscript(input, options)
          return backend.attachPinnedTranscript(input, publish, options)
        }
      } else {
        const target = await backend.prepareFork(input, options)
        if (["attachExecutor", "release", "releaseJoined", "retryDeferred"].includes(method)) {
          const lease = await backend.acquireActiveTranscriptLease([target], options)
          if (method === "retryDeferred") {
            const abort = new AbortController()
            abort.abort(new lifecycle.SessionLifecycleLockError("defer joined release"))
            await backend.releaseJoinedTranscriptLease(lease, { ...options, admissionSignal: abort.signal })
          }
          operation = () => method === "attachExecutor" ? backend.attachActiveTranscriptExecutor(lease, owner, options)
            : method === "release" ? backend.releaseActiveTranscriptLease(lease, options)
              : method === "releaseJoined" ? backend.releaseJoinedTranscriptLease(lease, options)
                : retryDeferredLeaseReleases(options)
        } else if (["claimDeletion", "attachDeletion", "finishDeletion", "runDeletionPhase"].includes(method)) {
          await backend.abandonFork(target, options)
          if (method === "claimDeletion") operation = () => claimDeletion([], options)
          else if (method === "runDeletionPhase") operation = () => runDeletionPhase([], { ...options, deleter })
          else {
            const claim = (await claimDeletion([], options))!
            operation = () => method === "attachDeletion"
              ? attachDeletionExecutor(claim.key, claim.deletionToken!, owner, owner.pid, options)
              : finishDeletion(claim.key, claim.deletionToken!, undefined, options)
          }
        } else if (method === "reconcileRescue") {
          await backend.abandonFork(target, options)
          operation = () => backend.reconcile([target], options)
        } else if (method === "reconcileRetire" || method.startsWith("runGc")) {
          await backend.commitFork(target, options)
          operation = () => method === "reconcileRetire" ? backend.reconcile([], options)
            : backend.runGc([], { ...options, deleter })
        } else operation = () => method === "acquire" ? backend.acquireActiveTranscriptLease([target], options)
          : method === "commit" ? backend.commitFork(target, options)
            : method === "abandon" ? backend.abandonFork(target, options)
              : backend.publishPinnedTranscript(target, publish, options)
      }
      clock = context.now
      const before = snapshot()
      injection.arm(point satisfies LifecycleCommitFault, path.ordinal ?? 1)
      const expected = point === "busy-before" ? BookkeepingBusyError : BookkeepingCommitUncertainError
      // Joined release deliberately absorbs retryable lock errors; it is retried by GC.
      if (method === "releaseJoined" && point === "busy-before") await operation()
      else await expect(operation()).rejects.toBeInstanceOf(expected)
      expect(injection.hits).toBe(1)
      expect(Boolean(connectionFor(directory).poisoned)).toBe(point !== "busy-before")
      // Engine fact: a throwing COMMIT discards afterCommit hooks even when the COMMIT was durable
      // (ioerr-after); publication therefore sees callback=1, hook=0 and a durable pin.
      expect(hooks).toBe(0)
      if (publication(method)) expect(callbacks).toBe(1)
      expect(deletions).toBe(method === "runGc: deletion finish" ? 1 : 0)
      // Read admission reopens poisoned wrappers and observes the durable outcome, not a cached object.
      const after = snapshot()
      expect(Boolean(connectionFor(directory).poisoned)).toBe(false)
      const committed = [...path.committedBefore ?? [], ...point === "ioerr-after" ? [path.faulted] : []]
      expect(after).toEqual(expectedDurable(before, after, context, committed))
      if (runGcDeletion(method)) {
        // Next public runGc: an unclaimed retired row is deleted; a durable claim owned by this live
        // process is neither re-deleted nor recovered (deferred); a durable finish leaves nothing to do.
        const unclaimed = committed.at(-1) === "reconcileRetire", claimed = committed.at(-1) === "claimDeletion"
        expect(await backend.runGc([], { ...options, deleter })).toEqual({ deleted: unclaimed ? 1 : 0, notFound: 0,
          failed: 0, deferred: claimed ? 1 : 0 })
        const final = snapshot()
        expect(final).toEqual(unclaimed
          ? expectedDurable(before, final, context, ["reconcileRetire", "claimDeletion", "finishDeletion"]) : after)
        expect(deletions).toBe(unclaimed || method === "runGc: deletion finish" ? 1 : 0)
        if (claimed) {
          const row = final.ledger.resources[context.key]!
          await finishDeletion(row.key, row.deletionToken!, undefined, options)
          expect(snapshot()).toEqual(expectedDurable(before, final, context, [...committed, "finishDeletion"]))
        }
      } else if (point !== "ioerr-after") {
        await operation()
        const repeated = snapshot()
        expect(repeated).toEqual(expectedDurable(before, repeated, context, path.retry ?? [path.faulted]))
        expect(deletions).toBe(path.retry?.includes("finishDeletion") ? 1 : 0)
        if (publication(method)) expect(hooks).toBe(1)
      }
      const next = await backend.prepareFork({ configDir: directory, sessionId: "after-reopen" }, options)
      expect(next.lifecycleGeneration).toBeDefined()
      await retryDeferredLeaseReleases(options)
    } finally {
      handle.close(); rmSync(directory, { recursive: true, force: true })
    }
  })
}
