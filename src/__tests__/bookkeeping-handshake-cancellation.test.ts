import { expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { initializeSessionBookkeeping, connectionFor } from "../proxy/session/bookkeeping/connection"
import { registerLiveTranscript } from "../proxy/session/bookkeeping/lifecycleRegisterSql"
import { abandonFork } from "../proxy/session/bookkeeping/lifecycleTransitionsSql"
import { runDeletionPhase } from "../proxy/session/bookkeeping/lifecycleDeletionSql"
import { withBookkeepingWriteAsync } from "../proxy/session/bookkeeping/transaction"
import type { SessionLifecycleOptions } from "../proxy/sessionLifecycle"

it.each(["busy", "clear", "external-cancel"] as const)("handshake cancellation reaches real SQL admission (%s)", async mode => {
  const directory = mkdtempSync(join(tmpdir(), "sql-handshake-"))
  const ready = join(directory, "writer-ready"), released = join(directory, "writer-released")
  const marker = join(directory, "sdk-calls"), sdk = join(directory, "sdk.mjs")
  writeFileSync(sdk, `import {appendFileSync} from 'node:fs'; export async function deleteSession() {
    appendFileSync(${JSON.stringify(marker)}, 'called\\n'); }`)
  let armed = false, writerStarted = false, executorCommits = 0
  let writer: ReturnType<typeof spawn> | undefined, writerExit: Promise<unknown> | undefined
  const handle = initializeSessionBookkeeping(directory, { executeTransaction(db, sql) {
    db.exec(sql) // observation only: every SQL operation and COMMIT is genuine
    if (sql !== "COMMIT" || !armed) return
    const row = db.prepare("SELECT state,deletion_executor_json FROM resources").get() as
      { state: string; deletion_executor_json: string | null } | undefined
    if (row?.deletion_executor_json) executorCommits++
    if (row?.state === "deleting" && mode !== "clear" && !writerStarted) {
      writerStarted = true
      writer = spawn("node", ["--input-type=module", "-e", `
        import Database from 'libsql'; import {writeFileSync} from 'node:fs';
        const [path,ready,released]=process.argv.slice(1); const db=new Database(path);
        db.pragma('busy_timeout=0'); db.exec('BEGIN IMMEDIATE'); writeFileSync(ready,'locked');
        setTimeout(()=>{db.exec('ROLLBACK'); db.close(); writeFileSync(released,'done');},1100);
      `, handle.path, ready, released], { stdio: ["ignore", "pipe", "pipe"] })
      writerExit = once(writer, "exit")
      const deadline = Date.now() + 3000, sleeper = new Int32Array(new SharedArrayBuffer(4))
      while (!existsSync(ready)) {
        if (Date.now() > deadline) throw new Error("native competing writer failed to lock")
        Atomics.wait(sleeper, 0, 0, 5)
      }
    }
  } })
  const controller = new AbortController()
  const options: SessionLifecycleOptions = { storeDir: directory, retiredGraceMs: 0, maxDeletesPerRun: 1,
    lockWaitMs: 3000, lockRetryMs: 10, deletionHandshakeTimeoutMs: 80, deletionTimeoutMs: 1000,
    sdkModuleUrl: pathToFileURL(sdk).href,
    ...(mode === "external-cancel" ? { admissionSignal: controller.signal } : {}) }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const locator = await registerLiveTranscript({ configDir: directory, sessionId: "synthetic" }, options)
    await abandonFork(locator, options)
    armed = true
    const phase = runDeletionPhase([], options)
    if (mode === "external-cancel") timer = setTimeout(() => controller.abort(new Error("external cancellation")), 180)
    if (mode === "external-cancel") {
      await expect(phase).rejects.toThrow("external cancellation")
      expect(existsSync(released)).toBe(false)
    } else await phase
    expect(connectionFor(directory).pending).toBe(0)
    if (writerExit) await writerExit
    // Waiting for finish/requeue behind the real writer is legitimate; the
    // falsifier is ANY executor COMMIT after expired handshake, not total time.
    expect(executorCommits).toBe(mode === "clear" ? 1 : 0)
    expect(existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0).toBe(mode === "clear" ? 1 : 0)
    const row = handle.reader.get("SELECT state,last_error FROM resources")
    expect(row?.state).toBe(mode === "clear" ? "deleted" : mode === "busy" ? "retired" : "deleting")
    if (mode === "busy") expect(row?.last_error).toContain("handshake timed out")
    await withBookkeepingWriteAsync(directory, { lockWaitMs: 300 }, () => true)
    expect(connectionFor(directory).pending).toBe(0)
  } finally {
    if (timer) clearTimeout(timer)
    if (writer && writer.exitCode === null) { writer.kill("SIGKILL"); await writerExit }
    handle.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
