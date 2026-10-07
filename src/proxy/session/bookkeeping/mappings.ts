import { createHash } from "node:crypto"
import { resourceKey, canonicalizeLocator } from "./locator"
import { SessionLifecycleCorruptError } from "../lifecycleErrors"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"
import type { CanonicalStoredSession } from "./types"
import { mappingGeneration, legacyUserDenial, mappingObjectIndex, MAPPING_OBJECT_ORDER } from "./mappingMetadata"
import type {
  BookkeepingReader,
  BookkeepingTransaction,
  SqlValue,
  StoredSession,
  TranscriptLocator,
} from "./types"

const digest = (key: string) => createHash("sha256").update(key).digest("hex")
const optionalColumns = [
  ["revision", "revision", false],
  ["generationId", "generation_id", false],
  ["lineageHash", "lineage_hash", false],
  ["previousClaudeSessionId", "previous_claude_session_id", false],
  ["contextUsage", "context_usage_json", true],
  ["passthroughToolCallAssistantUuid", "passthrough_tool_call_assistant_uuid", false],
  ["passthroughToolCallIds", "passthrough_tool_call_ids_json", true],
  ["currentTranscript", "current_locator_json", true],
  ["previousTranscript", "previous_locator_json", true],
] as const

function validateEntry(entry: StoredSession): void {
  if (
    !entry ||
    typeof entry !== "object" ||
    typeof entry.claudeSessionId !== "string" ||
    !entry.claudeSessionId ||
    (entry.generationId !== undefined && (typeof entry.generationId !== "string" || !entry.generationId)) ||
    (entry.revision !== undefined && (!Number.isSafeInteger(entry.revision) || entry.revision < 1))
  )
    throw new TypeError("invalid mapping identity/revision")
  for (const key of ["createdAt", "lastUsedAt", "messageCount"] as const) {
    if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) throw new TypeError(`invalid mapping ${key}`)
  }
  for (const field of ["messageHashes", "passthroughToolCallIds"] as const) {
    if (
      entry[field] !== undefined &&
      (!Array.isArray(entry[field]) || entry[field].some((value) => typeof value !== "string"))
    )
      throw new TypeError(`invalid ${field}`)
  }
  if (
    entry.messageBlockHashes !== undefined &&
    (!Array.isArray(entry.messageBlockHashes) ||
      entry.messageBlockHashes.some(
        (block) => !Array.isArray(block) || block.some((value) => typeof value !== "string"),
      ))
  )
    throw new TypeError("invalid messageBlockHashes")
  if (
    entry.sdkMessageUuids !== undefined &&
    (!Array.isArray(entry.sdkMessageUuids) ||
      entry.sdkMessageUuids.some((value) => value !== null && typeof value !== "string"))
  )
    throw new TypeError("invalid sdkMessageUuids")
  for (const [locator, id] of [
    [entry.currentTranscript, entry.claudeSessionId],
    [entry.previousTranscript, entry.previousClaudeSessionId],
  ] as const) {
    if (locator !== undefined && (resourceKey(locator).length !== 64 || locator.sessionId !== id))
      throw new TypeError("mapping locator/session mismatch")
  }
}

export function writeMappingRow(
  tx: BookkeepingTransaction,
  key: string,
  entry: CanonicalStoredSession,
  update = false,
): void {
  validateEntry(entry)
  const values: SqlValue[] = optionalColumns.map(([property, , json]) => {
    const value = entry[property]
    return value === undefined ? null : json ? JSON.stringify(value) : (value as SqlValue)
  })
  const columns = [
    "claude_session_id",
    "created_at",
    "last_used_at",
    "message_count",
    ...optionalColumns.map(([, column]) => column),
    "generation_token", "legacy_denial", "object_index",
  ]
  const assignments = columns.map((column) => `${column}=excluded.${column}`).join(",")
  const conflict = update ? `ON CONFLICT(key) DO UPDATE SET ${assignments}` : ""
  tx.run(
    `INSERT INTO mappings(key,${columns.join(",")},insertion_order)
    VALUES(${Array(8 + values.length)
      .fill("?")
      .join(",")},(SELECT coalesce(max(insertion_order),0)+1 FROM mappings)) ${conflict}`,
    key,
    entry.claudeSessionId,
    entry.createdAt,
    entry.lastUsedAt,
    entry.messageCount,
    ...values,
    mappingGeneration(key, entry), legacyUserDenial(entry), mappingObjectIndex(key),
  )
  // Mutation invalidates imported bytes even if a later projection happens to return to its old shape.
  tx.run("DELETE FROM legacy_exports WHERE kind='mapping' AND key=?", key)
  const legacy = entry.generationId === undefined
  const history = legacy
    ? entry
    : {
        messageHashes: entry.messageHashes,
        messageBlockHashes: entry.messageBlockHashes,
        sdkMessageUuids: entry.sdkMessageUuids,
        passthroughResumeUuid: (entry as StoredSession & { passthroughResumeUuid?: unknown }).passthroughResumeUuid,
      }
  tx.run(
    `INSERT INTO mapping_history VALUES(?,?,?) ON CONFLICT(mapping_key)
      DO UPDATE SET encoding=excluded.encoding,history_json=excluded.history_json`,
    key,
    legacy ? "legacy-entry" : "history",
    JSON.stringify(history),
  )
  for (const [slot, locator] of [
    ["current", entry.currentTranscript],
    ["previous", entry.previousTranscript],
  ] as const) {
    if (locator)
      tx.run(
        `INSERT INTO mapping_pins VALUES(?,?,?,?) ON CONFLICT(mapping_key,slot)
          DO UPDATE SET resource_key=excluded.resource_key,generation=excluded.generation`,
        key,
        slot,
        resourceKey(locator),
        locator.lifecycleGeneration ?? null,
      )
    else tx.run("DELETE FROM mapping_pins WHERE mapping_key=? AND slot=?", key, slot)
  }
}

function advanceSlot(tx: BookkeepingTransaction, key: string): void {
  tx.run(
    `INSERT INTO fence_slots VALUES('store',?,1) ON CONFLICT(namespace,slot) DO UPDATE SET counter=counter+1`,
    digest(key).slice(0, 4),
  )
}

export function readMapping(reader: BookkeepingReader, key: string): StoredSession | undefined {
  const row = reader.get("SELECT * FROM mappings WHERE key=?", key)
  if (!row) return undefined
  const history = reader.get("SELECT encoding,history_json FROM mapping_history WHERE mapping_key=?", key)
  if (!history) throw new Error("mapping history missing")
  if (history.encoding === "legacy-entry") {
    const entry = JSON.parse(String(history.history_json)) as StoredSession
    validateEntry(entry)
    if (entry.generationId !== undefined || row.generation_id !== null)
      throw new Error("legacy mapping encoding/generation mismatch")
    return entry
  }
  if (history.encoding !== "history" || row.generation_id === null)
    throw new Error("mapping encoding/generation mismatch")
  const entry: StoredSession = {
    claudeSessionId: String(row.claude_session_id),
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
    messageCount: Number(row.message_count),
  }
  for (const [property, column, json] of optionalColumns) {
    if (row[column] !== null)
      Object.assign(entry, { [property]: json ? JSON.parse(String(row[column])) : row[column] })
  }
  const payload = JSON.parse(String(history.history_json)) as Record<string, unknown>
  if (
    Object.keys(payload).some(
      (key) => !["messageHashes", "messageBlockHashes", "sdkMessageUuids", "passthroughResumeUuid"].includes(key),
    )
  )
    throw new Error("unexpected mapping history field")
  Object.assign(entry, payload)
  validateEntry(entry)
  return entry
}

export function readMappingGeneration(reader: BookkeepingReader, key: string): string {
  const row = reader.get("SELECT generation_token FROM mappings WHERE key=?", key)
  if (!row) {
    const slot = reader.get(
      "SELECT counter FROM fence_slots WHERE namespace='store' AND slot=?",
      digest(key).slice(0, 4),
    )
    return `a:${digest(key)}:${slot?.counter ?? 0}`
  }
  return String(row.generation_token)
}

/** A missing key is compared by its durable fence slot, not by mere absence. */
export function compareAndSwapMapping(
  tx: BookkeepingTransaction,
  key: string,
  expectedGeneration: string,
  replacement?: CanonicalStoredSession,
): boolean {
  if (readMappingGeneration(tx, key) !== expectedGeneration) return false
  if (replacement && !replacement.generationId)
    throw new TypeError("mapping mutation requires a new generationId")
  if (replacement && `p:${digest(key)}:${replacement.generationId}` === expectedGeneration)
    throw new TypeError("mapping mutation must advance generation")
  if (replacement) writeMappingRow(tx, key, replacement, true)
  else tx.run("DELETE FROM mappings WHERE key=?", key)
  advanceSlot(tx, key)
  return true
}

export const LOOKUP_CLAUDE_SQL =
  `SELECT key FROM mappings WHERE claude_session_id=? AND legacy_denial=0
   ORDER BY last_used_at DESC,${MAPPING_OBJECT_ORDER} LIMIT 1`
export const PIN_LOOKUP_SQL =
  "SELECT mapping_key FROM mapping_pins WHERE resource_key=? AND (generation IS NULL OR generation=?)"

/** Only locator metadata, never mapping_history or whole session hydration. */
export function readSessionTranscriptPins(reader: BookkeepingReader): TranscriptLocator[] {
  return reader
    .all(
      `SELECT current_locator_json,previous_locator_json FROM mappings
    WHERE current_locator_json IS NOT NULL OR previous_locator_json IS NOT NULL`,
    )
    .flatMap((row) =>
      [row.current_locator_json, row.previous_locator_json].flatMap((value) =>
        value === null ? [] : [JSON.parse(String(value)) as TranscriptLocator],
      ),
    )
}

/** Capture under a read snapshot; invoke the returned filesystem audit only AFTER COMMIT. */
export function captureMappingPinsValidation(reader: BookkeepingReader): () => void {
  const locators = new Set<string>()
  const importedLocators: Array<{ raw: TranscriptLocator; projected: string }> = []
  let after: string | undefined
  while (true) {
    const rows = reader.all(
      `SELECT m.*,h.encoding,
      CASE WHEN h.encoding='legacy-entry' THEN h.history_json ELSE NULL END AS history_json
      FROM mappings m LEFT JOIN mapping_history h ON h.mapping_key=m.key
      ${after === undefined ? "" : "WHERE m.key>?"} ORDER BY m.key LIMIT 128`,
      ...(after === undefined ? [] : [after]),
    )
    if (!rows.length) break
    for (const row of rows) {
      if (row.encoding !== (row.generation_id === null ? "legacy-entry" : "history")) {
        throw new SessionLifecycleCorruptError("mapping history/encoding mismatch")
      }
      const entryForMetadata = row.encoding === "legacy-entry"
        ? JSON.parse(String(row.history_json)) as StoredSession : readMapping(reader, String(row.key))!
      if (row.generation_token !== mappingGeneration(String(row.key), entryForMetadata)
        || row.legacy_denial !== legacyUserDenial(entryForMetadata)
        || row.object_index !== mappingObjectIndex(String(row.key))) {
        throw new SessionLifecycleCorruptError(`mapping lookup metadata/payload mismatch: ${JSON.stringify(row.key)}`)
      }
      if (row.encoding === "legacy-entry") {
        const entry = JSON.parse(String(row.history_json)) as StoredSession
        validateEntry(entry)
        const columns = [
          ["claudeSessionId", "claude_session_id", false],
          ["createdAt", "created_at", false],
          ["lastUsedAt", "last_used_at", false],
          ["messageCount", "message_count", false],
          ...optionalColumns,
        ] as const
        for (const [property, column, json] of columns) {
          const value = entry[property]
          const expected = value === undefined ? null : json ? JSON.stringify(value) : value
          if ((property === "currentTranscript" || property === "previousTranscript")
            && value !== undefined && row[column] !== null) {
            const raw = value as TranscriptLocator
            const projected = JSON.parse(String(row[column])) as TranscriptLocator
            if (raw.sessionId !== projected.sessionId
              || raw.lifecycleGeneration !== projected.lifecycleGeneration
              || (raw.projectDir === undefined) !== (projected.projectDir === undefined)) {
              throw new SessionLifecycleCorruptError("legacy locator identity/payload mismatch")
            }
            importedLocators.push({ raw: value as TranscriptLocator, projected: String(row[column]) })
            continue
          }
          if (expected !== row[column]) {
            throw new SessionLifecycleCorruptError(
              `legacy mapping metadata/payload mismatch: ${row.key}/${column}`,
            )
          }
        }
      }
      const expected = new Map<string, string>()
      for (const [slot, value] of [
        ["current", row.current_locator_json],
        ["previous", row.previous_locator_json],
      ]) {
        if (value === null) continue
        const locator = JSON.parse(String(value)) as TranscriptLocator
        locators.add(String(value))
        expected.set(
          String(slot),
          JSON.stringify([resourceKey(locator), locator.lifecycleGeneration ?? null]),
        )
      }
      for (const pin of reader.all("SELECT * FROM mapping_pins WHERE mapping_key=?", row.key!)) {
        if (expected.get(String(pin.slot)) !== JSON.stringify([pin.resource_key, pin.generation])) {
          throw new SessionLifecycleCorruptError("bookkeeping pin projection mismatch")
        }
        expected.delete(String(pin.slot))
      }
      if (expected.size) throw new SessionLifecycleCorruptError("bookkeeping pin projection missing")
    }
    after = String(rows.at(-1)!.key)
  }
  if (reader.get(`SELECT p.mapping_key FROM mapping_pins p LEFT JOIN mappings m ON m.key=p.mapping_key
    WHERE m.key IS NULL LIMIT 1`)) throw new SessionLifecycleCorruptError("orphan bookkeeping pin")
  return () => {
    const paths = new Map<string, string>()
    for (const { raw, projected } of importedLocators) {
      if (JSON.stringify(canonicalizeLocator(raw, paths)) !== projected) {
        throw new BookkeepingMaintenanceRequiredError("legacy locator realpath changed; run offline recanonicalize")
      }
    }
    for (const raw of locators) {
      const stored = JSON.parse(raw) as TranscriptLocator
      const canonical = canonicalizeLocator(stored, paths)
      if (stored.configDir !== canonical.configDir || stored.projectDir !== canonical.projectDir) {
        throw new BookkeepingMaintenanceRequiredError("transcript realpath changed; run offline recanonicalize")
      }
    }
  }
}

/** Maintenance-only convenience when no SQL transaction is held. */
export function validateMappingPins(reader: BookkeepingReader): void {
  captureMappingPinsValidation(reader)()
}
