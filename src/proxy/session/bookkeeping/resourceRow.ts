import type { BookkeepingResource, BookkeepingTransaction } from "./types"
import { parseProcessIncarnation } from "../processIncarnation"

/** Internal row codec; not a runtime resource creation API. */
export function writeResourceRow(tx: BookkeepingTransaction, resource: BookkeepingResource): void {
  const encode = (value: BookkeepingResource["deletionOwner"]): string | null => {
    if (value === undefined) return null
    if (!parseProcessIncarnation(value)) throw new TypeError("invalid process incarnation")
    return JSON.stringify(value)
  }
  tx.run(
    `INSERT INTO resources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    resource.key,
    resource.generation,
    resource.locator.configDir,
    resource.locator.projectDir ?? null,
    resource.locator.sessionId,
    resource.state,
    resource.createdAt,
    resource.updatedAt,
    resource.attempts,
    resource.nextAttemptAt ?? null,
    resource.lastError ?? null,
    resource.deletionToken ?? null,
    encode(resource.deletionOwner),
    encode(resource.deletionExecutor),
    resource.deletionProcessGroupId ?? null,
    resource.rowVersion,
  )
}
