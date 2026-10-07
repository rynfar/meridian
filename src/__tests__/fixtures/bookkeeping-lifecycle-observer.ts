import { readFileSync } from "node:fs"
import { join } from "node:path"
import { withBookkeepingRead } from "../../proxy/session/bookkeeping/database"
import { readResource, readResourceLease } from "../../proxy/session/bookkeeping/resources"
import { RESOURCE_STATES } from "../../proxy/session/bookkeeping/schema"
import type { TranscriptResource } from "../../proxy/session/bookkeeping/types"
import { sqliteLifecycleTest } from "./bookkeeping-lifecycle-install"
import { getSessionStoreDir, readSessionTranscriptPins } from "../../proxy/sessionStore"

export interface LifecycleState {
  resources: Record<string, TranscriptResource>
  fenceSlots: Record<string, number>
  counts: Record<string, number>
}

/** Cross-backend test observation API. SQL state and public pin projection share one read scope.
 * JSON has no public lifecycle snapshot API: its read-only codec stays behind this adapter. */
export function observeLifecycleLedger(directory: string, sqlite = sqliteLifecycleTest) {
  if (getSessionStoreDir() !== directory) throw new Error("observer requires the installed store directory")
  const capture = () => ({ state: observeLifecycleState(directory, sqlite), pins: readSessionTranscriptPins() })
  return sqlite ? withBookkeepingRead(directory, capture) : capture()
}

/** Observe ledger state in one read scope on the installed handle; never open a writer. */
export function observeLifecycleState(directory: string, sqlite = sqliteLifecycleTest): LifecycleState {
  if (!sqlite) {
    const sidecar = JSON.parse(readFileSync(join(directory, "session-gc.json"), "utf8")) as {
      resources: Record<string, TranscriptResource>; meta?: { fenceSlots?: Record<string, number> }
    }
    const counts = Object.fromEntries(RESOURCE_STATES.map(state => [`resources:${state}`, 0]))
    for (const resource of Object.values(sidecar.resources)) counts[`resources:${resource.state}`]!++
    return { resources: sidecar.resources, fenceSlots: sidecar.meta?.fenceSlots ?? {}, counts }
  }
  return withBookkeepingRead(directory, reader => {
    const resources: Record<string, TranscriptResource> = {}
    for (const row of reader.all("SELECT key FROM resources ORDER BY key")) {
      const key = String(row.key)
      const resource = readResource(reader, key)!
      const leases = reader.all("SELECT token FROM resource_leases WHERE resource_key=? ORDER BY token", key)
      if (leases.length) resource.activeLeases = Object.fromEntries(leases.map(lease => [
        String(lease.token), readResourceLease(reader, key, String(lease.token))!,
      ]))
      resources[key] = resource
    }
    const fenceSlots = Object.fromEntries(reader.all("SELECT slot,counter FROM fence_slots WHERE namespace='lifecycle'")
      .map(row => [String(row.slot), Number(row.counter)]))
    const counts = Object.fromEntries(reader.all("SELECT kind,value FROM bookkeeping_counts WHERE kind LIKE 'resources:%'")
      .map(row => [String(row.kind), Number(row.value)]))
    return { resources, fenceSlots, counts }
  })
}
