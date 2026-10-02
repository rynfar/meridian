import { setTimeout as delay } from "node:timers/promises"
import { getMaxStoredSessionsLimit } from "../../sessionStore"
import { BookkeepingMaintenanceRequiredError } from "./connection"
import { withBookkeepingRead, withBookkeepingWriteAsync } from "./transaction"
import { advanceStoreSlot } from "./storeMutationSupport"
import { MAPPING_OBJECT_ORDER } from "./mappingMetadata"

/** Apply limit reductions before binding the listener, in bounded metadata-only pages. */
export async function maintainBookkeepingBeforeListen(directory: string): Promise<void> {
  const maximum = getMaxStoredSessionsLimit()
  while (true) {
    const count = withBookkeepingRead(directory, (reader) =>
      Number(reader.get("SELECT value FROM bookkeeping_counts WHERE kind='mappings'")?.value ?? 0))
    if (count <= maximum) return
    await withBookkeepingWriteAsync(directory, { scope: "store" }, (tx) => {
      const excess = Number(tx.get("SELECT value FROM bookkeeping_counts WHERE kind='mappings'")!.value) - maximum
      if (excess <= 0) return
      const rows = tx.all(`SELECT key FROM mappings WHERE key NOT IN
        (SELECT mapping_key FROM priority_assignments UNION SELECT mapping_key FROM priority_rollbacks)
        ORDER BY last_used_at,${MAPPING_OBJECT_ORDER} LIMIT ?`, Math.min(128, excess))
      if (!rows.length) throw new BookkeepingMaintenanceRequiredError(
        "stored-session limit is below protected priority mappings; raise MERIDIAN_MAX_STORED_SESSIONS",
      )
      for (const row of rows) {
        const key = String(row.key)
        tx.run("DELETE FROM mappings WHERE key=?", key)
        advanceStoreSlot(tx, key)
      }
    })
    await delay(0)
  }
}
