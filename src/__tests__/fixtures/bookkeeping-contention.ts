import Database from "libsql"
import { fork } from "node:child_process"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import {
  BOOKKEEPING_FILENAME,
  initializeSessionBookkeeping,
  withBookkeepingWriteAsync,
} from "../../proxy/session/bookkeeping/database"
import { join } from "node:path"

const directory = process.argv[2]!
if (process.argv[3] === "holder") {
  const db = new Database(join(directory, BOOKKEEPING_FILENAME))
  process.once("disconnect", () => {
    if (db.inTransaction) db.exec("ROLLBACK")
    db.close()
    process.exit(0)
  })
  db.exec("BEGIN IMMEDIATE")
  process.send?.("locked")
  process.once("message", () => {
    db.exec("ROLLBACK")
    db.close()
    process.removeAllListeners("disconnect")
    process.disconnect()
  })
} else {
  const handle = initializeSessionBookkeeping(directory)
  const child = fork(fileURLToPath(import.meta.url), [directory, "holder"], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  })
  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`holder exit ${code}: ${stderr}`)),
    )
  })
  process.once("SIGTERM", () => {
    child.kill("SIGTERM")
    void exited.finally(() => process.exit(143))
  })
  try {
    await Promise.race([
      new Promise<void>((resolve) => child.once("message", () => resolve())),
      exited.then(() => {
        throw new Error("holder exited before lock")
      }),
    ])
    const histogram = monitorEventLoopDelay({ resolution: 1 })
    histogram.enable()
    let last = performance.now(),
      maxLag = 0,
      ticks = 0,
      calls = 0
    const timer = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - last - 1)
      last = now
      ticks++
    }, 1)
    const release = setTimeout(() => child.send("release"), 250)
    const start = performance.now()
    try {
      await withBookkeepingWriteAsync(directory, { lockWaitMs: 2000, lockRetryMs: 3 }, (tx) => {
        calls++
        tx.run("INSERT INTO fence_slots VALUES('store','node',1)")
      })
      console.log(
        JSON.stringify({
          node: process.versions.node,
          calls,
          elapsed: performance.now() - start,
          maxLag,
          histogramMax: histogram.max / 1e6,
          ticks,
          committed: handle.reader.get("SELECT counter FROM fence_slots WHERE slot='node'")?.counter,
        }),
      )
    } finally {
      clearInterval(timer)
      clearTimeout(release)
      histogram.disable()
    }
    await exited
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM")
    await exited.catch(() => undefined)
    handle.close()
  }
}
