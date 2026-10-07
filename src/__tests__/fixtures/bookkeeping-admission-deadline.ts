import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import Database from "libsql"
import { initializeSessionBookkeepingAsync, withBookkeepingWriteAsync } from "../../proxy/session/bookkeeping/database"
import { SessionLifecycleLockError } from "../../proxy/session/lifecycleErrors"
import { assertAdmissionDeadline, measureAdmissionHeartbeat, type AdmissionHeartbeat } from "./bookkeeping-heartbeat"

if (process.argv[2] === "blocker") {
  const db = new Database(process.argv[3]!)
  const release = () => {
    if (db.inTransaction) db.exec("ROLLBACK")
    db.close()
    process.exit(0)
  }
  process.once("disconnect", release)
  process.once("message", release)
  db.exec("BEGIN IMMEDIATE")
  process.send?.("locked")
} else {
  const directory = process.argv[2]!
  const count = Number(process.argv[3] ?? 50)
  if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError(`invalid sample count: ${process.argv[3]}`)
  const handle = await initializeSessionBookkeepingAsync(directory)
  const child = fork(fileURLToPath(import.meta.url), ["blocker", handle.path], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
  const locked = Promise.withResolvers<void>()
  child.once("message", (message) => {
    if (message === "locked") locked.resolve()
    else locked.reject(new Error(`unexpected blocker message: ${String(message)}`))
  })
  child.once("error", locked.reject)
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => {
    locked.reject(new Error(`blocker exited before readiness: ${code}: ${stderr}`))
    resolve(code)
  }))
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 2_000 + count * 200)
  try {
    await locked.promise
    const samples: AdmissionHeartbeat[] = []
    for (let i = 0; i < count; i++) {
      const sample = await measureAdmissionHeartbeat(80, async () => {
        await assert.rejects(withBookkeepingWriteAsync(directory, { lockWaitMs: 80, lockRetryMs: 5 }, () => {
          throw new Error("child-held BEGIN IMMEDIATE must not admit")
        }), SessionLifecycleLockError)
      })
      samples.push(sample)
      assertAdmissionDeadline(sample)
    }
    child.send("release")
    assert.equal(await exited, 0, stderr)
    console.log(JSON.stringify({ node: process.versions.node, samples }))
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    await exited
    handle.close()
  }
}
