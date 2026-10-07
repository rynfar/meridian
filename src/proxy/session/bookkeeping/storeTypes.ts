import type { StoredSession, TranscriptLocator } from "./types"
import type { TokenUsage } from "../lineage"
import type {
  StoredSessionGeneration, DurablePriorityAssignment, PriorityAssignmentGeneration, DurablePriorityAttempt,
} from "./legacyCodec"

export type SharedSessionLookupResult =
  | { status: "found"; session: StoredSession; generation?: StoredSessionGeneration }
  | { status: "missing"; existing?: StoredSession; generation?: StoredSessionGeneration }
  | { status: "error"; error: Error }

export type PriorityAssignmentLookupResult =
  | { status: "found"; assignment: DurablePriorityAssignment; generation: PriorityAssignmentGeneration;
      attempt?: DurablePriorityAttempt }
  | { status: "missing"; generation: PriorityAssignmentGeneration; attempt?: DurablePriorityAttempt }
  | { status: "error"; error: Error }

export interface PriorityAttemptTurn { turnId: string; issuedAt: number }
export interface PriorityAttemptClaim { ownerToken: string }

export interface SharedSessionPriorityPublication {
  routeKey: string
  profileId: string
  lastHumanTurnDigest: string
  lastHumanTurnIssuedAt: number
  expectedAssignmentGeneration: PriorityAssignmentGeneration
}
export interface SharedSessionAndPriorityAssignmentOptions {
  key: string
  claudeSessionId: string
  messageCount: number
  lineageHash: string
  messageHashes: string[]
  sdkMessageUuids?: Array<string | null>
  contextUsage?: TokenUsage
  messageBlockHashes: string[][]
  passthroughToolCallAssistantUuid?: string | null
  passthroughToolCallIds?: string[] | null
  currentTranscript?: TranscriptLocator
  sourceTranscript?: TranscriptLocator
  expectedMappingGeneration: StoredSessionGeneration
  /** Original routed mapping retained across chained publications for rollback. */
  rollbackMappingKey?: string
  /** Exact pre-SDK durable claim cleared only by this winning publication. */
  attemptOwnerToken?: string
  priority: SharedSessionPriorityPublication
}
export interface SharedSessionAndPriorityAssignmentResult {
  mappingGeneration: StoredSessionGeneration
  assignmentGeneration: PriorityAssignmentGeneration
  previousMapping: StoredSession | null
  previousAssignment: DurablePriorityAssignment | null
}
export interface FinalizeSharedSessionAndPriorityAssignmentOptions {
  key: string
  routeKey: string
  expectedMappingGeneration: StoredSessionGeneration
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  rollbackMappingKey?: string
  attemptOwnerToken?: string
}
export interface RollbackSharedSessionAndPriorityAssignmentOptions {
  key: string
  routeKey: string
  expectedMappingGeneration: StoredSessionGeneration
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  previousMapping: StoredSession | null
  previousAssignment: DurablePriorityAssignment | null
  attemptOwnerToken?: string
}
export interface RollbackSharedSessionAndPriorityAssignmentResult {
  mappingGeneration: StoredSessionGeneration
  assignmentGeneration: PriorityAssignmentGeneration
  restoredMapping: StoredSession | null
  restoredAssignment: DurablePriorityAssignment | null
}
export interface SessionRecoveryInfo {
  claudeSessionId: string
  previousClaudeSessionId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
}
export type StoreSessionArguments = [
  key: string, claudeSessionId: string, messageCount?: number, lineageHash?: string,
  messageHashes?: string[], sdkMessageUuids?: Array<string | null>, contextUsage?: TokenUsage,
  messageBlockHashes?: string[][], passthroughToolCallAssistantUuid?: string | null,
  passthroughToolCallIds?: string[] | null, currentTranscript?: TranscriptLocator,
  sourceTranscript?: TranscriptLocator, expectedGeneration?: StoredSessionGeneration | null,
]
