import { expect, it } from "bun:test"
import Database from "libsql"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { initializeSessionBookkeeping, connectionFor } from "../proxy/session/bookkeeping/connection"
import { checkpointBookkeepingAsync, withBookkeepingWriteAsync, withBookkeepingWrite, checkpointBookkeeping } from "../proxy/session/bookkeeping/transaction"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"

it("waits for a separate-process native writer before draining the queued checkpoint", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-process-"))
  const handle = initializeSessionBookkeeping(dir)
  const ready = join(dir, "ready")
  const writer = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql'; import {writeFileSync} from 'node:fs';
    const [p,r]=process.argv.slice(1); const db=new Database(p); db.pragma('busy_timeout=0');
    db.exec('BEGIN IMMEDIATE'); writeFileSync(r,'1');
    setTimeout(()=>{db.exec('ROLLBACK');db.close()},400)`, handle.path, ready], { stdio: "inherit" })
  const exited = once(writer, "exit")
  let pending: Promise<unknown> | undefined
  let maintenance: Promise<unknown> | undefined
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready)) {
      if (Date.now() > deadline) throw new Error("writer failed to lock")
      await delay(5)
    }
    pending = withBookkeepingWriteAsync(dir, { lockWaitMs: 2000, lockRetryMs: 10 }, tx =>
      tx.run("INSERT INTO fence_slots VALUES('store','child-repro',1)"))
    expect(() => checkpointBookkeeping(dir)).toThrow("idle")
    maintenance = checkpointBookkeepingAsync(dir, { lockWaitMs: 2000 })
    const result = await maintenance as { busy: number; log: number; checkpointed: number }
    expect(result.busy).toBe(0)
    expect(result.checkpointed).toBe(result.log)
    await pending
    expect((await exited)[0]).toBe(0)
    expect(connectionFor(dir).pending).toBe(0)
  } finally {
    if (writer.exitCode === null) writer.kill("SIGTERM")
    await exited
    await Promise.allSettled([pending, maintenance])
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 5000)

it("queues PASSIVE behind a native competing writer, ahead of later arrivals, with close accounting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-queue-"))
  const handle = initializeSessionBookkeeping(dir)
  const blocker = new Database(handle.path)
  const reader = new Database(handle.path)
  const order: string[] = []
  blocker.exec("BEGIN IMMEDIATE")
  const first = withBookkeepingWriteAsync(dir, { lockWaitMs: 2000, lockRetryMs: 2 }, tx => {
    tx.run("INSERT INTO fence_slots VALUES('store','first',1)")
    tx.afterCommit(() => {
      reader.exec("BEGIN")
      reader.prepare("SELECT * FROM fence_slots").all()
    })
    order.push("first")
  })
  let checkpoint: Promise<unknown> | undefined
  let later: Promise<unknown> | undefined
  let checkpointFrames = -1
  try {
    expect(() => checkpointBookkeeping(dir)).toThrow("idle")
    checkpoint = checkpointBookkeepingAsync(dir, { lockWaitMs: 2000 }).then(result => {
      expect(result.checkpointed).toBe(result.log)
      checkpointFrames = result.log
    })
    later = withBookkeepingWriteAsync(dir, { lockWaitMs: 2000 }, tx => {
      tx.run("INSERT INTO fence_slots VALUES('store','later',1)")
      order.push("later")
    })
    expect(connectionFor(dir).pending).toBe(3)
    expect(() => handle.close()).toThrow("admission")
    await delay(30)
    expect(order).toEqual([])
    blocker.exec("ROLLBACK")
    await Promise.all([first, checkpoint, later])
    expect(order).toEqual(["first", "later"])
    // Promise observers run after the next FIFO holder starts. Frame counts witness
    // the actual native checkpoint preceding the later holder's committed write.
    expect(checkpointFrames).toBeLessThan(checkpointBookkeeping(dir).log)
    expect(connectionFor(dir).pending).toBe(0)
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK")
    await Promise.allSettled([first, checkpoint, later])
    blocker.close()
    if (reader.inTransaction) reader.exec("ROLLBACK")
    reader.close()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it("bounds queued maintenance wait, cancels without checkpoint and restores pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-deadline-"))
  const handle = initializeSessionBookkeeping(dir)
  const blocker = new Database(handle.path)
  blocker.exec("BEGIN IMMEDIATE")
  const first = withBookkeepingWriteAsync(dir, { lockWaitMs: 1000, lockRetryMs: 2 }, () => true)
  try {
    const start = performance.now()
    await expect(checkpointBookkeepingAsync(dir, { lockWaitMs: 25 })).rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(performance.now() - start).toBeLessThan(500)
    const controller = new AbortController()
    const canceled = checkpointBookkeepingAsync(dir, { admissionSignal: controller.signal })
    controller.abort(new Error("maintenance canceled"))
    await expect(canceled).rejects.toThrow("maintenance canceled")
    expect(connectionFor(dir).pending).toBe(1)
    blocker.exec("ROLLBACK")
    await first
    expect((await checkpointBookkeepingAsync(dir)).busy).toBe(0)
    expect(connectionFor(dir).pending).toBe(0)
  } finally {
    if (blocker.inTransaction) blocker.exec("ROLLBACK")
    await first
    blocker.close()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it("PASSIVE retains a live reader's snapshot and WAL without truncation, then catches up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkpoint-reader-"))
  const handle = initializeSessionBookkeeping(dir)
  const reader = new Database(handle.path)
  try {
    reader.exec("BEGIN")
    reader.prepare("SELECT * FROM fence_slots").all()
    withBookkeepingWrite(dir, {}, tx => tx.run("INSERT INTO fence_slots VALUES('store','new',1)"))
    const size = statSync(handle.path + "-wal").size
    const partial = await checkpointBookkeepingAsync(dir)
    expect(partial.checkpointed).toBeLessThan(partial.log)
    expect(statSync(handle.path + "-wal").size).toBe(size)
    expect(reader.prepare("SELECT * FROM fence_slots WHERE slot='new'").get()).toBeUndefined()
    reader.exec("ROLLBACK")
    const complete = await checkpointBookkeepingAsync(dir)
    expect(complete.checkpointed).toBe(complete.log)
    expect(statSync(handle.path + "-wal").size).toBe(size)
    withBookkeepingWrite(dir, {}, () => {
      expect(() => checkpointBookkeepingAsync(dir)).toThrow("transaction")
    })
  } finally {
    if (reader.inTransaction) reader.exec("ROLLBACK")
    reader.close()
    handle.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
