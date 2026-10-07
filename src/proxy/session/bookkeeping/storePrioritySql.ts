/** Priority lookup reads only the exact route, attempt, and absence slot. */
import { mappingDigest } from "./mappingMetadata"
import { withStoreRead } from "./storeScope"
import type { BookkeepingReader } from "./types"
import type { PriorityAssignmentLookupResult } from "./storeTypes"

export function readPriorityAssignment(reader: BookkeepingReader, route: string): PriorityAssignmentLookupResult {
  const row = reader.get("SELECT * FROM priority_assignments WHERE route_key=?", route)
  const pending = reader.get("SELECT * FROM priority_attempts WHERE route_key=?", route)
  const attempt = pending ? {
    blocked: pending.blocked === 1,
    blockedTurnDigest: pending.blocked_turn_digest === null ? null : String(pending.blocked_turn_digest),
    blockedTurnIssuedAt: pending.blocked_turn_issued_at === null ? null : Number(pending.blocked_turn_issued_at),
    pendingTurnDigest: pending.pending_turn_digest === null ? null : String(pending.pending_turn_digest),
    pendingTurnIssuedAt: pending.pending_turn_issued_at === null ? null : Number(pending.pending_turn_issued_at),
    ownerToken: pending.owner_token === null ? null : String(pending.owner_token),
    generationId: String(pending.generation_id), updatedAt: Number(pending.updated_at),
  } : undefined
  const digest = mappingDigest(`priority:${route}`)
  if (!row) {
    const slot = reader.get("SELECT counter FROM fence_slots WHERE namespace='store' AND slot=?", digest.slice(0, 4))
    return { status: "missing", generation: `a:${digest}:${slot?.counter ?? 0}`, attempt }
  }
  const assignment = {
    profileId: String(row.profile_id), lastHumanTurnDigest: String(row.last_human_turn_digest),
    lastHumanTurnIssuedAt: Number(row.last_human_turn_issued_at), mappingKey: String(row.mapping_key),
    mappingGeneration: String(row.mapping_generation), generationId: String(row.generation_id),
    updatedAt: Number(row.updated_at),
  }
  return { status: "found", assignment, generation: `r:${digest}:${assignment.generationId}`, attempt }
}

export function lookupPriorityAssignmentResult(directory: string, route: string): PriorityAssignmentLookupResult {
  try { return withStoreRead(directory, (reader) => readPriorityAssignment(reader, route)) }
  catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    console.error("[sessionStore] priority route read failed:", normalized.message)
    return { status: "error", error: normalized }
  }
}
