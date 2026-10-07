import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises"
import { hostname } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { setTimeout as waitForLockRetry } from "node:timers/promises"
import {
  SIDECAR_VERSION, allocateLifecycleGeneration, isRecord, parseLegacySidecar, serializeLegacySidecar,
} from "./session/bookkeeping/legacyCodec"
import type { SessionGcSidecar } from "./session/bookkeeping/legacyCodec"
export { parseLegacySidecar, serializeLegacySidecar } from "./session/bookkeeping/legacyCodec"
import { canonicalizeLocator, resourceKey } from "./session/bookkeeping/locator"
import type { TranscriptLocator, TranscriptResource } from "./session/bookkeeping/types"
export type { TranscriptLocator, TranscriptResourceState } from "./session/bookkeeping/types"
import { lifecycleLockQueue } from "./session/lifecycleLockQueue"
import { activeLifecycleBackend } from "./session/bookkeeping/lifecycleBackend"
export { setSessionLifecycleBackendForTest } from "./session/bookkeeping/lifecycleBackend"
import {
  SessionLifecycleError,
  SessionLifecycleLockError,
  SessionLifecycleCorruptError,
  SessionLifecycleBacklogError,
} from "./session/lifecycleErrors"
export {
  SessionLifecycleError,
  SessionLifecycleLockError,
  SessionLifecycleCorruptError,
  SessionLifecycleBacklogError,
  SessionLifecycleQueueCapacityError,
  SessionLifecycleQueueStalledError,
  SessionLifecycleReentrancyError,
} from "./session/lifecycleErrors"
import {
  getMaxStoredSessionsLimit,
  getSessionStoreDir,
  pruneSupersededProfileCopies,
  listSupersededProfileConversations,
  type ProfileCopyPruneOptions,
} from "./sessionStore"
import { CrossProcessTurnCoordinator, type CrossProcessTurnLease } from "./session/crossProcessTurnCoordinator"
import {
  directoryRenameWasBlocked,
  syncDirectoryDurably,
} from "./session/durableFileSystem"
import {
  createRecoveryClaimOwner,
  getRecoveryClaimPath,
  getRecoveryClaimTombstonePath,
  parseRecoveryClaimOwnerJson,
  recoveryClaimOwnerIsDead,
  type RecoveryClaimOwner,
} from "./session/recoveryClaim"
import {
  captureProcessIncarnation,
  parseProcessIncarnation,
  processIncarnationIsDead,
  processIncarnationPredatesBoot,
  processIncarnationProbeBudgetMs,
  type ProcessIncarnation,
} from "./session/processIncarnation"
const SIDECAR_NAME = "session-gc.json"
const DEFAULT_MAX_PENDING = 256
const DEFAULT_MAX_TOMBSTONES = 256
const DEFAULT_MAX_DELETES = 16
const DEFAULT_LOCK_WAIT_MS = 2_000
const DEFAULT_LOCK_RETRY_MS = 25
const DEFAULT_LOCK_STALE_MS = 60_000
const DEFAULT_PREPARED_GRACE_MS = 5 * 60_000
const DEFAULT_DELETING_LEASE_MS = 60_000
const DEFAULT_RETIRED_GRACE_MS = 11 * 60_000
// Deliberately its own knob, not the prepared grace: a deployment may size the
// grace small to expire prepared forks fast, which must not expire leases a
// live request still holds.
const DEFAULT_UNARMED_LEASE_TTL_MS = 11 * 60_000
const DEFAULT_RETRY_BASE_MS = 5_000
const DEFAULT_RETRY_MAX_MS = 60 * 60_000
const DEFAULT_DELETE_TIMEOUT_MS = 30_000
// "Nothing to delete" travels as an exit code because child output is clipped,
// and a Node crash report can bury the verdict. 75 is the gate timeout.
const SESSION_GC_NOT_FOUND_EXIT_CODE = 69

export type SessionDeleter = (locator: TranscriptLocator) => Promise<void>

export interface SessionLifecycleOptions {
  /** Cancel queued/external-lock admission only, never a running durable transaction. */
  admissionSignal?: AbortSignal
  /** Test seam. Production callers should use getSessionStoreDir(). */
  storeDir?: string
  deleter?: SessionDeleter
  now?: () => number
  /** Maximum non-live ownership backlog (prepared/retired/deleting). */
  maxPending?: number
  /** Hard ceiling across every non-deleted owned transcript. */
  maxOwned?: number
  maxTombstones?: number
  maxDeletesPerRun?: number
  lockWaitMs?: number
  lockRetryMs?: number
  lockStaleMs?: number
  preparedGraceMs?: number
  deletingLeaseMs?: number
  /** Quarantine after retirement so old readers and rolling upgrades can drain. */
  retiredGraceMs?: number
  /** Lifetime of an unarmed lease; sized by the caller's turn watchdog. */
  unarmedLeaseTtlMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  deletionTimeoutMs?: number
  /** Budget for the executor's durable attach under the sidecar lock (FIFO wait
   * plus write), counted after incarnation capture; never the gated execution. */
  deletionHandshakeTimeoutMs?: number
  /** Refresh durable mapping pins before each destructive claim. */
  pinProvider?: () => readonly TranscriptLocator[]
  /** Stops new deletion claims once elapsed; a started claim keeps its own
   * budgets (deletionTimeoutMs plus deletionHandshakeTimeoutMs). */
  runTimeoutMs?: number
  /** Test seam. Overrides the resolved @anthropic-ai/claude-agent-sdk module the
   * deletion child imports, so the fenced-delete path can run against a stub. */
  sdkModuleUrl?: string
}

export interface ActiveTranscriptLease {
  token: string
  resourceKeys: string[]
}

export interface ReconcileResult {
  preparedRetired: number
  liveRetired: number
  resourcesPinned: number
  deletingRecovered: number
}

export interface GcResult {
  deleted: number
  notFound: number
  failed: number
  deferred: number
}

/** Stable ownership key. The separator prevents ambiguous concatenation. */
export function getTranscriptResourceKey(locator: TranscriptLocator): string {
  return resourceKey(locator)
}

function physicalLocator(locator: TranscriptLocator): TranscriptLocator {
  const { lifecycleGeneration: _generation, ...physical } = locator
  return physical
}

function exactLocator(resource: TranscriptResource): TranscriptLocator {
  return { ...resource.locator, lifecycleGeneration: resource.generation }
}

function assertExactLifecycleGeneration(resource: TranscriptResource, locator: TranscriptLocator): void {
  if (locator.lifecycleGeneration !== resource.generation) {
    throw new SessionLifecycleError(`stale or missing lifecycle generation for transcript ${resource.key}`)
  }
}

/** Persist a cross-process writer lease before an SDK child can touch transcripts. */
export async function acquireActiveTranscriptLease(
  locators: readonly TranscriptLocator[],
  options: SessionLifecycleOptions = {},
): Promise<ActiveTranscriptLease> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.acquireActiveTranscriptLease(locators, options)
  const normalized = [...new Map(
    locators.map(canonicalizeTranscriptLocator).map((locator) => [getTranscriptResourceKey(locator), locator]),
  ).entries()]
  if (normalized.length === 0) throw new TypeError("active transcript lease requires at least one locator")
  const owner = captureProcessIncarnation()
  if (!owner) throw new SessionLifecycleError("cannot capture active transcript owner incarnation")
  const token = randomUUID()
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const unarmedLeaseTtlMs = nonNegativeOption(options.unarmedLeaseTtlMs, DEFAULT_UNARMED_LEASE_TTL_MS, "unarmedLeaseTtlMs")
    for (const [key, locator] of normalized) {
      const resource = sidecar.resources[key]
      if (!resource) throw new SessionLifecycleError(`cannot lease unjournaled transcript ${key}`)
      assertSameLocator(resource.locator, locator)
      assertExactLifecycleGeneration(resource, locator)
      pruneDeadActiveLeases(resource, nowMs(options), unarmedLeaseTtlMs)
      if (Object.values(resource.activeLeases ?? {}).some(lease => lease.purpose !== "publication")) {
        throw new SessionLifecycleError(`transcript ${key} already has an active SDK writer`)
      }
      if (resource.state === "deleting" || resource.state === "deleted") {
        throw new SessionLifecycleError(`cannot lease transcript ${key} from state ${resource.state}`)
      }
      resource.activeLeases ??= {}
      resource.activeLeases[token] = { token, owner, createdAt: nowMs(options) }
    }
    await writeSidecar(paths.sidecar, sidecar)
  })
  return { token, resourceKeys: normalized.map(([key]) => key) }
}

/** Arm a writer lease with the exact gated shell/CLI process incarnation. */
export async function attachActiveTranscriptExecutor(
  lease: ActiveTranscriptLease,
  executor: ProcessIncarnation,
  options: SessionLifecycleOptions = {},
  executorRecoverable = true,
): Promise<void> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.attachActiveTranscriptExecutor(lease, executor, options, executorRecoverable)
  const parsedExecutor = parseProcessIncarnation(executor)
  if (!parsedExecutor) throw new TypeError("invalid active transcript executor incarnation")
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    for (const key of lease.resourceKeys) {
      const record = sidecar.resources[key]?.activeLeases?.[lease.token]
      if (!record) throw new SessionLifecycleError(`active transcript lease ${lease.token} was lost`)
      if (record.purpose === "publication") throw new SessionLifecycleError("cannot arm a publication lease")
      record.executor = parsedExecutor
      record.executorRecoverable = executorRecoverable
    }
    await writeSidecar(paths.sidecar, sidecar)
  })
}

/** Release only this exact writer lease after its child has been joined. */
export async function releaseActiveTranscriptLease(
  lease: ActiveTranscriptLease,
  options: SessionLifecycleOptions = {},
): Promise<void> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.releaseActiveTranscriptLease(lease, options)
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    let changed = false
    for (const key of lease.resourceKeys) {
      const resource = sidecar.resources[key]
      if (!resource?.activeLeases?.[lease.token]) continue
      delete resource.activeLeases[lease.token]
      if (Object.keys(resource.activeLeases).length === 0) delete resource.activeLeases
      changed = true
    }
    if (changed) await writeSidecar(paths.sidecar, sidecar)
  })
}

/** Joined writers' leases whose release met a busy lock, by store directory. */
const deferredLeaseReleases = new Map<string, Map<string, ActiveTranscriptLease>>()

/**
 * Release the lease of a writer that has already been joined.
 *
 * Once the writer has exited, only the bookkeeping is late, so a busy lock must
 * not fail the finished turn. Throwing also stranded the lease: an armed win32
 * lease outlives its owner until the host reboots, so its transcript could not
 * be leased or collected and it held a retirement-backlog slot all that time.
 * The next GC sweep, including the one at shutdown, retries the release.
 */
export async function releaseJoinedTranscriptLease(
  lease: ActiveTranscriptLease,
  options: SessionLifecycleOptions = {},
): Promise<void> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.releaseJoinedTranscriptLease(lease, options)
  try {
    await releaseActiveTranscriptLease(lease, options)
  } catch (error) {
    if (!(error instanceof SessionLifecycleLockError)) throw error
    const storeDir = getStoreDir(options)
    let pending = deferredLeaseReleases.get(storeDir)
    if (!pending) deferredLeaseReleases.set(storeDir, pending = new Map())
    pending.set(lease.token, lease)
  }
}

async function retryDeferredLeaseReleases(options: SessionLifecycleOptions): Promise<void> {
  const pending = deferredLeaseReleases.get(getStoreDir(options))
  if (!pending) return
  for (const lease of pending.values()) {
    await releaseActiveTranscriptLease(lease, options)
    pending.delete(lease.token)
  }
}

/** Persist ownership before the SDK process which can create the transcript starts. */
export async function prepareFork(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<TranscriptLocator> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.prepareFork(locator, options)
  return prepareForkIntent(locator, options)
}

/**
 * Keep a new request's target alive through SDK shutdown and mapping publication.
 * This is separate from the exclusive physical-writer lease. Storing it as an
 * unarmed active lease also makes older collectors retain it until owner death.
 */
export async function prepareForkForPublication(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<TranscriptLocator> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.prepareForkForPublication(locator, options)
  const owner = captureProcessIncarnation()
  if (!owner) throw new SessionLifecycleError("cannot capture publication owner incarnation")
  return prepareForkIntent(locator, options, owner)
}

async function prepareForkIntent(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions,
  publicationOwner?: ProcessIncarnation,
): Promise<TranscriptLocator> {
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const existing = sidecar.resources[key]
    if (existing) {
      if (publicationOwner) throw new SessionLifecycleError(`publication target ${key} already exists`)
      assertSameLocator(existing.locator, normalized)
      assertExactLifecycleGeneration(existing, normalized)
      if (existing.state === "deleted") {
        throw new SessionLifecycleError(`transcript resource ${key} is already deleted`)
      }
      Object.assign(locator, exactLocator(existing))
      return exactLocator(existing)
    }
    const now = nowMs(options)
    deferRetirementForAdmission(sidecar, options, now)
    assertResourceCapacity(sidecar, options, "prepared")
    const resource: TranscriptResource = {
      key,
      generation: allocateLifecycleGeneration(sidecar, key),
      locator: physicalLocator(normalized),
      state: "prepared",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    }
    if (publicationOwner) {
      const token = randomUUID()
      resource.activeLeases = {
        [token]: { token, owner: publicationOwner, purpose: "publication", createdAt: now },
      }
    }
    sidecar.resources[key] = resource
    pruneTombstones(sidecar, options)
    await writeSidecar(paths.sidecar, sidecar)
    Object.assign(locator, exactLocator(resource))
    return exactLocator(resource)
  })
}

/** Ensure a legacy/direct-resume locator is journaled without promoting a prepared target. */
export async function ensureTranscriptJournaled(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<TranscriptLocator> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.ensureTranscriptJournaled(locator, options)
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const existing = sidecar.resources[key]
    if (existing) {
      assertSameLocator(existing.locator, normalized)
      if (normalized.lifecycleGeneration !== undefined) assertExactLifecycleGeneration(existing, normalized)
      if (existing.state === "deleting" || existing.state === "deleted") {
        throw new SessionLifecycleError(`cannot journal transcript ${key} from state ${existing.state}`)
      }
      Object.assign(locator, exactLocator(existing))
      return exactLocator(existing)
    }
    if (normalized.lifecycleGeneration !== undefined) {
      throw new SessionLifecycleError(`stale lifecycle generation for missing transcript ${key}`)
    }
    assertResourceCapacity(sidecar, options, "live")
    const now = nowMs(options)
    const resource: TranscriptResource = {
      key,
      generation: allocateLifecycleGeneration(sidecar, key),
      locator: physicalLocator(normalized),
      state: "live",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    }
    sidecar.resources[key] = resource
    pruneTombstones(sidecar, options)
    await writeSidecar(paths.sidecar, sidecar)
    Object.assign(locator, exactLocator(resource))
    return exactLocator(resource)
  })
}

/** Register an existing SDK transcript as Meridian-owned without a fork intent. */
export async function registerLiveTranscript(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<TranscriptLocator> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.registerLiveTranscript(locator, options)
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    let resource = sidecar.resources[key]
    if (!resource) {
      if (normalized.lifecycleGeneration !== undefined) {
        throw new SessionLifecycleError(`stale lifecycle generation for missing transcript ${key}`)
      }
      assertResourceCapacity(sidecar, options, "live")
      const now = nowMs(options)
      resource = {
        key,
        generation: allocateLifecycleGeneration(sidecar, key),
        locator: physicalLocator(normalized),
        state: "live",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      }
      sidecar.resources[key] = resource
      pruneTombstones(sidecar, options)
      await writeSidecar(paths.sidecar, sidecar)
      Object.assign(locator, exactLocator(resource))
      return exactLocator(resource)
    }
    assertSameLocator(resource.locator, normalized)
    if (normalized.lifecycleGeneration !== undefined) assertExactLifecycleGeneration(resource, normalized)
    if (resource.state === "live") {
      Object.assign(locator, exactLocator(resource))
      return exactLocator(resource)
    }
    if (resource.state === "deleting" || resource.state === "deleted") {
      throw new SessionLifecycleError(`cannot register transcript ${key} from state ${resource.state}`)
    }
    resource.state = "live"
    resource.updatedAt = nowMs(options)
    delete resource.nextAttemptAt
    delete resource.lastError
    await writeSidecar(paths.sidecar, sidecar)
    Object.assign(locator, exactLocator(resource))
    return exactLocator(resource)
  })
}

/** Mark a successfully spawned, Meridian-owned fork as live. */
export async function commitFork(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<void> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.commitFork(locator, options)
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const resource = sidecar.resources[key]
    if (!resource) {
      throw new SessionLifecycleError(`fork ${key} was not prepared`)
    }
    assertSameLocator(resource.locator, normalized)
    assertExactLifecycleGeneration(resource, normalized)
    if (resource.state === "live") return
    if (resource.state !== "prepared") {
      throw new SessionLifecycleError(`cannot commit fork ${key} from state ${resource.state}`)
    }
    resource.state = "live"
    resource.updatedAt = nowMs(options)
    delete resource.nextAttemptAt
    delete resource.lastError
    await writeSidecar(paths.sidecar, sidecar)
  })
}

/**
 * Fence durable mapping publication against GC's final claim transaction.
 * The callback must be synchronous and must perform the session-store CAS.
 * A normal publisher must refer to an already journaled resource. This makes
 * tombstone pruning safe: a delayed old publisher cannot recreate a locator
 * that GC already deleted.
 */
export async function publishPinnedTranscript<T extends boolean | string>(
  locator: TranscriptLocator,
  publish: () => T,
  options: SessionLifecycleOptions = {},
): Promise<T> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.publishPinnedTranscript(locator, publish, options)
  return updatePinnedTranscript(locator, publish, options, false)
}

/**
 * Atomically attach a legacy mapping whose source predates lifecycle metadata.
 * Missing-resource creation is allowed only inside the same lifecycle critical
 * section as the exact session-store CAS, so there is no stale publish gap.
 */
export async function attachPinnedTranscript<T extends boolean | string>(
  locator: TranscriptLocator,
  publish: () => T,
  options: SessionLifecycleOptions = {},
): Promise<T> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.attachPinnedTranscript(locator, publish, options)
  return updatePinnedTranscript(locator, publish, options, true)
}

async function updatePinnedTranscript<T extends boolean | string>(
  locator: TranscriptLocator,
  publish: () => T,
  options: SessionLifecycleOptions,
  allowMissing: boolean,
): Promise<T> {
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  const originalGeneration = locator.lifecycleGeneration
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const beforeMutation = structuredClone(sidecar)
    let resource = sidecar.resources[key]
    let changed = false
    const now = nowMs(options)
    if (!resource) {
      if (!allowMissing) {
        throw new SessionLifecycleError(`cannot publish unjournaled transcript ${key}`)
      }
      assertResourceCapacity(sidecar, options, "live")
      resource = sidecar.resources[key] = {
        key,
        generation: allocateLifecycleGeneration(sidecar, key),
        locator: physicalLocator(normalized),
        state: "live",
        createdAt: now,
        updatedAt: now,
        attempts: 0,
      }
      changed = true
    } else {
      assertSameLocator(resource.locator, normalized)
      if (!allowMissing || normalized.lifecycleGeneration !== undefined) {
        assertExactLifecycleGeneration(resource, normalized)
      }
      if (resource.state === "deleting" || resource.state === "deleted") {
        throw new SessionLifecycleError(`cannot publish transcript ${key} from state ${resource.state}`)
      }
      if (resource.state !== "live") {
        resource.state = "live"
        resource.updatedAt = now
        delete resource.nextAttemptAt
        delete resource.lastError
        changed = true
      }
    }
    // Release publication ownership in the same locked transaction as the
    // synchronous mapping CAS. A failed CAS restores the complete lease record.
    if (releasePublicationLease(resource)) changed = true
    if (changed) {
      pruneTombstones(sidecar, options)
      await writeSidecar(paths.sidecar, sidecar)
    }
    // Keep the lifecycle lock held across the synchronous session-store CAS.
    locator.lifecycleGeneration = resource.generation
    try {
      const result = publish()
      if (result === false) {
        if (changed) await writeSidecar(paths.sidecar, beforeMutation)
        if (originalGeneration === undefined) delete locator.lifecycleGeneration
        else locator.lifecycleGeneration = originalGeneration
      }
      return result
    } catch (error) {
      if (changed) await writeSidecar(paths.sidecar, beforeMutation)
      if (originalGeneration === undefined) delete locator.lifecycleGeneration
      else locator.lifecycleGeneration = originalGeneration
      throw error
    }
  })
}

/** Retire an intent when spawn fails. It remains tracked until SDK deletion succeeds. */
export async function abandonFork(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<void> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.abandonFork(locator, options)
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const resource = sidecar.resources[key]
    if (!resource) {
      throw new SessionLifecycleError(`fork ${key} was not prepared`)
    }
    assertSameLocator(resource.locator, normalized)
    assertExactLifecycleGeneration(resource, normalized)
    const releasedPublication = releasePublicationLease(resource)
    if (resource.state === "prepared" || resource.state === "live") {
      if (resource.state === "live") assertPendingCapacity(sidecar, options)
      resource.state = "retired"
      resource.updatedAt = nowMs(options)
      resource.nextAttemptAt = resource.updatedAt + retiredGraceMs(options)
      await writeSidecar(paths.sidecar, sidecar)
    } else if (releasedPublication) {
      await writeSidecar(paths.sidecar, sidecar)
    }
  })
}

/**
 * Reconcile durable ownership with caller-provided current and previous pins.
 * Pins are the retention authority. Callers should pass both generations.
 */
export async function reconcile(
  pins: readonly TranscriptLocator[],
  options: SessionLifecycleOptions = {},
): Promise<ReconcileResult> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.reconcile(pins, options)
  // Validate caller pins before waiting for the lock. The authoritative pin
  // provider is refreshed again while the lifecycle lock is held.
  indexPins(pins)
  return withSidecarLock(options, paths => reconcileUnderLock(pins, options, paths))
}

async function reconcileUnderLock(
  pins: readonly TranscriptLocator[],
  options: SessionLifecycleOptions,
  paths: SidecarPaths,
): Promise<ReconcileResult> {
    const effectivePins = indexPins(options.pinProvider?.() ?? pins)
    const sidecar = await readSidecar(paths.sidecar)
    const pinKeys = new Set(Object.values(sidecar.resources)
      .filter((resource) => resourceIsPinned(resource, effectivePins))
      .map((resource) => resource.key))
    const result: ReconcileResult = {
      preparedRetired: 0,
      liveRetired: 0,
      resourcesPinned: 0,
      deletingRecovered: 0,
    }
    const now = nowMs(options)
    const preparedCutoff = now - nonNegativeOption(options.preparedGraceMs, DEFAULT_PREPARED_GRACE_MS, "preparedGraceMs")
    let changed = false
    const unarmedLeaseTtlMs = nonNegativeOption(options.unarmedLeaseTtlMs, DEFAULT_UNARMED_LEASE_TTL_MS, "unarmedLeaseTtlMs")
    for (const resource of Object.values(sidecar.resources)) {
      if (pruneDeadActiveLeases(resource, now, unarmedLeaseTtlMs)) changed = true
    }
    let pending = pendingResourceCount(sidecar)
    const maxPending = option(options.maxPending, DEFAULT_MAX_PENDING, "maxPending")
    // Passive retirement must leave room for one active preallocation. Without
    // that headroom, a profile switch can unpin enough live transcripts to fill
    // the backlog and block every fresh request until the quarantine expires.
    // A one-slot configuration cannot reserve capacity without disabling
    // passive cleanup entirely, so preserve its existing behavior.
    const passiveRetirementLimit = maxPending > 1 ? maxPending - 1 : maxPending

    // A deletion claim is recoverable only after the exact persisted executor
    // is provably dead. Before the executor handshake, authoritative death of
    // the claiming proxy is enough because the gated child cannot start the
    // physical SDK deletion without that handshake.
    for (const resource of Object.values(sidecar.resources)) {
      if (resource.state !== "deleting") continue
      // The incarnation probe (pid + OS start id) is immune to pid reuse. On
      // POSIX the group probe additionally waits out surviving descendants.
      // win32 has no process groups and recycles pids aggressively: probing
      // the stored pid there could misread an unrelated process as a live
      // deleter forever, permanently blocking recovery of this claim, and a
      // single-pid probe observes no descendants anyway — executor death is
      // the entire win32 signal (the un-detached deletion child spawns none;
      // see deleteWithSdkChild).
      const executorDead = resource.deletionExecutor
        && resource.deletionProcessGroupId !== undefined
        ? processIncarnationIsDead(resource.deletionExecutor)
          && (process.platform === "win32"
            || processGroupIsEmpty(resource.deletionProcessGroupId))
        : false
      const ownerDiedBeforeHandshake = !resource.deletionExecutor
        && resource.deletionOwner !== undefined
        && processIncarnationIsDead(resource.deletionOwner)
      if (!executorDead && !ownerDiedBeforeHandshake) continue
      resource.state = "retired"
      resource.updatedAt = now
      resource.nextAttemptAt = now
      delete resource.deletionToken
      delete resource.deletionOwner
      delete resource.deletionExecutor
      delete resource.deletionProcessGroupId
      result.deletingRecovered++
      changed = true
    }

    // Rescue durable pins first. This releases pending capacity before any
    // unpinned live resource tries to enter the bounded retirement backlog.
    for (const resource of Object.values(sidecar.resources)) {
      if (!pinKeys.has(resource.key)) continue
      result.resourcesPinned++
      if (resource.state === "deleted") {
        throw new SessionLifecycleError(`pinned transcript ${resource.key} was already deleted`)
      }
      if (resource.state === "prepared" || resource.state === "retired") {
        resource.state = "live"
        resource.updatedAt = now
        delete resource.nextAttemptAt
        delete resource.lastError
        pending--
        changed = true
      }
      // A deleting resource may have an in-flight child. It cannot be rescued safely.
    }

    for (const resource of Object.values(sidecar.resources)) {
      if (pinKeys.has(resource.key) || hasActiveTranscriptLease(resource)) continue
      if (resource.state === "prepared" && resource.updatedAt <= preparedCutoff) {
        // prepared and retired both consume one pending slot.
        resource.state = "retired"
        resource.updatedAt = now
        resource.nextAttemptAt = now + retiredGraceMs(options)
        result.preparedRetired++
        changed = true
      } else if (resource.state === "live" && pending < passiveRetirementLimit) {
        resource.state = "retired"
        resource.updatedAt = now
        resource.nextAttemptAt = now + retiredGraceMs(options)
        result.liveRetired++
        pending++
        changed = true
      }
    }

    if (changed) await writeSidecar(paths.sidecar, sidecar)
    return result
}

/**
 * Remove superseded cross-profile mappings no faster than the transcript
 * backlog can absorb them. Fresh-request admission draws on the same pending
 * budget and, when it is full, returns the newest retired transcripts to live
 * (deferRetirementForAdmission) - which would undo this prune's retirements
 * one request at a time. The transcripts unpinned here are therefore capped to
 * keep at least half of the budget free: a large first prune drains over
 * successive sweeps, as retired transcripts are deleted, instead of filling
 * the backlog at once.
 * Reconciliation reserves retirement capacity before releasing the same lock.
 * An authoritative pin provider is required. Returns mappings removed.
 */
export async function releaseSupersededProfileCopies(
  copies: Omit<ProfileCopyPruneOptions, "maxUnpinnedTranscripts">,
  options: SessionLifecycleOptions = {},
  turnCoordinator = new CrossProcessTurnCoordinator(join(options.storeDir ?? getSessionStoreDir(), "turn-locks")),
): Promise<number> {
  const maxPending = option(options.maxPending, DEFAULT_MAX_PENDING, "maxPending")
  if (!options.pinProvider) throw new SessionLifecycleError("profile-copy pruning requires an authoritative pin provider")
  return withSidecarLock(options, async paths => {
    // Recover unrecorded retirements from an earlier failed publication before
    // granting more capacity; a pin-provider/write failure must precede pruning.
    await reconcileUnderLock([], options, paths)
    const sidecar = await readSidecar(paths.sidecar)
    const budget = Math.floor(maxPending / 2) - pendingResourceCount(sidecar)
    if (budget <= 0) return 0
    const selection = { ...copies, maxUnpinnedTranscripts: budget }
    const conversations = listSupersededProfileConversations(selection).slice(0, 64)
    const leases: CrossProcessTurnLease[] = []
    const fenced = new Set<string>()
    try {
      // Never wait while holding the sidecar lock: a request holding a turn
      // may itself need lifecycle metadata. Busy conversations wait for a later sweep.
      for (const conversation of conversations) {
        const lease = await turnCoordinator.tryAcquireIdle(`session:${conversation}`)
        if (!lease) continue
        leases.push(lease)
        fenced.add(conversation)
      }
      const removed = pruneSupersededProfileCopies({ ...selection,
        isConversationActive: id => !fenced.has(id) || copies.isConversationActive(id),
      })
      if (removed) await reconcileUnderLock([], options, paths)
      return removed
    } finally {
      const releases = await Promise.allSettled(leases.map(lease => lease.release()))
      const failed = releases.find(result => result.status === "rejected")
      if (failed?.status === "rejected") throw failed.reason
    }
  })
}

/**
 * Delete a bounded batch of unpinned retired transcripts through the supported
 * SDK API, after retrying deferred lease releases that would otherwise fence them.
 */
export async function runGc(
  pins: readonly TranscriptLocator[],
  options: SessionLifecycleOptions = {},
): Promise<GcResult> {
  const backend = activeLifecycleBackend()
  if (backend) return backend.runGc(pins, options)
  await retryDeferredLeaseReleases(options)
  await reconcile(pins, options)
  let currentPins = indexPins(pins)
  const limit = option(options.maxDeletesPerRun, DEFAULT_MAX_DELETES, "maxDeletesPerRun")
  const result: GcResult = { deleted: 0, notFound: 0, failed: 0, deferred: 0 }
  const runTimeoutMs = option(options.runTimeoutMs, DEFAULT_DELETE_TIMEOUT_MS, "runTimeoutMs")
  const deadline = Date.now() + runTimeoutMs

  for (let index = 0; index < limit; index++) {
    if (Date.now() >= deadline) break
    const refreshedPins = options.pinProvider?.()
    if (refreshedPins) {
      currentPins = indexPins(refreshedPins)
    }
    const candidate = await claimDeletion(currentPins, options)
    if (!candidate) break

    let failure: unknown
    let notFound = false
    let deletionStillRunning = false
    try {
      // The run deadline only gates the next claim; this one keeps its full budgets.
      const deletionTimeout = option(options.deletionTimeoutMs, DEFAULT_DELETE_TIMEOUT_MS, "deletionTimeoutMs")
      if (options.deleter) {
        await awaitCustomDeleter(options.deleter(candidate.locator), deletionTimeout)
      } else {
        await deleteWithSdkChild(
          candidate.locator,
          candidate.deletionToken!,
          deletionTimeout,
          (executor, processGroupId, signal) => attachDeletionExecutor(
            candidate.key,
            candidate.deletionToken!,
            executor,
            processGroupId,
            signal,
            options,
          ),
          options,
        )
      }
    } catch (error) {
      if (error instanceof DeletionStillRunningError) deletionStillRunning = true
      else if (isNotFoundError(error, candidate.locator.sessionId)) notFound = true
      else failure = error
    }

    if (deletionStillRunning) {
      // The SDK has no deletion fencing token. Keep the resource permanently
      // deleting until an operator proves the old deleter is gone; retrying
      // could let an old physical delete race a newly pinned generation.
      result.deferred++
      break
    }
    await finishDeletion(candidate.key, candidate.deletionToken!, failure, options)
    if (failure) result.failed++
    else if (notFound) result.notFound++
    else result.deleted++
  }

  result.deferred += await countDeferred(currentPins, options)
  return result
}

async function claimDeletion(
  pins: PinIndex,
  options: SessionLifecycleOptions,
): Promise<TranscriptResource | undefined> {
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const refreshedPins = options.pinProvider?.()
    const finalPins = refreshedPins ? indexPins(refreshedPins) : pins
    const now = nowMs(options)
    const unarmedLeaseTtlMs = nonNegativeOption(options.unarmedLeaseTtlMs, DEFAULT_UNARMED_LEASE_TTL_MS, "unarmedLeaseTtlMs")
    let leasesChanged = false
    for (const resource of Object.values(sidecar.resources)) {
      if (pruneDeadActiveLeases(resource, now, unarmedLeaseTtlMs)) leasesChanged = true
    }
    const candidate = Object.values(sidecar.resources)
      .filter((resource) =>
        resource.state === "retired"
        && !resourceIsPinned(resource, finalPins)
        && !hasActiveTranscriptLease(resource)
        && (resource.nextAttemptAt ?? 0) <= now)
      .sort((left, right) => left.updatedAt - right.updatedAt || left.key.localeCompare(right.key))[0]
    if (!candidate) {
      if (leasesChanged) await writeSidecar(paths.sidecar, sidecar)
      return undefined
    }
    const deletionOwner = captureProcessIncarnation()
    if (!deletionOwner) throw new SessionLifecycleError("cannot capture deletion owner process incarnation")
    candidate.state = "deleting"
    candidate.updatedAt = now
    candidate.deletionToken = randomUUID()
    candidate.deletionOwner = deletionOwner
    delete candidate.deletionExecutor
    delete candidate.deletionProcessGroupId
    await writeSidecar(paths.sidecar, sidecar)
    return structuredClone(candidate)
  })
}

async function attachDeletionExecutor(
  key: string,
  deletionToken: string,
  executor: ProcessIncarnation,
  processGroupId: number,
  signal: AbortSignal,
  options: SessionLifecycleOptions,
): Promise<void> {
  // The signal fences admission only: a started write runs to completion, so
  // finishDeletion (queued behind this holder) sees the whole attach or none of it.
  signal.throwIfAborted()
  await withSidecarLock({ ...options, admissionSignal: signal }, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    signal.throwIfAborted()
    const resource = sidecar.resources[key]
    if (!resource || resource.state !== "deleting" || resource.deletionToken !== deletionToken) {
      throw new SessionLifecycleError(`deletion lease for ${key} was lost before executor handshake`)
    }
    resource.deletionExecutor = executor
    resource.deletionProcessGroupId = processGroupId
    resource.updatedAt = nowMs(options)
    await writeSidecar(paths.sidecar, sidecar)
  })
}

async function finishDeletion(
  key: string,
  deletionToken: string,
  failure: unknown,
  options: SessionLifecycleOptions,
): Promise<void> {
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const resource = sidecar.resources[key]
    if (!resource || resource.state !== "deleting" || resource.deletionToken !== deletionToken) {
      throw new SessionLifecycleError(`deletion lease for ${key} was lost`)
    }
    const now = nowMs(options)
    resource.updatedAt = now
    delete resource.deletionToken
    delete resource.deletionOwner
    delete resource.deletionExecutor
    delete resource.deletionProcessGroupId
    if (!failure) {
      resource.state = "deleted"
      delete resource.nextAttemptAt
      delete resource.lastError
    } else {
      resource.state = "retired"
      resource.attempts++
      resource.lastError = errorMessage(failure).slice(0, 1_000)
      const base = option(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, "retryBaseMs")
      const maximum = option(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, "retryMaxMs")
      const delay = Math.min(maximum, base * (2 ** Math.min(resource.attempts - 1, 20)))
      resource.nextAttemptAt = now + delay
    }
    pruneTombstones(sidecar, options)
    await writeSidecar(paths.sidecar, sidecar)
  })
}

async function countDeferred(
  pins: PinIndex,
  options: SessionLifecycleOptions,
): Promise<number> {
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    return Object.values(sidecar.resources).filter((resource) =>
      (resource.state === "retired" || resource.state === "deleting")
      && !resourceIsPinned(resource, pins)).length
  })
}

class DeletionStillRunningError extends Error {}

/** The SDK reported the transcript already gone: there is nothing left to delete. */
class TranscriptAlreadyAbsentError extends Error {}

/** @internal Bridge from the SQL deletion phase into the one deletion runtime; not package API.
 * Frozen so that neither a consumer nor a test can swap a member under the JSON path. */
export const sessionDeletionRuntime = Object.freeze({
  processGroupIsEmpty,
  deleteWithSdkChild, awaitCustomDeleter, isNotFoundError, DeletionStillRunningError,
  maxDeletes: DEFAULT_MAX_DELETES, timeoutMs: DEFAULT_DELETE_TIMEOUT_MS,
  retryBaseMs: DEFAULT_RETRY_BASE_MS, retryMaxMs: DEFAULT_RETRY_MAX_MS,
})

async function awaitCustomDeleter(deletion: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new DeletionStillRunningError("custom deleter did not settle before timeout")), timeoutMs)
    timer.unref?.()
  })
  try {
    await Promise.race([deletion, timeout])
  } catch (error) {
    if (error instanceof DeletionStillRunningError) {
      void deletion.catch(() => undefined)
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function processGroupIsEmpty(processGroupId: number): boolean {
  // POSIX only: a negative pid probes the whole process group, and a stale
  // pgid cannot be recycled until the pid space wraps. On win32 a pid is
  // reusable the moment its last handle closes, so a pid probe can pin
  // "still running" on an unrelated process indefinitely while observing no
  // descendants; win32 callers must join the leader through its ChildProcess
  // handle or the persisted executor incarnation instead.
  if (process.platform === "win32") {
    throw new SessionLifecycleError("process-group probes are POSIX-only")
  }
  try {
    process.kill(-processGroupId, 0)
    return false
  } catch (error) {
    return hasCode(error, "ESRCH")
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // No POSIX process groups on Windows. taskkill /T force-terminates the
    // deletion child together with any descendants it may have spawned; the
    // requested POSIX signal collapses to a forced kill (both call sites pass
    // SIGKILL). Call sites only reach this while the un-reaped ChildProcess
    // handle still pins the pid, so the kill cannot land on a reused pid.
    // Best effort beyond that: losing a race to an already-exiting tree is
    // fine.
    spawnSync("taskkill", ["/PID", String(processGroupId), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    })
    return
  }
  try {
    process.kill(-processGroupId, signal)
  } catch (error) {
    if (!hasCode(error, "ESRCH")) throw error
  }
}

async function waitForProcessGroupEmpty(
  processGroupId: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (processGroupIsEmpty(processGroupId)) return true
    await new Promise<void>((resolveWait) => {
      const timer = setTimeout(resolveWait, Math.min(25, Math.max(1, deadline - Date.now())))
      timer.unref?.()
    })
  }
  return processGroupIsEmpty(processGroupId)
}

async function waitForDeletionExit(
  exited: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([exited.then(() => true, () => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function deleteWithSdkChild(
  locator: TranscriptLocator,
  deletionToken: string,
  timeoutMs: number,
  attachExecutor: (
    executor: ProcessIncarnation,
    processGroupId: number,
    signal: AbortSignal,
  ) => Promise<void>,
  options: SessionLifecycleOptions,
): Promise<void> {
  const handshakeTimeoutMs = option(
    options.deletionHandshakeTimeoutMs,
    DEFAULT_DELETE_TIMEOUT_MS,
    "deletionHandshakeTimeoutMs",
  )
  const sdkUrl = options.sdkModuleUrl ?? import.meta.resolve("@anthropic-ai/claude-agent-sdk")
  const gateDirectory = join(getStoreDir(options), "deletion-gates")
  await mkdir(gateDirectory, { recursive: true, mode: 0o700 })
  const gatePath = join(gateDirectory, `${deletionToken}.go`)
  await unlink(gatePath).catch((error) => {
    if (!hasCode(error, "ENOENT")) throw error
  })
  const script = `
const { existsSync } = await import("node:fs");
const { setTimeout: wait } = await import("node:timers/promises");
const gateDeadline = Date.now() + Number(process.env.MERIDIAN_GC_GATE_TIMEOUT_MS);
while (!existsSync(process.env.MERIDIAN_GC_GATE_PATH)) {
  if (Date.now() >= gateDeadline) process.exit(75);
  await wait(10);
}
const sdk = await import(process.env.MERIDIAN_GC_SDK_URL);
const sessionId = process.env.MERIDIAN_GC_SESSION_ID;
const options = process.env.MERIDIAN_GC_PROJECT_DIR
  ? { dir: process.env.MERIDIAN_GC_PROJECT_DIR }
  : undefined;
// Only the SDK's session-specific verdict means "already absent". A generic
// "not found" can be the SDK or the child itself failing to load, and must stay
// a retryable failure rather than tombstone a transcript still on disk.
const absent = (message) => message.includes(process.env.MERIDIAN_GC_ABSENT_PHRASE);
try {
  await sdk.deleteSession(sessionId, options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("not found")) throw error;
  if (options) {
    try {
      await sdk.deleteSession(sessionId);
      process.exit(0); // The dir-less retry deleted it: a deletion, not an absence.
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      if (!absent(fallbackMessage)) throw fallbackError;
      process.exit(${SESSION_GC_NOT_FOUND_EXIT_CODE});
    }
  }
  if (!absent(message)) throw error;
  process.exit(${SESSION_GC_NOT_FOUND_EXIT_CODE});
}
`
  const child = spawn(getSessionGcNodeExecutable(), ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: locator.configDir,
      MERIDIAN_GC_SDK_URL: sdkUrl,
      MERIDIAN_GC_SESSION_ID: locator.sessionId,
      MERIDIAN_GC_ABSENT_PHRASE: sessionAbsentPhrase(locator.sessionId),
      MERIDIAN_GC_PROJECT_DIR: locator.projectDir ?? "",
      MERIDIAN_GC_GATE_PATH: gatePath,
      // The child counts its gate deadline from its own start, but the parent
      // opens the gate only after capturing the child's incarnation — a
      // PowerShell round trip on win32 that may consume its entire probe
      // budget — and after the durable executor handshake. Without both
      // allowances the child exits 75 before the gate ever appears, turning
      // every deletion into a retryable failure on a loaded host.
      MERIDIAN_GC_GATE_TIMEOUT_MS: String(
        timeoutMs
        + handshakeTimeoutMs
        + processIncarnationProbeBudgetMs(),
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
  })
  let output = ""
  const collect = (chunk: Buffer | string): void => {
    if (output.length < 64 * 1024) output += chunk.toString()
  }
  child.stdout?.on("data", collect)
  child.stderr?.on("data", collect)
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit)
    child.once("exit", (code, signal) => resolveExit({ code, signal }))
  })
  let joined = false
  let unjoined = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const joinTimeoutMs = Math.max(100, Math.min(2_000, timeoutMs))
  const processGroupId = child.pid
  // win32 recycles a pid the instant the child is reaped, so pid-level kills
  // are only safe while our un-reaped handle still pins it. If the leader is
  // already gone there, so is its taskkill-visible tree.
  let deletionTreeKilled = false
  const killDeletionTree = (): void => {
    if (!processGroupId || deletionTreeKilled) return
    if (process.platform === "win32" && (child.exitCode !== null || child.signalCode !== null)) return
    signalProcessGroup(processGroupId, "SIGKILL")
    // macOS can reject a second signal to a killed, not-yet-reaped group
    // with EPERM. Join the original kill instead of masking its timeout.
    deletionTreeKilled = true
  }
  try {
    if (!processGroupId) throw new Error("session deletion child has no PID")
    const executor = captureProcessIncarnation(processGroupId)
    if (!executor) throw new Error("cannot capture session deletion executor incarnation")
    // The handshake budget starts after incarnation capture and covers only the
    // durable attach; losing the race never opens the gate.
    const handshakeDeadline = performance.now() + handshakeTimeoutMs
    const handshake = new AbortController()
    // Admission cancellation joins the handshake fence when the runtime
    // supports combining; otherwise the handshake deadline alone fences it.
    const handshakeSignal = options.admissionSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([handshake.signal, options.admissionSignal])
      : handshake.signal
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    let onHandshakeAbort: (() => void) | undefined
    const handshakeAbort = new Promise<never>((_resolve, reject) => {
      const settle = (): void => reject(handshakeSignal.reason)
      if (handshakeSignal.aborted) {
        settle()
        return
      }
      onHandshakeAbort = settle
      handshakeSignal.addEventListener("abort", onHandshakeAbort, { once: true })
    })
    handshakeTimer = setTimeout(() => {
      handshake.abort(new Error("session deletion executor handshake timed out"))
    }, handshakeTimeoutMs)
    handshakeTimer.unref?.()
    try {
      await Promise.race([attachExecutor(executor, processGroupId, handshakeSignal), handshakeAbort])
    } finally {
      if (handshakeTimer) clearTimeout(handshakeTimer)
      if (onHandshakeAbort) handshakeSignal.removeEventListener("abort", onHandshakeAbort)
    }
    // A delayed timer, an admission abort, or an attach that resolved past
    // the monotonic deadline must all still fail closed.
    handshakeSignal.throwIfAborted()
    if (performance.now() >= handshakeDeadline) {
      throw new Error("session deletion executor handshake timed out")
    }
    const gateHandle = await open(gatePath, "wx", 0o600)
    try {
      await gateHandle.writeFile("go\n", "utf8")
      await gateHandle.sync()
    } finally {
      await gateHandle.close()
    }

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        killDeletionTree()
        reject(new Error("session deletion process group timed out and was killed"))
      }, timeoutMs)
      timer.unref?.()
    })
    const status = await Promise.race([exited, timeout])
    // The leader was just joined through its own ChildProcess handle, which
    // is immune to pid reuse. On win32 the un-detached leader is the entire
    // observable "group" (the SDK's deleteSession spawns no descendants) and
    // its pid is already reusable, so probing it could only misread a reused
    // pid as a still-running deleter and wedge this resource in permanent
    // deferral; the handle join is the fence. POSIX still waits out group
    // survivors.
    joined = process.platform === "win32"
      ? true
      : await waitForProcessGroupEmpty(processGroupId, joinTimeoutMs)
    if (!joined) {
      throw new DeletionStillRunningError("session deletion process group remains active")
    }
    if (status.code === SESSION_GC_NOT_FOUND_EXIT_CODE) {
      throw new TranscriptAlreadyAbsentError(
        `session deletion child reported transcript ${locator.sessionId} already absent`,
      )
    }
    if (status.code !== 0) {
      throw new Error(`session deletion child exited ${status.code ?? status.signal}: ${clipChildOutput(output)}`)
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (!joined && processGroupId) {
      killDeletionTree()
      const [leaderExited, groupEmpty] = await Promise.all([
        waitForDeletionExit(exited, joinTimeoutMs),
        // win32: the leader's ChildProcess handle is the only reuse-proof
        // join signal; see the comment on the un-timed-out path above.
        process.platform === "win32"
          ? Promise.resolve(true)
          : waitForProcessGroupEmpty(processGroupId, joinTimeoutMs),
      ])
      joined = leaderExited && groupEmpty
      unjoined = !joined
    }
    await unlink(gatePath).catch((error) => {
      if (!hasCode(error, "ENOENT")) {
        console.error("[sessionLifecycle] deletion gate cleanup failed:", errorMessage(error))
      }
    })
    if (unjoined) {
      throw new DeletionStillRunningError("session deletion process group remains unjoined")
    }
  }
}

/** Keep both ends of child output within the storage budget: the verdict sits
 *  at the head, while a Node crash report floods the tail with vendor source. */
export function clipChildOutput(output: string): string {
  const halfBudget = 2_000
  if (output.length <= halfBudget * 2) return output
  const elided = output.length - halfBudget * 2
  return `${output.slice(0, halfBudget)}\n…[${elided} chars elided]…\n${output.slice(-halfBudget)}`
}

function getStoreDir(options: SessionLifecycleOptions): string {
  if (options.storeDir) return options.storeDir
  return getSessionStoreDir()
}

interface SidecarPaths {
  sidecar: string
  lock: string
}

interface SidecarLockCandidate {
  /** Become the lock. False means somebody else already holds it. */
  publish: () => Promise<boolean>
  /** Drop the staging name. A published candidate stays alive as the lock. */
  discard: () => Promise<void>
}

/** Initialise one lock candidate for a whole acquisition, not one per attempt.
 *
 *  The fsync itself is load-bearing: a crash that leaves the lock linked to an
 *  unwritten inode is unrecoverable, because stale-lock recovery only retires a
 *  lock whose owner it can parse and prove dead. Paying it per attempt is what
 *  does not follow. An fsync costs ~100ms on a busy filesystem, so a 2s budget
 *  bought ~13 attempts rather than the ~80 a 25ms retry interval implies, and
 *  each one wrote into the very directory the holder must fsync to publish the
 *  sidecar, so waiters taxed the holder they were waiting for. One initialised
 *  inode, re-linked, keeps the durability and drops the cost to a rename-class
 *  metadata operation.
 */
export async function createInitializedSidecarLockCandidate(
  path: string,
  contents: string,
): Promise<SidecarLockCandidate> {
  const staging = `${path}.candidate-${process.pid}-${randomUUID()}`
  const discard = async (): Promise<void> => {
    await unlink(staging).catch((error) => {
      if (!hasCode(error, "ENOENT")) {
        console.error("[sessionLifecycle] lock staging cleanup failed:", errorMessage(error))
      }
    })
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(staging, "wx", 0o600)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await discard()
    throw error
  }
  return {
    publish: async () => {
      try {
        await link(staging, path)
        return true
      } catch (error) {
        if (hasCode(error, "EEXIST")) return false
        throw error
      }
    },
    discard,
  }
}

/** Offline migration uses the same lifecycle lock and recovery protocol as legacy publication. */
export function withLegacyLifecycleMaintenanceLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  return withSidecarLock({ storeDir: directory, lockWaitMs: 100, lockStaleMs: 1 }, operation)
}

async function withSidecarLock<T>(
  options: SessionLifecycleOptions,
  operation: (paths: SidecarPaths) => Promise<T>,
): Promise<T> {
  const dir = getStoreDir(options)
  const paths = { sidecar: join(dir, SIDECAR_NAME), lock: join(dir, `${SIDECAR_NAME}.lock`) }
  return lifecycleLockQueue.run(paths.lock, options.admissionSignal, async () => {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await chmod(dir, 0o700)
    options.admissionSignal?.throwIfAborted()
    const incarnation = captureProcessIncarnation()
    if (!incarnation) throw new SessionLifecycleLockError("cannot capture lock owner process incarnation")
    const token = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), incarnation })
    const deadline = performance.now() + nonNegativeOption(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS, "lockWaitMs")
    const retryMs = option(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, "lockRetryMs")
    const staleMs = option(options.lockStaleMs, DEFAULT_LOCK_STALE_MS, "lockStaleMs")
    // Only the local head creates a durable candidate; local backlog consumes
    // neither the external acquisition budget nor candidate-file I/O.
    const candidate = await createInitializedSidecarLockCandidate(
      paths.lock,
      `${token}\n${Date.now()}\n`,
    )
    let acquired = false
    try {
      try {
        while (!acquired) {
          options.admissionSignal?.throwIfAborted()
          acquired = await candidate.publish()
          if (acquired) break
          await recoverStaleLock(paths.lock, staleMs)
          options.admissionSignal?.throwIfAborted()
          if (performance.now() >= deadline) {
            throw new SessionLifecycleLockError(`timed out waiting for ${paths.lock}`)
          }
          await waitForLockRetry(Math.min(retryMs, Math.max(1, deadline - performance.now())), undefined, {
            signal: options.admissionSignal,
          })
        }
      } finally {
        await candidate.discard()
      }
      options.admissionSignal?.throwIfAborted()
      return await operation(paths)
    } finally {
      // Only the owner may release. A stale-lock recovery must not unlink a successor.
      try {
        if (acquired) {
          const contents = await readFile(paths.lock, "utf8")
          if (contents.startsWith(`${token}\n`)) await unlink(paths.lock)
        }
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          console.error("[sessionLifecycle] lock release failed:", errorMessage(error))
        }
      }
    }
  })
}

interface CanonicalLifecycleLockOwner {
  pid: number
  hostname: string
  token: string
  incarnation: ProcessIncarnation
}

function parseCanonicalLifecycleLockOwner(contents: string): CanonicalLifecycleLockOwner | undefined {
  const token = contents.split("\n", 1)[0] ?? ""
  try {
    const owner = JSON.parse(token) as unknown
    if (!isRecord(owner)) return undefined
    const incarnation = parseProcessIncarnation(owner.incarnation)
    if (
      typeof owner.pid !== "number"
      || !Number.isInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.hostname !== "string"
      || owner.hostname.length === 0
      || typeof owner.token !== "string"
      || owner.token.length === 0
      || !incarnation
    ) return undefined
    return {
      pid: owner.pid,
      hostname: owner.hostname,
      token: owner.token,
      incarnation,
    }
  } catch {
    return undefined
  }
}

function canonicalLifecycleLockOwnerIsDead(contents: string): boolean {
  const owner = parseCanonicalLifecycleLockOwner(contents)
  return owner ? processIncarnationIsDead(owner.incarnation) : false
}

interface LifecycleRecoveryClaimSnapshot {
  dev: number
  ino: number
  owner?: RecoveryClaimOwner
}

async function snapshotLifecycleRecoveryClaim(
  claimPath: string,
): Promise<LifecycleRecoveryClaimSnapshot | undefined> {
  let info: Awaited<ReturnType<typeof lstat>>
  try {
    info = await lstat(claimPath)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return undefined
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return { dev: info.dev, ino: info.ino }

  let owner: RecoveryClaimOwner | undefined
  try {
    owner = parseRecoveryClaimOwnerJson(await readFile(join(claimPath, "owner.json"), "utf8"))
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error
  }
  return { dev: info.dev, ino: info.ino, owner }
}

/** Atomically publish a fully initialized, non-empty recovery owner directory. */
async function publishLifecycleRecoveryClaim(
  claimPath: string,
  owner: RecoveryClaimOwner,
): Promise<boolean> {
  const candidate = `${claimPath}.candidate-${process.pid}-${owner.token}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let published = false
  try {
    await mkdir(candidate, { mode: 0o700 })
    handle = await open(join(candidate, "owner.json"), "wx", 0o600)
    await handle.writeFile(JSON.stringify(owner), "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await syncDirectoryDurably(candidate)

    try {
      await lstat(claimPath)
      return false
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error
    }
    try {
      await rename(candidate, claimPath)
      published = true
      await syncDirectoryDurably(dirname(claimPath))
      return true
    } catch (error) {
      if (await directoryRenameWasBlocked(error, claimPath)) return false
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
    if (!published) await rm(candidate, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Retire only the observed dead claim generation. Its tombstone fences ABA. */
async function retireDeadLifecycleRecoveryClaim(
  claimPath: string,
  generation: string,
): Promise<boolean> {
  const observed = await snapshotLifecycleRecoveryClaim(claimPath)
  if (!observed) return true
  if (
    !observed.owner
    || observed.owner.generation !== generation
    || !recoveryClaimOwnerIsDead(observed.owner)
  ) return false

  const tombstone = getRecoveryClaimTombstonePath(claimPath, observed.owner.token)
  try {
    await lstat(tombstone)
    return false
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error
  }

  const current = await snapshotLifecycleRecoveryClaim(claimPath)
  if (!current) return true
  const currentOwner = current.owner
  if (
    current.dev !== observed.dev
    || current.ino !== observed.ino
    || !currentOwner
    || currentOwner.token !== observed.owner.token
    || currentOwner.generation !== generation
    || !recoveryClaimOwnerIsDead(currentOwner)
  ) return false

  try {
    await rename(claimPath, tombstone)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return true
    if (await directoryRenameWasBlocked(error, tombstone)) return false
    throw error
  }

  const moved = await snapshotLifecycleRecoveryClaim(tombstone)
  if (
    !moved
    || moved.dev !== observed.dev
    || moved.ino !== observed.ino
    || moved.owner?.token !== observed.owner.token
    || moved.owner?.generation !== generation
  ) throw new SessionLifecycleLockError("recovery claim identity changed during retirement")
  return true
}

async function releaseLifecycleRecoveryClaim(
  claimPath: string,
  owner: RecoveryClaimOwner,
): Promise<void> {
  try {
    const current = await snapshotLifecycleRecoveryClaim(claimPath)
    if (current?.owner?.token === owner.token && current.owner.generation === owner.generation) {
      await rm(claimPath, { recursive: true })
    }
  } catch (error) {
    console.error("[sessionLifecycle] stale recovery claim cleanup failed:", errorMessage(error))
  }
}

async function cleanupLifecycleRecoveryTombstones(claimPath: string): Promise<void> {
  const prefix = `${basename(claimPath)}.orphan-`
  try {
    for (const name of await readdir(dirname(claimPath))) {
      if (!name.startsWith(prefix)) continue
      const path = join(dirname(claimPath), name)
      const info = await lstat(path)
      if (info.isDirectory() && !info.isSymbolicLink()) {
        await rm(path, { recursive: true })
      }
    }
  } catch (error) {
    if (!hasCode(error, "ENOENT")) {
      console.error("[sessionLifecycle] stale recovery tombstone cleanup failed:", errorMessage(error))
    }
  }
}

async function recoverStaleLock(lockPath: string, staleMs: number): Promise<void> {
  let contents: string
  let info: Awaited<ReturnType<typeof stat>>
  try {
    contents = await readFile(lockPath, "utf8")
    info = await stat(lockPath)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return
    throw error
  }
  if (
    Date.now() - info.mtimeMs <= staleMs
    || !canonicalLifecycleLockOwnerIsDead(contents)
  ) return

  const generation = contents
  const claimPath = getRecoveryClaimPath(lockPath, generation)
  const claimOwner = createRecoveryClaimOwner(generation)
  if (!await publishLifecycleRecoveryClaim(claimPath, claimOwner)) {
    if (!await retireDeadLifecycleRecoveryClaim(claimPath, generation)) return
    if (!await publishLifecycleRecoveryClaim(claimPath, claimOwner)) return
  }

  let generationResolved = false
  try {
    let currentContents: string
    let currentInfo: Awaited<ReturnType<typeof stat>>
    try {
      currentContents = await readFile(lockPath, "utf8")
      currentInfo = await stat(lockPath)
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        generationResolved = true
        return
      }
      throw error
    }
    if (
      currentContents !== contents
      || currentInfo.dev !== info.dev
      || currentInfo.ino !== info.ino
    ) {
      generationResolved = true
      return
    }
    if (
      Date.now() - currentInfo.mtimeMs <= staleMs
      || !canonicalLifecycleLockOwnerIsDead(currentContents)
    ) return

    const quarantine = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    await rename(lockPath, quarantine)
    generationResolved = true
    const movedContents = await readFile(quarantine, "utf8")
    if (movedContents !== currentContents) {
      throw new SessionLifecycleLockError("claimed lock identity changed during stale recovery")
    }
    await unlink(quarantine)
  } catch (error) {
    if (hasCode(error, "ENOENT")) generationResolved = true
    else throw error
  } finally {
    await releaseLifecycleRecoveryClaim(claimPath, claimOwner)
    if (generationResolved) await cleanupLifecycleRecoveryTombstones(claimPath)
  }
}

async function readSidecar(path: string): Promise<SessionGcSidecar> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    if (hasCode(error, "ENOENT")) return {
      version: SIDECAR_VERSION,
      meta: { fenceSlots: {} },
      resources: {},
    }
    throw error
  }

  return parseLegacySidecar(raw, path)
}

async function writeSidecar(path: string, sidecar: SessionGcSidecar): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, "wx", 0o600)
    // Compact on purpose: machine-read only, and indentation costs ~25% of the
    // bytes and of the serialisation CPU spent under the lock.
    await handle.writeFile(serializeLegacySidecar(sidecar), "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
    await chmod(path, 0o600)
    // Persist the rename itself, not only the temporary file contents. This is
    // the durability boundary before the SDK may create a managed fork.
    await syncDirectoryDurably(dirname(path))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function assertResourceCapacity(
  sidecar: SessionGcSidecar,
  options: SessionLifecycleOptions,
  nextState: "prepared" | "live",
): void {
  const resources = Object.values(sidecar.resources)
  const owned = resources.filter((resource) => resource.state !== "deleted").length
  const maxPending = option(options.maxPending, DEFAULT_MAX_PENDING, "maxPending")
  // One durable mapping can pin its current transcript and direct predecessor.
  // Keep a separate hard ownership ceiling so normal live mappings cannot
  // consume the crash/deletion backlog allowance or deadlock fresh allocation
  // at the much smaller pending limit.
  const defaultMaxOwned = Math.min(
    Number.MAX_SAFE_INTEGER,
    getMaxStoredSessionsLimit() * 2 + maxPending,
  )
  const maxOwned = option(options.maxOwned, defaultMaxOwned, "maxOwned")
  if (owned >= maxOwned) {
    throw new SessionLifecycleBacklogError("session transcript ownership capacity is full")
  }
  if (nextState === "prepared" && pendingResourceCount(sidecar) >= maxPending) {
    throw new SessionLifecycleBacklogError("session transcript ownership backlog is full")
  }
}

/** Pinned resource keys, each with the lifecycle generations its pins name. */
type PinIndex = ReadonlyMap<string, ReadonlySet<string | undefined>>

/**
 * Canonicalise and hash every pin once. Matching resources against the raw pin
 * list rehashed each pin for each resource: with ~1,400 resources and ~800 pins
 * that is over a million SHA-256 digests, which kept every sweep inside the
 * lifecycle lock for more than a second and starved all other requests.
 */
function indexPins(pins: readonly TranscriptLocator[]): PinIndex {
  const realpaths = new Map<string, string>()
  const index = new Map<string, Set<string | undefined>>()
  for (const pin of pins) {
    const canonical = canonicalizeLocator(pin, realpaths)
    const key = getTranscriptResourceKey(canonical)
    let generations = index.get(key)
    if (!generations) index.set(key, generations = new Set())
    generations.add(canonical.lifecycleGeneration)
  }
  return index
}

function resourceIsPinned(resource: TranscriptResource, pins: PinIndex): boolean {
  const generations = pins.get(resource.key)
  return generations !== undefined
    // Legacy mappings conservatively pin the physical locator until their
    // first exact-CAS lifecycle attachment stores a generation.
    && (generations.has(undefined) || generations.has(resource.generation))
}

function hasActiveTranscriptLease(resource: TranscriptResource): boolean {
  return resource.activeLeases !== undefined && Object.keys(resource.activeLeases).length > 0
}

function releasePublicationLease(resource: TranscriptResource): boolean {
  if (!resource.activeLeases) return false
  let changed = false
  for (const [token, lease] of Object.entries(resource.activeLeases)) {
    if (lease.purpose !== "publication") continue
    delete resource.activeLeases[token]
    changed = true
  }
  if (Object.keys(resource.activeLeases).length === 0) delete resource.activeLeases
  return changed
}

function pruneDeadActiveLeases(resource: TranscriptResource, now: number, unarmedLeaseTtlMs: number): boolean {
  if (!resource.activeLeases) return false
  let changed = false
  for (const [token, lease] of Object.entries(resource.activeLeases)) {
    // An executor whose death cannot prove its descendants gone (win32) is
    // still provably gone, with them, once the host has rebooted.
    const executorDead = lease.executor
      ? lease.executorRecoverable === false
        ? processIncarnationPredatesBoot(lease.executor)
        : processIncarnationIsDead(lease.executor)
      : false
    // An unarmed lease cannot have started a physical writer: production opens
    // the SDK gate only after attachActiveTranscriptExecutor commits. The TTL is
    // sized by the turn watchdog, so one that outlives it with its owner still
    // alive can only be a release that failed — collect it by age instead of
    // fencing the conversation until restart. Age is checked first because an
    // owner probe can spawn a process.
    const unarmedLeaseExpired = !lease.executor && now - lease.createdAt > unarmedLeaseTtlMs
    const unarmedOwnerDead = !lease.executor && !unarmedLeaseExpired && processIncarnationIsDead(lease.owner)
    if (!executorDead && !unarmedOwnerDead && !unarmedLeaseExpired) continue
    delete resource.activeLeases[token]
    changed = true
  }
  if (Object.keys(resource.activeLeases).length === 0) delete resource.activeLeases
  return changed
}

function pendingResourceCount(sidecar: SessionGcSidecar): number {
  return Object.values(sidecar.resources).filter((resource) =>
    resource.state === "prepared"
    || resource.state === "retired"
    || resource.state === "deleting"
  ).length
}

/**
 * A request's preallocation outranks transcript cleanup. Passive retirement
 * fills the pending budget up to one free slot, and every in-flight turn holds
 * a prepared slot until it publishes, so a strict budget would refuse
 * concurrent turns whenever deletion lags behind retirement. A retired
 * transcript that no deletion has claimed is merely waiting for cleanup:
 * returning the newest one to live only postpones its deletion until reconcile
 * finds room again, while the oldest keep their place at the head of the
 * deletion queue. Admission is refused only when the whole budget is in-flight
 * preparations and deletions.
 */
function deferRetirementForAdmission(
  sidecar: SessionGcSidecar,
  options: SessionLifecycleOptions,
  now: number,
): void {
  const maximum = option(options.maxPending, DEFAULT_MAX_PENDING, "maxPending")
  let excess = pendingResourceCount(sidecar) - maximum + 1
  if (excess <= 0) return
  const newestRetired = Object.values(sidecar.resources)
    .filter((resource) => resource.state === "retired")
    .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
  for (const resource of newestRetired) {
    if (excess <= 0) return
    resource.state = "live"
    resource.updatedAt = now
    delete resource.nextAttemptAt
    delete resource.lastError
    excess--
  }
}

function assertPendingCapacity(
  sidecar: SessionGcSidecar,
  options: SessionLifecycleOptions,
): void {
  const maximum = option(options.maxPending, DEFAULT_MAX_PENDING, "maxPending")
  if (pendingResourceCount(sidecar) >= maximum) {
    throw new SessionLifecycleBacklogError("session transcript ownership backlog is full")
  }
}

function pruneTombstones(sidecar: SessionGcSidecar, options: SessionLifecycleOptions): void {
  const maximum = option(options.maxTombstones, DEFAULT_MAX_TOMBSTONES, "maxTombstones")
  const tombstones = Object.values(sidecar.resources)
    .filter((resource) => resource.state === "deleted")
    .sort((left, right) => right.updatedAt - left.updatedAt || left.key.localeCompare(right.key))
  for (const resource of tombstones.slice(maximum)) delete sidecar.resources[resource.key]
}

export function canonicalizeTranscriptLocator(locator: TranscriptLocator): TranscriptLocator {
  return { ...canonicalizeLocator(locator, undefined) }
}

function assertSameLocator(left: TranscriptLocator, right: TranscriptLocator): void {
  if (left.sessionId !== right.sessionId
    || left.configDir !== right.configDir
    || left.projectDir !== right.projectDir) {
    throw new SessionLifecycleCorruptError("resource key collision or locator mismatch")
  }
}

/** The SDK's UUID-specific absence verdict — the only wording either the parent
 *  or the deletion child may read as "already gone". ENOENT and generic "not
 *  found" can mean the child or the SDK failed to load, and must be retried. */
function sessionAbsentPhrase(sessionId: string): string {
  return `Session ${sessionId} not found`
}

function isNotFoundError(error: unknown, sessionId: string): boolean {
  if (error instanceof TranscriptAlreadyAbsentError) return true
  return errorMessage(error).includes(sessionAbsentPhrase(sessionId))
}

/** Resolve a real Node runtime even when Meridian itself is bundled under Bun. */
let sessionGcNodeExecutable: string | undefined

export function getSessionGcNodeExecutable(): string {
  if (typeof process.versions.bun !== "string") return process.execPath
  if (sessionGcNodeExecutable) return sessionGcNodeExecutable

  // PATH may select a version-manager shim rather than Node. Volta on Windows
  // loses multiline --eval arguments, and its PID identifies the shim instead
  // of the executor we need to fence. Use a short single-line probe, then spawn
  // the actual Node binary directly. Cache only successful resolutions.
  const probe = spawnSync("node", ["-p", "process.execPath"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 16 * 1024,
    windowsHide: true,
  })
  const executable = probe.stdout?.trim()
  if (probe.error || probe.status !== 0 || !executable || !isAbsolute(executable)) {
    throw new SessionLifecycleError("cannot resolve Node executable for session deletion")
  }
  sessionGcNodeExecutable = realpathSync(executable)
  return sessionGcNodeExecutable
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function nowMs(options: SessionLifecycleOptions): number {
  const value = (options.now ?? Date.now)()
  if (!Number.isFinite(value)) throw new TypeError("now() must return a finite number")
  return value
}

function option(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new TypeError(`${name} must be a positive integer`)
  return resolved
}

function nonNegativeOption(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new TypeError(`${name} must be a non-negative integer`)
  return resolved
}

function retiredGraceMs(options: SessionLifecycleOptions): number {
  return nonNegativeOption(options.retiredGraceMs, DEFAULT_RETIRED_GRACE_MS, "retiredGraceMs")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
