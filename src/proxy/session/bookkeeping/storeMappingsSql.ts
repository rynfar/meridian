/** Addressed SQL reads; only the winning mapping's history is hydrated. */
import { LOOKUP_CLAUDE_SQL, readMapping, readMappingGeneration } from "./mappings"
import { withStoreRead } from "./storeScope"
import type { BookkeepingReader } from "./types"
import type { SharedSessionLookupResult } from "./storeTypes"

export function readSharedSession(reader: BookkeepingReader, key: string): SharedSessionLookupResult {
  const generation = readMappingGeneration(reader, key)
  const session = readMapping(reader, key)
  if (!session) return { status: "missing", generation }
  const denied = reader.get("SELECT legacy_denial FROM mappings WHERE key=?", key)?.legacy_denial === 1
  return denied ? { status: "missing", existing: session, generation } : { status: "found", session, generation }
}

export function readSharedSessionByClaudeId(reader: BookkeepingReader, id: string): SharedSessionLookupResult {
  const winner = reader.get(LOOKUP_CLAUDE_SQL, id)
  // Match the legacy facade's truthy newestKey guard, including the empty-key corner case.
  if (!winner?.key) return { status: "missing" }
  return readSharedSession(reader, String(winner.key))
}

export function lookupSharedSessionResult(directory: string, key: string): SharedSessionLookupResult {
  return lookup(() => withStoreRead(directory, (reader) => readSharedSession(reader, key)))
}

export function lookupSharedSessionByClaudeIdResult(directory: string, id: string): SharedSessionLookupResult {
  return lookup(() => withStoreRead(directory, (reader) => readSharedSessionByClaudeId(reader, id)))
}

function lookup(operation: () => SharedSessionLookupResult): SharedSessionLookupResult {
  try { return operation() }
  catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    console.error("[sessionStore] read failed:", normalized.message)
    return { status: "error", error: normalized }
  }
}
