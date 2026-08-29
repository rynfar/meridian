import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  abandonFork,
  getTranscriptResourceKey,
  prepareFork,
  reconcile,
  runGc,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"

// Regression coverage for the Windows session-GC stall: runGc used to no-op on
// win32 whenever no custom deleter was injected (the production configuration),
// so retired transcripts were never deleted, the prepared/retired/deleting
// backlog grew unbounded, and prepareFork eventually threw "session transcript
// ownership backlog is full". These tests drive the *default* (fenced SDK
// child) deletion path against a stub SDK and assert it drains on every
// platform, Windows included. Do NOT add a `process.platform === "win32"` skip:
// running here on Windows is the whole point. Timeouts are generous because
// capturing each spawned child's incarnation shells out to PowerShell/CIM on
// Windows, which is budgeted up to 10s per probe on a cold host.

interface StoredResource {
  state: string
  deletionToken?: string
  deletionOwner?: unknown
  deletionExecutor?: unknown
  deletionProcessGroupId?: number
  lastError?: string
}

interface StoredSidecar {
  resources: Record<string, StoredResource>
}

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

// A stand-in for @anthropic-ai/claude-agent-sdk. deleteSession records the
// session id it was asked to delete (keyed off CLAUDE_CONFIG_DIR, which the
// fenced child sets per locator) so the test can prove the child actually ran.
const STUB_SDK_SOURCE = String.raw`
import { appendFileSync, mkdirSync } from "node:fs"
import { createServer } from "node:net"
import { dirname } from "node:path"
export async function deleteSession(sessionId, options) {
  const log = process.env.CLAUDE_CONFIG_DIR + ".deleted.log"
  mkdirSync(dirname(log), { recursive: true })
  appendFileSync(log, JSON.stringify({ sessionId, dir: options?.dir ?? null }) + "\n")
  if (sessionId === "windows-gc-timeout") {
    createServer().listen(0)
    const { promise } = Promise.withResolvers()
    await promise
  }
}
`

async function makeFixture(sessionId: string): Promise<{
  root: string
  storeDir: string
  locator: TranscriptLocator
  deletionLog: string
  sdkModuleUrl: string
}> {
  const root = await mkdtemp(join(tmpdir(), "meridian-win-gc-"))
  tempRoots.push(root)
  const storeDir = join(root, "store")
  const configDir = join(root, "config")
  const projectDir = join(root, "project")
  await mkdir(storeDir, { recursive: true })
  const sdkPath = join(root, "stub-sdk.mjs")
  await writeFile(sdkPath, STUB_SDK_SOURCE, "utf8")
  return {
    root,
    storeDir,
    locator: { sessionId, configDir, projectDir },
    deletionLog: `${configDir}.deleted.log`,
    sdkModuleUrl: pathToFileURL(sdkPath).href,
  }
}

function gcOptions(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return {
    storeDir: fixture.storeDir,
    preparedGraceMs: 0,
    retiredGraceMs: 0,
    lockWaitMs: 2_000,
    lockRetryMs: 5,
    sdkModuleUrl: fixture.sdkModuleUrl,
  }
}

function readSidecar(storeDir: string): StoredSidecar {
  return JSON.parse(readFileSync(join(storeDir, "session-gc.json"), "utf8")) as StoredSidecar
}

describe("session GC deletes retired transcripts on every platform", () => {
  test("runGc drives a retired transcript to deleted through the default fenced child", async () => {
    const fixture = await makeFixture("windows-gc-retired")
    const options = gcOptions(fixture)
    const key = getTranscriptResourceKey(fixture.locator)

    const exact = await prepareFork(fixture.locator, options)
    await abandonFork(exact, options)
    expect(readSidecar(fixture.storeDir).resources[key]?.state).toBe("retired")

    const result = await runGc([], options)

    expect(result.deleted).toBe(1)
    expect(result.failed).toBe(0)
    expect(readSidecar(fixture.storeDir).resources[key]?.state).toBe("deleted")

    // The fenced child really imported the (stub) SDK and asked it to delete the
    // exact session id. On the buggy win32 path this file never appeared.
    expect(existsSync(fixture.deletionLog)).toBe(true)
    const logged = (await readFile(fixture.deletionLog, "utf8")).trim().split("\n").map(
      (line) => JSON.parse(line) as { sessionId: string },
    )
    expect(logged.map((entry) => entry.sessionId)).toContain("windows-gc-retired")
  }, 60_000)

  test("runGc tree-kills and joins a timed-out deletion child", async () => {
    const fixture = await makeFixture("windows-gc-timeout")
    const options = { ...gcOptions(fixture), deletionTimeoutMs: 2_000 }
    const key = getTranscriptResourceKey(fixture.locator)

    const exact = await prepareFork(fixture.locator, options)
    await abandonFork(exact, options)

    const result = await runGc([], options)

    expect(result.failed).toBe(1)
    expect(result.deferred).toBe(1)
    const resource = readSidecar(fixture.storeDir).resources[key]
    expect(resource?.state).toBe("retired")
    expect(resource?.lastError).toContain("timed out and was killed")
    expect(existsSync(fixture.deletionLog)).toBe(true)
  }, 60_000)

  test("the pending backlog drains instead of filling up", async () => {
    const fixture = await makeFixture("windows-gc-backlog")
    const options = { ...gcOptions(fixture), maxPending: 4 }

    // Fill, retire, and collect more resources than maxPending across sweeps.
    // Before the fix this loop threw "session transcript ownership backlog is
    // full" on win32 because runGc never reclaimed a single slot.
    for (let index = 0; index < 6; index++) {
      const locator: TranscriptLocator = {
        sessionId: `backlog-${index}`,
        configDir: join(fixture.root, `config-${index}`),
        projectDir: join(fixture.root, `project-${index}`),
      }
      const exact = await prepareFork(locator, options)
      await abandonFork(exact, options)
      const swept = await runGc([], options)
      expect(swept.failed).toBe(0)
    }

    const states = Object.values(readSidecar(fixture.storeDir).resources).map((r) => r.state)
    expect(states.filter((state) => state === "retired" || state === "deleting")).toHaveLength(0)
  }, 120_000)

  // win32 recycles pids aggressively: by the next reconcile, a crashed
  // deletion child's pid routinely belongs to an unrelated live process
  // (here: this very test process). Recovery must key off the reuse-proof
  // executor incarnation (pid + OS start id) alone — probing the raw pid
  // would misread the reused pid as a live deleter and block recovery of the
  // claim forever. POSIX genuinely differs (the group probe waits out
  // surviving group members), so this test is win32-only rather than a win32
  // skip.
  test.if(process.platform === "win32")(
    "reconcile recovers a deleting claim whose executor pid was reused by a live process",
    async () => {
      const fixture = await makeFixture("windows-gc-reused-pid")
      const options = gcOptions(fixture)
      const key = getTranscriptResourceKey(fixture.locator)

      const exact = await prepareFork(fixture.locator, options)
      await abandonFork(exact, options)

      const current = captureProcessIncarnation()
      if (!current) throw new Error("test process incarnation unavailable")
      // Same live pid as this process, but a boot id that can never match the
      // local host: a provably dead incarnation on a provably live pid.
      const reusedPidExecutor = { ...current, bootId: "00000000-0000-4000-8000-000000000000" }
      const sidecarPath = join(fixture.storeDir, "session-gc.json")
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8")) as StoredSidecar
      const resource = sidecar.resources[key]
      if (!resource) throw new Error("expected sidecar resource for fixture locator")
      resource.state = "deleting"
      resource.deletionToken = "reused-pid-token"
      resource.deletionOwner = reusedPidExecutor
      resource.deletionExecutor = reusedPidExecutor
      resource.deletionProcessGroupId = current.pid
      await writeFile(sidecarPath, JSON.stringify(sidecar), "utf8")

      const recovered = await reconcile([], options)
      expect(recovered.deletingRecovered).toBe(1)
      expect(readSidecar(fixture.storeDir).resources[key]?.state).toBe("retired")
    },
    60_000,
  )
})
