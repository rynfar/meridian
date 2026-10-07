import { observeMaintenancePhases } from "../../proxy/session/bookkeeping/maintenanceJournal"
import { migrateBookkeeping } from "../../proxy/session/bookkeeping/migration"
import { initializeSessionBookkeeping } from "../../proxy/session/bookkeeping/connection"
import { retireFile } from "../../proxy/session/bookkeeping/privateRetirement"
import { randomUUID } from "node:crypto"
import { join } from "node:path"

const [mode, directory, name] = process.argv.slice(2)
if (!directory || !name) throw new Error("fixture arguments required")
observeMaintenancePhases(point => {
  if (mode === "retire" ? point === `retire:intent:${name}` : point.startsWith(`retire:intent:${name}.tmp-`) && !point.includes(".owner.json"))
    process.kill(process.pid, "SIGKILL")
})
if (mode === "retire") retireFile(join(directory, name), randomUUID())
else if (mode === "fresh") initializeSessionBookkeeping(directory).close()
else await migrateBookkeeping(directory, { writersStopped: true })
