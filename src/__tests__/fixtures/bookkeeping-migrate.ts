import { migrateBookkeeping } from "../../proxy/session/bookkeeping/migration"

const directory = process.argv[2]
if (!directory) throw new Error("migration fixture requires directory")
const result = await migrateBookkeeping(directory, { writersStopped: true })
process.stdout.write(JSON.stringify(result) + "\n")
