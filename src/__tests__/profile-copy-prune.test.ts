/**
 * Superseded cross-profile copies of one conversation: which are pruned, which
 * are kept, and how a mass first prune drains through the transcript backlog
 * without starving fresh-request admission.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { pathToFileURL } from "node:url"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, closeSync, fsyncSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CrossProcessTurnCoordinator } from "../proxy/session/crossProcessTurnCoordinator"
import {
  abandonFork,
  prepareFork,
  reconcile,
  registerLiveTranscript,
  releaseSupersededProfileCopies,
  runGc,
  type SessionLifecycleOptions,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"
import {
  DEFAULT_PROFILE_COPY_GRACE_MS,
  pruneSupersededProfileCopies,
  readSessionStoreSnapshot,
  setSessionStoreDir,
} from "../proxy/sessionStore"

const META_KEY = "\u0000meridian-session-store"
const HOUR = 60 * 60_000
const GRACE = DEFAULT_PROFILE_COPY_GRACE_MS
const PROFILES = ["work", "personal", "spare"]

interface FixtureCopy {
  key: string
  ageMs: number
  transcript?: boolean
}

type FixtureDocument = Record<string, Record<string, unknown>>

function writeStore(
  dir: string,
  copies: FixtureCopy[],
  decorate: (document: FixtureDocument) => void = () => {},
): void {
  const now = Date.now()
  const document: FixtureDocument = { [META_KEY]: { version: 1, slots: {} } }
  for (const copy of copies) {
    const claudeSessionId = randomUUID()
    document[copy.key] = {
      claudeSessionId,
      revision: 1,
      generationId: randomUUID(),
      createdAt: now - copy.ageMs,
      lastUsedAt: now - copy.ageMs,
      messageCount: 1,
      messageHashes: ["m"],
      ...(copy.transcript === false ? {} : {
        currentTranscript: { sessionId: claudeSessionId, configDir: join(dir, "config"), projectDir: join(dir, "config", "p") },
      }),
    }
  }
  decorate(document)
  const temp = join(dir, `sessions.json.tmp-${randomUUID()}`)
  const fd = openSync(temp, "wx", 0o600)
  writeFileSync(fd, JSON.stringify(document))
  fsyncSync(fd)
  closeSync(fd)
  renameSync(temp, join(dir, "sessions.json"))
}

function storedKeys(): string[] {
  return Object.keys(readSessionStoreSnapshot()).sort()
}

function prune(overrides: Partial<Parameters<typeof pruneSupersededProfileCopies>[0]> = {}): Promise<number> {
  return pruneSupersededProfileCopies({
    profileIds: PROFILES,
    graceMs: GRACE,
    maxUnpinnedTranscripts: 1_000,
    isConversationActive: () => false,
    ...overrides,
  })
}

describe("pruneSupersededProfileCopies", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "profile-copies-"))
    setSessionStoreDir(dir)
  })

  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it("keeps the newest copy of a conversation and removes older copies past the grace window", async () => {
    writeStore(dir, [
      { key: "work:ses_a", ageMs: GRACE + 5 * HOUR },
      { key: "personal:ses_a", ageMs: GRACE + 2 * HOUR },
      { key: "ses_a", ageMs: 1_000 },
      { key: "work:ses_b", ageMs: GRACE + 9 * HOUR },
    ])
    expect(await prune()).toBe(2)
    expect(storedKeys()).toEqual(["ses_a", "work:ses_b"])
  })

  it("keeps every copy touched within the grace window, and a zero grace keeps only the newest", async () => {
    writeStore(dir, [
      { key: "work:ses_a", ageMs: 30 * 60_000 },
      { key: "personal:ses_a", ageMs: 1_000 },
    ])
    expect(await prune()).toBe(0)
    expect(storedKeys()).toEqual(["personal:ses_a", "work:ses_a"])
    expect(await prune({ graceMs: 0 })).toBe(1)
    expect(storedKeys()).toEqual(["personal:ses_a"])
  })

  it("by default keeps a copy for a day, past an account's 5-hour usage window", async () => {
    expect(GRACE).toBe(24 * HOUR)
    writeStore(dir, [
      { key: "work:ses_a", ageMs: 23 * HOUR },
      { key: "work:ses_b", ageMs: 25 * HOUR },
      { key: "personal:ses_a", ageMs: 1_000 },
      { key: "personal:ses_b", ageMs: 1_000 },
    ])
    expect(await prune()).toBe(1)
    expect(storedKeys()).toEqual(["personal:ses_a", "personal:ses_b", "work:ses_a"])
  })

  it("groups only configured profile prefixes, never unrelated keys that contain a colon", async () => {
    writeStore(dir, [
      { key: "unknown:ses_a", ageMs: GRACE + 5 * HOUR },
      { key: "work:ses_a", ageMs: 1_000 },
      { key: "ses_a#title", ageMs: GRACE + 5 * HOUR },
    ])
    expect(await prune()).toBe(0)
  })

  it("keeps every copy of a conversation that has a request in flight", async () => {
    writeStore(dir, [
      { key: "work:ses_a", ageMs: GRACE + 5 * HOUR },
      { key: "personal:ses_a", ageMs: 1_000 },
      { key: "work:ses_b", ageMs: GRACE + 5 * HOUR },
      { key: "personal:ses_b", ageMs: 1_000 },
    ])
    expect(await prune({ isConversationActive: (id) => id === "ses_a" })).toBe(1)
    expect(storedKeys()).toEqual(["personal:ses_a", "personal:ses_b", "work:ses_a"])
  })

  it("never removes a mapping a priority route depends on", async () => {
    writeStore(dir, [
      { key: "work:ses_a", ageMs: GRACE + 5 * HOUR },
      { key: "personal:ses_a", ageMs: 1_000 },
    ], (document) => {
      const digest = createHash("sha256").update("work:ses_a").digest("hex")
      document[META_KEY] = {
        version: 3,
        slots: {},
        priorityAssignments: {
          "route-a": {
            profileId: "work",
            lastHumanTurnDigest: "A".repeat(43),
            lastHumanTurnIssuedAt: 1,
            mappingKey: "work:ses_a",
            mappingGeneration: `p:${digest}:${document["work:ses_a"]!.generationId}`,
            generationId: randomUUID(),
            updatedAt: Date.now(),
          },
        },
        priorityAttempts: {},
        priorityRollbackMappings: {},
      }
    })
    expect(await prune()).toBe(0)
    expect(storedKeys()).toEqual(["personal:ses_a", "work:ses_a"])
  })

  it("stops once the removed mappings would unpin more transcripts than the budget, oldest first", async () => {
    writeStore(dir, [
      { key: "work:ses_a", ageMs: GRACE + 9 * HOUR },
      { key: "work:ses_b", ageMs: GRACE + 8 * HOUR, transcript: false },
      { key: "work:ses_c", ageMs: GRACE + 7 * HOUR },
      { key: "personal:ses_a", ageMs: 1_000 },
      { key: "personal:ses_b", ageMs: 1_000 },
      { key: "personal:ses_c", ageMs: 1_000 },
    ])
    // ses_a costs 1, ses_b (no transcript) costs 0, ses_c would exceed.
    expect(await prune({ maxUnpinnedTranscripts: 1 })).toBe(2)
    expect(storedKeys()).toEqual(["personal:ses_a", "personal:ses_b", "personal:ses_c", "work:ses_c"])
  })

  it("takes no lock and writes nothing when nothing is superseded", async () => {
    writeStore(dir, [{ key: "work:ses_a", ageMs: GRACE + 5 * HOUR }])
    const before = readFileSync(join(dir, "sessions.json"), "utf8")
    expect(await prune()).toBe(0)
    expect(readFileSync(join(dir, "sessions.json"), "utf8")).toBe(before)
  })
})

describe("cross-process turn activity", () => {
  it("reports a conversation active exactly while another coordinator holds its turn lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "profile-copies-turns-"))
    try {
      const holder = new CrossProcessTurnCoordinator(root)
      const observer = new CrossProcessTurnCoordinator(root)
      expect(observer.isHeld("session:ses_a")).toBe(false)
      const lease = await holder.acquire("session:ses_a")
      expect(observer.isHeld("session:ses_a")).toBe(true)
      expect(observer.isHeld("session:ses_b")).toBe(false)
      await lease.release()
      expect(observer.isHeld("session:ses_a")).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("mass prune through the transcript lifecycle", () => {
  it("retains copies when a foreign turn acquires after an idle observation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-copy-arriving-turn-"))
    const root = join(dir, "turns"), held = join(dir, "held"), go = join(dir, "go")
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../proxy/session/crossProcessTurnCoordinator.ts")).href
    const worker = spawn(process.execPath, ["--eval", `
      import { existsSync, writeFileSync } from 'node:fs';
      const { CrossProcessTurnCoordinator } = await import(${JSON.stringify(moduleUrl)});
      while(!existsSync(${JSON.stringify(go)})) await new Promise(r=>setTimeout(r,5));
      const lease = await new CrossProcessTurnCoordinator(${JSON.stringify(root)}).acquire('session:arrival');
      writeFileSync(${JSON.stringify(held)},'held');
      const timer=setInterval(()=>{},1000);
      process.on('SIGTERM',async()=>{await lease.release();clearInterval(timer);process.exit(0)});
    `], { stdio: ["ignore", "ignore", "pipe"] })
    const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()))
    try {
      setSessionStoreDir(dir)
      writeStore(dir, [{ key: "work:arrival", ageMs: GRACE + HOUR }, { key: "personal:arrival", ageMs: 1_000 }])
      const coordinator = new CrossProcessTurnCoordinator(root)
      let observed = false
      const removed = await releaseSupersededProfileCopies({ profileIds: PROFILES, graceMs: GRACE,
        isConversationActive: () => {
          // Snapshot idle, then force another OS process to publish its lease.
          // A boolean observation alone must not authorize mapping deletion.
          if (!observed) {
            observed = true
            expect(coordinator.isHeld("session:arrival")).toBe(false)
            writeFileSync(go, "go")
            const deadline = Date.now() + 5_000
            while (!existsSync(held) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
            expect(existsSync(held)).toBe(true)
          }
          return false
        },
      }, { storeDir: dir, pinProvider: () => Object.values(readSessionStoreSnapshot()).flatMap(x => x.currentTranscript ? [x.currentTranscript] : []) }, coordinator)
      expect(removed).toBe(0)
      expect(storedKeys()).toEqual(["personal:arrival", "work:arrival"])
    } finally {
      worker.kill("SIGTERM")
      await exited
      setSessionStoreDir(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("reserves half-budget capacity across competing sweeps before either GC reconciliation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-copy-competing-sweeps-"))
    setSessionStoreDir(dir)
    try {
      writeStore(dir, Array.from({ length: 8 }, (_, n) => [
        { key: `work:competing-${n}`, ageMs: GRACE + HOUR },
        { key: `personal:competing-${n}`, ageMs: 1_000 },
      ]).flat())
      const pins = (): TranscriptLocator[] => Object.values(readSessionStoreSnapshot())
        .flatMap(session => session.currentTranscript ? [session.currentTranscript] : [])
      const options: SessionLifecycleOptions = { storeDir: dir, maxPending: 8, pinProvider: pins }
      for (const locator of pins()) await registerLiveTranscript({ ...locator }, options)
      const removed = await Promise.all([0, 1].map(() => releaseSupersededProfileCopies({
        profileIds: PROFILES, graceMs: GRACE, isConversationActive: () => false,
      }, options)))
      expect(removed.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(4)
      await reconcile(pins(), options)
      const sidecar = JSON.parse(readFileSync(join(dir, "session-gc.json"), "utf8")) as { resources: Record<string, { state: string }> }
      expect(Object.values(sidecar.resources).filter(resource => ["prepared", "retired", "deleting"].includes(resource.state)).length).toBeLessThanOrEqual(4)
    } finally {
      setSessionStoreDir(null)
      rmSync(dir, { recursive: true, force: true })
    }
  })
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "profile-copies-mass-"))
    setSessionStoreDir(dir)
  })

  afterEach(() => {
    setSessionStoreDir(null)
    rmSync(dir, { recursive: true, force: true })
  })

  it("drains many superseded copies over successive sweeps while fresh admission keeps working", async () => {
    const maxPending = 16
    const conversations = 20
    const staleCopies: FixtureCopy[] = []
    const newest: FixtureCopy[] = []
    for (let index = 0; index < conversations; index++) {
      newest.push({ key: `spare:ses_${index}`, ageMs: 1_000 })
      staleCopies.push({ key: `work:ses_${index}`, ageMs: GRACE + (10 + index) * HOUR })
      staleCopies.push({ key: `personal:ses_${index}`, ageMs: GRACE + (40 + index) * HOUR })
    }
    writeStore(dir, [...staleCopies, ...newest])
    const options: SessionLifecycleOptions = {
      storeDir: dir,
      maxPending,
      maxDeletesPerRun: 4,
      preparedGraceMs: 60 * 60_000,
      retiredGraceMs: 0,
      lockWaitMs: 2_000,
      lockRetryMs: 5,
      deleter: async () => {},
    }
    const pins = (): TranscriptLocator[] => Object.values(readSessionStoreSnapshot())
      .flatMap((session) => session.currentTranscript ? [session.currentTranscript] : [])
    for (const locator of pins()) await registerLiveTranscript({ ...locator }, options)
    options.pinProvider = pins

    let sweeps = 0
    let maxObservedPending = 0
    while (Object.keys(readSessionStoreSnapshot()).length > conversations) {
      sweeps++
      expect(sweeps).toBeLessThan(40)
      await releaseSupersededProfileCopies({
        profileIds: PROFILES,
        graceMs: GRACE,
        isConversationActive: () => false,
      }, options)
      await reconcile(pins(), options)
      const sidecar = JSON.parse(readFileSync(join(dir, "session-gc.json"), "utf8")) as {
        resources: Record<string, { state: string }>
      }
      const pending = Object.values(sidecar.resources)
        .filter((resource) => ["prepared", "retired", "deleting"].includes(resource.state)).length
      maxObservedPending = Math.max(maxObservedPending, pending)
      expect(pending).toBeLessThanOrEqual(maxPending / 2)
      // Admission shares the backlog; the prune must never leave it without room.
      const fresh = await prepareFork({ sessionId: randomUUID(), configDir: join(dir, "config"), projectDir: join(dir, "config", "p") }, options)
      await abandonFork(fresh, options)
      await runGc(pins(), options)
    }
    expect(sweeps).toBeGreaterThan(1)
    expect(maxObservedPending).toBeGreaterThan(0)
    expect(storedKeys()).toEqual(newest.map((copy) => copy.key).sort())
  })
})
