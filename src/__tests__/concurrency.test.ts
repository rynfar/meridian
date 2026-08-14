import { afterEach, describe, expect, test } from "bun:test"
import {
  AbortableSemaphore,
  getProcessSdkSemaphore,
  resetProcessSdkSemaphoreForTests,
  resolveMaxConcurrent,
} from "../proxy/concurrency"

describe("AbortableSemaphore", () => {
  test("limits active leases and grants queued waiters FIFO", async () => {
    const semaphore = new AbortableSemaphore(1)
    const first = await semaphore.acquire()
    const order: number[] = []
    const secondP = semaphore.acquire().then(lease => { order.push(2); return lease })
    const thirdP = semaphore.acquire().then(lease => { order.push(3); return lease })

    expect(semaphore.snapshot).toEqual({ active: 1, queued: 2, limit: 1 })
    first.release()
    const second = await secondP
    expect(order).toEqual([2])
    second.release()
    const third = await thirdP
    expect(order).toEqual([2, 3])
    third.release()
    expect(semaphore.snapshot).toEqual({ active: 0, queued: 0, limit: 1 })
  })

  test("removes an aborted waiter without consuming capacity", async () => {
    const semaphore = new AbortableSemaphore(1)
    const first = await semaphore.acquire()
    const controller = new AbortController()
    const cancelled = semaphore.acquire(controller.signal)
    const next = semaphore.acquire()
    controller.abort("gone")
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" })
    expect(semaphore.snapshot.queued).toBe(1)
    first.release()
    const lease = await next
    expect(semaphore.snapshot.active).toBe(1)
    lease.release()
  })

  test("release is idempotent", async () => {
    const semaphore = new AbortableSemaphore(1)
    const lease = await semaphore.acquire()
    lease.release()
    lease.release()
    expect(semaphore.snapshot.active).toBe(0)
  })
})

describe("resolveMaxConcurrent", () => {
  const original = { ...process.env }
  afterEach(() => {
    process.env = { ...original }
    resetProcessSdkSemaphoreForTests()
  })

  test("accepts primary and legacy positive integer values", () => {
    expect(resolveMaxConcurrent({ MERIDIAN_MAX_CONCURRENT: "3" }, () => {})).toBe(3)
    expect(resolveMaxConcurrent({ CLAUDE_PROXY_MAX_CONCURRENT: "4" }, () => {})).toBe(4)
  })

  test("uses the documented default silently when unset", () => {
    const warnings: string[] = []
    expect(resolveMaxConcurrent({}, message => warnings.push(message))).toBe(10)
    expect(warnings).toEqual([])
  })

  test("falls back and warns at most once for invalid values", () => {
    const warnings: string[] = []
    expect(resolveMaxConcurrent({ MERIDIAN_MAX_CONCURRENT: "1.5" }, message => warnings.push(message))).toBe(10)
    expect(resolveMaxConcurrent({ MERIDIAN_MAX_CONCURRENT: "0" }, message => warnings.push(message))).toBe(10)
    expect(warnings).toHaveLength(1)
  })
})

describe("getProcessSdkSemaphore", () => {
  const originalMax = process.env.MERIDIAN_MAX_CONCURRENT

  afterEach(() => {
    resetProcessSdkSemaphoreForTests()
    if (originalMax === undefined) delete process.env.MERIDIAN_MAX_CONCURRENT
    else process.env.MERIDIAN_MAX_CONCURRENT = originalMax
  })

  test("shares one semaphore across callers in the same process", () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "3"
    const first = getProcessSdkSemaphore()
    const second = getProcessSdkSemaphore()
    expect(second).toBe(first)
    expect(first.limit).toBe(3)
  })
})
