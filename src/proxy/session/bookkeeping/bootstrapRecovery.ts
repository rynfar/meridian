import { join } from "node:path"
import { acquireMaintenanceGuard, assertGuardRecoveryQuiescent, MAINTENANCE_GUARD_FILENAME } from "./guard"
import { bootstrapResidues, cleanupBootstrapOrphans } from "./bootstrapOwner"
import { inspectionDirectory } from "./inspect"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"

/** Explicit offline recovery, including the first published guard's link window. */
export function recoverBootstrapAliases(input: string, options: { writersStopped: boolean }): void {
  if (!options.writersStopped) throw new BookkeepingMaintenanceRequiredError("bootstrap recovery requires --writers-stopped")
  assertGuardRecoveryQuiescent()
  const directory = inspectionDirectory(input)
  const paths = [MAINTENANCE_GUARD_FILENAME, "session-bookkeeping.sqlite"].map(name => join(directory, name))
  for (const path of paths) {
    if (bootstrapResidues(path).some(row => row.verdict !== "dead-incarnation"))
      throw new BookkeepingMaintenanceRequiredError("live or ambiguous bootstrap ownership; no cleanup allowed")
  }
  // acquireMaintenanceGuard validates a linked first guard through native SQLite
  // without auxiliary alias fds, takes EXCLUSIVE, then cleans only proven-dead aliases.
  const guard = acquireMaintenanceGuard(directory)
  try { for (const path of paths) cleanupBootstrapOrphans(path) } finally { guard.close() }
}
