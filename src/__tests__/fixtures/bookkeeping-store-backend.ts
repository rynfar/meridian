import { describe, it } from "bun:test"
import { initializeSessionBookkeeping, type BookkeepingHandle } from "../../proxy/session/bookkeeping/database"
import { setSessionStoreBackendForTest } from "../../proxy/sessionStore"
import { sqliteSessionStoreBackend } from "../../proxy/session/bookkeeping/sqliteStoreBackend"

export const sqliteStoreTest = process.env.BOOKKEEPING_TEST_BACKEND === "sqlite"
  || process.env.BOOKKEEPING_TEST_STORE_BACKEND === "sqlite"
/** These assertions observe JSON bytes, file replacement or JSON-only child writers. */
export function legacyStoreOnly(name: string, test: () => void | Promise<void>, timeout?: number): void {
  const suite = sqliteStoreTest ? describe.skip : describe
  suite("legacy-only: JSON document/file protocol, not the store API", () => { it(name, test, timeout) })
}
let handle: BookkeepingHandle | undefined

/** Empty suites need the production fresh-schema bootstrap, not synthetic migration journals. */
export function setupStoreBackend(directory: string): void {
  if (!sqliteStoreTest) return
  handle = initializeSessionBookkeeping(directory)
  setSessionStoreBackendForTest(sqliteSessionStoreBackend)
}

export function teardownStoreBackend(): void {
  if (!sqliteStoreTest) return
  setSessionStoreBackendForTest(null)
  handle?.close()
  handle = undefined
}
