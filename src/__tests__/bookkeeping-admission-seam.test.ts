import { expect, it } from "bun:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initializeSessionBookkeeping, withBookkeepingWriteAsync } from "../proxy/session/bookkeeping/database"
import { BookkeepingAdmissionSeamError, setBookkeepingAdmissionWaitForTest } from "../proxy/session/bookkeeping/transaction"
import { SessionLifecycleLockError } from "../proxy/session/lifecycleErrors"
import { sessionDeletionRuntime } from "../proxy/sessionLifecycle"
import { assertAdmissionHeartbeat, measureAdmissionHeartbeat } from "./fixtures/bookkeeping-heartbeat"
import { writeBenchArtifact } from "./fixtures/bookkeeping-support"

const blockingWait = async (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
function refusal(): BookkeepingAdmissionSeamError["reason"] | undefined {
  try { setBookkeepingAdmissionWaitForTest(blockingWait) } catch (error) {
    expect(error).toBeInstanceOf(BookkeepingAdmissionSeamError)
    return (error as BookkeepingAdmissionSeamError).reason
  }
  return undefined
}

// Must stay the first admission of this file's process: the seam refuses once any admission ran.
it("installs once before any admission; a blocking wait starves the heartbeat (negative control)", async () => {
  setBookkeepingAdmissionWaitForTest(blockingWait)
  expect(refusal()).toBe("already-installed")
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "admission-seam-")))
  const handle = initializeSessionBookkeeping(directory)
  const child = spawn("node", ["--input-type=module", "-e", `
    import Database from 'libsql';
    const db = new Database(${JSON.stringify(handle.path)});
    db.exec('BEGIN IMMEDIATE'); process.send('locked');
    process.on('disconnect', () => { db.exec('ROLLBACK'); db.close(); process.exit(0); });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => { stderr += String(chunk) })
  try {
    await Promise.race([once(child, "message"), once(child, "exit").then(([code]) => {
      throw new Error(`holder exited: ${code}: ${stderr}`)
    })])
    const blocked = await measureAdmissionHeartbeat(80, async () => {
      await expect(withBookkeepingWriteAsync(directory, { lockWaitMs: 80, lockRetryMs: 5 }, () => {
        throw new Error("child-held BEGIN IMMEDIATE must not admit")
      })).rejects.toBeInstanceOf(SessionLifecycleLockError)
    })
    expect(blocked.elapsedMs).toBeGreaterThanOrEqual(80)
    expect(() => assertAdmissionHeartbeat(blocked)).toThrow("timer starved")
    writeBenchArtifact("lifecycle-contention-negative-control.json", blocked)
  } finally {
    setBookkeepingAdmissionWaitForTest(undefined)
    if (child.exitCode === null) {
      const exited = once(child, "exit")
      if (child.connected) child.disconnect()
      else child.kill("SIGKILL")
      await exited
    }
    handle.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

it("refuses installation after an admission ran in this process, with a typed reason", () => {
  expect(refusal()).toBe("admission-started")
  expect(() => setBookkeepingAdmissionWaitForTest(undefined)).not.toThrow()
})

it("freezes the internal deletion runtime bridge", () => {
  expect(Object.isFrozen(sessionDeletionRuntime)).toBe(true)
  expect(() => Object.assign(sessionDeletionRuntime, { timeoutMs: 1 })).toThrow(TypeError)
  expect(sessionDeletionRuntime.timeoutMs).not.toBe(1)
})
