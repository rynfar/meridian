import type { SessionStoreBackend } from "./storeBackend"
import { lookupSharedSessionResult, lookupSharedSessionByClaudeIdResult } from "./storeMappingsSql"
import { lookupPriorityAssignmentResult } from "./storePrioritySql"
import { readSessionStoreSnapshot, readSessionStoreGenerationSnapshot, readSessionTranscriptPins,
  lookupSessionRecovery, listStoredSessions } from "./storeMaintenanceSql"
import { storeSharedSession } from "./storeWriteSql"
import { claimPriorityAttempt, releasePriorityAttempt, blockPriorityAttempt } from "./storeAttemptsSql"
import { storeSharedSessionAndPriorityAssignment } from "./storePublicationSql"
import { finalizeSharedSessionAndPriorityAssignment, rollbackSharedSessionAndPriorityAssignment } from "./storeSettlementSql"
import { attachSharedTranscriptLocator, evictSharedSession, clearSharedSessions } from "./storeMaintenanceWriteSql"

/** Explicit installation only; importing the JSON facade never activates or loads this backend. */
export const sqliteSessionStoreBackend: SessionStoreBackend = {
  lookupSharedSessionResult, lookupSharedSessionByClaudeIdResult, lookupPriorityAssignmentResult,
  readSessionStoreSnapshot, readSessionStoreGenerationSnapshot, readSessionTranscriptPins,
  lookupSessionRecovery, listStoredSessions, storeSharedSession,
  claimPriorityAttempt, releasePriorityAttempt, blockPriorityAttempt,
  storeSharedSessionAndPriorityAssignment, finalizeSharedSessionAndPriorityAssignment,
  rollbackSharedSessionAndPriorityAssignment, attachSharedTranscriptLocator, evictSharedSession, clearSharedSessions,
}
