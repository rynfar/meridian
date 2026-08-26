import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { captureProcessIncarnation } from "../proxy/session/processIncarnation"

const coordinatorModule = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../proxy/session/crossProcessTurnCoordinator.ts"),
).href
const processIncarnationModule = pathToFileURL(
  resolve(dirname(fileURLToPath(import.meta.url)), "../proxy/session/processIncarnation.ts"),
).href

const workerSource = String.raw`
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { hostname } from "node:os"
const { CrossProcessTurnCoordinator } = await import(process.env.COORDINATOR_MODULE)
const { captureProcessIncarnation } = await import(process.env.PROCESS_INCARNATION_MODULE)
const currentIncarnation = captureProcessIncarnation()
if (!currentIncarnation) throw new Error("worker process incarnation unavailable")
const deadIncarnation = (pid) => ({
  ...currentIncarnation,
  pid,
  bootId: "00000000-0000-4000-8000-000000000000",
})
const root = process.env.LOCK_ROOT
const eventFile = process.env.EVENT_FILE
const key = process.env.LOCK_KEY
const action = process.env.ACTION
const options = JSON.parse(process.env.OPTIONS)
const event = async (name, extra = {}) => {
  await appendFile(eventFile, JSON.stringify({ name, at: Date.now(), pid: process.pid, ...extra }) + "\n")
}
const keepAlive = setInterval(() => {}, 1_000)
try {
  if (action === "seed-stale") {
    const hash = createHash("sha256").update(key).digest("hex")
    const lockPath = join(root, hash + ".lock")
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "stale-seed", pid: 999_999_999, hostname: hostname(), createdAt: 1,
      incarnation: deadIncarnation(999_999_999),
    }))
    const heartbeat = join(lockPath, "heartbeat-stale-seed")
    await writeFile(heartbeat, "")
    const old = new Date(1)
    await Bun.file(heartbeat).exists()
    const { utimes } = await import("node:fs/promises")
    await utimes(heartbeat, old, old)
    await event("seeded")
  } else if (action === "seed-orphan-claim") {
    const hash = createHash("sha256").update(key).digest("hex")
    const lockPath = join(root, hash + ".lock")
    await mkdir(lockPath, { recursive: true })
    const staleToken = "stale-with-orphan-claim"
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: staleToken, pid: 999_999_999, hostname: hostname(), createdAt: 1,
      incarnation: deadIncarnation(999_999_999),
    }))
    const heartbeat = join(lockPath, "heartbeat-" + staleToken)
    await writeFile(heartbeat, "")
    const claimIdentity = createHash("sha256").update(staleToken).digest("hex")
    const claimPath = lockPath + ".recover-" + claimIdentity
    const firstClaimToken = "first-dead-recovery-claim"
    const firstTombstone = claimPath + ".orphan-"
      + createHash("sha256").update(firstClaimToken).digest("hex")
    await mkdir(firstTombstone, { recursive: true })
    await writeFile(join(firstTombstone, "owner.json"), JSON.stringify({
      version: 2, generation: staleToken, token: firstClaimToken,
      pid: 999_999_998, hostname: hostname(), createdAt: 1,
      incarnation: deadIncarnation(999_999_998),
    }))
    await mkdir(claimPath, { recursive: true })
    const claimToken = "second-dead-recovery-claim"
    await writeFile(join(claimPath, "owner.json"), JSON.stringify({
      version: 2, generation: staleToken, token: claimToken,
      pid: 999_999_999, hostname: hostname(), createdAt: 1,
      incarnation: deadIncarnation(999_999_999),
    }))
    const { utimes } = await import("node:fs/promises")
    const old = new Date(1)
    await utimes(heartbeat, old, old)
    await event("seeded-orphan-claim")
  } else {
    const coordinator = new CrossProcessTurnCoordinator(root, options)
    if (action === "abort") {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), Number(process.env.ABORT_AFTER_MS))
      try {
        await coordinator.acquire(key, controller.signal)
        await event("unexpected-acquire")
      } catch (error) {
        await event("acquire-error", { errorName: error.name })
      } finally {
        clearTimeout(timer)
      }
    } else if (action === "timeout") {
      try {
        const lease = await coordinator.acquire(key)
        await event("unexpected-acquire")
        await lease.release()
      } catch (error) {
        await event("acquire-error", { errorName: error.name })
      }
    } else {
      const lease = await coordinator.acquire(key)
      await event("acquired", { waitedMs: lease.waitedMs })
      if (action === "crash") {
        clearInterval(keepAlive)
        process.exit(0)
      }
      if (action === "tamper-release") {
        const hash = createHash("sha256").update(key).digest("hex")
        const ownerPath = join(root, hash + ".lock", "owner.json")
        const owner = JSON.parse(await readFile(ownerPath, "utf8"))
        owner.token = "not-the-lease-token"
        await writeFile(ownerPath, JSON.stringify(owner))
        try {
          await lease.release()
          await event("unexpected-release")
        } catch (error) {
          await event("release-refused", { errorName: error.name })
        }
        await Bun.sleep(Number(process.env.HOLD_MS))
      } else {
        await Bun.sleep(Number(process.env.HOLD_MS || 0))
        await event("leaving")
        await lease.release()
        await lease.release()
        await event("released")
      }
    }
  }
} finally {
  clearInterval(keepAlive)
}
`

type WorkerAction = "hold" | "abort" | "timeout" | "crash" | "seed-stale" | "seed-orphan-claim" | "tamper-release"
interface WorkerEvent {
  name: string
  at: number
  pid: number
  waitedMs?: number
  errorName?: string
}

const tempRoots: string[] = []
const children = new Set<ReturnType<typeof Bun.spawn>>()

afterEach(async () => {
  for (const child of children) child.kill()
  children.clear()
  await Promise.all(tempRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function makeFiles(): Promise<{ base: string, locks: string, events: string }> {
  const base = await mkdtemp(join(tmpdir(), "meridian-cross-process-turn-"))
  tempRoots.push(base)
  return { base, locks: join(base, "locks"), events: join(base, "events.jsonl") }
}

function spawnWorker(
  action: WorkerAction,
  paths: { locks: string, events: string },
  overrides: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
  const child = Bun.spawn([process.execPath, "-e", workerSource], {
    env: {
      ...process.env,
      COORDINATOR_MODULE: coordinatorModule,
      PROCESS_INCARNATION_MODULE: processIncarnationModule,
      LOCK_ROOT: paths.locks,
      EVENT_FILE: paths.events,
      LOCK_KEY: "logical-session",
      ACTION: action,
      HOLD_MS: "0",
      OPTIONS: JSON.stringify({
        acquireTimeoutMs: 2_000,
        staleAfterMs: 800,
        heartbeatIntervalMs: 100,
        retryDelayMs: 10,
      }),
      ...overrides,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  children.add(child)
  void child.exited.then(() => children.delete(child))
  return child
}

async function events(path: string): Promise<WorkerEvent[]> {
  try {
    const text = await readFile(path, "utf8")
    return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as WorkerEvent)
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
    throw error
  }
}

async function waitForEvent(path: string, name: string, timeoutMs = 5_000): Promise<WorkerEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = (await events(path)).find(item => item.name === name)
    if (found) return found
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for worker event ${name}`)
}

async function expectSuccess(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const exitCode = await child.exited
  if (exitCode === 0) return
  const stderr = child.stderr instanceof ReadableStream
    ? await new Response(child.stderr).text()
    : String(child.stderr ?? "")
  throw new Error(`Worker exited ${exitCode}: ${stderr}`)
}

describe("cross-process turn coordinator", () => {
  test("serializes the same logical key in independent processes", async () => {
    const paths = await makeFiles()
    const heartbeatOptions = JSON.stringify({
      acquireTimeoutMs: 2_000,
      staleAfterMs: 120,
      heartbeatIntervalMs: 25,
      retryDelayMs: 10,
    })
    const first = spawnWorker("hold", paths, { HOLD_MS: "500", OPTIONS: heartbeatOptions })
    const firstAcquired = await waitForEvent(paths.events, "acquired")
    const second = spawnWorker("hold", paths, { HOLD_MS: "0", OPTIONS: heartbeatOptions })

    await Promise.all([expectSuccess(first), expectSuccess(second)])
    const all = await events(paths.events)
    const firstLeaving = all.find(item => item.name === "leaving" && item.pid === firstAcquired.pid)!
    const secondAcquired = all.find(item => item.name === "acquired" && item.pid !== firstAcquired.pid)!
    expect(firstLeaving.at).toBeLessThanOrEqual(secondAcquired.at)
    expect(secondAcquired.waitedMs).toBeGreaterThanOrEqual(0)
  })

  test("aborts a bounded cross-process acquire without entering the turn", async () => {
    const paths = await makeFiles()
    const holder = spawnWorker("hold", paths, { HOLD_MS: "400" })
    const held = await waitForEvent(paths.events, "acquired")
    const waiter = spawnWorker("abort", paths, { ABORT_AFTER_MS: "60" })

    await expectSuccess(waiter)
    const all = await events(paths.events)
    const failure = all.find(item => item.name === "acquire-error" && item.pid !== held.pid)
    expect(failure?.errorName).toBe("AbortError")
    expect(all.some(item => item.name === "unexpected-acquire")).toBe(false)
    await expectSuccess(holder)
  })

  test("atomically recovers locks left by dead and stale owners", async () => {
    const deadPaths = await makeFiles()
    const deadOwner = spawnWorker("crash", deadPaths)
    await waitForEvent(deadPaths.events, "acquired")
    await expectSuccess(deadOwner)
    const deadSuccessor = spawnWorker("hold", deadPaths)
    await expectSuccess(deadSuccessor)
    const deadAcquisitions = (await events(deadPaths.events)).filter(item => item.name === "acquired")
    expect(deadAcquisitions).toHaveLength(2)
    // Parent death is necessary but not sufficient: quarantine the last fresh
    // heartbeat so an orphan SDK child cannot overlap its successor.
    expect(deadAcquisitions[1]!.waitedMs).toBeGreaterThanOrEqual(500)

    const stalePaths = await makeFiles()
    const seeder = spawnWorker("seed-stale", stalePaths)
    await expectSuccess(seeder)
    const staleSuccessor = spawnWorker("hold", stalePaths)
    await expectSuccess(staleSuccessor)
    expect((await events(stalePaths.events)).some(item => item.name === "released")).toBe(true)
  })

  test("repeatedly adopts dead recovery claims and cleans resolved tombstones", async () => {
    const paths = await makeFiles()
    const seeder = spawnWorker("seed-orphan-claim", paths)
    await expectSuccess(seeder)
    const recoveryOptions = {
      OPTIONS: JSON.stringify({
        acquireTimeoutMs: 2_000,
        staleAfterMs: 100,
        heartbeatIntervalMs: 25,
        retryDelayMs: 10,
      }),
    }
    const successors = [
      spawnWorker("hold", paths, recoveryOptions),
      spawnWorker("hold", paths, recoveryOptions),
    ]
    await Promise.all(successors.map(expectSuccess))
    const all = await events(paths.events)
    expect(all.filter((item) => item.name === "acquired")).toHaveLength(2)
    expect(all.filter((item) => item.name === "released")).toHaveLength(2)
    expect((await readdir(paths.locks)).some((name) => name.includes(".recover-"))).toBe(false)
  })

  test("fails closed for live and remote recovery claim owners", async () => {
    for (const [claimHostname, claimPid] of [[hostname(), process.pid], ["remote.example", 999_999_999]] as const) {
      const paths = await makeFiles()
      const key = "logical-session"
      const lockPath = join(paths.locks, `${createHash("sha256").update(key).digest("hex")}.lock`)
      const generation = `blocked-${claimHostname}`
      await mkdir(lockPath, { recursive: true })
      await writeFile(join(lockPath, "owner.json"), JSON.stringify({
        token: generation,
        pid: 999_999_999,
        hostname: hostname(),
        createdAt: 1,
      }))
      const heartbeat = join(lockPath, `heartbeat-${generation}`)
      await writeFile(heartbeat, "")
      await utimes(heartbeat, new Date(1), new Date(1))

      const claimPath = `${lockPath}.recover-${createHash("sha256").update(generation).digest("hex")}`
      await mkdir(claimPath, { recursive: true })
      await writeFile(join(claimPath, "owner.json"), JSON.stringify({
        version: 2,
        generation,
        token: `claim-${claimHostname}`,
        pid: claimPid,
        hostname: claimHostname,
        createdAt: 1,
        incarnation: claimHostname !== hostname()
          ? { ...captureProcessIncarnation()!, pid: claimPid, hostId: "b".repeat(64) }
          : claimPid === process.pid
            ? captureProcessIncarnation()
            : {
              ...captureProcessIncarnation()!,
              pid: claimPid,
              bootId: "00000000-0000-4000-8000-000000000000",
            },
      }))

      const contender = spawnWorker("timeout", paths, {
        OPTIONS: JSON.stringify({
          acquireTimeoutMs: 120,
          staleAfterMs: 20,
          heartbeatIntervalMs: 5,
          retryDelayMs: 5,
        }),
      })
      await expectSuccess(contender)
      const failure = (await events(paths.events)).find((item) => item.name === "acquire-error")
      expect(failure?.errorName).toBe("CrossProcessTurnAcquireTimeoutError")
      expect(await readFile(join(claimPath, "owner.json"), "utf8")).toContain(`claim-${claimHostname}`)
    }
  })

  test("a lease cannot release a directory whose owner token changed", async () => {
    const paths = await makeFiles()
    const owner = spawnWorker("tamper-release", paths, {
      HOLD_MS: "450",
      OPTIONS: JSON.stringify({
        acquireTimeoutMs: 2_000,
        staleAfterMs: 2_000,
        heartbeatIntervalMs: 100,
        retryDelayMs: 10,
      }),
    })
    await waitForEvent(paths.events, "release-refused")

    const contender = spawnWorker("timeout", paths, {
      OPTIONS: JSON.stringify({
        acquireTimeoutMs: 120,
        staleAfterMs: 2_000,
        heartbeatIntervalMs: 100,
        retryDelayMs: 10,
      }),
    })
    await expectSuccess(contender)
    const failure = (await events(paths.events)).find(
      item => item.name === "acquire-error" && item.pid !== owner.pid,
    )
    expect(failure?.errorName).toBe("CrossProcessTurnAcquireTimeoutError")

    await expectSuccess(owner)
    const hash = createHash("sha256").update("logical-session").digest("hex")
    expect(await Bun.file(join(paths.locks, `${hash}.lock`, "owner.json")).exists()).toBe(true)
  })
})
