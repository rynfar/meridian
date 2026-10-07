import type { StoredSession, TranscriptLocator } from "./types"
import type { StoredSessionGeneration, PriorityAssignmentGeneration } from "./legacyCodec"
import type {
  SharedSessionLookupResult, PriorityAssignmentLookupResult, PriorityAttemptTurn, PriorityAttemptClaim,
  SharedSessionAndPriorityAssignmentOptions, SharedSessionAndPriorityAssignmentResult,
  FinalizeSharedSessionAndPriorityAssignmentOptions, RollbackSharedSessionAndPriorityAssignmentOptions,
  RollbackSharedSessionAndPriorityAssignmentResult, SessionRecoveryInfo, StoreSessionArguments,
} from "./storeTypes"
import { assertBookkeepingIdentityChangeAllowed, assertLegacyStoreAccessAllowed } from "./storeIdentity"

/** Complete contract: a partial SQL implementation cannot be installed as a backend. */
export interface SessionStoreBackend {
  readSessionStoreSnapshot(directory: string): Record<string, StoredSession>
  readSessionStoreGenerationSnapshot(directory: string, adapter: string, profiles: readonly string[]):
    Record<string, StoredSessionGeneration>
  readSessionTranscriptPins(directory: string): TranscriptLocator[]
  lookupSharedSessionResult(directory: string, key: string): SharedSessionLookupResult
  lookupSharedSessionByClaudeIdResult(directory: string, id: string): SharedSessionLookupResult
  lookupPriorityAssignmentResult(directory: string, route: string): PriorityAssignmentLookupResult
  storeSharedSession(directory: string, ...args: StoreSessionArguments): StoredSessionGeneration | false
  claimPriorityAttempt(directory: string, options: {
    routeKey: string; expectedAssignmentGeneration: PriorityAssignmentGeneration; turn?: PriorityAttemptTurn
  }): PriorityAttemptClaim | false
  releasePriorityAttempt(directory: string, route: string, token: string): boolean
  blockPriorityAttempt(directory: string, route: string, token: string): boolean
  storeSharedSessionAndPriorityAssignment(directory: string, options: SharedSessionAndPriorityAssignmentOptions):
    SharedSessionAndPriorityAssignmentResult | false
  finalizeSharedSessionAndPriorityAssignment(directory: string,
    options: FinalizeSharedSessionAndPriorityAssignmentOptions): boolean
  rollbackSharedSessionAndPriorityAssignment(directory: string,
    options: RollbackSharedSessionAndPriorityAssignmentOptions): RollbackSharedSessionAndPriorityAssignmentResult | false
  attachSharedTranscriptLocator(directory: string, key: string, id: string, locator: TranscriptLocator,
    generation?: StoredSessionGeneration): StoredSessionGeneration | false
  evictSharedSession(directory: string, key: string, generation?: StoredSessionGeneration): boolean
  lookupSessionRecovery(directory: string, key: string): SessionRecoveryInfo | undefined
  listStoredSessions(directory: string): Array<SessionRecoveryInfo & { key: string }>
  clearSharedSessions(directory: string): void
}

let selected: SessionStoreBackend | undefined
export function activeStoreBackend(): SessionStoreBackend | undefined {
  if (!selected) assertLegacyStoreAccessAllowed()
  return selected
}

/** Explicit fixture/embedder test seam only. There is deliberately no environment-based activation. */
export function setSessionStoreBackendForTest(backend: SessionStoreBackend | null): void {
  installSessionStoreBackend(backend)
}

/** Production installs the complete backend after READY initialization. */
export function installSessionStoreBackend(backend: SessionStoreBackend | null): void {
  assertBookkeepingIdentityChangeAllowed()
  selected = backend ?? undefined
}
