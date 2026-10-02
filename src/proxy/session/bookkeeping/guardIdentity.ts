import { readdirSync } from "node:fs"
import { basename } from "node:path"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"

export const MAINTENANCE_GUARD_FILENAME = "session-bookkeeping-maintenance.sqlite"

/** A published coordination inode is permanent, including after a refused transition. */
export function assertGuardNotRetired(source: string): void {
  if (basename(source) === MAINTENANCE_GUARD_FILENAME)
    throw new BookkeepingMaintenanceRequiredError("published maintenance guard must never be retired")
}

/** Do not bootstrap a replacement or open/close an old guard under a retirement intent. */
export function assertNoGuardRetirement(directory: string): void {
  if (readdirSync(directory).some(name => name.startsWith(`${MAINTENANCE_GUARD_FILENAME}.deletion-intent.releasing-`)
    || name.startsWith(`${MAINTENANCE_GUARD_FILENAME}.releasing-`))) {
    throw new BookkeepingMaintenanceRequiredError(
      "unsafe legacy maintenance-guard retirement; keep writers stopped and recover the original guard identity",
    )
  }
}
