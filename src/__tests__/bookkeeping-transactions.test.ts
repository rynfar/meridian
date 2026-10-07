import { afterEach, beforeEach, expect, it } from "bun:test"
import Database from "libsql"
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import {
  BookkeepingCommitUncertainError,
  BookkeepingBusyError,
  checkpointBookkeeping,
  checkpointBookkeepingOffline,
  getBookkeepingLockWaitMs,
  initializeSessionBookkeeping,
  withBookkeepingRead,
  withBookkeepingWrite,
  withBookkeepingWriteAsync,
  type BookkeepingHandle,
} from "../proxy/session/bookkeeping/database"
import { readMapping } from "../proxy/session/bookkeeping/mappings"
import { insertMapping } from "../proxy/session/bookkeeping/resourceImport"
import { allocateResource } from "../proxy/session/bookkeeping/resources"
import { canonicalizeLocator } from "../proxy/session/bookkeeping/locator"
import { tmpdir } from "node:os"
import { buildNodeFixture, writeBenchArtifact } from "./fixtures/bookkeeping-support"
import { SessionLifecycleLockError, SessionLifecycleReentrancyError } from "../proxy/session/lifecycleErrors"
import type { BookkeepingTransaction } from "../proxy/session/bookkeeping/types"
import { assertAdmissionDeadline, assertAdmissionHeartbeat, type AdmissionHeartbeat } from "./fixtures/bookkeeping-heartbeat"

let directory: string
let handle: BookkeepingHandle
let locator: ReturnType<typeof canonicalizeLocator>
const write = <T>(fn: (tx: BookkeepingTransaction) => T): T =>
  withBookkeepingWrite(directory, { scope: "publication" }, fn)
beforeEach(() => {
  const root = tmpdir()
  mkdirSync(root, { recursive: true })
  directory = mkdtempSync(join(root, "transactions-"))
  handle = initializeSessionBookkeeping(directory)
  locator = canonicalizeLocator({ sessionId: "c", configDir: directory })
})
afterEach(() => {
  handle?.close()
  rmSync(directory, { recursive: true, force: true })
})

function mutations(tx: BookkeepingTransaction): void {
  allocateResource(tx, locator, { state: "live", createdAt: 1, updatedAt: 1, attempts: 0 })
  insertMapping(tx, "key", {
    claudeSessionId: "c",
    createdAt: 1,
    lastUsedAt: 1,
    messageCount: 0,
    generationId: "g",
    currentTranscript: locator,
  })
  tx.run("INSERT INTO priority_assignments VALUES('route','p','digest',1,'key','g','r',1,1)")
}
function expectEmpty(): void {
  for (const table of [
    "resources",
    "mappings",
    "mapping_history",
    "mapping_pins",
    "priority_assignments",
    "fence_slots",
  ])
    expect(handle.reader.get(`SELECT count(*) AS n FROM ${table}`)?.n).toBe(0)
  expect(handle.reader.all("SELECT value FROM bookkeeping_counts").every((row) => row.value === 0)).toBe(true)
}

it("starts IMMEDIATE before a synchronous callback and publishes hooks only after durable commit", () => {
  const other = new Database(handle.path)
  other.pragma("busy_timeout=0")
  const events: string[] = []
  const hookErrors: unknown[] = []
  try {
    const value = withBookkeepingWrite(
      directory,
      { onHookError: (errors) => hookErrors.push(...errors) },
      (tx) => {
        expect(() => other.exec("BEGIN IMMEDIATE")).toThrow()
        mutations(tx)
        expect(readMapping(tx, "key")?.generationId).toBe("g")
        expect((other.prepare("SELECT count(*) AS n FROM mappings").get() as { n: number }).n).toBe(0)
        tx.afterCommit(() => {
          events.push("hook")
          expect((other.prepare("SELECT count(*) AS n FROM mappings").get() as { n: number }).n).toBe(1)
          other.exec("BEGIN IMMEDIATE; ROLLBACK")
        })
        events.push("callback")
        return 42
      },
    )
    expect(value).toBe(42)
    expect(hookErrors).toEqual([])
    expect(events).toEqual(["callback", "hook"])
  } finally {
    other.close()
  }
})

for (const failure of ["false", "throw", "commit"] as const) {
  it(`rolls back resource, mapping, priority, counts and cache hooks on ${failure}`, () => {
    let hookCalls = 0,
      calls = 0
    const callback = (tx: BookkeepingTransaction) => {
      calls++
      mutations(tx)
      tx.afterCommit(() => {
        hookCalls++
      })
      if (failure === "false") return false
      if (failure === "throw") throw new Error("callback fault")
      // Actual SQLite COMMIT fault, no production monkeypatch: this statement
      // succeeds, but its deferred foreign key cannot be satisfied at COMMIT.
      tx.run(
        `CREATE TEMP TABLE commit_fault(id INTEGER PRIMARY KEY,
          parent INTEGER REFERENCES commit_fault(id) DEFERRABLE INITIALLY DEFERRED)`,
      )
      tx.run("INSERT INTO commit_fault VALUES(1,2)")
      return true
    }
    if (failure === "false") expect(write(callback)).toBe(false)
    else expect(() => write(callback)).toThrow()
    expect(calls).toBe(1)
    expect(hookCalls).toBe(0)
    if (failure === "commit") withBookkeepingRead(directory, () => undefined)
    expectEmpty()
    expect(write((tx) => tx.run("INSERT INTO fence_slots VALUES('store','retry',1)"))).toBe(1)
  })
}

it("joins only explicit nested store writes, with the same capability and no second BEGIN", () => {
  let hook = false
  const result = write((outer) => {
    mutations(outer)
    const inner = withBookkeepingWrite(directory, { scope: "store" }, (tx) => {
      expect(tx).toBe(outer)
      expect(readMapping(tx, "key")?.generationId).toBe("g")
      tx.afterCommit(() => {
        hook = true
      })
      return "joined"
    })
    expect(hook).toBe(false)
    expect(inner).toBe("joined")
    return inner
  })
  expect(result).toBe("joined")
  expect(hook).toBe(true)
  expect(() =>
    withBookkeepingWrite(directory, {}, () =>
      withBookkeepingWrite(directory, { scope: "store" }, () => true),
    ),
  ).toThrow(SessionLifecycleReentrancyError)
  expect(() => write(() => withBookkeepingWriteAsync(directory, {}, () => true))).toThrow(
    SessionLifecycleReentrancyError,
  )
})

it("poisons an outer transaction on a nested false or swallowed throw", () => {
  expect(() =>
    write((tx) => {
      mutations(tx)
      expect(withBookkeepingWrite(directory, { scope: "store" }, () => false)).toBe(false)
      return true
    }),
  ).toThrow("rollback")
  expectEmpty()
  expect(() =>
    write((tx) => {
      mutations(tx)
      try {
        withBookkeepingWrite(directory, { scope: "store" }, () => {
          throw new Error("inner")
        })
      } catch (error) {
        expect(String(error)).toContain("inner")
      }
      return true
    }),
  ).toThrow("rollback")
  expectEmpty()
})

it("rejects cross-directory publication before any mutation on the second database", () => {
  const otherDirectory = join(directory, "other")
  const other = initializeSessionBookkeeping(otherDirectory)
  try {
    expect(() =>
      write((tx) => {
        mutations(tx)
        withBookkeepingWrite(otherDirectory, { scope: "store" }, (otherTx) =>
          otherTx.run("INSERT INTO fence_slots VALUES('store','bad',1)"),
        )
      }),
    ).toThrow("cross-database")
    expectEmpty()
    expect(other.reader.get("SELECT count(*) AS n FROM fence_slots")?.n).toBe(0)
  } finally {
    other.close()
  }
})

it("rejects thenables and prevents an async continuation or captured capability from writing", async () => {
  let captured: BookkeepingTransaction | undefined
  expect(() =>
    write((tx) => {
      captured = tx
      mutations(tx)
      return {
        then() {
          throw new Error("must not be awaited")
        },
      }
    }),
  ).toThrow("synchronous")
  expect(() => captured!.run("INSERT INTO fence_slots VALUES('store','late',1)")).toThrow("expired")
  let escaped = false
  expect(() =>
    write(async (tx) => {
      mutations(tx)
      await Promise.resolve()
      try {
        tx.run("INSERT INTO fence_slots VALUES('store','late',1)")
      } catch (error) {
        escaped = String(error).includes("expired")
      }
    }),
  ).toThrow("synchronous")
  await delay(0)
  expect(escaped).toBe(true)
  expectEmpty()
})

it("keeps afterCommit failure distinct from rollback and still runs subsequent cache hooks", () => {
  let lastHook = false
  const errors: unknown[] = []
  const result = withBookkeepingWrite(
    directory,
    { onHookError: (failures) => errors.push(...failures) },
    (tx) => {
      mutations(tx)
      tx.afterCommit(() => {
        throw new Error("cache failure")
      })
      tx.afterCommit(() => {
        lastHook = true
      })
      return "published"
    },
  )
  expect(result).toBe("published")
  expect(errors.map(String)).toEqual(["Error: cache failure"])
  expect(lastHook).toBe(true)
  expect(readMapping(handle.reader, "key")?.generationId).toBe("g")
})

it("returns retryable sync busy, expires async budget without callback and never replays after entry", async () => {
  const blocker = new Database(handle.path)
  blocker.exec("BEGIN IMMEDIATE")
  let calls = 0
  try {
    expect(() =>
      write(() => {
        calls++
      }),
    ).toThrow(BookkeepingBusyError)
    await expect(
      withBookkeepingWriteAsync(directory, { lockWaitMs: 35, lockRetryMs: 2 }, () => {
        calls++
      }),
    ).rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(calls).toBe(0)
  } finally {
    blocker.exec("ROLLBACK")
    blocker.close()
  }
  await expect(
    withBookkeepingWriteAsync(directory, {}, (tx) => {
      calls++
      mutations(tx)
      throw new BookkeepingBusyError("callback fault must not replay")
    }),
  ).rejects.toBeInstanceOf(BookkeepingBusyError)
  expect(calls).toBe(1)
  expectEmpty()
})

it("includes local FIFO waiting in the budget, honors cancellation and protects handles during admission", async () => {
  const blocker = new Database(handle.path)
  blocker.exec("BEGIN IMMEDIATE")
  const controller = new AbortController()
  const order: number[] = []
  const first = withBookkeepingWriteAsync(directory, { lockWaitMs: 1000, lockRetryMs: 2 }, () => {
    order.push(1)
  })
  const expired = withBookkeepingWriteAsync(directory, { lockWaitMs: 20 }, () => {
    order.push(2)
  })
  const canceled = withBookkeepingWriteAsync(directory, { admissionSignal: controller.signal }, () => {
    order.push(3)
  })
  const last = withBookkeepingWriteAsync(directory, { lockWaitMs: 1000 }, () => {
    order.push(4)
  })
  const expiredOutcome = expired.then(
    () => undefined,
    (error) => error as unknown,
  )
  const canceledOutcome = canceled.then(
    () => undefined,
    (error) => error as unknown,
  )
  try {
    expect(() => handle.close()).toThrow("admission")
    controller.abort(new Error("canceled"))
    expect(await expiredOutcome).toBeInstanceOf(SessionLifecycleLockError)
    expect(String(await canceledOutcome)).toContain("canceled")
  } finally {
    blocker.exec("ROLLBACK")
    blocker.close()
  }
  await Promise.all([first, last])
  expect(order).toEqual([1, 4])
  write(() => expect(() => handle.close()).toThrow("transaction"))
})

it("two real Node processes contend without a long synchronous event-loop stall", async () => {
  handle.close()
  const output = join(directory, "contention.mjs")
  const build = await buildNodeFixture("bookkeeping-contention.ts", "contention.mjs", directory)
  expect(build.success).toBe(true)
  const child = spawn("node", [output, directory], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const timeout = setTimeout(() => child.kill("SIGTERM"), 8000)
  let exit: number | null
  try {
    exit = await new Promise<number | null>((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", resolveExit)
    })
  } finally {
    clearTimeout(timeout)
  }
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  const evidence = JSON.parse(stdout) as {
    node: string
    calls: number
    elapsed: number
    maxLag: number
    histogramMax: number
    ticks: number
    committed: number
  }
  writeBenchArtifact("node-contention.json", evidence)
  expect(Number(evidence.node.split(".")[0])).toBeGreaterThanOrEqual(22)
  expect(evidence.calls).toBe(1)
  expect(evidence.committed).toBe(1)
  expect(evidence.ticks).toBeGreaterThan(0)
}, 10_000)

it("uses the maximum env budget and gives zero exactly one BEGIN attempt", async () => {
  expect(getBookkeepingLockWaitMs({})).toBe(10_000)
  expect(
    getBookkeepingLockWaitMs({ SESSION_GC_LOCK_WAIT_MS: "12000", MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "4000" }),
  ).toBe(12000)
  expect(
    getBookkeepingLockWaitMs({ SESSION_GC_LOCK_WAIT_MS: "20", MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "40" }),
  ).toBe(40)
  expect(
    getBookkeepingLockWaitMs({ SESSION_GC_LOCK_WAIT_MS: "0", MERIDIAN_SESSION_LOCK_TIMEOUT_MS: "0" }),
  ).toBe(0)
  expect(
    getBookkeepingLockWaitMs({ MERIDIAN_SESSION_GC_LOCK_WAIT_MS: "13000", SESSION_GC_LOCK_WAIT_MS: "10" }),
  ).toBe(13000)
  handle.close()
  let begins = 0
  handle = initializeSessionBookkeeping(directory, {
    executeTransaction(db, sql) {
      if (sql === "BEGIN IMMEDIATE") begins++
      db.exec(sql)
    },
  })
  expect(await withBookkeepingWriteAsync(directory, { lockWaitMs: 0 }, () => 7)).toBe(7)
  expect(begins).toBe(1)
  const blocker = new Database(handle.path)
  try {
    blocker.exec("BEGIN IMMEDIATE")
    await expect(
      withBookkeepingWriteAsync(directory, { lockWaitMs: 0 }, () => {
        throw new Error("must not enter")
      }),
    ).rejects.toBeInstanceOf(SessionLifecycleLockError)
    expect(begins).toBe(2)
  } finally {
    blocker.exec("ROLLBACK")
    blocker.close()
  }
})

for (const afterDurableCommit of [false, true]) {
  it(`poisons/reopens uncertain COMMIT (actual durable=${afterDurableCommit}) without hooks or replay`, async () => {
    handle.close()
    let inject = true,
      calls = 0,
      hooks = 0
    let poisoned: Database.Database | undefined
    handle = initializeSessionBookkeeping(directory, {
      executeTransaction(db, sql) {
        if (sql === "COMMIT" && inject) {
          inject = false
          poisoned = db
          if (afterDurableCommit) db.exec(sql)
          throw Object.assign(new Error("injected fsync failure"), {
            code: afterDurableCommit ? "SQLITE_IOERR_FSYNC" : "SQLITE_FULL",
          })
        }
        db.exec(sql)
      },
    })
    const failure = await withBookkeepingWriteAsync(directory, {}, (tx) => {
      calls++
      mutations(tx)
      tx.afterCommit(() => {
        hooks++
      })
    }).then(
      () => undefined,
      (error) => error as unknown,
    )
    expect(failure).toBeInstanceOf(BookkeepingCommitUncertainError)
    expect((failure as BookkeepingCommitUncertainError).committed).toBe("unknown")
    expect(() => poisoned!.prepare("SELECT 1").get()).toThrow()
    poisoned = undefined
    expect(() => handle.reader.get("SELECT 1")).toThrow("closed")
    await withBookkeepingWriteAsync(directory, {}, (tx) => {
      expect(readMapping(tx, "key") !== undefined).toBe(afterDurableCommit)
      tx.run("INSERT INTO fence_slots VALUES('store','reopened',1)")
    })
    expect(calls).toBe(1)
    expect(hooks).toBe(0)
    expect(handle.reader.get("PRAGMA wal_autocheckpoint")?.wal_autocheckpoint).toBe(0)
  })
}

it("retains a multi-SELECT snapshot while a second process commits between reads", () => {
  write((tx) =>
    insertMapping(tx, "key", {
      claudeSessionId: "c",
      generationId: "old",
      createdAt: 1,
      lastUsedAt: 1,
      messageCount: 0,
      messageHashes: ["old"],
    }),
  )
  withBookkeepingRead(directory, (reader) => {
    expect(reader.get("SELECT generation_id FROM mappings WHERE key='key'")?.generation_id).toBe("old")
    const child = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import D from 'libsql'; const d=new D(process.argv[1]);
          d.exec(\`BEGIN IMMEDIATE; UPDATE mappings SET generation_id='new';
            UPDATE mapping_history SET history_json='{"messageHashes":["new"]}'; COMMIT\`);
          d.close()`,
        handle.path,
      ],
      { encoding: "utf8" },
    )
    expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 0, stderr: "" })
    expect(readMapping(reader, "key")?.messageHashes).toEqual(["old"])
    expect(() => withBookkeepingWrite(directory, { scope: "store" }, () => true)).toThrow(
      SessionLifecycleReentrancyError,
    )
  })
  expect(withBookkeepingRead(directory, (reader) => readMapping(reader, "key"))?.messageHashes).toEqual([
    "new",
  ])
})

it("defers WAL checkpoint to maintenance and reserves file shrink for explicit offline TRUNCATE", () => {
  const initial = statSync(handle.path).size
  const walBefore = statSync(handle.path + "-wal").size
  for (let n = 0; n < 1400; n++)
    write((tx) =>
      insertMapping(tx, `m${n}`, {
        claudeSessionId: "c",
        generationId: String(n),
        createdAt: 1,
        lastUsedAt: 1,
        messageCount: 1,
        messageHashes: ["x".repeat(4096)],
      }),
    )
  const walGrown = statSync(handle.path + "-wal").size
  expect(walGrown).toBeGreaterThan(walBefore)
  expect(walGrown).toBeGreaterThan(5 * 1024 * 1024)
  expect(statSync(handle.path).size).toBe(initial)
  const result = checkpointBookkeeping(directory)
  expect(result.busy).toBe(0)
  expect(result.log).toBeGreaterThan(0)
  expect(result.checkpointed).toBe(result.log)
  expect(statSync(handle.path).size).toBeGreaterThan(initial)
  expect(statSync(handle.path + "-wal").size).toBe(walGrown)
  const truncated = checkpointBookkeepingOffline(directory, "TRUNCATE")
  expect(truncated.busy).toBe(0)
  expect(statSync(handle.path + "-wal").size).toBe(0)
})

it("rolls back a leftover transaction on close and releases the file to another process", () => {
  if (process.platform === "win32") return // Windows rename/ACL evidence is a separate gate.
  handle.close()
  let native: Database.Database | undefined
  handle = initializeSessionBookkeeping(directory, {
    executeTransaction(db, sql) {
      native = db
      db.exec(sql)
    },
  })
  write(() => true)
  native!.exec("BEGIN IMMEDIATE; INSERT INTO fence_slots VALUES('store','uncommitted',1)")
  handle.close()
  native = undefined
  const child = spawnSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `import D from 'libsql'; import{renameSync}from'node:fs'; const p=process.argv[1],d=new D(p);
        d.exec('BEGIN EXCLUSIVE');
        if(d.prepare("SELECT counter FROM fence_slots WHERE slot='uncommitted'").get()) process.exit(2);
        d.exec('ROLLBACK');d.close(); renameSync(p,p+'.moved');renameSync(p+'.moved',p)`,
      handle.path,
    ],
    { encoding: "utf8" },
  )
  expect({ code: child.status, stderr: child.stderr }).toEqual({ code: 0, stderr: "" })
  handle = initializeSessionBookkeeping(directory)
})

// One run carries the whole required sample count (measured ~12.4 s of a 40 s test budget).
const ADMISSION_DEADLINE_SAMPLES = 150
it(`never expires ${ADMISSION_DEADLINE_SAMPLES} Node admission budgets early while a child holds BEGIN IMMEDIATE`, async () => {
  handle.close()
  const build = await buildNodeFixture("bookkeeping-admission-deadline.ts", "deadline.mjs", directory)
  expect(build.success).toBe(true)
  const child = spawnSync("node", [join(directory, "deadline.mjs"), directory, String(ADMISSION_DEADLINE_SAMPLES)], {
    encoding: "utf8", timeout: 35_000,
  })
  expect({ status: child.status, stderr: child.stderr, error: child.error }).toEqual({
    status: 0, stderr: "", error: undefined,
  })
  const evidence = JSON.parse(child.stdout) as { node: string; samples: AdmissionHeartbeat[] }
  writeBenchArtifact("admission-deadline.json", evidence)
  expect(Number(evidence.node.split(".")[0])).toBeGreaterThanOrEqual(22)
  expect(evidence.samples).toHaveLength(ADMISSION_DEADLINE_SAMPLES)
  for (const sample of evidence.samples) assertAdmissionDeadline(sample)
}, 40_000)

it("measures three competing Node writers and bounds lock starvation by the admission budget", async () => {
  handle.close()
  const build = await buildNodeFixture("bookkeeping-three-process.ts", "three.mjs", directory)
  expect(build.success).toBe(true)
  const child = spawn("node", [join(directory, "three.mjs"), directory], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk)
  })
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const timer = setTimeout(() => child.kill("SIGTERM"), 12000)
  let exit: number | null
  try {
    exit = await new Promise<number | null>((resolve, reject) => {
      child.once("exit", resolve)
      child.once("error", reject)
    })
  } finally {
    clearTimeout(timer)
  }
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  const rows = JSON.parse(stdout) as Array<{
    completed: number
    rejected: number
    rejectionFraction: number
    rejections: Array<{ name: string; waitMs: number }>
    admissionBudgetMs: number
    expiryMs: number
    heartbeat: AdmissionHeartbeat
    maxAdmissionMs: number
    timerLagP50: number
    timerLagMax: number
    delayedFraction: number
    blockedFraction: number
    beginAttempts: number
    maxBeginMs: number
  }>
  writeBenchArtifact("three-process.json", rows)
  expect(rows.length).toBe(3)
  for (const row of rows) {
    expect(row.completed + row.rejected).toBe(250)
    expect(row.rejections).toHaveLength(row.rejected)
    for (const rejection of row.rejections) {
      expect(rejection.name).toBe("SessionLifecycleLockError")
      expect(rejection.waitMs).toBeGreaterThanOrEqual(row.admissionBudgetMs)
    }
    // Includes scheduler jitter and the short synchronous transaction after admission.
    expect(row.maxAdmissionMs).toBeLessThanOrEqual(row.admissionBudgetMs + 100)
    expect(row.rejectionFraction).toBe(row.rejected / 250)
    assertAdmissionHeartbeat(row.heartbeat)
  }
  console.log("three-writer rejection fractions:", rows.map((row) => row.rejectionFraction))
  handle = initializeSessionBookkeeping(directory)
  expect(handle.reader.get("SELECT count(*) AS n FROM fence_slots WHERE namespace='store' AND slot LIKE 'process-%'")?.n)
    .toBe(rows.reduce((sum, row) => sum + row.completed, 0))
}, 15000)
