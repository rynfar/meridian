import { afterEach, beforeEach, expect, it } from "bun:test"
import Database from "libsql"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireMaintenanceGuard,
  acquireRuntimeGuard,
  assertGuardLease,
  BookkeepingGuardBusyError,
  MAINTENANCE_GUARD_FILENAME,
} from "../proxy/session/bookkeeping/guard"
import type { GuardLease } from "../proxy/session/bookkeeping/guard"
import { initializeSessionBookkeeping, withBookkeepingWrite } from "../proxy/session/bookkeeping/database"
import type { BookkeepingHandle } from "../proxy/session/bookkeeping/database"
import { openForMaintenance } from "../proxy/session/bookkeeping/maintenance"
import { buildNodeFixture } from "./fixtures/bookkeeping-support"

let directory: string
const held: Array<{ close(): void }> = []
function track<T extends { close(): void }>(handle: T): T {
  held.push(handle)
  return handle
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bookkeeping-maintenance-"))
})
afterEach(() => {
  for (const handle of held.splice(0).reverse()) handle.close()
  rmSync(directory, { recursive: true, force: true })
})

it("allows multiple shared holders and requires every one to stop before maintenance", () => {
  const first = track(acquireRuntimeGuard(directory))
  const second = track(acquireRuntimeGuard(directory))
  expect(first.mode).toBe("shared")
  expect(second.mode).toBe("shared")
  expect(() => acquireMaintenanceGuard(directory)).toThrow("stop all proxies")
  first.close()
  expect(() => acquireMaintenanceGuard(directory)).toThrow(BookkeepingGuardBusyError)
  second.close()
  const exclusive = track(acquireMaintenanceGuard(directory))
  expect(exclusive.mode).toBe("exclusive")
  expect(() => acquireRuntimeGuard(directory)).toThrow(BookkeepingGuardBusyError)
})

it("uses a private rollback-journal guard with durable format identity", () => {
  const lease = track(acquireRuntimeGuard(directory))
  expect(statSync(lease.path).mode & 0o777).toBe(0o600)
  lease.close()
  const db = new Database(lease.path)
  try {
    expect(db.pragma("journal_mode")).toEqual([{ journal_mode: "delete" }])
    expect(db.pragma("user_version")).toEqual([{ user_version: 1 }])
    expect(db.prepare("SELECT format,epoch FROM maintenance_guard").all()).toEqual([
      { format: "meridian-bookkeeping-guard", epoch: 0 },
    ])
  } finally {
    db.close()
  }
  expect(existsSync(lease.path + "-wal")).toBe(false)
})

it("ties a shared guard to the main registry lifetime, including poisoned/reopened connections", () => {
  let fail = true
  const first = track(
    initializeSessionBookkeeping(directory, {
      executeTransaction(db, sql) {
        if (sql === "COMMIT" && fail) {
          fail = false
          throw new Error("injected uncertain commit")
        }
        db.exec(sql)
      },
    }),
  )
  const second = track(initializeSessionBookkeeping(directory))
  expect(() => acquireMaintenanceGuard(directory)).toThrow(BookkeepingGuardBusyError)
  expect(() => withBookkeepingWrite(directory, {}, () => true)).toThrow("outcome unknown")
  expect(() => acquireMaintenanceGuard(directory)).toThrow(BookkeepingGuardBusyError)
  expect(withBookkeepingWrite(directory, {}, () => 42)).toBe(42)
  first.close()
  expect(() => acquireMaintenanceGuard(directory)).toThrow(BookkeepingGuardBusyError)
  second.close()
  track(acquireMaintenanceGuard(directory))
})

it("holds exclusive maintenance around the main handle without stealing its caller-owned guard", () => {
  track(initializeSessionBookkeeping(directory)).close()
  const guard = track(acquireMaintenanceGuard(directory))
  const main = track(openForMaintenance(directory, { expectPhase: "READY", guard }))
  expect(() => guard.close()).toThrow("close guarded main handles")
  expect(() => guard.toShared(() => undefined)).toThrow("close guarded main handles")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("stop all proxies")
  main.close()
  assertGuardLease(guard, directory, "exclusive")
  expect(() => acquireRuntimeGuard(directory)).toThrow(BookkeepingGuardBusyError)
  let rechecked = false
  const shared = guard.toShared(() => {
    rechecked = true
  })
  expect(rechecked).toBe(true)
  expect(shared.mode).toBe("shared")
  track(initializeSessionBookkeeping(directory)).close()
  expect(() => acquireMaintenanceGuard(directory)).toThrow(BookkeepingGuardBusyError)
  shared.close()
  track(acquireMaintenanceGuard(directory))
})

it("rejects a foreign guard and releases a failed initialization lease", () => {
  const fake: GuardLease = { path: "fake", mode: "exclusive", close() {} }
  expect(() => assertGuardLease(fake, directory, "exclusive")).toThrow("foreign")
  writeFileSync(join(directory, "sessions.json"), "{}")
  expect(() => initializeSessionBookkeeping(directory)).toThrow("offline migration")
  track(acquireMaintenanceGuard(directory))
})

it("rechecks backend only under the new shared lease and releases it when that recheck fails", () => {
  const guard = track(acquireMaintenanceGuard(directory))
  expect(() =>
    guard.toShared(() => {
      throw new Error("backend is exporting")
    }),
  ).toThrow("exporting")
  expect(() => assertGuardLease(guard, directory, "shared")).toThrow("closed")
  track(acquireMaintenanceGuard(directory))
})

it("fails closed on zero-byte, wrong-format and WAL guard databases", () => {
  const path = join(directory, MAINTENANCE_GUARD_FILENAME)
  writeFileSync(path, "")
  expect(() => acquireRuntimeGuard(directory)).toThrow()
  rmSync(path)
  const guard = track(acquireRuntimeGuard(directory))
  guard.close()
  const db = new Database(path)
  db.pragma("user_version=2")
  db.close()
  expect(() => acquireRuntimeGuard(directory)).toThrow("format/version")
  const wal = new Database(path)
  wal.pragma("user_version=1")
  wal.pragma("journal_mode=WAL")
  wal.close()
  expect(() => acquireRuntimeGuard(directory)).toThrow("never WAL")
})

it("cleans a dead guard bootstrap candidate, without silently changing directory permissions", async () => {
  expect((await buildNodeFixture("bookkeeping-guard.ts", "guard.mjs", directory)).success).toBe(true)
  const orphan = spawnSync("node", [join(directory, "guard.mjs"), directory, "orphan"])
  expect(orphan.status).toBe(0)
  track(acquireRuntimeGuard(directory)).close()
  expect(readdirSync(directory).some((name) => name.includes(".tmp-"))).toBe(false)
  chmodSync(directory, 0o755)
  expect(() => acquireRuntimeGuard(directory)).toThrow("already be private")
  chmodSync(directory, 0o700)
})

it("closing one of two same-process guard leases does not drop the survivor's physical lock", async () => {
  expect((await buildNodeFixture("bookkeeping-guard.ts", "guard.mjs", directory)).success).toBe(true)
  const first = track(acquireRuntimeGuard(directory))
  const second = track(acquireRuntimeGuard(directory))
  const probe = () => spawnSync("node", [join(directory, "guard.mjs"), directory, "probe-maintenance"], {
    encoding: "utf8", timeout: 4000,
  })
  expect(probe().status).toBe(73)
  first.close()
  expect(probe().status).toBe(73)
  second.close()
  expect(probe().status).toBe(0)
})

it("detects a second process winning the exclusive-to-shared gap", async () => {
  expect((await buildNodeFixture("bookkeeping-guard.ts", "guard.mjs", directory)).success).toBe(true)
  const guard = track(acquireMaintenanceGuard(directory))
  let verified = false
  expect(() =>
    guard.toShared(
      () => {
        verified = true
      },
      () => {
        const child = spawnSync("node", [join(directory, "guard.mjs"), directory, "commit-maintenance"], {
          encoding: "utf8",
          timeout: 4000,
        })
        expect({ exit: child.status, stderr: child.stderr }).toEqual({ exit: 0, stderr: "" })
      },
    ),
  ).toThrow(BookkeepingGuardBusyError)
  expect(verified).toBe(false)
  track(acquireRuntimeGuard(directory))
})

it("two real runtime processes exclude maintenance until the last process releases its lease", async () => {
  expect((await buildNodeFixture("bookkeeping-guard.ts", "guard.mjs", directory)).success).toBe(true)
  const script = join(directory, "guard.mjs")
  const children = [0, 1].map(() =>
    spawn("node", [script, directory, "runtime"], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }),
  )
  const errors = ["", ""]
  children.forEach((child, n) =>
    child.stderr?.on("data", (chunk) => {
      errors[n] += String(chunk)
    }),
  )
  const exits = children.map(
    (child) =>
      new Promise<number | null>((resolve, reject) => {
        child.once("exit", resolve)
        child.once("error", reject)
      }),
  )
  const ready = children.map((child, n) =>
    Promise.race([
      new Promise<void>((resolve) => child.once("message", () => resolve())),
      exits[n]!.then((code) => {
        throw new Error(`runtime ${n} exited early: ${code}: ${errors[n]}`)
      }),
    ]),
  )
  const timer = setTimeout(() => children.forEach((child) => child.kill("SIGTERM")), 10000)
  const probe = () =>
    spawnSync("node", [script, directory, "probe-maintenance"], {
      encoding: "utf8",
      timeout: 4000,
    })
  try {
    await Promise.all(ready)
    expect(probe().status).toBe(73)
    children[0]!.send("close")
    expect(await exits[0]).toBe(0)
    expect(probe().status).toBe(73)
    children[1]!.send("close")
    expect(await exits[1]).toBe(0)
    const last = probe()
    expect({ exit: last.status, stderr: last.stderr }).toEqual({ exit: 0, stderr: "" })
    expect(errors).toEqual(["", ""])
  } finally {
    clearTimeout(timer)
    children.forEach((child) => {
      if (child.exitCode === null) child.kill("SIGTERM")
    })
    await Promise.allSettled(exits)
  }
}, 15000)
