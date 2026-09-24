import { expect, it } from "bun:test"
import { LifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import {
  SessionLifecycleQueueCapacityError,
  SessionLifecycleQueueStalledError,
  SessionLifecycleReentrancyError,
} from "../proxy/session/lifecycleErrors"

function controlledClock() {
  let now = 0
  const timers = new Map<() => void, number>()
  return {
    schedule: (callback: () => void, delay: number) => {
      timers.set(callback, now + delay)
      return () => { timers.delete(callback) }
    },
    advance: (milliseconds: number) => {
      now += milliseconds
      for (const [callback, deadline] of timers) {
        if (deadline <= now) {
          timers.delete(callback)
          callback()
        }
      }
    },
  }
}

it("serves FIFO when cumulative local waiting exceeds the active stall budget", async () => {
  // Given: every individual holder progresses before its own stall deadline.
  const clock = controlledClock()
  const queue = new LifecycleLockQueue({ stallMs: 100, schedule: clock.schedule })
  const gates = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
  const order: number[] = []
  const operations = gates.map((gate, index) => queue.run("store", undefined, async () => {
    order.push(index)
    started[index]?.resolve()
    await gate.promise
  }))
  // When: the third caller waits through two healthy 90ms holders.
  for (let index = 0; index < gates.length; index++) {
    await started[index]?.promise
    clock.advance(90)
    gates[index]?.resolve()
    await operations[index]
  }
  // Then: no caller expires merely because predecessors made progress.
  await Promise.all(operations)
  expect(order).toEqual([0, 1, 2])
})

it("removes an aborted middle waiter and immediately frees its capacity", async () => {
  const queue = new LifecycleLockQueue({ maxPending: 1 })
  const holder = Promise.withResolvers<void>()
  const active = queue.run("store", undefined, () => holder.promise)
  const controller = new AbortController()
  const order: string[] = []
  const aborted = queue.run("store", controller.signal, async () => { order.push("aborted") })
  const rejection = aborted.then(() => undefined, error => error)
  controller.abort(new Error("cancelled"))
  expect(await rejection).toEqual(new Error("cancelled"))
  const successor = queue.run("store", undefined, async () => { order.push("successor") })
  holder.resolve()
  await Promise.all([active, successor])
  expect(order).toEqual(["successor"])
})

it("rejects capacity overflow without executing rejected work", async () => {
  const queue = new LifecycleLockQueue({ maxPending: 1 })
  const holder = Promise.withResolvers<void>()
  const active = queue.run("store", undefined, () => holder.promise)
  const waiting = queue.run("store", undefined, async () => {})
  let executed = false
  await expect(queue.run("store", undefined, async () => { executed = true }))
    .rejects.toBeInstanceOf(SessionLifecycleQueueCapacityError)
  holder.resolve()
  await Promise.all([active, waiting])
  expect(executed).toBe(false)
})

it("rejects waiters behind a stalled active holder without permitting overlap", async () => {
  const clock = controlledClock()
  const queue = new LifecycleLockQueue({ stallMs: 100, schedule: clock.schedule })
  const holder = Promise.withResolvers<void>()
  const active = queue.run("store", undefined, () => holder.promise)
  let executed = false
  const waiting = queue.run("store", undefined, async () => { executed = true })
  const rejection = waiting.then(() => undefined, error => error)
  clock.advance(100)
  expect(await rejection).toBeInstanceOf(SessionLifecycleQueueStalledError)
  await expect(queue.run("store", undefined, async () => { executed = true }))
    .rejects.toBeInstanceOf(SessionLifecycleQueueStalledError)
  expect(executed).toBe(false)
  holder.resolve()
  await active
  await queue.run("store", undefined, async () => { executed = true })
  expect(executed).toBe(true)
})

it("does not settle or release an active transaction when its caller aborts", async () => {
  const queue = new LifecycleLockQueue()
  const holder = Promise.withResolvers<void>()
  const controller = new AbortController()
  let settled = false
  const active = queue.run("store", controller.signal, async () => {
    await holder.promise
    return "durable"
  }).then(result => { settled = true; return result })
  controller.abort()
  await Promise.resolve()
  expect(settled).toBe(false)
  holder.resolve()
  expect(await active).toBe("durable")
})

it("rejects same-context reentrancy while allowing other lock paths", async () => {
  const queue = new LifecycleLockQueue()
  await queue.run("store", undefined, async () => {
    await expect(queue.run("store", undefined, async () => "nested"))
      .rejects.toBeInstanceOf(SessionLifecycleReentrancyError)
    expect(await queue.run("other-store", undefined, async () => "independent")).toBe("independent")
  })
})

it("hands off after an active failure and does not retain stale async-context ownership", async () => {
  const queue = new LifecycleLockQueue()
  const later = Promise.withResolvers<void>()
  let continuation: Promise<string> | undefined
  await expect(queue.run("store", undefined, async () => {
    continuation = later.promise.then(() => queue.run("store", undefined, async () => "later"))
    throw new Error("transaction failed")
  })).rejects.toThrow("transaction failed")
  later.resolve()
  expect(await continuation).toBe("later")
})
