/**
 * Session cache management.
 *
 * Manages in-memory LRU caches for session and fingerprint lookups,
 * coordinates with the shared file store for cross-proxy session resume.
 */

import { LRUMap } from "../../utils/lruMap"
import { diagnosticLog } from "../../telemetry"
import {
  lookupSharedSession,
  lookupSharedSessionResult,
  lookupSharedSessionByClaudeIdResult,
  storeSharedSession,
  storeSharedSessionAndPriorityAssignment,
  rollbackSharedSessionAndPriorityAssignment,
  clearSharedSessions,
  evictSharedSession,
  type DurablePriorityAssignment,
  type PriorityAssignmentGeneration,
  type StoredSession,
  type StoredSessionGeneration,
} from "../sessionStore"
import { getConversationFingerprint } from "./fingerprint"
import {
  computeLineageHash,
  formatLineageMismatch,
  computeMessageBlockHashes,
  computeMessageHashes,
  verifyLineage,
  type SessionState,
  type TokenUsage,
  type LineageResult,
} from "./lineage"

export interface PrioritySessionPublication {
  readonly routeKey: string
  readonly profileId: string
  readonly lastHumanTurnDigest: string
  expectedAssignmentGeneration: PriorityAssignmentGeneration
  rollback?: {
    readonly key: string
    readonly previousMapping: StoredSession | null
    readonly previousAssignment: DurablePriorityAssignment | null
    publishedMappingGeneration: StoredSessionGeneration
    publishedAssignmentGeneration: PriorityAssignmentGeneration
  }
}

// --- Cache setup ---

const DEFAULT_MAX_SESSIONS = 1000

export function getMaxSessionsLimit(): number {
  const raw = process.env.MERIDIAN_MAX_SESSIONS ?? process.env.CLAUDE_PROXY_MAX_SESSIONS
  if (!raw) return DEFAULT_MAX_SESSIONS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[PROXY] Invalid MERIDIAN_MAX_SESSIONS value "${raw}"; using default ${DEFAULT_MAX_SESSIONS}`)
    return DEFAULT_MAX_SESSIONS
  }

  return parsed
}

function removeFingerprintEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of fingerprintCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      fingerprintCache.delete(key)
    }
  }
}

function removeSessionEntriesByClaudeSessionId(claudeSessionId: string): void {
  for (const [key, state] of sessionCache.entries()) {
    if (state.claudeSessionId === claudeSessionId) {
      sessionCache.delete(key)
    }
  }
}

function createSessionCache(maxSize: number) {
  return new LRUMap<string, SessionState>(maxSize, (_key, evictedState) => {
    removeFingerprintEntriesByClaudeSessionId(evictedState.claudeSessionId)
  })
}

function createFingerprintCache(maxSize: number) {
  return new LRUMap<string, SessionState>(maxSize, (_key, evictedState) => {
    removeSessionEntriesByClaudeSessionId(evictedState.claudeSessionId)
  })
}

// Read limit once at module load — no hot-reload in createProxyServer to avoid
// silently dropping all sessions mid-operation. clearSessionCache() re-reads the
// env var so tests can override the limit.
let activeMaxSessions = getMaxSessionsLimit()
let sessionCache = createSessionCache(activeMaxSessions)
let fingerprintCache = createFingerprintCache(activeMaxSessions)

/** Clear all session caches (used in tests).
 *  Re-reads MERIDIAN_MAX_SESSIONS / CLAUDE_PROXY_MAX_SESSIONS so tests can override the limit. */
export function clearSessionCache() {
  const configuredLimit = getMaxSessionsLimit()
  if (configuredLimit !== activeMaxSessions) {
    activeMaxSessions = configuredLimit
    sessionCache = createSessionCache(activeMaxSessions)
    fingerprintCache = createFingerprintCache(activeMaxSessions)
  } else {
    sessionCache.clear()
    fingerprintCache.clear()
  }
  // Also clear shared file store
  try { clearSharedSessions() } catch {}
}

/** Evict a stale session from all caches and the shared store.
 *  Used when a resume/undo fails because the upstream Claude session is gone. */
export function evictSession(
  sessionId: string | undefined,
  workingDirectory?: string,
  messages?: Array<{ role: string; content: any }>,
  expectedGeneration?: StoredSessionGeneration,
): boolean {
  if (sessionId) {
    const cached = sessionCache.get(sessionId)
    if (cached) {
      removeFingerprintEntriesByClaudeSessionId(cached.claudeSessionId)
      sessionCache.delete(sessionId)
    }
    // Store failures are safety-significant: callers must not release a turn
    // after claiming cleanup succeeded while the durable mapping remains.
    const evicted = evictSharedSession(sessionId, expectedGeneration)
    // Header-keyed and fingerprint-keyed conversations are independent durable
    // keys. Never apply one key's generation token to the other key.
    return evicted
  }
  if (messages) {
    const fp = getConversationFingerprint(messages, workingDirectory)
    if (fp) {
      const cached = fingerprintCache.get(fp)
      if (cached) {
        removeSessionEntriesByClaudeSessionId(cached.claudeSessionId)
        fingerprintCache.delete(fp)
      }
      return evictSharedSession(fp, expectedGeneration)
    }
  }
  return false
}

// --- Session operations ---

/** Refresh lastAccess on a verified session so LRU eviction reflects actual usage */
function touchSession(state: SessionState): SessionState {
  state.lastAccess = Date.now()
  return state
}

function stateFromSharedSession(
  shared: NonNullable<ReturnType<typeof lookupSharedSession>>,
): SessionState {
  return {
    claudeSessionId: shared.claudeSessionId,
    lastAccess: Date.now(),
    messageCount: shared.messageCount || 0,
    lineageHash: shared.lineageHash || "",
    messageHashes: shared.messageHashes,
    messageBlockHashes: shared.messageBlockHashes,
    sdkMessageUuids: shared.sdkMessageUuids,
    passthroughToolCallAssistantUuid: shared.passthroughToolCallAssistantUuid,
    passthroughToolCallIds: shared.passthroughToolCallIds,
    contextUsage: shared.contextUsage,
    currentTranscript: shared.currentTranscript,
    previousTranscript: shared.previousTranscript,
  }
}

/** Revoke a late atomic route+mapping publication and restore pre-request authority. */
export function rollbackPrioritySessionPublication(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: unknown }>,
  workingDirectory: string | undefined,
  publication: PrioritySessionPublication,
): StoredSessionGeneration | false {
  const rollback = publication.rollback
  if (!rollback) return false
  const restored = rollbackSharedSessionAndPriorityAssignment({
    key: rollback.key,
    routeKey: publication.routeKey,
    expectedMappingGeneration: rollback.publishedMappingGeneration,
    expectedAssignmentGeneration: rollback.publishedAssignmentGeneration,
    previousMapping: rollback.previousMapping,
    previousAssignment: rollback.previousAssignment,
  })
  if (!restored) return false

  publication.expectedAssignmentGeneration = restored.assignmentGeneration
  publication.rollback = undefined
  if (sessionId) {
    if (restored.restoredMapping) sessionCache.set(sessionId, stateFromSharedSession(restored.restoredMapping))
    else sessionCache.delete(sessionId)
  } else {
    const fingerprint = getConversationFingerprint(messages, workingDirectory)
    if (fingerprint) {
      if (restored.restoredMapping) fingerprintCache.set(fingerprint, stateFromSharedSession(restored.restoredMapping))
      else fingerprintCache.delete(fingerprint)
    }
  }
  return restored.mappingGeneration
}

function classifyLineage(
  state: SessionState,
  messages: Array<{ role: string; content: any }>,
  cacheKey: string
): LineageResult {
  const result = verifyLineage(state, messages)

  if (result.type === "continuation" && result.resumeContentFrom !== undefined) {
    const msg = `Parallel tool-result continuation (key=${cacheKey.slice(0, 8)}…): resume from message ${result.resumeFrom}, content block ${result.resumeContentFrom}.`
    console.error(`[PROXY] ${msg}`)
    diagnosticLog.lineage(msg)
  } else if (result.type === "compaction") {
    const msg = `Compaction detected (key=${cacheKey.slice(0, 8)}…): suffix overlap ${result.suffixOverlap}/${state.messageCount}, resume from incoming message ${result.resumeFrom}.`
    console.error(`[PROXY] ${msg}`)
    diagnosticLog.lineage(msg)
  } else if (result.type === "undo") {
    const msg = `Undo detected (key=${cacheKey.slice(0, 8)}…): prefix overlap ${result.prefixOverlap}/${state.messageCount}, rollback UUID: ${result.rollbackUuid || "none (legacy session)"}.`
    console.error(`[PROXY] ${msg}`)
    diagnosticLog.lineage(msg)
  } else if (result.type === "diverged" && result.reason === "modified-history") {
    // The overlap count alone is not actionable — name the message that broke,
    // which verifyLineage already worked out to reach this branch.
    const detail = result.mismatch ? formatLineageMismatch(result.mismatch) : undefined
    const msg = `Stale session detected (key=${cacheKey.slice(0, 8)}…): prefix overlap ${result.prefixOverlap || 0}/${state.messageCount}, incoming ${messages.length} msgs. Starting fresh replay.`
      + (detail ? `\n  ${detail}` : "")
    console.error(`[PROXY] ${msg}`)
    diagnosticLog.lineage(msg)
  }

  return result
}

/** Look up a cached session by header or fingerprint.
 *  Returns a LineageResult that classifies the mutation and includes the
 *  session state needed for the correct SDK action. */
export function lookupSession(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  workingDirectory?: string
): LineageResult {
  if (sessionId) {
    // A durable absence is an authoritative eviction. Only an actual store
    // read error may use the local fallback; otherwise another proxy's abort
    // could be resurrected from stale memory.
    const shared = lookupSharedSessionResult(sessionId)
    const cached = sessionCache.get(sessionId)
    const state = shared.status === "found"
      ? stateFromSharedSession(shared.session)
      : shared.status === "error" ? cached : undefined
    if (shared.status === "missing") {
      sessionCache.delete(sessionId)
      if (cached) {
        removeSessionEntriesByClaudeSessionId(cached.claudeSessionId)
        removeFingerprintEntriesByClaudeSessionId(cached.claudeSessionId)
      }
    }
    if (!state) return { type: "diverged", reason: "not-found" }
    const result = classifyLineage(state, messages, sessionId)
    if (result.type === "continuation" || result.type === "compaction") {
      sessionCache.set(sessionId, touchSession(state))
    }
    return result
  }

  const fp = getConversationFingerprint(messages, workingDirectory)
  if (fp) {
    const shared = lookupSharedSessionResult(fp)
    const cached = fingerprintCache.get(fp)
    const state = shared.status === "found"
      ? stateFromSharedSession(shared.session)
      : shared.status === "error" ? cached : undefined
    if (shared.status === "missing") {
      fingerprintCache.delete(fp)
      if (cached) {
        removeSessionEntriesByClaudeSessionId(cached.claudeSessionId)
        removeFingerprintEntriesByClaudeSessionId(cached.claudeSessionId)
      }
    }
    if (!state) return { type: "diverged", reason: "not-found" }
    const result = classifyLineage(state, messages, fp)
    if (result.type === "continuation" || result.type === "compaction") {
      fingerprintCache.set(fp, touchSession(state))
    }
    return result
  }
  return { type: "diverged", reason: "not-found" }
}

/** Look up a session by the Claude SDK session ID returned in responses.
 *  Searches both in-memory caches and the shared file store, returning the
 *  freshest matching state if multiple cache keys point to the same Claude session. */
export function getSessionByClaudeId(claudeSessionId: string): SessionState | undefined {
  const shared = lookupSharedSessionByClaudeIdResult(claudeSessionId)
  if (shared.status === "error") {
    throw new Error(`Shared session store is unavailable: ${shared.error.message}`)
  }
  if (shared.status === "missing") {
    removeSessionEntriesByClaudeSessionId(claudeSessionId)
    removeFingerprintEntriesByClaudeSessionId(claudeSessionId)
    return undefined
  }
  return stateFromSharedSession(shared.session)
}

/** Store a session mapping with lineage hash and SDK UUIDs for divergence detection.
 *  @param sdkMessageUuids — per-message SDK assistant UUIDs (null for user messages).
 *    If provided, merged with any previously stored UUIDs to build a complete map.
 *  @param contextUsage — optional last observed token usage to attach to the session. */
export function storeSession(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: unknown }>,
  claudeSessionId: string,
  workingDirectory?: string,
  sdkMessageUuids?: Array<string | null>,
  contextUsage?: TokenUsage,
  passthroughToolCallAssistantUuid?: string | null,
  passthroughToolCallIds?: string[] | null,
  currentTranscript?: { sessionId: string; configDir: string; projectDir?: string },
  sourceTranscript?: { sessionId: string; configDir: string; projectDir?: string },
  expectedGeneration?: StoredSessionGeneration | null,
  priorityPublication?: PrioritySessionPublication,
): StoredSessionGeneration | false {
  if (!claudeSessionId) return false
  const lineageHash = computeLineageHash(messages)
  const messageHashes = computeMessageHashes(messages)
  const messageBlockHashes = computeMessageBlockHashes(messages)
  const state: SessionState = {
    claudeSessionId,
    lastAccess: Date.now(),
    messageCount: messages?.length || 0,
    lineageHash,
    messageHashes,
    messageBlockHashes,
    sdkMessageUuids,
    ...(passthroughToolCallAssistantUuid ? { passthroughToolCallAssistantUuid } : {}),
    ...(passthroughToolCallIds ? { passthroughToolCallIds } : {}),
    ...(contextUsage ? { contextUsage } : {}),
    ...(currentTranscript ? { currentTranscript } : {}),
    ...(sourceTranscript ? { previousTranscript: sourceTranscript } : {}),
  }
  const fp = getConversationFingerprint(messages, workingDirectory)
  const key = sessionId || fp
  if (!key) return false
  let storedGeneration: StoredSessionGeneration | false
  if (priorityPublication) {
    if (expectedGeneration === undefined || expectedGeneration === null) {
      throw new Error("priority publication requires an exact mapping generation")
    }
    const published = storeSharedSessionAndPriorityAssignment({
      key,
      claudeSessionId,
      messageCount: state.messageCount,
      lineageHash,
      messageHashes,
      sdkMessageUuids,
      contextUsage,
      messageBlockHashes,
      passthroughToolCallAssistantUuid: passthroughToolCallAssistantUuid ?? null,
      passthroughToolCallIds: passthroughToolCallIds ?? null,
      currentTranscript,
      sourceTranscript,
      expectedMappingGeneration: expectedGeneration,
      priority: {
        routeKey: priorityPublication.routeKey,
        profileId: priorityPublication.profileId,
        lastHumanTurnDigest: priorityPublication.lastHumanTurnDigest,
        expectedAssignmentGeneration: priorityPublication.expectedAssignmentGeneration,
      },
    })
    if (!published) return false
    const rollback = priorityPublication.rollback
    if (rollback && rollback.key !== key) {
      throw new Error("priority publication changed mapping keys within one request")
    }
    priorityPublication.rollback = {
      key,
      previousMapping: rollback?.previousMapping ?? published.previousMapping,
      previousAssignment: rollback?.previousAssignment ?? published.previousAssignment,
      publishedMappingGeneration: published.mappingGeneration,
      publishedAssignmentGeneration: published.assignmentGeneration,
    }
    priorityPublication.expectedAssignmentGeneration = published.assignmentGeneration
    storedGeneration = published.mappingGeneration
  } else {
    storedGeneration = storeSharedSession(
      key,
      claudeSessionId,
      state.messageCount,
      lineageHash,
      messageHashes,
      sdkMessageUuids,
      contextUsage,
      messageBlockHashes,
      // undefined would preserve the stored checkpoint; a full store must rewrite it.
      passthroughToolCallAssistantUuid ?? null,
      passthroughToolCallIds ?? null,
      currentTranscript,
      sourceTranscript,
      expectedGeneration,
    )
  }
  if (!storedGeneration) return false

  // Publish to memory only after the durable CAS succeeds.
  if (sessionId) sessionCache.set(sessionId, state)
  if (fp && !sessionId) fingerprintCache.set(fp, state)
  return storedGeneration
}
