/** MIGRATOR ONLY. This module is not exported by the runtime database facade. */
import { openHandle } from "./connection"
import type { MaintenanceGuardLease } from "./guard"
export function openForMaintenance(
  directory: string,
  options: { expectPhase: string; guard?: MaintenanceGuardLease; skipRealpathAudit?: boolean },
) {
  return openHandle(directory, {}, options.expectPhase, options.guard, options.skipRealpathAudit)
}
