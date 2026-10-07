import { initializeSessionBookkeepingAsync } from "../../proxy/session/bookkeeping/database"
process.once("disconnect", () => process.exit(0))
const start = new Promise<void>((resolve) => process.once("message", () => resolve()))
process.send?.("ready")
await start
const handle = await initializeSessionBookkeepingAsync(process.argv[2]!)
if (handle.reader.get("PRAGMA user_version")?.user_version !== 1) throw new Error("incomplete bootstrap")
handle.close()
process.disconnect()
