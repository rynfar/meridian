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

  test("raising the limit grants waiting acquisitions immediately, in order", async () => {
    const semaphore = new AbortableSemaphore(1)
    const held = await semaphore.acquire()
    const order: number[] = []
    const secondP = semaphore.acquire().then(lease => { order.push(2); return lease })
    const thirdP = semaphore.acquire().then(lease => { order.push(3); return lease })
    expect(semaphore.snapshot).toEqual({ active: 1, queued: 2, limit: 1 })

    semaphore.setLimit(3)
    const [second, third] = await Promise.all([secondP, thirdP])

    expect(order).toEqual([2, 3])
    expect(semaphore.snapshot).toEqual({ active: 3, queued: 0, limit: 3 })
    held.release()
    second.release()
    third.release()
  })

  test("lowering the limit never revokes a live lease; it converges as they release", async () => {
    const semaphore = new AbortableSemaphore(3)
    const leases = [await semaphore.acquire(), await semaphore.acquire(), await semaphore.acquire()]

    semaphore.setLimit(1)
    // Work already underway keeps its permit: active is allowed to exceed the
    // new budget until it drains.
    expect(semaphore.snapshot).toEqual({ active: 3, queued: 0, limit: 1 })

    let granted = false
    const queued = semaphore.acquire().then(lease => { granted = true; return lease })

    leases[0]!.release()
    await Promise.resolve()
    expect(granted).toBe(false)
    leases[1]!.release()
    await Promise.resolve()
    expect(granted).toBe(false)

    leases[2]!.release()
    const lease = await queued
    expect(semaphore.snapshot).toEqual({ active: 1, queued: 0, limit: 1 })
    lease.release()
  })

  test("setLimit rejects values that are not positive integers", () => {
    const semaphore = new AbortableSemaphore(2)
    expect(() => semaphore.setLimit(0)).toThrow(RangeError)
    expect(() => semaphore.setLimit(-1)).toThrow(RangeError)
    expect(() => semaphore.setLimit(1.5)).toThrow(RangeError)
    expect(() => semaphore.setLimit(Number.NaN)).toThrow(RangeError)
    expect(semaphore.limit).toBe(2)
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

  test("follows a later environment change without losing the shared instance", () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "2"
    const first = getProcessSdkSemaphore()
    expect(first.limit).toBe(2)

    // A second proxy starting later in the same process — or a test that sets
    // the variable after the first proxy booted — used to be ignored outright.
    process.env.MERIDIAN_MAX_CONCURRENT = "5"
    const second = getProcessSdkSemaphore()
    expect(second).toBe(first)
    expect(second.limit).toBe(5)

    process.env.MERIDIAN_MAX_CONCURRENT = "1"
    expect(getProcessSdkSemaphore().limit).toBe(1)
  })

  test("returns to the default budget when the variable is unset again", () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "2"
    expect(getProcessSdkSemaphore().limit).toBe(2)
    delete process.env.MERIDIAN_MAX_CONCURRENT
    expect(getProcessSdkSemaphore().limit).toBe(10)
  })

  test("an invalid value falls back to the default rather than throwing", () => {
    process.env.MERIDIAN_MAX_CONCURRENT = "4"
    const semaphore = getProcessSdkSemaphore()
    process.env.MERIDIAN_MAX_CONCURRENT = "not-a-number"
    expect(getProcessSdkSemaphore()).toBe(semaphore)
    expect(semaphore.limit).toBe(10)
  })
})
