/**
 * Session-GC deletion-budget regressions.
 *
 * runGc used to charge its own run deadline against every deletion:
 * `deletionTimeout = min(deletionTimeoutMs, max(1, deadline - now))`
 * truncated an already-started claim to the run's remainder. On a loaded
 * host the executor handshake (durable attach under the sidecar lock) queues
 * behind other lifecycle holders in the FIFO, so the remainder could be gone
 * before the attach ever completed, causing gate timeouts (exit 75). The fix
 * splits the budgets: the run deadline only forbids beginning the NEXT claim;
 * an already-started deletion gets its full deletion budget plus its own
 * handshake budget, keeping the executor fencing intact.
 *
 * The durableFileSystem mock is a pass-through unless a test holds a gate, so
 * a leak into another suite in the same `bun test` invocation is inert.
 */

import { describe, expect, mock, test, afterEach } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import * as realDurableFs from "../proxy/session/durableFileSystem"

interface SyncGate {
  promise: Promise<void>
  release: () => void
}

// The next N syncDirectoryDurably calls park until released, in call order.
let syncGates: SyncGate[] = []

// Capture the original by value BEFORE mock.module: bun patches the module
// namespace in place, so reading it through the namespace inside the wrapper
// would re-enter the mock.
const realSyncDirectoryDurably = realDurableFs.syncDirectoryDurably

mock.module("../proxy/session/durableFileSystem", () => ({
  ...realDurableFs,
  syncDirectoryDurably: async (path: string): Promise<void> => {
    const gate = syncGates[0]
    if (gate) await gate.promise
    return realSyncDirectoryDurably(path)
  },
}))

const { abandonFork, getTranscriptResourceKey, prepareFork, runGc } = await import(
  "../proxy/sessionLifecycle"
)
type TranscriptLocator = Parameters<typeof prepareFork>[0]

function holdNextSync(count: number): void {
  for (let index = 0; index < count; index++) {
    let release!: () => void
    const promise = new Promise<void>((resolve) => {
      release = resolve
    })
    syncGates.push({ promise, release })
  }
}

function releaseNextSync(): void {
  syncGates.shift()?.release()
}

function releaseAllSyncs(): void {
  while (syncGates.length) syncGates.shift()!.release()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(desc: string, probe: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${desc}`)
}

// A stand-in for @anthropic-ai/claude-agent-sdk. deleteSession records the
// session id it was asked to delete (keyed off CLAUDE_CONFIG_DIR, which the
// fenced child sets per locator) so the test can prove the child actually
// ran, then optionally delays or hangs. The delay must be well below every
// deletion budget in play so only the defect under test can truncate it.
interface StubBehavior {
  delayMs?: number
  hang?: boolean
}

function stubSdkSource(behavior: StubBehavior): string {
  return `\
import { appendFileSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { dirname } from "node:path"
export async function deleteSession(sessionId, options) {
  const log = process.env.CLAUDE_CONFIG_DIR + ".deleted.log"
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, JSON.stringify({ sessionId, dir: options?.dir ?? null }) + "\\n")
  const delay = ${behavior.delayMs ?? 0}
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  if (${behavior.hang ? "true" : "false"}) {
    // A live handle keeps the child's event loop alive; without it node
    // would end the unsettled top-level await with exit code 13 instead of
    // hanging for the parent to kill.
    createServer().listen(0)
    const { promise } = Promise.withResolvers()
    await promise
  }
}
`
}

async function makeFixture(
  sessionId: string,
  stubBehavior: StubBehavior = {},
): Promise<{
  root: string
  storeDir: string
  locator: TranscriptLocator
  deletionLog: string
  sdkModuleUrl: string
}> {
  const root = await mkdtemp(join(tmpdir(), "meridian-gc-budgets-"))
  tempRoots.push(root)
  const storeDir = join(root, "store")
  const configDir = join(root, "config")
  const projectDir = join(root, "project")
  await mkdir(storeDir, { recursive: true })
  const sdkPath = join(root, "stub-sdk.mjs")
  await writeFile(sdkPath, stubSdkSource(stubBehavior), "utf8")
  return {
    root,
    storeDir,
    locator: { sessionId, configDir, projectDir },
    deletionLog: `${configDir}.deleted.log`,
    sdkModuleUrl: pathToFileURL(sdkPath).href,
  }
}

const tempRoots: string[] = []

afterEach(async () => {
  releaseAllSyncs()
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

interface StoredResource {
  state: string
  deletionToken?: string
  deletionOwner?: unknown
  deletionExecutor?: unknown
  deletionProcessGroupId?: number
  attempts?: number
  lastError?: string
}

interface StoredSidecar {
  resources: Record<string, StoredResource>
}

function readSidecar(storeDir: string): StoredSidecar {
  return JSON.parse(readFileSync(join(storeDir, "session-gc.json"), "utf8")) as StoredSidecar
}

function gatePath(storeDir: string, resource: StoredResource | undefined): string {
  if (!resource?.deletionToken) throw new Error("resource has no deletion token")
  return join(storeDir, "deletion-gates", `${resource.deletionToken}.go`)
}

function gcOptions(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return {
    storeDir: fixture.storeDir,
    preparedGraceMs: 0,
    retiredGraceMs: 0,
    lockWaitMs: 2_000,
    lockRetryMs: 5,
    sdkModuleUrl: fixture.sdkModuleUrl,
    // Failure retries are re-claimable on the immediately following pass.
    retryBaseMs: 1,
    retryMaxMs: 8,
  }
}

describe("session GC deletion budgets", () => {
  test(
    "a slow claim does not truncate the next deletion's budget (the run deadline only gates new claims)",
    async () => {
      const fixture = await makeFixture("gc-budget-claim-delay", { delayMs: 30 })
      const options = { ...gcOptions(fixture), runTimeoutMs: 150, deletionTimeoutMs: 5_000 }
      const key = getTranscriptResourceKey(fixture.locator)

      const exact = await prepareFork(fixture.locator, options)
      await abandonFork(exact, options)
      expect(readSidecar(fixture.storeDir).resources[key]?.state).toBe("retired")

      // Park the claim's durable sidecar publish. The rename has already
      // landed at that point (state=deleting, no executor on disk) while
      // claimDeletion is still the active lock holder, so the short run
      // deadline burns entirely inside the claim.
      holdNextSync(1)
      try {
        const swept = runGc([], options)
        await waitFor("claimed resource visible as deleting without an executor", () => {
          const resource = readSidecar(fixture.storeDir).resources[key]
          return resource?.state === "deleting" && resource.deletionExecutor === undefined
        })

        // Let the run budget expire while the claim is still pending.
        await sleep(400)

        releaseNextSync()
        const result = await swept
        expect(result.failed).toBe(0)
        expect(result.deleted).toBe(1)
        expect(readSidecar(fixture.storeDir).resources[key]?.state).toBe("deleted")
        expect(existsSync(fixture.deletionLog)).toBe(true)
      } finally {
        releaseAllSyncs()
      }
    },
    60_000,
  )

  test(
    "a handshake queued behind the lifecycle FIFO times out with the gate closed, and fencing holds",
    async () => {
      const fixture = await makeFixture("gc-handshake-fifo", { delayMs: 30 })
      // A generous prepared grace keeps reconcile's passive retirement from
      // touching the still-prepared blocker, so the first durable publish in
      // this sweep belongs to the main claim.
      const options = {
        ...gcOptions(fixture),
        preparedGraceMs: 300_000,
        // One claim per sweep: the point is the handshake failure of the
        // first (fenced) claim, not whatever a retry loop deletes after the
        // fences released.
        maxDeletesPerRun: 1,
        deletionTimeoutMs: 5_000,
        deletionHandshakeTimeoutMs: 400,
      }
      const key = getTranscriptResourceKey(fixture.locator)

      const exact = await prepareFork(fixture.locator, options)
      await abandonFork(exact, options)

      // A second fork in the same store: its abandon will park in the FIFO
      // ahead of the attach, standing in for any concurrent lifecycle holder.
      const blockerLocator: TranscriptLocator = {
        sessionId: "gc-handshake-fifo-blocker",
        configDir: join(fixture.root, "config-blocker"),
        projectDir: join(fixture.root, "project-blocker"),
      }
      const blockerExact = await prepareFork(blockerLocator, options)

      // G1 parks the claim's durable publish (rename already landed).
      holdNextSync(1)
      try {
        const swept = runGc([], options)
        await waitFor("main resource claimed", () =>
          readSidecar(fixture.storeDir).resources[key]?.state === "deleting")

        // G2 parks the blocker's abandon publish. It queues in the FIFO
        // behind the claim holder; once the claim releases, it becomes the
        // active holder and the attach must queue behind it.
        holdNextSync(1)
        const blockerAbandoned = abandonFork(blockerExact, options)
        releaseNextSync()
        // The blocker's rename proves it held the lock while the attach
        // queues behind it. Do not await the abandon itself here: it stays
        // parked in G2 until the handshake deadline has passed.
        const blockerKey = getTranscriptResourceKey(blockerLocator)
        await waitFor("blocker retired on disk", () =>
          readSidecar(fixture.storeDir).resources[blockerKey]?.state === "retired")

        // The attach is now waiting in the FIFO. Its handshake budget burns
        // while the gate stays closed: the child never reaches the SDK.
        await sleep(700)
        const pending = readSidecar(fixture.storeDir).resources[key]
        expect(pending?.state).toBe("deleting")
        const stalledGatePath = gatePath(fixture.storeDir, pending)
        expect(existsSync(stalledGatePath)).toBe(false)
        expect(existsSync(fixture.deletionLog)).toBe(false)

        releaseNextSync()
        await blockerAbandoned
        const result = await swept
        expect(result.deleted).toBe(0)
        expect(result.failed).toBe(1)

        const settled = readSidecar(fixture.storeDir).resources[key]
        expect(settled?.state).toBe("retired")
        expect(settled?.deletionToken).toBeUndefined()
        expect(settled?.deletionExecutor).toBeUndefined()
        expect(settled?.lastError).toContain("handshake timed out")
        expect(existsSync(stalledGatePath)).toBe(false)
        expect(existsSync(fixture.deletionLog)).toBe(false)

        // The next sweep deletes exactly one transcript: no stale token or
        // resurrected lease stands in the way.
        const second = await runGc([], { ...options, maxDeletesPerRun: 1 })
        expect(second.deleted).toBe(1)
        expect(second.failed).toBe(0)
        // Whichever candidate the sweep picked, exactly one SDK marker line
        // appeared across the two fixture config dirs.
        const markerLines = [fixture.locator.configDir, blockerLocator.configDir]
          .map((configDir) => `${configDir}.deleted.log`)
          .filter((path) => existsSync(path))
          .flatMap((path) => readFileSync(path, "utf8").trim().split("\n"))
        expect(markerLines).toHaveLength(1)
      } finally {
        releaseAllSyncs()
      }
    },
    60_000,
  )

  test(
    "a handshake that times out mid-write lets the durable attach finish and cannot resurrect the token",
    async () => {
      const fixture = await makeFixture("gc-handshake-durable-write", { delayMs: 30 })
      // One claim per sweep: after the handshake failure the 1ms retry delay
      // would otherwise let the same sweep re-claim and delete the resource,
      // burying the settlement this test inspects.
      const options = {
        ...gcOptions(fixture),
        maxDeletesPerRun: 1,
        deletionTimeoutMs: 5_000,
        deletionHandshakeTimeoutMs: 400,
      }
      const key = getTranscriptResourceKey(fixture.locator)

      const exact = await prepareFork(fixture.locator, options)
      await abandonFork(exact, options)

      // G1 parks the claim's publish, G2 parks the attach's publish.
      holdNextSync(2)
      try {
        const swept = runGc([], options)
        await waitFor("claimed resource visible as deleting", () =>
          readSidecar(fixture.storeDir).resources[key]?.state === "deleting")
        releaseNextSync()
        // The attach now holds the lock; its executor record has been
        // renamed into place, but the durable publish is still parked.
        await waitFor("executor persisted on disk", () =>
          readSidecar(fixture.storeDir).resources[key]?.deletionExecutor !== undefined)

        // Let the handshake deadline pass while the attach holds the lock.
        await sleep(700)
        const pending = readSidecar(fixture.storeDir).resources[key]
        expect(pending?.state).toBe("deleting")
        const stalledGatePath = gatePath(fixture.storeDir, pending)
        expect(existsSync(stalledGatePath)).toBe(false)
        expect(existsSync(fixture.deletionLog)).toBe(false)

        releaseNextSync()
        const result = await swept
        expect(result.failed).toBe(1)

        const settled = readSidecar(fixture.storeDir).resources[key]
        expect(settled?.state).toBe("retired")
        expect(settled?.deletionToken).toBeUndefined()
        expect(settled?.deletionExecutor).toBeUndefined()
        expect(settled?.lastError).toContain("handshake timed out")
        expect(existsSync(stalledGatePath)).toBe(false)
        expect(existsSync(fixture.deletionLog)).toBe(false)
        expect(readdirSync(join(fixture.storeDir, "deletion-gates"))).toHaveLength(0)

        // The next sweep succeeds through the full fenced path.
        const second = await runGc([], options)
        expect(second.deleted).toBe(1)
        expect(second.failed).toBe(0)
      } finally {
        releaseAllSyncs()
      }
    },
    60_000,
  )

  test(
    "the full deletion budget applies to execution: a hanging child is killed and joined, not truncated",
    async () => {
      const fixture = await makeFixture("gc-budget-execution", { hang: true })
      // The run deadline is far shorter than the deletion budget: the run
      // deadline must not truncate an already-started execution, and the
      // single-claim cap keeps the 1ms retry from re-claiming within the
      // same sweep.
      const options = {
        ...gcOptions(fixture),
        maxDeletesPerRun: 1,
        runTimeoutMs: 300,
        deletionTimeoutMs: 2_500,
      }
      const key = getTranscriptResourceKey(fixture.locator)

      const exact = await prepareFork(fixture.locator, options)
      await abandonFork(exact, options)

      const result = await runGc([], options)

      expect(result.failed).toBe(1)
      expect(result.deleted).toBe(0)
      const resource = readSidecar(fixture.storeDir).resources[key]
      expect(resource?.state).toBe("retired")
      expect(resource?.lastError).toContain("timed out and was killed")
      expect(resource?.deletionExecutor).toBeUndefined()
      // The SDK marker proves the child ran; the hang ended in a kill+join,
      // never a "deleted" verdict, and the gate did not leak.
      expect(existsSync(fixture.deletionLog)).toBe(true)
      expect(readdirSync(join(fixture.storeDir, "deletion-gates"))).toHaveLength(0)
    },
    60_000,
  )
})
