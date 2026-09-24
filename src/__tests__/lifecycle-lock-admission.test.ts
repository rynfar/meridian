import { afterEach, expect, it, spyOn } from "bun:test"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as durable from "../proxy/session/durableFileSystem"
import {
  getTranscriptResourceKey, prepareFork, publishPinnedTranscript, registerLiveTranscript,
  SessionLifecycleLockError, SessionLifecycleReentrancyError,
} from "../proxy/sessionLifecycle"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const storeDir = mkdtempSync(join(tmpdir(), "meridian-lock-admission-"))
  roots.push(storeDir)
  return { storeDir, sessionId: "first", configDir: storeDir }
}

it("does not execute a queued registration after admission cancellation", async () => {
  const first = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const sync = durable.syncDirectoryDurably
  const spy = spyOn(durable, "syncDirectoryDurably").mockImplementation(async path => {
    if (path === first.storeDir) { entered.resolve(); await release.promise }
    await sync(path)
  })
  const controller = new AbortController()
  try {
    const active = registerLiveTranscript(first, first)
    await entered.promise
    const second = { ...first, sessionId: "cancelled" }
    const waiting = registerLiveTranscript(second, { ...first, admissionSignal: controller.signal })
    const outcome = waiting.then(() => "executed", error => error)
    controller.abort(new Error("cancelled admission"))
    release.resolve()
    await active
    expect(await outcome).toEqual(new Error("cancelled admission"))
    const persisted: unknown = JSON.parse(readFileSync(join(first.storeDir, "session-gc.json"), "utf8"))
    expect(persisted).not.toHaveProperty(`resources.${getTranscriptResourceKey(second)}`)
  } finally {
    release.resolve()
    spy.mockRestore()
  }
})

it("finishes directory durability and returns ownership when cancellation arrives during a transaction", async () => {
  const target = fixture()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const sync = durable.syncDirectoryDurably
  let directorySynced = false
  let acknowledged = false
  const spy = spyOn(durable, "syncDirectoryDurably").mockImplementation(async path => {
    if (path === target.storeDir) { entered.resolve(); await release.promise }
    await sync(path)
    directorySynced = true
  })
  const controller = new AbortController()
  try {
    const operation = registerLiveTranscript(target, { ...target, admissionSignal: controller.signal })
      .then(result => { acknowledged = true; return result })
    await entered.promise
    controller.abort()
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(directorySynced).toBe(false)
    release.resolve()
    const result = await operation
    expect(directorySynced).toBe(true)
    expect(result.lifecycleGeneration).toBeDefined()
    const persisted: unknown = JSON.parse(readFileSync(join(target.storeDir, "session-gc.json"), "utf8"))
    expect(persisted).toHaveProperty(`resources.${getTranscriptResourceKey(target)}.generation`, result.lifecycleGeneration)
  } finally {
    release.resolve()
    spy.mockRestore()
  }
})

it("releases only its own lock and skips mutation when cancellation races successful publication", async () => {
  const target = fixture()
  const controller = new AbortController()
  const link = fsPromises.link
  const lock = join(target.storeDir, "session-gc.json.lock")
  const spy = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
    await link(source, destination)
    if (destination === lock) controller.abort(new Error("cancelled acquisition"))
  })
  try {
    await expect(registerLiveTranscript(target, { ...target, admissionSignal: controller.signal }))
      .rejects.toThrow("cancelled acquisition")
    expect(readdirSync(target.storeDir)).toEqual([])
  } finally {
    spy.mockRestore()
  }
})

it("still bounds an externally held lock without stealing its ownership", async () => {
  const target = fixture()
  const lock = join(target.storeDir, "session-gc.json.lock")
  writeFileSync(lock, "external owner\n")
  await expect(registerLiveTranscript(target, { ...target, lockWaitMs: 0 }))
    .rejects.toBeInstanceOf(SessionLifecycleLockError)
  expect(readFileSync(lock, "utf8")).toBe("external owner\n")
  expect(readdirSync(target.storeDir)).toEqual(["session-gc.json.lock"])
})

it("hands off after aborting external acquisition without removing the external owner", async () => {
  const target = fixture()
  const lock = join(target.storeDir, "session-gc.json.lock")
  writeFileSync(lock, "external owner\n")
  const attempted = Promise.withResolvers<void>()
  const controller = new AbortController()
  const link = fsPromises.link
  const spy = spyOn(fsPromises, "link").mockImplementation(async (source, destination) => {
    try {
      await link(source, destination)
    } finally {
      if (destination === lock) attempted.resolve()
    }
  })
  const active = registerLiveTranscript(target, { ...target, admissionSignal: controller.signal })
    .catch(error => error)
  let successor: Promise<unknown> | undefined
  try {
    await attempted.promise
    successor = registerLiveTranscript({ ...target, sessionId: "successor" }, target)
    controller.abort(new Error("cancel external acquisition"))
    expect(await active).toEqual(new Error("cancel external acquisition"))
    expect(readFileSync(lock, "utf8")).toBe("external owner\n")
    rmSync(lock)
    expect(await successor).toHaveProperty("lifecycleGeneration")
  } finally {
    controller.abort()
    await Promise.allSettled([active, successor])
    spy.mockRestore()
  }
})

it("rejects lifecycle reentrancy from a synchronous publication callback and preserves rollback", async () => {
  const target = fixture()
  await prepareFork(target, target)
  let nested: Promise<unknown> | undefined
  expect(await publishPinnedTranscript(target, () => {
    nested = registerLiveTranscript({ ...target, sessionId: "nested" }, target).catch(error => error)
    return false
  }, target)).toBe(false)
  expect(await nested).toBeInstanceOf(SessionLifecycleReentrancyError)
  const persisted: unknown = JSON.parse(readFileSync(join(target.storeDir, "session-gc.json"), "utf8"))
  expect(persisted).toHaveProperty(`resources.${getTranscriptResourceKey(target)}.state`, "prepared")
})
