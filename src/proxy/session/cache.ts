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
  lookupSharedSessionByClaudeId,
  storeSharedSession,
  clearSharedSessions,
  evictSharedSession,
} from "../sessionStore"
import { getConversationFingerprint } from "./fingerprint"
import {
  computeLineageHash,
  computeMessageBlockHashes,
  computeMessageHashes,
  verifyLineage,
  type SessionState,
  type TokenUsage,
  type LineageResult,
} from "./lineage"

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
  messages?: Array<{ role: string; content: any }>
): void {
  if (sessionId) {
    const cached = sessionCache.get(sessionId)
    if (cached) {
      removeFingerprintEntriesByClaudeSessionId(cached.claudeSessionId)
      sessionCache.delete(sessionId)
    }
    try { evictSharedSession(sessionId) } catch {}
  }
  if (messages) {
    const fp = getConversationFingerprint(messages, workingDirectory)
    if (fp) {
      const cached = fingerprintCache.get(fp)
      if (cached) {
        removeSessionEntriesByClaudeSessionId(cached.claudeSessionId)
        fingerprintCache.delete(fp)
      }
      try { evictSharedSession(fp) } catch {}
    }
  }
}

// --- Session operations ---

/** Refresh lastAccess on a verified session so LRU eviction reflects actual usage */
function touchSession(state: SessionState): SessionState {
  state.lastAccess = Date.now()
  return state
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
    const msg = `Stale session detected (key=${cacheKey.slice(0, 8)}…): prefix overlap ${result.prefixOverlap || 0}/${state.messageCount}, incoming ${messages.length} msgs. Starting fresh replay.`
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
    const cached = sessionCache.get(sessionId)
    if (cached) {
      const result = classifyLineage(cached, messages, sessionId)
      if (result.type === "continuation" || result.type === "compaction") touchSession(result.session)
      return result
    }
    const shared = lookupSharedSession(sessionId)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        messageBlockHashes: shared.messageBlockHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
        passthroughResumeUuid: shared.passthroughResumeUuid,
        contextUsage: shared.contextUsage,
      }
      const result = classifyLineage(state, messages, sessionId)
      if (result.type === "continuation" || result.type === "compaction") {
        sessionCache.set(sessionId, state)
      }
      return result
    }
    return { type: "diverged", reason: "not-found" }
  }

  const fp = getConversationFingerprint(messages, workingDirectory)
  if (fp) {
    const cached = fingerprintCache.get(fp)
    if (cached) {
      const result = classifyLineage(cached, messages, fp)
      if (result.type === "continuation" || result.type === "compaction") touchSession(result.session)
      return result
    }
    const shared = lookupSharedSession(fp)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        messageBlockHashes: shared.messageBlockHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
        passthroughResumeUuid: shared.passthroughResumeUuid,
        contextUsage: shared.contextUsage,
      }
      const result = classifyLineage(state, messages, fp)
      if (result.type === "continuation" || result.type === "compaction") {
        fingerprintCache.set(fp, state)
      }
      return result
    }
  }
  return { type: "diverged", reason: "not-found" }
}

/** Look up a session by the Claude SDK session ID returned in responses.
 *  Searches both in-memory caches and the shared file store, returning the
 *  freshest matching state if multiple cache keys point to the same Claude session. */
export function getSessionByClaudeId(claudeSessionId: string): SessionState | undefined {
  let newest: SessionState | undefined

  const consider = (state: SessionState | undefined) => {
    if (!state || state.claudeSessionId !== claudeSessionId) return
    if (!newest || state.lastAccess > newest.lastAccess) {
      newest = state
    }
  }

  for (const state of sessionCache.values()) consider(state)
  for (const state of fingerprintCache.values()) consider(state)

  const shared = lookupSharedSessionByClaudeId(claudeSessionId)
  if (shared) {
    consider({
      claudeSessionId: shared.claudeSessionId,
      lastAccess: shared.lastUsedAt,
      messageCount: shared.messageCount || 0,
      lineageHash: shared.lineageHash || "",
      messageHashes: shared.messageHashes,
      messageBlockHashes: shared.messageBlockHashes,
      sdkMessageUuids: shared.sdkMessageUuids,
      passthroughResumeUuid: shared.passthroughResumeUuid,
      contextUsage: shared.contextUsage,
    })
  }

  return newest
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
  passthroughResumeUuid?: string | null
) {
  if (!claudeSessionId) return
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
    ...(passthroughResumeUuid ? { passthroughResumeUuid } : {}),
    ...(contextUsage ? { contextUsage } : {}),
  }
  // In-memory cache
  if (sessionId) sessionCache.set(sessionId, state)
  const fp = getConversationFingerprint(messages, workingDirectory)
  // Only populate the fingerprint cache for headerless requests. When a
  // session header is present the session is already tracked by ID; writing
  // to the fingerprint cache too causes cross-session collisions when a
  // later headerless request (e.g. OpenCode category-dispatched or title
  // generation) happens to share the same first-message fingerprint.
  if (fp && !sessionId) fingerprintCache.set(fp, state)
  // Shared file store (cross-proxy resume)
  const key = sessionId || fp
  if (key) {
    storeSharedSession(
      key,
      claudeSessionId,
      state.messageCount,
      lineageHash,
      messageHashes,
      sdkMessageUuids,
      contextUsage,
      messageBlockHashes,
      // undefined would preserve the stored boundary; a full store must rewrite it.
      passthroughResumeUuid ?? null
    )
  }
}
