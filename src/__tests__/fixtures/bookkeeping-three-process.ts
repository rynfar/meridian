import Database from "libsql"
import { fork } from "node:child_process"
import { performance } from "node:perf_hooks"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import {
  initializeSessionBookkeepingAsync,
  withBookkeepingWriteAsync,
} from "../../proxy/session/bookkeeping/database"
import { SessionLifecycleLockError } from "../../proxy/session/lifecycleErrors"
import { measureAdmissionHeartbeat } from "./bookkeeping-heartbeat"

const directory = process.argv[2]!
const id = process.argv[3]
if (id !== undefined) process.once("disconnect", () => process.exit(0))
let nativeMs = 0,
  maxBeginMs = 0,
  beginAttempts = 0
const handle = await initializeSessionBookkeepingAsync(directory, {
  executeTransaction(db, sql) {
    const start = performance.now()
    try {
      db.exec(sql)
    } finally {
      const elapsed = performance.now() - start
      nativeMs += elapsed
      if (sql === "BEGIN IMMEDIATE") {
        beginAttempts++
        maxBeginMs = Math.max(maxBeginMs, elapsed)
      }
    }
  },
})
if (id !== undefined) {
  const start = new Promise<void>((resolve) => process.once("message", () => resolve()))
  process.send?.("ready")
  await start
  const samples: number[] = []
  let last = performance.now(),
    lagSum = 0
  const began = last
  const timer = setInterval(() => {
    const now = performance.now(),
      lag = Math.max(0, now - last - 2)
    samples.push(lag)
    lagSum += lag
    last = now
  }, 2)
  let expiryMs = 0,
    completed = 0,
    rejected = 0,
    maxAdmissionMs = 0
  const admissionBudgetMs = 250
  const rejections: Array<{ name: string; waitMs: number }> = []
  try {
    const heartbeat = await measureAdmissionHeartbeat(80, async () => {
      try {
        await withBookkeepingWriteAsync(directory, { lockWaitMs: 80, lockRetryMs: 5 }, () => {
          throw new Error("held database must not admit")
        })
        throw new Error("expected admission expiry")
      } catch (error) {
        if (!(error instanceof SessionLifecycleLockError)) throw error
      }
    })
    expiryMs = heartbeat.elapsedMs
    const released = new Promise<void>((resolve) => process.once("message", () => resolve()))
    process.send?.("expired")
    await released
    for (let i = 0; i < 250; i++) {
      const before = performance.now()
      try {
        await withBookkeepingWriteAsync(directory, { lockWaitMs: admissionBudgetMs }, (tx) => {
          const start = performance.now()
          try {
            tx.run(
              "INSERT INTO fence_slots VALUES('store',?,1)",
              `process-${id}-${i}`,
            )
          } finally {
            nativeMs += performance.now() - start
          }
        })
        completed++
        maxAdmissionMs = Math.max(maxAdmissionMs, performance.now() - before)
      } catch (error) {
        if (!(error instanceof SessionLifecycleLockError)) throw error
        rejected++
        rejections.push({ name: error.constructor.name, waitMs: performance.now() - before })
      }
      await delay(1)
    }
    clearInterval(timer)
    const elapsed = performance.now() - began
    samples.sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        id,
        node: process.versions.node,
        completed,
        rejected,
        rejectionFraction: rejected / 250,
        rejections,
        admissionBudgetMs,
        expiryMs,
        heartbeat,
        maxAdmissionMs,
        timerLagP50: samples[Math.floor(samples.length / 2)],
        timerLagMax: samples.at(-1),
        delayedFraction: lagSum / elapsed,
        blockedFraction: nativeMs / elapsed,
        nativeMs,
        maxBeginMs,
        beginAttempts,
        elapsed,
        samples: samples.length,
      }),
    )
  } finally {
    clearInterval(timer)
    handle.close()
    process.disconnect()
  }
} else {
  const blocker = new Database(handle.path)
  const workers = Array.from({ length: 3 }, (_, n) => {
    const child = fork(fileURLToPath(import.meta.url), [directory, String(n)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    })
    let stdout = "",
      stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const ready = Promise.withResolvers<void>(),
      expired = Promise.withResolvers<void>()
    void ready.promise.catch(() => undefined)
    void expired.promise.catch(() => undefined)
    child.on("message", (value) => {
      if (value === "ready") ready.resolve()
      if (value === "expired") expired.resolve()
    })
    const exit = new Promise<unknown>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => {
        if (code !== 0) {
          const error = new Error(`worker ${n}: ${code}: ${stderr}`)
          ready.reject(error)
          expired.reject(error)
          reject(error)
        } else resolve(JSON.parse(stdout))
      })
    })
    void exit.catch(() => undefined)
    return { child, ready: ready.promise, expired: expired.promise, exit }
  })
  process.once("SIGTERM", () => {
    workers.forEach((worker) => worker.child.kill("SIGTERM"))
    void Promise.allSettled(workers.map((worker) => worker.exit)).finally(() => process.exit(143))
  })
  try {
    await Promise.all(workers.map((worker) => worker.ready))
    blocker.exec("BEGIN IMMEDIATE")
    workers.forEach((worker) => worker.child.send("start"))
    await Promise.all(workers.map((worker) => worker.expired))
    blocker.exec("ROLLBACK")
    workers.forEach((worker) => worker.child.send("released"))
    console.log(JSON.stringify(await Promise.all(workers.map((worker) => worker.exit))))
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK")
    blocker.close()
    handle.close()
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill("SIGTERM")
    await Promise.allSettled(workers.map((worker) => worker.exit))
  }
}
