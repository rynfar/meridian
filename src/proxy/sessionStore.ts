/**
 * File-based session store for cross-proxy session resume.
 *
 * When running per-terminal proxies (each on a different port),
 * sessions need to be shared so you can resume a conversation
 * started in one terminal from another. This stores session
 * mappings in a JSON file that all proxy instances read/write.
 *
 * Format: { [key]: { claudeSessionId, createdAt, lastUsedAt } }
 * Keys are either OpenCode session IDs or conversation fingerprints.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { TokenUsage } from "./session/lineage"

export interface StoredSession {
  claudeSessionId: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
  /** Hash of messages[0..messageCount-1] for conversation lineage verification */
  lineageHash?: string
  /** Per-message content hashes for precise diff-based compaction detection */
  messageHashes?: string[]
  /** Per-message hashes of individual content blocks for append-only tool results */
  messageBlockHashes?: string[][]
  /** Per-message SDK assistant UUIDs for undo rollback (null for user messages) */
  sdkMessageUuids?: Array<string | null>
  /** Uuid of the last persisted passthrough deny — resume boundary after an early stop. */
  passthroughResumeUuid?: string
  /** Last observed token usage for this Claude session */
  contextUsage?: TokenUsage
  /** Previous Claude session ID preserved when the session mapping is replaced.
   *  Enables recovery when a lineage bug (e.g. false compaction) causes the
   *  original session to be abandoned and a new one started. */
  previousClaudeSessionId?: string
}

// No time-based session expiry. SDK sessions persist on Anthropic's side
// for weeks — discarding our mapping just forces a destructive flat-text
// replay on the next request. Storage is bounded by MAX_STORED_SESSIONS.
const DEFAULT_MAX_STORED_SESSIONS = 10_000
const STALE_LOCK_THRESHOLD_MS = 30_000

function getMaxStoredSessions(): number {
  const raw = process.env.MERIDIAN_MAX_STORED_SESSIONS ?? process.env.CLAUDE_PROXY_MAX_STORED_SESSIONS
  if (!raw) return DEFAULT_MAX_STORED_SESSIONS
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_STORED_SESSIONS
  return parsed
}

function acquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, "wx")
    closeSync(fd)
    return true
  } catch (e) {
    const err = e as NodeJS.ErrnoException
    if (err.code !== "EEXIST") {
      console.error("[sessionStore] lock acquire failed:", err.message)
      return false
    }
    try {
      const stat = statSync(lockPath)
      if (Date.now() - stat.mtimeMs > STALE_LOCK_THRESHOLD_MS) {
        // TOCTOU: another process could grab the lock between unlink and open.
        // The second openSync("wx") will throw EEXIST in that case, caught below.
        // This is acceptable — one process wins, the other proceeds without lock.
        unlinkSync(lockPath)
        const fd = openSync(lockPath, "wx")
        closeSync(fd)
        return true
      }
    } catch (staleError) {
      console.error("[sessionStore] stale lock recovery failed:", (staleError as Error).message)
    }
    return false
  }
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch (e) {
    console.error("[sessionStore] lock release failed:", (e as Error).message)
  }
}

/** Override for testing — avoids env var race when test files run in parallel */
let sessionDirOverride: string | null = null
/** When true, skip file locking entirely (for testing) */
let skipLocking = false

/** Set an explicit session store directory. Takes priority over env var.
 *  Pass null to clear. For testing only.
 *  @param opts.skipLocking — skip file locking (default true for test isolation) */
export function setSessionStoreDir(dir: string | null, opts?: { skipLocking?: boolean }): void {
  sessionDirOverride = dir
  skipLocking = dir !== null && (opts?.skipLocking ?? true)
}

function getStorePath(): string {
  const dir = sessionDirOverride
    || process.env.MERIDIAN_SESSION_DIR
    || process.env.CLAUDE_PROXY_SESSION_DIR
    || getDefaultCacheDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return join(dir, "sessions.json")
}

/**
 * Resolve the default cache directory, auto-migrating from the old name.
 * If ~/.cache/opencode-claude-max-proxy exists but ~/.cache/meridian does not,
 * creates a symlink so sessions are preserved without user action.
 */
function getDefaultCacheDir(): string {
  const newDir = join(homedir(), ".cache", "meridian")
  const oldDir = join(homedir(), ".cache", "opencode-claude-max-proxy")

  // Already using the new directory
  if (existsSync(newDir)) return newDir

  // Old directory exists — create symlink for seamless migration
  if (existsSync(oldDir)) {
    try {
      const { symlinkSync } = require("fs")
      symlinkSync(oldDir, newDir)
    } catch {
      // Symlink failed (permissions, already exists race, etc.) — fall back to old dir
      return oldDir
    }
    return newDir
  }

  // Neither exists — use new name
  return newDir
}

function readStore(): Record<string, StoredSession> {
  const path = getStorePath()
  if (!existsSync(path)) return {}
  try {
    const data = readFileSync(path, "utf-8")
    return JSON.parse(data) as Record<string, StoredSession>
  } catch (e) {
    console.error("[sessionStore] read failed:", (e as Error).message)
    return {}
  }
}

function writeStore(store: Record<string, StoredSession>): void {
  const path = getStorePath()
  const tmp = `${path}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2))
    renameSync(tmp, path) // atomic write
  } catch (e) {
    console.error("[sessionStore] write failed:", (e as Error).message)
    // If rename fails, try direct write
    try {
      writeFileSync(path, JSON.stringify(store, null, 2))
    } catch (directWriteError) {
      console.error("[sessionStore] write failed:", (directWriteError as Error).message)
    }
  }
}

export function lookupSharedSession(key: string): StoredSession | undefined {
  const store = readStore()
  return store[key]
}

export function lookupSharedSessionByClaudeId(claudeSessionId: string): StoredSession | undefined {
  const sessions = Object.values(readStore())
  let newest: StoredSession | undefined

  for (const session of sessions) {
    if (session.claudeSessionId !== claudeSessionId) continue
    if (!newest || session.lastUsedAt > newest.lastUsedAt) {
      newest = session
    }
  }

  return newest
}

export function storeSharedSession(
  key: string,
  claudeSessionId: string,
  messageCount?: number,
  lineageHash?: string,
  messageHashes?: string[],
  sdkMessageUuids?: Array<string | null>,
  contextUsage?: TokenUsage,
  messageBlockHashes?: string[][],
  passthroughResumeUuid?: string | null
): void {
  const path = getStorePath()
  const lockPath = `${path}.lock`
  const hasLock = skipLocking ? false : acquireLock(lockPath)
  if (!hasLock && !skipLocking) {
    console.warn("[sessionStore] could not acquire lock, proceeding without")
  }
  try {
    const store = readStore()
    const existing = store[key]
    // Preserve the previous Claude session ID when the mapping changes.
    // This enables recovery when a lineage bug causes the original session
    // to be abandoned — the old ID still points to the full conversation
    // in ~/.claude/projects/.
    const previousClaudeSessionId = existing && existing.claudeSessionId !== claudeSessionId
      ? existing.claudeSessionId
      : existing?.previousClaudeSessionId
    store[key] = {
      claudeSessionId,
      createdAt: existing?.createdAt || Date.now(),
      lastUsedAt: Date.now(),
      messageCount: messageCount ?? existing?.messageCount ?? 0,
      lineageHash: lineageHash ?? existing?.lineageHash,
      messageHashes: messageHashes ?? existing?.messageHashes,
      messageBlockHashes: messageBlockHashes ?? existing?.messageBlockHashes,
      sdkMessageUuids: sdkMessageUuids ?? existing?.sdkMessageUuids,
      passthroughResumeUuid: passthroughResumeUuid === undefined
        ? existing?.passthroughResumeUuid
        : passthroughResumeUuid ?? undefined,
      contextUsage: contextUsage ?? existing?.contextUsage,
      ...(previousClaudeSessionId ? { previousClaudeSessionId } : {}),
    }

    // Prune oldest entries if over capacity (count-based, not time-based)
    const maxEntries = getMaxStoredSessions()
    const keys = Object.keys(store)
    if (keys.length > maxEntries) {
      const sorted = keys.sort((a, b) => (store[a]!.lastUsedAt || 0) - (store[b]!.lastUsedAt || 0))
      const toRemove = sorted.slice(0, keys.length - maxEntries)
      for (const k of toRemove) {
        delete store[k]
      }
    }

    writeStore(store)
  } finally {
    if (hasLock) {
      releaseLock(lockPath)
    }
  }
}

/** Remove a single session from the shared file store.
 *  Used when a session is detected as stale (e.g. expired upstream). */
export function evictSharedSession(key: string): void {
  const path = getStorePath()
  const lockPath = `${path}.lock`
  const hasLock = skipLocking ? false : acquireLock(lockPath)
  if (!hasLock && !skipLocking) {
    console.warn("[sessionStore] could not acquire lock for eviction, proceeding without")
  }
  try {
    const store = readStore()
    if (store[key]) {
      delete store[key]
      writeStore(store)
    }
  } finally {
    if (hasLock) {
      releaseLock(lockPath)
    }
  }
}

/** Look up recovery information for a session key.
 *  Returns the current and previous Claude session IDs, plus derived
 *  file paths and CLI commands for conversation recovery. */
export function lookupSessionRecovery(key: string): {
  claudeSessionId: string
  previousClaudeSessionId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
} | undefined {
  const store = readStore()
  const session = store[key]
  if (!session) return undefined
  return {
    claudeSessionId: session.claudeSessionId,
    previousClaudeSessionId: session.previousClaudeSessionId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    messageCount: session.messageCount,
  }
}

/** List all stored session keys and their Claude session IDs.
 *  Used by the recovery endpoint to find sessions by partial match. */
export function listStoredSessions(): Array<{
  key: string
  claudeSessionId: string
  previousClaudeSessionId?: string
  createdAt: number
  lastUsedAt: number
  messageCount: number
}> {
  const store = readStore()
  return Object.entries(store).map(([key, session]) => ({
    key,
    claudeSessionId: session.claudeSessionId,
    previousClaudeSessionId: session.previousClaudeSessionId,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    messageCount: session.messageCount,
  }))
}

export function clearSharedSessions(): void {
  const path = getStorePath()
  try {
    writeFileSync(path, "{}")
  } catch (e) {
    console.error("[sessionStore] clear failed:", (e as Error).message)
  }
}
