import { acquireMaintenanceGuard, BookkeepingGuardBusyError } from "../../proxy/session/bookkeeping/guard"
import { initializeSessionBookkeepingAsync } from "../../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../../proxy/session/bookkeeping/database"
import { createBootstrapPath } from "../../proxy/session/bookkeeping/bootstrapOwner"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const [directory, mode] = process.argv.slice(2)
if (!directory) throw new Error("fixture needs directory")
if (mode === "orphan") {
  writeFileSync(createBootstrapPath(join(directory, "session-bookkeeping-maintenance.sqlite")), "", { mode: 0o600 })
} else if (mode === "probe-maintenance" || mode === "commit-maintenance") {
  try {
    const lease = acquireMaintenanceGuard(directory)
    if (mode === "commit-maintenance") lease.toShared(() => undefined).close()
    else lease.close()
  } catch (error) {
    if (error instanceof BookkeepingGuardBusyError) process.exit(73)
    throw error
  }
} else {
  let handle: BookkeepingHandle | undefined
  const close = () => handle?.close()
  process.once("disconnect", () => {
    close()
    process.exit(0)
  })
  process.once("SIGTERM", () => {
    close()
    process.exit(143)
  })
  handle = await initializeSessionBookkeepingAsync(directory)
  process.once("message", () => {
    close()
    process.removeAllListeners("disconnect")
    process.disconnect()
  })
  process.send?.({ ready: true, path: handle.path })
}
