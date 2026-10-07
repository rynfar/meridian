/** Derived lookup authority, maintained with the payload in the same transaction. */
import { createHash } from "node:crypto"
import type { StoredSession } from "./types"

export const mappingDigest = (value: string): string => createHash("sha256").update(value).digest("hex")

export function mappingGeneration(key: string, entry: StoredSession): string {
  return `p:${mappingDigest(key)}:${entry.generationId ?? `legacy-${mappingDigest(JSON.stringify(entry))}`}`
}

export function legacyUserDenial(entry: StoredSession): number {
  const legacy = (entry as StoredSession & { passthroughResumeUuid?: unknown }).passthroughResumeUuid
  return Number(typeof legacy === "string" && legacy.length > 0 && !entry.passthroughToolCallAssistantUuid)
}

/** ECMAScript array-index keys precede strings in Object.entries, regardless of insertion time. */
export function mappingObjectIndex(key: string): number {
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 4294967295 && String(index) === key
    ? index : 4294967295
}

export const MAPPING_OBJECT_ORDER = "object_index,insertion_order"
