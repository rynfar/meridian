import { connectionFor, getBookkeepingLockWaitMs } from "./connection"
import { checkpointBookkeepingOffline } from "./transaction"
import { BookkeepingMaintenanceRequiredError } from "./storagePaths"

/** Synchronous maintenance only; one idle main handle, separate exclusive guard. */
export function truncateOffline(directory: string, operation: "export" | "migration" | "abort"): void {
  const connection = connectionFor(directory)
  const budget = getBookkeepingLockWaitMs()
  const deadline = performance.now() + budget
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  while (true) {
    const result = checkpointBookkeepingOffline(directory, "TRUNCATE")
    if (result.busy === 0 && result.log === 0) return
    const remaining = deadline - performance.now()
    if (remaining <= 0) {
      throw new BookkeepingMaintenanceRequiredError(
        `${operation} checkpoint busy after ${budget}ms: external database reader/writer holds a WAL lock `
        + `at ${connection.path}; holder PID unavailable from SQLite; local handles=${connection.refs}, `
        + `local transaction=${connection.db?.inTransaction}, busy=${result.busy}, log=${result.log}, `
        + `checkpointed=${result.checkpointed}; stop all database readers`,
      )
    }
    Atomics.wait(sleeper, 0, 0, Math.min(remaining, 20 + Math.random() * 20))
  }
}
