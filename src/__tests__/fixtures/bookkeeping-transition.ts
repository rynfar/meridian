import { migrateBookkeeping } from "../../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../../proxy/session/bookkeeping/exportJson"
import { abortBookkeepingMigration } from "../../proxy/session/bookkeeping/abortMigration"

const [action, directory] = process.argv.slice(2)
if (!directory) throw new Error("missing fixture directory")
if (action === "migrate") await migrateBookkeeping(directory, { writersStopped: true })
else if (action === "export") exportBookkeepingJson(directory)
else if (action === "abort") abortBookkeepingMigration(directory)
else throw new Error("unknown fixture action")
