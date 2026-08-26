import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
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
import { getMaxStoredSessionsLimit, getSessionStoreDir } from "./sessionStore"
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
  type ProcessIncarnation,
} from "./session/processIncarnation"

const SIDECAR_VERSION = 2
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
const DEFAULT_RETRY_BASE_MS = 5_000
const DEFAULT_RETRY_MAX_MS = 60 * 60_000
const DEFAULT_DELETE_TIMEOUT_MS = 30_000

export interface TranscriptLocator {
  sessionId: string
  /** The absolute CLAUDE_CONFIG_DIR which owns this transcript. */
  configDir: string
  /** SDK project directory, passed as deleteSession(..., { dir }). */
  projectDir?: string
  /** Opaque physical-ownership fence. Omitted only on legacy store locators. */
  lifecycleGeneration?: string
}

export type TranscriptResourceState = "prepared" | "live" | "retired" | "deleting" | "deleted"

interface ActiveTranscriptLeaseRecord {
  token: string
  owner: ProcessIncarnation
  executor?: ProcessIncarnation
  executorRecoverable?: boolean
  createdAt: number
}

interface TranscriptResource {
  key: string
  generation: string
  locator: TranscriptLocator
  state: TranscriptResourceState
  createdAt: number
  updatedAt: number
  attempts: number
  nextAttemptAt?: number
  lastError?: string
  deletionToken?: string
  deletionOwner?: ProcessIncarnation
  deletionExecutor?: ProcessIncarnation
  deletionProcessGroupId?: number
  activeLeases?: Record<string, ActiveTranscriptLeaseRecord>
}

interface SessionGcSidecar {
  version: typeof SIDECAR_VERSION
  meta: { fenceSlots: Record<string, number> }
  resources: Record<string, TranscriptResource>
}

export type SessionDeleter = (locator: TranscriptLocator) => Promise<void>

export interface SessionLifecycleOptions {
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
  retryBaseMs?: number
  retryMaxMs?: number
  deletionTimeoutMs?: number
  /** Refresh durable mapping pins before each destructive claim. */
  pinProvider?: () => readonly TranscriptLocator[]
  /** Bound one complete sweep, including all child deletions. */
  runTimeoutMs?: number
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

export class SessionLifecycleError extends Error {}
export class SessionLifecycleLockError extends SessionLifecycleError {}
export class SessionLifecycleCorruptError extends SessionLifecycleError {}
export class SessionLifecycleBacklogError extends SessionLifecycleError {}

/** Stable ownership key. The separator prevents ambiguous concatenation. */
export function getTranscriptResourceKey(locator: TranscriptLocator): string {
  validateLocator(locator)
  return createHash("sha256")
    .update(locator.configDir)
    .update("\0")
    .update(locator.sessionId)
    .digest("hex")
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
  const normalized = [...new Map(
    locators.map(canonicalizeTranscriptLocator).map((locator) => [getTranscriptResourceKey(locator), locator]),
  ).entries()]
  if (normalized.length === 0) throw new TypeError("active transcript lease requires at least one locator")
  const owner = captureProcessIncarnation()
  if (!owner) throw new SessionLifecycleError("cannot capture active transcript owner incarnation")
  const token = randomUUID()
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    for (const [key, locator] of normalized) {
      const resource = sidecar.resources[key]
      if (!resource) throw new SessionLifecycleError(`cannot lease unjournaled transcript ${key}`)
      assertSameLocator(resource.locator, locator)
      assertExactLifecycleGeneration(resource, locator)
      pruneDeadActiveLeases(resource)
      if (hasActiveTranscriptLease(resource)) {
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
  const parsedExecutor = parseProcessIncarnation(executor)
  if (!parsedExecutor) throw new TypeError("invalid active transcript executor incarnation")
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    for (const key of lease.resourceKeys) {
      const record = sidecar.resources[key]?.activeLeases?.[lease.token]
      if (!record) throw new SessionLifecycleError(`active transcript lease ${lease.token} was lost`)
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

/** Persist ownership before the SDK process which can create the transcript starts. */
export async function prepareFork(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<TranscriptLocator> {
  const normalized = canonicalizeTranscriptLocator(locator)
  const key = getTranscriptResourceKey(normalized)
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const existing = sidecar.resources[key]
    if (existing) {
      assertSameLocator(existing.locator, normalized)
      assertExactLifecycleGeneration(existing, normalized)
      if (existing.state === "deleted") {
        throw new SessionLifecycleError(`transcript resource ${key} is already deleted`)
      }
      Object.assign(locator, exactLocator(existing))
      return exactLocator(existing)
    }
    assertResourceCapacity(sidecar, options, "prepared")
    const now = nowMs(options)
    const resource: TranscriptResource = {
      key,
      generation: allocateLifecycleGeneration(sidecar, key),
      locator: physicalLocator(normalized),
      state: "prepared",
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

/** Ensure a legacy/direct-resume locator is journaled without promoting a prepared target. */
export async function ensureTranscriptJournaled(
  locator: TranscriptLocator,
  options: SessionLifecycleOptions = {},
): Promise<TranscriptLocator> {
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
    if (resource.state === "prepared" || resource.state === "live") {
      if (resource.state === "live") assertPendingCapacity(sidecar, options)
      resource.state = "retired"
      resource.updatedAt = nowMs(options)
      resource.nextAttemptAt = resource.updatedAt + retiredGraceMs(options)
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
  // Validate caller pins before waiting for the lock. The authoritative pin
  // provider is refreshed again while the lifecycle lock is held.
  pins.map(canonicalizeTranscriptLocator)
  return withSidecarLock(options, async (paths) => {
    const effectivePins = (options.pinProvider?.() ?? pins).map(canonicalizeTranscriptLocator)
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
    for (const resource of Object.values(sidecar.resources)) {
      if (pruneDeadActiveLeases(resource)) changed = true
    }
    let pending = pendingResourceCount(sidecar)
    const maxPending = option(options.maxPending, DEFAULT_MAX_PENDING, "maxPending")

    // A deletion claim is recoverable only after the exact persisted executor
    // is provably dead. Before the executor handshake, authoritative death of
    // the claiming proxy is enough because the gated child cannot start the
    // physical SDK deletion without that handshake.
    for (const resource of Object.values(sidecar.resources)) {
      if (resource.state !== "deleting") continue
      const executorDead = resource.deletionExecutor
        && resource.deletionProcessGroupId !== undefined
        ? processIncarnationIsDead(resource.deletionExecutor)
          && processGroupIsEmpty(resource.deletionProcessGroupId)
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
      } else if (resource.state === "live" && pending < maxPending) {
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
  })
}

/** Delete a bounded batch of unpinned retired transcripts through the supported SDK API. */
export async function runGc(
  pins: readonly TranscriptLocator[],
  options: SessionLifecycleOptions = {},
): Promise<GcResult> {
  await reconcile(pins, options)
  let currentPins = pins.map(canonicalizeTranscriptLocator)
  if (!options.deleter && process.platform === "win32") {
    return {
      deleted: 0,
      notFound: 0,
      failed: 0,
      deferred: await countDeferred(currentPins, options),
    }
  }
  const limit = option(options.maxDeletesPerRun, DEFAULT_MAX_DELETES, "maxDeletesPerRun")
  const result: GcResult = { deleted: 0, notFound: 0, failed: 0, deferred: 0 }
  const runTimeoutMs = option(options.runTimeoutMs, DEFAULT_DELETE_TIMEOUT_MS, "runTimeoutMs")
  const deadline = Date.now() + runTimeoutMs

  for (let index = 0; index < limit; index++) {
    if (Date.now() >= deadline) break
    const refreshedPins = options.pinProvider?.()
    if (refreshedPins) {
      currentPins = refreshedPins.map(canonicalizeTranscriptLocator)
    }
    const candidate = await claimDeletion(currentPins, options)
    if (!candidate) break

    let failure: unknown
    let notFound = false
    let deletionStillRunning = false
    try {
      const remainingMs = Math.max(1, deadline - Date.now())
      const deletionTimeout = Math.min(
        option(options.deletionTimeoutMs, DEFAULT_DELETE_TIMEOUT_MS, "deletionTimeoutMs"),
        remainingMs,
      )
      if (options.deleter) {
        await awaitCustomDeleter(options.deleter(candidate.locator), deletionTimeout)
      } else {
        await deleteWithSdkChild(
          candidate.locator,
          candidate.deletionToken!,
          deletionTimeout,
          (executor, processGroupId) => attachDeletionExecutor(
            candidate.key,
            candidate.deletionToken!,
            executor,
            processGroupId,
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
  pins: readonly TranscriptLocator[],
  options: SessionLifecycleOptions,
): Promise<TranscriptResource | undefined> {
  return withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
    const finalPins = (options.pinProvider?.() ?? pins).map(canonicalizeTranscriptLocator)
    const now = nowMs(options)
    let leasesChanged = false
    for (const resource of Object.values(sidecar.resources)) {
      if (pruneDeadActiveLeases(resource)) leasesChanged = true
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
  options: SessionLifecycleOptions,
): Promise<void> {
  await withSidecarLock(options, async (paths) => {
    const sidecar = await readSidecar(paths.sidecar)
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
  pins: readonly TranscriptLocator[],
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
  if (process.platform === "win32") return false
  try {
    process.kill(-processGroupId, 0)
    return false
  } catch (error) {
    return hasCode(error, "ESRCH")
  }
}

function signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") return
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
  attachExecutor: (executor: ProcessIncarnation, processGroupId: number) => Promise<void>,
  options: SessionLifecycleOptions,
): Promise<void> {
  const sdkUrl = import.meta.resolve("@anthropic-ai/claude-agent-sdk")
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
const options = process.env.MERIDIAN_GC_PROJECT_DIR
  ? { dir: process.env.MERIDIAN_GC_PROJECT_DIR }
  : undefined;
try {
  await sdk.deleteSession(process.env.MERIDIAN_GC_SESSION_ID, options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!options || !message.includes("not found")) throw error;
  await sdk.deleteSession(process.env.MERIDIAN_GC_SESSION_ID);
}
`
  const child = spawn(getSessionGcNodeExecutable(), ["--input-type=module", "--eval", script], {
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: locator.configDir,
      MERIDIAN_GC_SDK_URL: sdkUrl,
      MERIDIAN_GC_SESSION_ID: locator.sessionId,
      MERIDIAN_GC_PROJECT_DIR: locator.projectDir ?? "",
      MERIDIAN_GC_GATE_PATH: gatePath,
      MERIDIAN_GC_GATE_TIMEOUT_MS: String(timeoutMs),
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
  try {
    if (!processGroupId) throw new Error("session deletion child has no PID")
    const executor = captureProcessIncarnation(processGroupId)
    if (!executor) throw new Error("cannot capture session deletion executor incarnation")
    if (process.platform === "win32") {
      throw new SessionLifecycleError("fenced session deletion is unavailable on win32")
    }
    await attachExecutor(executor, processGroupId)
    const gateHandle = await open(gatePath, "wx", 0o600)
    try {
      await gateHandle.writeFile("go\n", "utf8")
      await gateHandle.sync()
    } finally {
      await gateHandle.close()
    }

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        signalProcessGroup(processGroupId, "SIGKILL")
        reject(new Error("session deletion process group timed out and was killed"))
      }, timeoutMs)
      timer.unref?.()
    })
    const status = await Promise.race([exited, timeout])
    joined = await waitForProcessGroupEmpty(processGroupId, joinTimeoutMs)
    if (!joined) {
      throw new DeletionStillRunningError("session deletion process group remains active")
    }
    if (status.code !== 0) {
      throw new Error(`session deletion child exited ${status.code ?? status.signal}: ${output.slice(-4_000)}`)
    }
  } finally {
    if (timer) clearTimeout(timer)
    if (!joined && processGroupId) {
      signalProcessGroup(processGroupId, "SIGKILL")
      const [leaderExited, groupEmpty] = await Promise.all([
        waitForDeletionExit(exited, joinTimeoutMs),
        waitForProcessGroupEmpty(processGroupId, joinTimeoutMs),
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

function getStoreDir(options: SessionLifecycleOptions): string {
  if (options.storeDir) return options.storeDir
  return getSessionStoreDir()
}

interface SidecarPaths {
  sidecar: string
  lock: string
}

async function publishInitializedSidecarLock(path: string, contents: string): Promise<boolean> {
  const staging = `${path}.candidate-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(staging, "wx", 0o600)
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(staging, path)
      return true
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false
      throw error
    }
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(staging).catch((error) => {
      if (!hasCode(error, "ENOENT")) {
        console.error("[sessionLifecycle] lock staging cleanup failed:", errorMessage(error))
      }
    })
  }
}

async function withSidecarLock<T>(
  options: SessionLifecycleOptions,
  operation: (paths: SidecarPaths) => Promise<T>,
): Promise<T> {
  const dir = getStoreDir(options)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
  const paths = { sidecar: join(dir, SIDECAR_NAME), lock: join(dir, `${SIDECAR_NAME}.lock`) }
  const incarnation = captureProcessIncarnation()
  if (!incarnation) throw new SessionLifecycleLockError("cannot capture lock owner process incarnation")
  const token = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), incarnation })
  const deadline = Date.now() + nonNegativeOption(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS, "lockWaitMs")
  const retryMs = option(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS, "lockRetryMs")
  const staleMs = option(options.lockStaleMs, DEFAULT_LOCK_STALE_MS, "lockStaleMs")
  let acquired = false

  while (!acquired) {
    acquired = await publishInitializedSidecarLock(paths.lock, `${token}
${Date.now()}
`)
    if (acquired) break
    await recoverStaleLock(paths.lock, staleMs)
    if (Date.now() >= deadline) {
      throw new SessionLifecycleLockError(`timed out waiting for ${paths.lock}`)
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())))
  }

  try {
    return await operation(paths)
  } finally {
    // Only the owner may release. A stale-lock recovery must not unlink a successor.
    try {
      const contents = await readFile(paths.lock, "utf8")
      if (contents.startsWith(`${token}\n`)) await unlink(paths.lock)
    } catch (error) {
      if (!hasCode(error, "ENOENT")) {
        console.error("[sessionLifecycle] lock release failed:", errorMessage(error))
      }
    }
  }
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
    const owner = JSON.parse(token) as Record<string, unknown>
    if (
      typeof owner.pid !== "number"
      || !Number.isInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.hostname !== "string"
      || owner.hostname.length === 0
      || typeof owner.token !== "string"
      || owner.token.length === 0
      || !parseProcessIncarnation(owner.incarnation)
    ) return undefined
    return owner as unknown as CanonicalLifecycleLockOwner
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
    const candidateDirectoryHandle = await open(candidate, "r")
    try {
      await candidateDirectoryHandle.sync()
    } finally {
      await candidateDirectoryHandle.close()
    }

    try {
      await lstat(claimPath)
      return false
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error
    }
    try {
      await rename(candidate, claimPath)
      published = true
      const parentDirectoryHandle = await open(dirname(claimPath), "r")
      try {
        await parentDirectoryHandle.sync()
      } finally {
        await parentDirectoryHandle.close()
      }
      return true
    } catch (error) {
      if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].some((code) => hasCode(error, code))) {
        return false
      }
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
    if (["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"].some((code) => hasCode(error, code))) {
      return false
    }
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

  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new SessionLifecycleCorruptError(`cannot parse ${path}: ${errorMessage(error)}`)
  }
  const upgraded = upgradeLegacySidecar(value)
  if (!isValidSidecar(upgraded)) {
    throw new SessionLifecycleCorruptError(`invalid or unsupported ${path}`)
  }
  return upgraded
}

async function writeSidecar(path: string, sidecar: SessionGcSidecar): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temp, "wx", 0o600)
    await handle.writeFile(`${JSON.stringify(sidecar, null, 2)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temp, path)
    await chmod(path, 0o600)
    // Persist the rename itself, not only the temporary file contents. This is
    // the durability boundary before the SDK may create a managed fork.
    const directoryHandle = await open(dirname(path), "r")
    try {
      await directoryHandle.sync()
    } finally {
      await directoryHandle.close()
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

function isValidActiveLeases(value: unknown): value is Record<string, ActiveTranscriptLeaseRecord> {
  if (!isRecord(value)) return false
  return Object.entries(value).every(([token, lease]) =>
    token.length > 0
    && isRecord(lease)
    && lease.token === token
    && parseProcessIncarnation(lease.owner) !== undefined
    && (lease.executor === undefined || parseProcessIncarnation(lease.executor) !== undefined)
    && (lease.executorRecoverable === undefined || typeof lease.executorRecoverable === "boolean")
    && (lease.executorRecoverable === undefined || lease.executor !== undefined)
    && isFiniteNumber(lease.createdAt)
  )
}

function fenceSlotForKey(key: string): string {
  return key.slice(0, 4)
}

function allocateLifecycleGeneration(sidecar: SessionGcSidecar, key: string): string {
  const slot = fenceSlotForKey(key)
  const current = sidecar.meta.fenceSlots[slot] ?? 0
  if (!Number.isSafeInteger(current) || current < 0 || current === Number.MAX_SAFE_INTEGER) {
    throw new SessionLifecycleCorruptError(`lifecycle fence slot ${slot} is exhausted or corrupt`)
  }
  const next = current + 1
  sidecar.meta.fenceSlots[slot] = next
  return `r:${key}:${next}`
}

function lifecycleGenerationIsValid(value: unknown, key: string): value is string {
  if (typeof value !== "string") return false
  const prefix = `r:${key}:`
  if (!value.startsWith(prefix)) return false
  const counter = Number(value.slice(prefix.length))
  return Number.isSafeInteger(counter) && counter > 0
}

function upgradeLegacySidecar(value: unknown): unknown {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.resources)) return value
  const upgraded: SessionGcSidecar = {
    version: SIDECAR_VERSION,
    meta: { fenceSlots: {} },
    resources: {},
  }
  for (const [key, raw] of Object.entries(value.resources)) {
    if (!isRecord(raw)) return value
    const generation = allocateLifecycleGeneration(upgraded, key)
    upgraded.resources[key] = {
      ...(raw as unknown as TranscriptResource),
      key,
      generation,
    }
  }
  return upgraded
}

function isValidSidecar(value: unknown): value is SessionGcSidecar {
  if (!isRecord(value) || value.version !== SIDECAR_VERSION
    || !isRecord(value.meta) || !isRecord(value.meta.fenceSlots)
    || !isRecord(value.resources)) return false
  const meta = value.meta as { fenceSlots: Record<string, unknown> }
  if (!Object.entries(meta.fenceSlots).every(([slot, counter]) =>
    /^[a-f0-9]{4}$/.test(slot)
    && typeof counter === "number"
    && Number.isSafeInteger(counter)
    && counter > 0)) return false
  return Object.entries(value.resources).every(([key, resource]) => {
    if (!/^[a-f0-9]{64}$/.test(key) || !isRecord(resource)) return false
    if (resource.key !== key || !isValidLocator(resource.locator)) return false
    if (!lifecycleGenerationIsValid(resource.generation, key)) return false
    if (Number(meta.fenceSlots[fenceSlotForKey(key)] ?? 0)
      < Number(resource.generation.slice(`r:${key}:`.length))) return false
    if (getTranscriptResourceKey(resource.locator) !== key) return false
    if (!isState(resource.state)) return false
    if (!isFiniteNumber(resource.createdAt) || !isFiniteNumber(resource.updatedAt)) return false
    if (typeof resource.attempts !== "number"
      || !Number.isSafeInteger(resource.attempts)
      || resource.attempts < 0) return false
    if (resource.nextAttemptAt !== undefined && !isFiniteNumber(resource.nextAttemptAt)) return false
    if (resource.lastError !== undefined && typeof resource.lastError !== "string") return false
    if (resource.deletionToken !== undefined && typeof resource.deletionToken !== "string") return false
    if (resource.deletionOwner !== undefined && !parseProcessIncarnation(resource.deletionOwner)) return false
    if (resource.deletionExecutor !== undefined && !parseProcessIncarnation(resource.deletionExecutor)) return false
    if (resource.deletionProcessGroupId !== undefined && (
      typeof resource.deletionProcessGroupId !== "number"
      || !Number.isSafeInteger(resource.deletionProcessGroupId)
      || resource.deletionProcessGroupId <= 0
    )) return false
    // Legacy deleting entries without exact owners/group identity remain permanently fenced.
    if (resource.state !== "deleting" && (
      resource.deletionToken !== undefined
      || resource.deletionOwner !== undefined
      || resource.deletionExecutor !== undefined
      || resource.deletionProcessGroupId !== undefined
    )) return false
    if (resource.deletionExecutor !== undefined && resource.deletionOwner === undefined) return false
    if (resource.deletionProcessGroupId !== undefined && resource.deletionExecutor === undefined) return false
    if (resource.activeLeases !== undefined && !isValidActiveLeases(resource.activeLeases)) return false
    return true
  })
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

function resourceIsPinned(
  resource: TranscriptResource,
  pins: readonly TranscriptLocator[],
): boolean {
  return pins.some((pin) =>
    getTranscriptResourceKey(pin) === resource.key
    // Legacy mappings conservatively pin the physical locator until their
    // first exact-CAS lifecycle attachment stores a generation.
    && (pin.lifecycleGeneration === undefined || pin.lifecycleGeneration === resource.generation))
}

function hasActiveTranscriptLease(resource: TranscriptResource): boolean {
  return resource.activeLeases !== undefined && Object.keys(resource.activeLeases).length > 0
}

function pruneDeadActiveLeases(resource: TranscriptResource): boolean {
  if (!resource.activeLeases) return false
  let changed = false
  for (const [token, lease] of Object.entries(resource.activeLeases)) {
    const executorDead = lease.executor && lease.executorRecoverable !== false
      ? processIncarnationIsDead(lease.executor)
      : false
    // An unarmed lease cannot have started a physical writer: production opens
    // the SDK gate only after attachActiveTranscriptExecutor commits.
    const unarmedOwnerDead = !lease.executor && processIncarnationIsDead(lease.owner)
    if (!executorDead && !unarmedOwnerDead) continue
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

function canonicalLocatorPath(path: string): string {
  const lexical = resolve(path)
  try {
    return realpathSync.native(lexical)
  } catch (error) {
    if (hasCode(error, "ENOENT")) return lexical
    throw error
  }
}

export function canonicalizeTranscriptLocator(locator: TranscriptLocator): TranscriptLocator {
  validateLocator(locator)
  return {
    sessionId: locator.sessionId,
    configDir: canonicalLocatorPath(locator.configDir),
    ...(locator.projectDir ? { projectDir: canonicalLocatorPath(locator.projectDir) } : {}),
    ...(locator.lifecycleGeneration ? { lifecycleGeneration: locator.lifecycleGeneration } : {}),
  }
}

function validateLocator(locator: TranscriptLocator): void {
  if (!locator || typeof locator.sessionId !== "string" || locator.sessionId.length === 0) {
    throw new TypeError("sessionId must be a non-empty string")
  }
  if (typeof locator.configDir !== "string" || !isAbsolute(locator.configDir)) {
    throw new TypeError("configDir must be an absolute path")
  }
  if (locator.projectDir !== undefined
    && (typeof locator.projectDir !== "string" || !isAbsolute(locator.projectDir))) {
    throw new TypeError("projectDir must be an absolute path when provided")
  }
  if (locator.lifecycleGeneration !== undefined
    && (typeof locator.lifecycleGeneration !== "string" || locator.lifecycleGeneration.length === 0)) {
    throw new TypeError("lifecycleGeneration must be a non-empty string when provided")
  }
}

function isValidLocator(value: unknown): value is TranscriptLocator {
  if (!isRecord(value)) return false
  try {
    validateLocator(value as unknown as TranscriptLocator)
    return Object.keys(value).every((key) =>
      key === "sessionId" || key === "configDir" || key === "projectDir" || key === "lifecycleGeneration")
  } catch {
    return false
  }
}

function assertSameLocator(left: TranscriptLocator, right: TranscriptLocator): void {
  if (left.sessionId !== right.sessionId
    || left.configDir !== right.configDir
    || left.projectDir !== right.projectDir) {
    throw new SessionLifecycleCorruptError("resource key collision or locator mismatch")
  }
}

function isState(value: unknown): value is TranscriptResourceState {
  return value === "prepared" || value === "live" || value === "retired"
    || value === "deleting" || value === "deleted"
}

function isNotFoundError(error: unknown, sessionId: string): boolean {
  // Match the SDK's UUID-specific response only. ENOENT and generic "not found"
  // errors can mean the child or SDK failed to load and must be retried.
  return errorMessage(error).includes(`Session ${sessionId} not found`)
}

/** Resolve a real Node runtime even when Meridian itself is bundled under Bun. */
export function getSessionGcNodeExecutable(): string {
  return typeof process.versions.bun === "string" ? "node" : process.execPath
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
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
