import { readFileSync } from "node:fs"
import { join } from "node:path"
import { STORE_META_KEY } from "../../proxy/session/bookkeeping/legacyCodec"

export interface CodecCase { kind: "sidecar" | "store"; raw: string; label?: string }
interface SidecarDocument {
  version: number
  meta: { fenceSlots: Record<string, unknown> }
  resources: Record<string, Record<string, unknown>>
}

export function nestedCodecCases(directory: string): CodecCase[] {
  const sidecarRaw = readFileSync(join(directory, "session-gc.json"), "utf8")
  const storeRaw = readFileSync(join(directory, "sessions.json"), "utf8")
  const rows: CodecCase[] = []
  for (const version of [1, 2]) {
    const mutate = (label: string, edit: (resource: Record<string, unknown>, doc: SidecarDocument) => void) => {
      const doc: SidecarDocument = JSON.parse(sidecarRaw)
      doc.version = version
      if (version === 1) for (const resource of Object.values(doc.resources)) delete resource.generation
      edit(Object.values(doc.resources)[0]!, doc)
      rows.push({ kind: "sidecar", label: `sidecar-v${version}/${label}`, raw: JSON.stringify(doc) })
    }
    mutate("resource-missing-key", (row) => { delete row.key })
    mutate("resource-missing-state", (row) => { delete row.state })
    mutate("resource-unknown-state", (row) => { row.state = "imaginary" })
    mutate("lease-missing-incarnation", (row) => {
      row.activeLeases = { bad: { token: "bad", createdAt: 1 } }
    })
    mutate("lease-invalid-incarnation", (row) => {
      row.activeLeases = { bad: { token: "bad", owner: {}, createdAt: 1 } }
    })
    mutate("fence-slot-wrong-type", (_row, doc) => { doc.meta.fenceSlots.abcd = "9" })
    mutate("numeric-generation", (row) => { row.generation = 7 })
    mutate("negative-attempts", (row) => { row.attempts = -1 })

    const doc: SidecarDocument = JSON.parse(sidecarRaw)
    doc.version = version
    const key = Object.keys(doc.resources)[0]!
    const valid = { ...doc.resources[key] }
    if (version === 1) delete valid.generation
    const invalid = { ...valid, attempts: -1 }
    const later = { ...valid, attempts: 42 }
    // Raw text is essential: an object literal/JSON.stringify cannot carry duplicate keys.
    for (const [label, first, last] of [
      ["duplicate-resource-valid-last", valid, later],
      ["duplicate-resource-invalid-first", invalid, valid],
      ["duplicate-resource-invalid-last", valid, invalid],
    ] as const) {
      rows.push({ kind: "sidecar", label: `sidecar-v${version}/${label}`,
        raw: `{"version":${version},"meta":${JSON.stringify(doc.meta)},"resources":{`
          + `${JSON.stringify(key)}:${JSON.stringify(first)},${JSON.stringify(key)}:${JSON.stringify(last)}}}` })
    }
  }
  for (const version of [1, 3]) {
    const mutate = (label: string, edit: (doc: Record<string, Record<string, unknown>>) => void) => {
      const doc: Record<string, Record<string, unknown>> = JSON.parse(storeRaw)
      if (version === 1) doc[STORE_META_KEY] = { version: 1, slots: { abcd: 0, dcba: 12 } }
      edit(doc)
      rows.push({ kind: "store", label: `store-v${version}/${label}`, raw: JSON.stringify(doc) })
    }
    mutate("mapping-missing-resource", (doc) => {
      // Valid mapping identity and absolute locator, but no such resource in the paired sidecar.
      doc.entry!.currentTranscript = { configDir: join(directory, "missing-config"), sessionId: "session" }
    })
    mutate("numeric-generation-id", (doc) => { doc.entry!.generationId = 7 })
    mutate("fence-slot-wrong-type", (doc) => { doc[STORE_META_KEY]!.slots = { abcd: "9" } })
  }
  return rows
}
