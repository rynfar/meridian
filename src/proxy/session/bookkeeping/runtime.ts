import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { getSessionStoreDir } from "../../sessionStore"
import { activeStoreBackend, installSessionStoreBackend } from "./storeBackend"
import { installSessionLifecycleBackend } from "./lifecycleBackend"
import { sqliteSessionStoreBackend } from "./sqliteStoreBackend"
import { sqliteLifecycleBackend } from "./lifecycleSql"
import {
  BookkeepingMaintenanceRequiredError, connectionFor,
  initializeSessionBookkeeping, initializeSessionBookkeepingAsync,
} from "./connection"
import { checkpointBookkeepingAsync, withBookkeepingWriteAsync } from "./transaction"
import type { BookkeepingCheckpoint } from "./transaction"
import type { BookkeepingHandle } from "./connection"
import type { BookkeepingWriteOptions } from "./types"
import { retainBookkeepingRuntimeIdentity } from "./runtimeIdentity"
import { maintainBookkeepingBeforeListen } from "./startupMaintenance"
import { assertJsonBookkeepingAuthority } from "./jsonAuthority"

export type BookkeepingMode = "json" | "sqlite"

/** Explicit operator selection. A migrated directory can never fall back to JSON. */
export function bookkeepingMode(env: NodeJS.ProcessEnv = process.env): BookkeepingMode {
  const value = env.MERIDIAN_BOOKKEEPING ?? "json"
  if (value !== "json" && value !== "sqlite") throw new TypeError("MERIDIAN_BOOKKEEPING must be json or sqlite")
  return value
}

function assertJsonDirectory(directory: string): void {
  assertJsonBookkeepingAuthority(directory)
}

let runtime: { directory: string; refs: number; releaseIdentity: () => void } | undefined

function ownRuntime(handle: BookkeepingHandle): BookkeepingHandle {
  const directory = realpathSync.native(resolve(getSessionStoreDir()))
  if (runtime && runtime.directory !== directory) {
    handle.close()
    throw new BookkeepingMaintenanceRequiredError("one process cannot serve different bookkeeping directories")
  }
  if (!runtime) {
    installSessionStoreBackend(sqliteSessionStoreBackend)
    installSessionLifecycleBackend(sqliteLifecycleBackend)
    runtime = { directory, refs: 0, releaseIdentity: retainBookkeepingRuntimeIdentity(directory) }
  }
  runtime.refs++
  let closed = false
  return { path: handle.path, reader: handle.reader, close() {
    if (closed) return
    handle.close()
    closed = true
    if (runtime && --runtime.refs === 0) {
      runtime.releaseIdentity()
      installSessionLifecycleBackend(null)
      installSessionStoreBackend(null)
      runtime = undefined
    }
  } }
}

/** CLI/library startup: initialization is not permission to migrate legacy data. */
export async function initializeProxyBookkeeping(): Promise<BookkeepingHandle | undefined> {
  const directory = getSessionStoreDir()
  if (bookkeepingMode() === "json") {
    if (runtime) throw new BookkeepingMaintenanceRequiredError("cannot change backend while proxies are running")
    assertJsonDirectory(directory)
    return undefined
  }
  const handle = await initializeSessionBookkeepingAsync(directory)
  try {
    await maintainBookkeepingBeforeListen(directory)
    return ownRuntime(handle)
  } catch (error) {
    handle.close()
    throw error
  }
}

/** Synchronous createProxyServer retains only an already initialized handle, never imports legacy JSON. */
export function retainProxyBookkeeping(): BookkeepingHandle | undefined {
  const directory = getSessionStoreDir()
  if (bookkeepingMode() === "json") {
    if (runtime) throw new BookkeepingMaintenanceRequiredError("cannot change backend while proxies are running")
    assertJsonDirectory(directory)
    return undefined
  }
  connectionFor(directory)
  return ownRuntime(initializeSessionBookkeeping(directory))
}

/** Whole synchronous store operation is admitted asynchronously; its nested writes join this scope. */
export function admitSessionStoreWrite<T>(operation: () => T, options: BookkeepingWriteOptions = {}): Promise<T> {
  if (!activeStoreBackend()) return Promise.resolve().then(operation)
  const directory = runtime?.directory ?? getSessionStoreDir()
  return withBookkeepingWriteAsync(directory, { ...options, scope: "store" }, operation)
}

export async function checkpointProxyBookkeeping(): Promise<BookkeepingCheckpoint | undefined> {
  if (runtime) return checkpointBookkeepingAsync(runtime.directory)
}
