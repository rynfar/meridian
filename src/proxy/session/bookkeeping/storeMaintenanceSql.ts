/** Full maintenance snapshots are intentionally separate from metadata-only hot reads. */
import { readMapping, readMappingGeneration, readSessionTranscriptPins as readPins } from "./mappings"
import { MAPPING_OBJECT_ORDER } from "./mappingMetadata"
import { withStoreRead } from "./storeScope"
import type { BookkeepingReader, SqlRow, StoredSession, TranscriptLocator } from "./types"
import type { SessionRecoveryInfo } from "./storeTypes"

export function readSessionStoreSnapshot(directory: string): Record<string, StoredSession> {
  return withStoreRead(directory, (reader) => Object.fromEntries(
    reader.all(`SELECT key FROM mappings ORDER BY ${MAPPING_OBJECT_ORDER}`)
      .map((row) => [String(row.key), readMapping(reader, String(row.key))!]),
  ))
}

export function readGenerationSnapshot(reader: BookkeepingReader, adapter: string,
  profiles: readonly string[]): Record<string, string> {
  // Match JavaScript suffix semantics for non-BMP/wildcard identifiers; scan keys, not payloads.
  const keys = new Set(reader.all(`SELECT key FROM mappings ORDER BY ${MAPPING_OBJECT_ORDER}`)
    .map((row) => String(row.key)).filter((key) => key === adapter || key.endsWith(`:${adapter}`)))
  keys.add(adapter)
  for (const profile of profiles) if (profile && profile !== "default") keys.add(`${profile}:${adapter}`)
  return Object.fromEntries([...keys].map((key) => [key, readMappingGeneration(reader, key)]))
}

export function readSessionStoreGenerationSnapshot(directory: string, adapter: string,
  profiles: readonly string[]): Record<string, string> {
  return withStoreRead(directory, (reader) => readGenerationSnapshot(reader, adapter, profiles))
}

export function readSessionTranscriptPins(directory: string): TranscriptLocator[] {
  return withStoreRead(directory, readPins)
}

const RECOVERY_COLUMNS = "key,claude_session_id,previous_claude_session_id,created_at,last_used_at,message_count"
function recovery(row: SqlRow): SessionRecoveryInfo {
  return { claudeSessionId: String(row.claude_session_id),
    previousClaudeSessionId: row.previous_claude_session_id === null ? undefined : String(row.previous_claude_session_id),
    createdAt: Number(row.created_at), lastUsedAt: Number(row.last_used_at), messageCount: Number(row.message_count) }
}

export function lookupSessionRecovery(directory: string, key: string): SessionRecoveryInfo | undefined {
  try {
    return withStoreRead(directory, (reader) => {
      const row = reader.get(`SELECT ${RECOVERY_COLUMNS} FROM mappings WHERE key=?`, key)
      return row ? recovery(row) : undefined
    })
  } catch (error) {
    console.error("[sessionStore] read failed:", (error as Error).message)
    return undefined
  }
}

export function listStoredSessions(directory: string): Array<SessionRecoveryInfo & { key: string }> {
  try {
    return withStoreRead(directory, (reader) => reader.all(
      `SELECT ${RECOVERY_COLUMNS} FROM mappings ORDER BY ${MAPPING_OBJECT_ORDER}`,
    ).map((row) => ({ key: String(row.key), ...recovery(row) })))
  } catch (error) {
    console.error("[sessionStore] read failed:", (error as Error).message)
    return []
  }
}
