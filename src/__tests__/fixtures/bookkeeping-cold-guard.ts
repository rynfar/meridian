import { acquireMaintenanceGuard, MAINTENANCE_GUARD_FILENAME } from "../../proxy/session/bookkeeping/guard"
import { lstatSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { privateName } from "../../proxy/session/bookkeeping/privateNames"
import { writeDurably } from "../../proxy/session/bookkeeping/maintenanceJournal"
import { setSessionStoreDir, storeSharedSession } from "../../proxy/sessionStore"
import { initializeSessionBookkeeping } from "../../proxy/session/bookkeeping/connection"
import { inspectBookkeeping } from "../../proxy/session/bookkeeping/inspect"
import { runBookkeepingCli } from "../../proxy/session/bookkeeping/cli"

const [directory, mode] = process.argv.slice(2)
if (!directory) throw new Error("directory required")
try {
  if (mode === "legacy-write") {
    process.env.MERIDIAN_SESSION_LOCK_TIMEOUT_MS = "20"
    setSessionStoreDir(directory)
    storeSharedSession("old-writer", "sdk-old")
    process.exit(0)
  }
  if (mode === "fresh") { initializeSessionBookkeeping(directory).close(); process.exit(0) }
  if (mode === "inspect") { console.log(JSON.stringify(inspectBookkeeping(directory))); process.exit(0) }
  if (mode === "export-stopped") process.exit(await runBookkeepingCli(["export-json", "--session-dir", directory, "--writers-stopped", "--json"]))
  const guard = acquireMaintenanceGuard(directory)
  if (mode === "crash-intent") {
    const source = guard.path, id = randomUUID()
    const { dev, ino } = lstatSync(source)
    writeDurably(privateName(source + ".deletion-intent", id), JSON.stringify({ source, id, dev, ino,
      private: privateName(source, id) }))
    process.kill(process.pid, "SIGKILL")
  }
  guard.close()
} catch (error) {
  console.error(String(error))
  process.exit(73)
}
