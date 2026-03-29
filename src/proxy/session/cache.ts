/**
 * Session cache management.
 *
 * Manages in-memory LRU caches for session and fingerprint lookups,
 * coordinates with the shared file store for cross-proxy session resume.
 */

import { LRUMap } from "../../utils/lruMap"
import { lookupSharedSession, storeSharedSession, clearSharedSessions, evictSharedSession } from "../sessionStore"
import { getConversationFingerprint } from "./fingerprint"
import {
  computeLineageHash,
  computeMessageHashes,
  verifyLineage,
  type SessionState,
  type LineageResult,
} from "./lineage"

// --- Cache setup ---

const DEFAULT_MAX_SESSIONS = 1000
const IMPLICIT_DEFAULT_PROFILE_ID = "default"

export function getMaxSessionsLimit(): number {
  const raw = process.env.CLAUDE_PROXY_MAX_SESSIONS
  if (!raw) return DEFAULT_MAX_SESSIONS

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[PROXY] Invalid CLAUDE_PROXY_MAX_SESSIONS value "${raw}"; using default ${DEFAULT_MAX_SESSIONS}`)
    return DEFAULT_MAX_SESSIONS
  }

  return parsed
}

function buildScopedKey(key: string, profileId?: string): string {
  if (!profileId || profileId === IMPLICIT_DEFAULT_PROFILE_ID) return key
  return `${profileId}:${key}`
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
 *  Re-reads CLAUDE_PROXY_MAX_SESSIONS so tests can override the limit. */
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
  profileId?: string
): void {
  if (sessionId) {
    const scopedSessionId = buildScopedKey(sessionId, profileId)
    const cached = sessionCache.get(scopedSessionId)
    if (cached) {
      removeFingerprintEntriesByClaudeSessionId(cached.claudeSessionId)
      sessionCache.delete(scopedSessionId)
    }
    try { evictSharedSession(scopedSessionId) } catch {}
  }
  if (messages) {
    const fp = getConversationFingerprint(messages, workingDirectory)
    if (fp) {
      const scopedFingerprint = buildScopedKey(fp, profileId)
      const cached = fingerprintCache.get(scopedFingerprint)
      if (cached) {
        removeSessionEntriesByClaudeSessionId(cached.claudeSessionId)
        fingerprintCache.delete(scopedFingerprint)
      }
      try { evictSharedSession(scopedFingerprint) } catch {}
    }
  }
}

// --- Session operations ---

/** Refresh lastAccess on a verified session so LRU eviction reflects actual usage */
function touchSession(state: SessionState): SessionState {
  state.lastAccess = Date.now()
  return state
}

/** Look up a cached session by header or fingerprint.
 *  Returns a LineageResult that classifies the mutation and includes the
 *  session state needed for the correct SDK action. */
export function lookupSession(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  workingDirectory?: string,
  profileId?: string
): LineageResult {
  if (sessionId) {
    const scopedSessionId = buildScopedKey(sessionId, profileId)
    const cached = sessionCache.get(scopedSessionId)
    if (cached) {
      const result = verifyLineage(cached, messages, scopedSessionId, sessionCache)
      if (result.type === "continuation" || result.type === "compaction") touchSession(result.session)
      return result
    }
    const shared = lookupSharedSession(scopedSessionId)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        profileId: shared.profileId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
      }
      const result = verifyLineage(state, messages, scopedSessionId, sessionCache)
      if (result.type === "continuation" || result.type === "compaction") {
        sessionCache.set(scopedSessionId, state)
      }
      return result
    }
    return { type: "diverged" }
  }

  const fp = getConversationFingerprint(messages, workingDirectory)
  if (fp) {
    const scopedFingerprint = buildScopedKey(fp, profileId)
    const cached = fingerprintCache.get(scopedFingerprint)
    if (cached) {
      const result = verifyLineage(cached, messages, scopedFingerprint, fingerprintCache)
      if (result.type === "continuation" || result.type === "compaction") touchSession(result.session)
      return result
    }
    const shared = lookupSharedSession(scopedFingerprint)
    if (shared) {
      const state: SessionState = {
        claudeSessionId: shared.claudeSessionId,
        profileId: shared.profileId,
        lastAccess: Date.now(),
        messageCount: shared.messageCount || 0,
        lineageHash: shared.lineageHash || "",
        messageHashes: shared.messageHashes,
        sdkMessageUuids: shared.sdkMessageUuids,
      }
      const result = verifyLineage(state, messages, scopedFingerprint, fingerprintCache)
      if (result.type === "continuation" || result.type === "compaction") {
        fingerprintCache.set(scopedFingerprint, state)
      }
      return result
    }
  }
  return { type: "diverged" }
}

/** Store a session mapping with lineage hash and SDK UUIDs for divergence detection.
 *  @param sdkMessageUuids — per-message SDK assistant UUIDs (null for user messages).
 *    If provided, merged with any previously stored UUIDs to build a complete map. */
export function storeSession(
  sessionId: string | undefined,
  messages: Array<{ role: string; content: any }>,
  claudeSessionId: string,
  workingDirectory?: string,
  sdkMessageUuids?: Array<string | null>,
  profileId?: string,
  effectiveProfileId?: string
) {
  if (!claudeSessionId) return
  const lineageHash = computeLineageHash(messages)
  const messageHashes = computeMessageHashes(messages)
  const state: SessionState = {
    claudeSessionId,
    profileId: effectiveProfileId,
    lastAccess: Date.now(),
    messageCount: messages?.length || 0,
    lineageHash,
    messageHashes,
    sdkMessageUuids,
  }
  // In-memory cache
  if (sessionId) sessionCache.set(buildScopedKey(sessionId, profileId), state)
  const fp = getConversationFingerprint(messages, workingDirectory)
  if (fp) fingerprintCache.set(buildScopedKey(fp, profileId), state)
  // Shared file store (cross-proxy resume)
  const key = sessionId || fp
  if (key) {
    storeSharedSession(
      buildScopedKey(key, profileId),
      claudeSessionId,
      state.messageCount,
      lineageHash,
      messageHashes,
      sdkMessageUuids,
      effectiveProfileId,
    )
  }
}
