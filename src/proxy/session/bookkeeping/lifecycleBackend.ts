import type * as Lifecycle from "../../sessionLifecycle"
import { assertBookkeepingIdentityChangeAllowed, assertLegacyStoreAccessAllowed } from "./storeIdentity"

/** Preserve ledger signatures, including generic publication callbacks. Type-only facade dependency. */
export interface SessionLifecycleBackend {
  acquireActiveTranscriptLease: typeof Lifecycle.acquireActiveTranscriptLease
  attachActiveTranscriptExecutor: typeof Lifecycle.attachActiveTranscriptExecutor
  releaseActiveTranscriptLease: typeof Lifecycle.releaseActiveTranscriptLease
  releaseJoinedTranscriptLease: typeof Lifecycle.releaseJoinedTranscriptLease
  prepareFork: typeof Lifecycle.prepareFork
  prepareForkForPublication: typeof Lifecycle.prepareForkForPublication
  ensureTranscriptJournaled: typeof Lifecycle.ensureTranscriptJournaled
  registerLiveTranscript: typeof Lifecycle.registerLiveTranscript
  commitFork: typeof Lifecycle.commitFork
  publishPinnedTranscript: typeof Lifecycle.publishPinnedTranscript
  attachPinnedTranscript: typeof Lifecycle.attachPinnedTranscript
  abandonFork: typeof Lifecycle.abandonFork
  reconcile: typeof Lifecycle.reconcile
  runGc: typeof Lifecycle.runGc
}

export const lifecycleBackendMethods = [
  "acquireActiveTranscriptLease", "attachActiveTranscriptExecutor", "releaseActiveTranscriptLease",
  "releaseJoinedTranscriptLease", "prepareFork", "prepareForkForPublication", "ensureTranscriptJournaled",
  "registerLiveTranscript", "commitFork", "publishPinnedTranscript", "attachPinnedTranscript",
  "abandonFork", "reconcile", "runGc",
] as const satisfies readonly (keyof SessionLifecycleBackend)[]

export class SessionLifecycleOperationUnavailableError extends Error {
  constructor(readonly method: keyof SessionLifecycleBackend) {
    super(`lifecycle ${method}: not available in this backend`)
    this.name = "SessionLifecycleOperationUnavailableError"
  }
}

let selected: SessionLifecycleBackend | undefined
/** Production accepts only the complete lifecycle port, after READY initialization. */
export function installSessionLifecycleBackend(backend: SessionLifecycleBackend | null): void {
  setSessionLifecycleBackendForTest(backend)
}
export function activeLifecycleBackend(): SessionLifecycleBackend | undefined {
  if (!selected) assertLegacyStoreAccessAllowed()
  return selected
}

/** Test-only partial installation requires an exact list of unavailable operations.
 * Missing operations fail closed, never fall through to JSON. */
export function setSessionLifecycleBackendForTest(backend: SessionLifecycleBackend | null): void
export function setSessionLifecycleBackendForTest(
  backend: Partial<SessionLifecycleBackend>, unavailable: readonly (keyof SessionLifecycleBackend)[],
): void
export function setSessionLifecycleBackendForTest(
  backend: Partial<SessionLifecycleBackend> | null,
  unavailable: readonly (keyof SessionLifecycleBackend)[] = [],
): void {
  assertBookkeepingIdentityChangeAllowed()
  if (backend === null) {
    selected = undefined
    return
  }
  const missing = lifecycleBackendMethods.filter((name) => typeof backend[name] !== "function")
  if (new Set(unavailable).size !== unavailable.length || missing.length !== unavailable.length
    || unavailable.some((name) => !missing.includes(name))) {
    throw new TypeError("lifecycle backend requires the exact list of unavailable methods")
  }
  // Copy the validated properties themselves, including prototype methods of an explicit test backend.
  selected = Object.fromEntries(lifecycleBackendMethods.map((name) => [name,
    typeof backend[name] === "function" ? backend[name]
      : () => { throw new SessionLifecycleOperationUnavailableError(name) },
  ])) as unknown as SessionLifecycleBackend
}
