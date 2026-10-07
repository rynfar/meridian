import { expect, it } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import {
  getStoredSessionGeneration,
  parseLegacySidecar,
  parseLegacyStoreForMaintenance,
  parseStoreDocument,
  serializeLegacySidecar,
  serializeLegacyStore,
  STORE_META_KEY,
} from "../proxy/session/bookkeeping/legacyCodec"
import { resourceKey } from "../proxy/session/bookkeeping/locator"
import type { ProcessIncarnation } from "../proxy/session/processIncarnation"

const locator = { sessionId: "session", configDir: "/profiles/test" }
const key = resourceKey(locator)
const owner: ProcessIncarnation = {
  version: 1,
  pid: 1234,
  hostId: "a".repeat(64),
  bootId: "00000000-0000-0000-0000-000000000001",
  startId: "7",
  startIdKind: "linux-proc-start-ticks",
}

it("upgrades v1 sidecar using its original key-slot allocation and round-trips v2", () => {
  const resource = {
    key,
    locator,
    state: "deleting",
    createdAt: 1,
    updatedAt: 2,
    attempts: 0,
    activeLeases: { lease: { token: "lease", owner, purpose: "publication", createdAt: 1 } },
  }
  const upgraded = parseLegacySidecar(JSON.stringify({ version: 1, resources: { [key]: resource } }))
  expect(upgraded.version).toBe(2)
  expect(upgraded.meta.fenceSlots).toEqual({ [key.slice(0, 4)]: 1 })
  expect(upgraded.resources[key]?.generation).toBe(`r:${key}:1`)
  expect(upgraded.resources[key]?.activeLeases?.lease?.owner).toEqual(owner)
  const serialized = serializeLegacySidecar(upgraded)
  expect(serialized).toBe(JSON.stringify(upgraded) + "\n")
  expect(serializeLegacySidecar(parseLegacySidecar(serialized))).toBe(serialized)
})

it("retains v2 generations, optional false, unknown fields and JSON property order", () => {
  const raw = {
    version: 2,
    unknown: { z: 1, a: 2 },
    meta: { fenceSlots: { [key.slice(0, 4)]: 42 } },
    resources: {
      [key]: {
        key,
        locator,
        generation: `r:${key}:40`,
        state: "live",
        createdAt: 1,
        updatedAt: 2,
        attempts: 0,
        activeLeases: {
          lease: {
            token: "lease",
            owner,
            executor: owner,
            executorRecoverable: false,
            createdAt: 1,
          },
        },
      },
    },
  }
  expect(serializeLegacySidecar(parseLegacySidecar(JSON.stringify(raw)))).toBe(JSON.stringify(raw) + "\n")
  expect(
    parseLegacySidecar(JSON.stringify(raw)).resources[key]?.activeLeases?.lease?.executorRecoverable,
  ).toBe(false)
})

it("preserves the exact legacy-entry digest, history NULLs, and store v1 encoding", () => {
  const entry = {
    unknown: { z: 1, a: 2 },
    messageHashes: [],
    claudeSessionId: "session",
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 2,
    sdkMessageUuids: [null, "uuid"],
    currentTranscript: locator,
  }
  const document = {
    [STORE_META_KEY]: { version: 1, slots: { abcd: 0 } },
    mapping: entry,
  }
  const raw = JSON.stringify(document)
  const decoded = parseStoreDocument(raw)
  expect(serializeLegacyStore(decoded)).toBe(raw)
  expect(JSON.stringify(decoded.sessions.mapping)).toBe(JSON.stringify(entry))
  const digest = (value: string) => createHash("sha256").update(value).digest("hex")
  expect(getStoredSessionGeneration(decoded.sessions.mapping!, "mapping")).toBe(
    `p:${digest("mapping")}:legacy-${digest(JSON.stringify(entry))}`,
  )
})

it("round-trips v3 priority assignment, attempt, rollback and retained mapping without normalizing tokens", () => {
  const make = (session: string) => ({
    claudeSessionId: session,
    generationId: randomUUID(),
    revision: 1,
    createdAt: 1,
    lastUsedAt: 2,
    messageCount: 0,
  })
  const current = make("new"),
    previous = make("previous")
  const document = {
    [STORE_META_KEY]: {
      version: 3,
      slots: { abcd: 7 },
      priorityAssignments: {
        route: {
          profileId: "profile",
          lastHumanTurnDigest: "a".repeat(43),
          lastHumanTurnIssuedAt: 1,
          mappingKey: "current",
          mappingGeneration: getStoredSessionGeneration(current, "current"),
          generationId: randomUUID(),
          updatedAt: 2,
        },
      },
      priorityAttempts: {
        route: {
          blocked: true,
          blockedTurnDigest: null,
          blockedTurnIssuedAt: null,
          pendingTurnDigest: null,
          pendingTurnIssuedAt: null,
          ownerToken: null,
          generationId: randomUUID(),
          updatedAt: 2,
        },
      },
      priorityRollbackMappings: {
        route: {
          mappingKey: "previous",
          mappingGeneration: getStoredSessionGeneration(previous, "previous"),
        },
      },
    },
    current,
    previous,
  }
  const raw = JSON.stringify(document)
  expect(serializeLegacyStore(parseStoreDocument(raw))).toBe(raw)
  const broken = structuredClone(document)
  broken[STORE_META_KEY].priorityRollbackMappings.route.mappingGeneration = getStoredSessionGeneration(
    make("other"),
    "previous",
  )
  expect(() => parseStoreDocument(JSON.stringify(broken))).toThrow("stale mapping generation")
  const inherited = { ...document, [STORE_META_KEY]: {
    ...document[STORE_META_KEY], priorityAssignments: {},
    priorityRollbackMappings: { constructor: document[STORE_META_KEY].priorityRollbackMappings.route },
  } }
  expect(() => parseStoreDocument(JSON.stringify(inherited))).not.toThrow()
  expect(() => parseLegacyStoreForMaintenance(JSON.stringify(inherited))).toThrow("lacks an own assignment")
})

it("rejects corrupt/unsupported documents without confusing them with absent input", () => {
  for (const raw of ["", "null", "[]", "not json", '{"version":99,"resources":{}}']) {
    expect(() => parseLegacySidecar(raw, "source-sidecar")).toThrow("source-sidecar")
  }
  for (const raw of ["", "null", "[]", "not json", '{"bad":{}}']) {
    expect(() => parseStoreDocument(raw)).toThrow()
  }
  expect(parseStoreDocument("{}")).toEqual({ sessions: {}, meta: { version: 1, slots: {} } })
  expect(() =>
    parseLegacySidecar(
      JSON.stringify({
        version: 2,
        meta: { fenceSlots: {} },
        resources: {
          [key]: {
            key,
            locator,
            generation: `r:${key}:1`,
            state: "live",
            createdAt: 1,
            updatedAt: 2,
            attempts: 0,
          },
        },
      }),
    ),
  ).toThrow("invalid or unsupported")
})

it("maintenance rejects inherited decoder key loss without changing the legacy request decoder", () => {
  const entry = { claudeSessionId: "c", createdAt: 1, lastUsedAt: 2, messageCount: 0 }
  const raw = JSON.stringify({ ["__proto__"]: entry })
  expect(Object.keys(parseStoreDocument(raw).sessions)).toEqual([])
  expect(() => parseLegacyStoreForMaintenance(raw)).toThrow("without data loss")
  const ordinary = JSON.stringify({ normal: entry })
  expect(parseLegacyStoreForMaintenance(ordinary)).toEqual(parseStoreDocument(ordinary))
})
