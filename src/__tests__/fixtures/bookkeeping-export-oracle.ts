import { expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { digestBytes } from "../../proxy/session/bookkeeping/maintenanceJournal"
import { parseLegacySidecar, parseLegacyStoreForMaintenance } from "../../proxy/session/bookkeeping/legacyCodec"

/** Source-derived oracle, never obtained from the SQL exporter under test. v1 upgrades are explicit. */
export function legacyInput(directory: string) {
  return {
    sidecar: parseLegacySidecar(readFileSync(join(directory, "session-gc.json"), "utf8")),
    store: parseLegacyStoreForMaintenance(readFileSync(join(directory, "sessions.json"), "utf8")),
  }
}

export function expectLegacyInput(directory: string, expected: ReturnType<typeof legacyInput>): void {
  const actual = legacyInput(directory)
  expect(actual).toEqual(expected)
  for (const [source, exported] of [[expected.sidecar.resources, actual.sidecar.resources],
    [expected.store.sessions, actual.store.sessions]] as const) {
    for (const [key, entry] of Object.entries(source)) {
      expect(digestBytes(JSON.stringify(exported[key])), key).toBe(digestBytes(JSON.stringify(entry)))
    }
  }
}
