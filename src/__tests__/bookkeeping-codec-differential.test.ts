import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { canonicalizeLocator, resourceKey } from "../proxy/session/bookkeeping/locator"
import { STORE_META_KEY } from "../proxy/session/bookkeeping/legacyCodec"
import { enrichFixture } from "./fixtures/bookkeeping-rich-fixture"
import { nestedCodecCases } from "./fixtures/bookkeeping-nested-codec-corpus"
import type { CodecCase } from "./fixtures/bookkeeping-nested-codec-corpus"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"
import { migrateBookkeeping } from "../proxy/session/bookkeeping/migration"
import { exportBookkeepingJson } from "../proxy/session/bookkeeping/exportJson"
import { legacyInput, expectLegacyInput } from "./fixtures/bookkeeping-export-oracle"

interface ContractCase extends CodecCase { error?: string }

// Expected wire bytes follow the format contract, not the codec/exporter under test.
function expectedBytes(row: CodecCase): string {
  const input = JSON.parse(row.raw)
  if (row.kind === "store") return JSON.stringify({ [STORE_META_KEY]: { version: 1, slots: {} }, ...input })
  if (input.version === 2) return JSON.stringify(input) + "\n"
  const slots: Record<string, number> = {}
  const resources: Record<string, unknown> = {}
  for (const [key, resource] of Object.entries(input.resources as Record<string, object>)) {
    const slot = key.slice(0, 4)
    slots[slot] = (slots[slot] ?? 0) + 1
    resources[key] = { ...resource, key, generation: `r:${key}:${slots[slot]}` }
  }
  return JSON.stringify({ version: 2, meta: { fenceSlots: slots }, resources }) + "\n"
}

it("preserves the portable legacy codec corpus, wire bytes and malformed-record refusals", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bookkeeping-codec-differential-")))
  try {
    const data = join(root, "data")
    mkdirSync(data, { mode: 0o700 })
    const locator = canonicalizeLocator({ configDir: data, sessionId: "session" })
    const key = resourceKey(locator)
    const sidecar = { version: 1, resources: { [key]: {
      key, locator, state: "live", createdAt: 1, updatedAt: 2, attempts: 0, unknown: { b: 2, a: 1 },
    } }, unknown: "preserve-or-reject-identically" }
    const entry = { extension: { z: null, a: true }, claudeSessionId: "session", createdAt: 1,
      lastUsedAt: 2, messageCount: 2, sdkMessageUuids: [null, "uuid"], messageHashes: [] }
    const store = { [STORE_META_KEY]: { version: 3, slots: { abcd: 0, dcba: 7 },
      priorityAssignments: {}, priorityAttempts: {}, priorityRollbackMappings: {} }, entry }
    writeFileSync(join(data, "session-gc.json"), JSON.stringify(sidecar), { mode: 0o600 })
    writeFileSync(join(data, "sessions.json"), JSON.stringify(store), { mode: 0o600 })
    enrichFixture(data)
    const cases: ContractCase[] = []
    const add = (kind: "sidecar" | "store", value: unknown, error?: string) =>
      cases.push({ kind, raw: JSON.stringify(value), error })
    add("sidecar", sidecar)
    cases.push({ kind: "sidecar", raw: readFileSync(join(data, "session-gc.json"), "utf8") })
    add("store", store)
    cases.push({ kind: "store", raw: readFileSync(join(data, "sessions.json"), "utf8") })
    add("store", { [STORE_META_KEY]: { version: 1, slots: { abcd: 0, dcba: 7 } }, entry })
    add("store", { entry: Object.fromEntries(Object.entries(entry).reverse()) })
    add("sidecar", Object.fromEntries(Object.entries(sidecar).reverse()))
    for (const kind of ["sidecar", "store"] as const) {
      for (const raw of ["", "{", "null", "[]", "true", "1", '"text"', "{}"]) {
        const error = raw === "" || raw === "{" ? "JSON"
          : kind === "sidecar" ? "invalid or unsupported"
          : raw === "{}" ? undefined : "session store must contain a JSON object"
        cases.push({ kind, raw, error })
      }
    }
    for (const revision of [-1, 1.5, null, "1"])
      add("store", { entry: { ...entry, revision } }, 'session store entry "entry" has invalid revision')
    for (const sdkMessageUuids of [[undefined], [5], {}, "uuid"])
      add("store", { entry: { ...entry, sdkMessageUuids } }, Array.isArray(sdkMessageUuids) && sdkMessageUuids[0] === undefined
        ? undefined : 'session store entry "entry" has invalid sdkMessageUuids')
    for (const version of [0, 4, "3", null]) {
      add("sidecar", { ...sidecar, version }, "invalid or unsupported")
      add("store", { ...store, [STORE_META_KEY]: { ...store[STORE_META_KEY], version } }, "session store metadata has an unsupported format")
    }
    add("sidecar", { version: 2, meta: { fenceSlots: { abcd: 0 } }, resources: {} }, "invalid or unsupported")
    add("store", { ...store, [STORE_META_KEY]: { ...store[STORE_META_KEY], unknown: true } }, "session store v3 metadata has unknown or missing fields")
    add("store", { entry: { ...entry, currentTranscript: { configDir: "relative", sessionId: "session" } } },
      'session store entry "entry" has invalid current transcript locator')
    for (const row of nestedCodecCases(data)) {
      const label = row.label!
      let error: string | undefined
      if (row.kind === "sidecar") {
        const accepted = label.endsWith("duplicate-resource-valid-last") || label.endsWith("duplicate-resource-invalid-first")
          || label === "sidecar-v1/fence-slot-wrong-type" || label === "sidecar-v1/numeric-generation"
        if (!accepted) error = "invalid or unsupported"
      } else if (label.endsWith("numeric-generation-id")) error = 'session store entry "entry" has invalid generationId'
      else if (label.endsWith("fence-slot-wrong-type")) error = 'session store metadata has invalid generation slot "abcd"'
      cases.push({ ...row, error })
    }
    writeFileSync(join(root, "cases.json"), JSON.stringify(cases))
    const runner = join(root, "runner.ts")
    writeFileSync(runner, `
      import { readFileSync } from 'node:fs';
      import { parseLegacySidecar, serializeLegacySidecar, parseStoreDocument, serializeLegacyStore }
        from ${JSON.stringify(resolve("src/proxy/session/bookkeeping/legacyCodec.ts"))};
      const rows = JSON.parse(readFileSync(${JSON.stringify(join(root, "cases.json"))}, 'utf8'));
      const outcomes = [];
      for (const row of rows) {
        let current;
        try {
          current = {bytes: row.kind === 'sidecar'
            ? serializeLegacySidecar(parseLegacySidecar(row.raw, 'corpus-sidecar'))
            : serializeLegacyStore(parseStoreDocument(row.raw))};
        } catch(error) { current = {error: error.message}; }
        outcomes.push(current);
      }
      console.log(JSON.stringify(outcomes));
    `)
    const build = await Bun.build({ entrypoints: [runner], outdir: root, naming: "runner.mjs", target: "node" })
    expect(build.success, String(build.logs)).toBe(true)
    const result = spawnSync("node", [join(root, "runner.mjs")], { encoding: "utf8", timeout: 30000 })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const outcomes: Array<{ bytes?: string; error?: string }> =
      JSON.parse(result.stdout)
    expect(outcomes).toHaveLength(cases.length)
    expect(cases).toHaveLength(70)
    expect(outcomes.filter((row) => row.bytes !== undefined)).toHaveLength(17)
    expect(outcomes.filter((row) => row.error !== undefined)).toHaveLength(53)
    writeBenchArtifact("codec-differential-corpus.json", cases.map((row, index) => ({
      ...row, ...outcomes[index],
      expected: row.error ? { errorContains: row.error } : { bytes: expectedBytes(row) },
    })))
    for (const [index, row] of cases.entries()) {
      if (row.error) expect(outcomes[index]!.error, row.label ?? row.raw).toContain(row.error)
      else expect(outcomes[index], row.label ?? row.raw).toEqual({ bytes: expectedBytes(row) })
    }
    // Every accepted document runs through storage, not merely through the same serializer twice.
    for (const [index, row] of cases.entries()) {
      const cycle = join(root, `roundtrip-${index}`)
      mkdirSync(cycle, { mode: 0o700 })
      writeFileSync(join(cycle, "session-gc.json"), row.kind === "sidecar" ? row.raw
        : readFileSync(join(data, "session-gc.json")), { mode: 0o600 })
      writeFileSync(join(cycle, "sessions.json"), row.kind === "store" ? row.raw
        : JSON.stringify({ [STORE_META_KEY]: { version: 1, slots: {} } }), { mode: 0o600 })
      if (row.error !== undefined) {
        await expect(migrateBookkeeping(cycle, { writersStopped: true }), row.label ?? row.raw).rejects.toThrow()
      } else {
        const original = legacyInput(cycle)
        await migrateBookkeeping(cycle, { writersStopped: true })
        exportBookkeepingJson(cycle)
        expectLegacyInput(cycle, original)
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 60000)
