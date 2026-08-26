import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  getTranscriptResourceKey,
  reconcile,
  runGc,
  type TranscriptLocator,
} from "../proxy/sessionLifecycle"

const lifecycleModule = pathToFileURL(
  resolve(import.meta.dir, "../proxy/sessionLifecycle.ts"),
).href

const workerSource = String.raw`
import { appendFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
const lifecycle = await import(process.env.LIFECYCLE_MODULE)
const locator = JSON.parse(process.env.LOCATOR)
const options = {
  storeDir: process.env.STORE_DIR,
  preparedGraceMs: 0,
  retiredGraceMs: 0,
  lockWaitMs: 2_000,
  lockRetryMs: 5,
}
const event = (name, extra = {}) => appendFile(
  process.env.EVENT_FILE,
  JSON.stringify({ name, pid: process.pid, ...extra }) + "\n",
)
try {
  await lifecycle.registerLiveTranscript(locator, options)
  const lease = await lifecycle.acquireActiveTranscriptLease([locator], options)
  if (process.env.MODE === "gated-crash") {
    const { createSdkProcessGate } = await import(process.env.SDK_GATE_MODULE)
    const gate = await createSdkProcessGate(
      process.env.GATE_ROOT,
      (executor, recoverableAfterCrash) => lifecycle.attachActiveTranscriptExecutor(
        lease,
        executor,
        options,
        recoverableAfterCrash,
      ),
    )
    gate.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", "await Bun.sleep(1500)"],
      env: { ...process.env },
      signal: new AbortController().signal,
    })
    await event("ready", { token: lease.token, executorPid: gate.executor.pid })
    await Bun.sleep(10_000)
  } else if (process.env.MODE === "armed") {
    const { captureProcessIncarnation } = await import(process.env.PROCESS_INCARNATION_MODULE)
    const executor = captureProcessIncarnation()
    if (!executor) throw new Error("worker process incarnation unavailable")
    await lifecycle.attachActiveTranscriptExecutor(lease, executor, options)
    await event("ready", { token: lease.token })
    const deadline = Date.now() + 10_000
    while (!existsSync(process.env.RELEASE_FILE)) {
      if (Date.now() >= deadline) throw new Error("worker timed out waiting for release")
      await Bun.sleep(10)
    }
    await lifecycle.releaseActiveTranscriptLease(lease, options)
    await event("released")
  } else {
    await event("ready", { token: lease.token })
    // Exit without arming or releasing. Reconciliation may recover this lease
    // only after this exact owner process is dead.
  }
} catch (error) {
  await event("worker-error", {
    errorName: error?.name ?? "Error",
    message: error?.message ?? String(error),
  })
  throw error
}
`

interface WorkerEvent {
  name: string
  pid: number
  token?: string
  executorPid?: number
  errorName?: string
  message?: string
}

interface StoredActiveLease {
  owner: { pid: number }
  executor?: { pid: number }
}

interface StoredResource {
  state: string
  activeLeases?: Record<string, StoredActiveLease>
}

interface StoredSidecar {
  resources: Record<string, StoredResource>
}

interface WorkerHandle {
  name: string
  child: ReturnType<typeof Bun.spawn>
  releaseFile: string
}

const tempRoots: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()

const processIncarnationModule = pathToFileURL(
  resolve(import.meta.dir, "../proxy/session/processIncarnation.ts"),
).href

const sdkGateModule = pathToFileURL(
  resolve(import.meta.dir, "../proxy/session/sdkProcessGate.ts"),
).href

afterEach(async () => {
  for (const child of children) child.kill()
  await Promise.all([...children].map((child) => Promise.race([
    child.exited.then(() => undefined),
    Bun.sleep(1_000),
  ])))
  children.clear()
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function spawnLeaseWorker(
  root: string,
  locator: TranscriptLocator,
  mode: "armed" | "unarmed" | "gated-crash",
): WorkerHandle {
  const releaseFile = join(root, `release-${mode}`)
  const child = Bun.spawn([process.execPath, "-e", workerSource], {
    env: {
      ...process.env,
      LIFECYCLE_MODULE: lifecycleModule,
      PROCESS_INCARNATION_MODULE: processIncarnationModule,
      SDK_GATE_MODULE: sdkGateModule,
      GATE_ROOT: join(root, "sdk-gates"),
      STORE_DIR: root,
      LOCATOR: JSON.stringify(locator),
      EVENT_FILE: join(root, "events.jsonl"),
      RELEASE_FILE: releaseFile,
      MODE: mode,
    },
    stdout: "ignore",
    stderr: "pipe",
  })
  children.add(child)
  return { name: mode, child, releaseFile }
}

async function readEvents(path: string): Promise<WorkerEvent[]> {
  try {
    const contents = await readFile(path, "utf8")
    return contents.trim().split("\n").filter(Boolean).map(
      (line) => JSON.parse(line) as WorkerEvent,
    )
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function waitForEvent(
  path: string,
  name: string,
  timeoutMs = 5_000,
): Promise<WorkerEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = await readEvents(path)
    const failure = events.find((event) => event.name === "worker-error")
    if (failure) throw new Error(`${failure.errorName}: ${failure.message}`)
    const found = events.find((event) => event.name === name)
    if (found) return found
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for worker event ${name}`)
}

async function expectExit(worker: WorkerHandle, timeoutMs = 5_000): Promise<void> {
  const timeout = Symbol("timeout")
  const outcome = await Promise.race([
    worker.child.exited,
    Bun.sleep(timeoutMs).then(() => timeout),
  ])
  if (outcome === timeout) {
    worker.child.kill()
    throw new Error(`Worker ${worker.name} did not exit within ${timeoutMs}ms`)
  }
  children.delete(worker.child)
  if (outcome === 0) return
  const stderrPromise = worker.child.stderr instanceof ReadableStream
    ? new Response(worker.child.stderr).text()
    : Promise.resolve(String(worker.child.stderr ?? ""))
  const stderr = await Promise.race([
    stderrPromise,
    Bun.sleep(1_000).then(() => "<stderr read timed out>"),
  ])
  throw new Error(`Worker ${worker.name} exited ${String(outcome)}: ${stderr}`)
}

function readSidecar(storeDir: string): StoredSidecar {
  return JSON.parse(readFileSync(join(storeDir, "session-gc.json"), "utf8")) as StoredSidecar
}

async function makeFixture(sessionId: string): Promise<{
  root: string
  events: string
  locator: TranscriptLocator
}> {
  const root = await mkdtemp(join(tmpdir(), "meridian-lifecycle-process-"))
  tempRoots.push(root)
  return {
    root,
    events: join(root, "events.jsonl"),
    locator: {
      sessionId,
      configDir: join(root, "config"),
      projectDir: join(root, "project"),
    },
  }
}

function gcOptions(storeDir: string) {
  return {
    storeDir,
    preparedGraceMs: 0,
    retiredGraceMs: 0,
    lockWaitMs: 2_000,
    lockRetryMs: 5,
  }
}

describe("session lifecycle leases across OS processes", () => {
  test("does not retire or delete a transcript leased by a live writer process", async () => {
    const fixture = await makeFixture("live-cross-process-writer")
    const worker = spawnLeaseWorker(fixture.root, fixture.locator, "armed")
    const ready = await waitForEvent(fixture.events, "ready")
    expect(ready.pid).not.toBe(process.pid)

    const key = getTranscriptResourceKey(fixture.locator)
    const options = gcOptions(fixture.root)
    expect((await reconcile([], options)).liveRetired).toBe(0)
    expect(readSidecar(fixture.root).resources[key]).toMatchObject({
      state: "live",
      activeLeases: {
        [ready.token!]: {
          owner: { pid: ready.pid },
          executor: { pid: ready.pid },
        },
      },
    })

    let deletes = 0
    const blocked = await runGc([], {
      ...options,
      deleter: async () => { deletes++ },
    })
    expect(blocked.deleted).toBe(0)
    expect(deletes).toBe(0)
    expect(readSidecar(fixture.root).resources[key]?.state).toBe("live")
    expect(existsSync(worker.releaseFile)).toBe(false)

    await writeFile(worker.releaseFile, "release")
    await waitForEvent(fixture.events, "released")
    await expectExit(worker)

    const collected = await runGc([], {
      ...options,
      deleter: async () => { deletes++ },
    })
    expect(collected.deleted).toBe(1)
    expect(deletes).toBe(1)
    expect(readSidecar(fixture.root).resources[key]?.state).toBe("deleted")
  }, 15_000)

  test("keeps an orphaned real SDK gate fenced until its exact executor exits", async () => {
    if (process.platform === "win32") return
    const fixture = await makeFixture("crashed-owner-live-gate")
    const worker = spawnLeaseWorker(fixture.root, fixture.locator, "gated-crash")
    const ready = await waitForEvent(fixture.events, "ready")
    expect(ready.pid).not.toBe(process.pid)
    expect(ready.executorPid).not.toBe(ready.pid)

    worker.child.kill("SIGKILL")
    const ownerExit = await Promise.race([
      worker.child.exited,
      Bun.sleep(3_000).then(() => "timeout" as const),
    ])
    expect(ownerExit).not.toBe("timeout")
    children.delete(worker.child)

    const key = getTranscriptResourceKey(fixture.locator)
    const options = gcOptions(fixture.root)
    expect((await reconcile([], options)).liveRetired).toBe(0)
    expect(readSidecar(fixture.root).resources[key]).toMatchObject({
      state: "live",
      activeLeases: {
        [ready.token!]: {
          owner: { pid: ready.pid },
          executor: { pid: ready.executorPid },
        },
      },
    })

    await Bun.sleep(1_700)
    expect((await reconcile([], options)).liveRetired).toBe(1)
    expect(readSidecar(fixture.root).resources[key]).toMatchObject({ state: "retired" })
    expect(readSidecar(fixture.root).resources[key]?.activeLeases).toBeUndefined()
  }, 15_000)

  test("recovers an unarmed lease after its owner process dies", async () => {
    const fixture = await makeFixture("dead-unarmed-writer")
    const worker = spawnLeaseWorker(fixture.root, fixture.locator, "unarmed")
    const ready = await waitForEvent(fixture.events, "ready")
    expect(ready.pid).not.toBe(process.pid)
    await expectExit(worker)

    const key = getTranscriptResourceKey(fixture.locator)
    expect(Object.keys(readSidecar(fixture.root).resources[key]?.activeLeases ?? {})).toEqual([
      ready.token!,
    ])

    const options = gcOptions(fixture.root)
    expect((await reconcile([], options)).liveRetired).toBe(1)
    expect(readSidecar(fixture.root).resources[key]).toMatchObject({ state: "retired" })
    expect(readSidecar(fixture.root).resources[key]?.activeLeases).toBeUndefined()

    let deletes = 0
    expect((await runGc([], {
      ...options,
      deleter: async () => { deletes++ },
    })).deleted).toBe(1)
    expect(deletes).toBe(1)
    expect(readSidecar(fixture.root).resources[key]?.state).toBe("deleted")
  }, 15_000)
})
