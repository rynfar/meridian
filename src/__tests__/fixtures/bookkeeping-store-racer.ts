import * as store from "../../proxy/sessionStore"
import { initializeSessionBookkeeping } from "../../proxy/session/bookkeeping/database"
import { BookkeepingBusyError, connectionFor } from "../../proxy/session/bookkeeping/connection"
import { sqliteSessionStoreBackend } from "../../proxy/session/bookkeeping/sqliteStoreBackend"

const input = JSON.parse(process.env.RACE_INPUT!)
store.setSessionStoreDir(input.directory)
const handle = initializeSessionBookkeeping(input.directory)
store.setSessionStoreBackendForTest(sqliteSessionStoreBackend)
const timeout = Object.values(connectionFor(input.directory).db!.prepare("PRAGMA busy_timeout").get()!)[0]
if (timeout !== 0) throw new Error(`native timeout must be zero, got ${timeout}`)
Atomics.wait = () => { throw new Error("synchronous sleep forbidden") }
process.once("message", (message) => {
  if (message !== "go") throw new Error("unexpected barrier signal")
  try {
    const result = store.storeSharedSessionAndPriorityAssignment(input.publication)
    process.send!({ outcome: result === false ? "cas" : "won", result })
  } catch (error) {
    if (!(error instanceof BookkeepingBusyError)) throw error
    process.send!({ outcome: "busy" })
  } finally {
    store.setSessionStoreBackendForTest(null)
    handle.close()
    process.disconnect!()
  }
})
process.send!("ready")
