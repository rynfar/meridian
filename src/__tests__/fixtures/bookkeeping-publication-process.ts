import { initializeSessionBookkeepingAsync } from "../../proxy/session/bookkeeping/database"
import { publishPinnedTranscript } from "../../proxy/session/bookkeeping/lifecyclePublicationSql"
import { sqliteSessionStoreBackend } from "../../proxy/session/bookkeeping/sqliteStoreBackend"
import { SessionLifecycleLockError } from "../../proxy/session/lifecycleErrors"
import type { TranscriptLocator } from "../../proxy/session/bookkeeping/types"

const directory = process.argv[2]!, locator = JSON.parse(process.argv[3]!) as TranscriptLocator
const key = process.argv[4]!, expected = process.argv[5]!
process.once("disconnect", () => process.exit(0))
const handle = await initializeSessionBookkeepingAsync(directory)
try {
  const start = new Promise<void>((resolve) => process.once("message", () => resolve()))
  process.send?.("ready")
  await start
  let result: string | boolean
  try {
    result = await publishPinnedTranscript(locator, () => sqliteSessionStoreBackend.storeSharedSession(
      directory, key, locator.sessionId, 1, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, locator, undefined, expected), { storeDir: directory, lockWaitMs: 2000 })
  } catch (error) {
    if (!(error instanceof SessionLifecycleLockError)) throw error
    result = "busy"
  }
  console.log(JSON.stringify({ result, node: process.versions.node }))
} finally {
  handle.close()
  process.disconnect()
}
