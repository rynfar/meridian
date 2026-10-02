import type { ProcessIncarnation } from "../processIncarnation"
import type { TokenUsage } from "../lineage"

import type { TranscriptLocator, CanonicalTranscriptLocator } from "./locator"
export type { TranscriptLocator, CanonicalTranscriptLocator } from "./locator"

export type TranscriptResourceState = "prepared" | "live" | "retired" | "deleting" | "deleted"

export interface TranscriptResource {
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
  rowVersion?: number
  activeLeases?: Record<string, ActiveTranscriptLeaseRecord>
}

export interface BookkeepingResource extends TranscriptResource {
  locator: CanonicalTranscriptLocator
  rowVersion: number
}

export interface ActiveTranscriptLeaseRecord {
  token: string
  owner: ProcessIncarnation
  purpose?: "publication"
  executor?: ProcessIncarnation
  executorRecoverable?: boolean
  createdAt: number
}

export interface StoredSession {
  claudeSessionId: string
  /** Monotonic per-entry revision retained for diagnostics and upgrades. */
  revision?: number
  /** Unique publication token. Replaced on every durable mapping mutation. */
  generationId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
  /** Hash of messages[0..messageCount-1] for conversation lineage verification. */
  lineageHash?: string
  /** Per-message content hashes for precise diff-based compaction detection. */
  messageHashes?: string[]
  /** Per-message hashes of individual content blocks for append-only tool results. */
  messageBlockHashes?: string[][]
  /** Per-message SDK assistant UUIDs for undo rollback (null for user messages). */
  sdkMessageUuids?: Array<string | null>
  /** SDK assistant UUID immediately before synthetic passthrough denials.
   * Continuations resume the same session here, preserving the stable prefix. */
  passthroughToolCallAssistantUuid?: string
  /** Forwarded tool IDs pending at the stored assistant checkpoint. */
  passthroughToolCallIds?: string[]
  /** Last observed token usage for this Claude session. */
  contextUsage?: TokenUsage
  /** Previous Claude session ID preserved when the session mapping is replaced.
   * Enables recovery when a lineage bug abandons the original session. */
  previousClaudeSessionId?: string
  /** Exact transcript location for the current Claude session. */
  currentTranscript?: TranscriptLocator
  /** Transcript location retained when the session mapping is replaced. */
  previousTranscript?: TranscriptLocator
}

export interface BookkeepingWriteOptions {
  /** Errors after durable commit cannot invalidate the returned publication. */
  onHookError?: (errors: readonly unknown[]) => void
  admissionSignal?: AbortSignal
  lockWaitMs?: number
  lockRetryMs?: number
  /** Only an explicit store/publication owner permits nested store writes. */
  scope?: "lifecycle" | "store" | "publication"
}

export type CanonicalStoredSession = Omit<StoredSession, "currentTranscript" | "previousTranscript"> & {
  currentTranscript?: CanonicalTranscriptLocator
  previousTranscript?: CanonicalTranscriptLocator
}

export type SqlValue = string | number | null
export type SqlRow = Record<string, SqlValue>

export interface BookkeepingReader {
  get(sql: string, ...parameters: SqlValue[]): SqlRow | undefined
  all(sql: string, ...parameters: SqlValue[]): SqlRow[]
}

/** The capability expires when the synchronous callback returns. */
export interface BookkeepingTransaction extends BookkeepingReader {
  run(sql: string, ...parameters: SqlValue[]): number
  afterCommit(hook: () => void): void
}
