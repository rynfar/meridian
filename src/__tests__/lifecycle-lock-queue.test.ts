import { expect, it, spyOn } from "bun:test"
import { LifecycleLockQueue } from "../proxy/session/lifecycleLockQueue"
import { diagnosticLog } from "../telemetry"
import { setProxyDiagnosticSink, setProxyLogSilent } from "../proxy/operationalLog"
import {
  SessionLifecycleQueueCapacityError,
  SessionLifecycleQueueStalledError,
  SessionLifecycleReentrancyError,
} from "../proxy/session/lifecycleErrors"

function controlledClock() {
  let now = 0
  const timers = new Map<() => void, number>()
  return {
    now: () => now,
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

it("does not blame the holder for a stall deadline delayed by a blocked event loop", async () => {
  // Given: a holder whose own continuations were blocked along with the
  // deadline - synchronous work anywhere in the process froze the loop.
  const clock = controlledClock()
  const logged: string[] = []
  const queue = new LifecycleLockQueue({ stallMs: 100, lagToleranceMs: 10, schedule: clock.schedule, now: clock.now, log: message => logged.push(message) })
  const holder = Promise.withResolvers<void>()
  const active = queue.run("store", undefined, () => holder.promise)
  let executed = false
  const waiting = queue.run("store", undefined, async () => { executed = true })
  // When: the deadline only gets to run long after it was due.
  clock.advance(400)
  // Then: the extension is logged with how late the deadline ran, the waiter
  // is still queued, and it is served once the holder finishes.
  expect(logged).toHaveLength(1)
  expect(logged[0]).toStartWith("session.lifecycle_stall_deadline_late late_ms=300 queued=1;")
  holder.resolve()
  await active
  await waiting
  expect(executed).toBe(true)
})

it("reports a late stall deadline on stderr and in the diagnostic log by default", async () => {
  // Other HTTP tests may have established the process-wide silent host policy.
  setProxyLogSilent(false)
  // The proxy registers this sink when its server module loads.
  setProxyDiagnosticSink((message) => diagnosticLog.session(message))
  diagnosticLog.clear()
  const stderr = spyOn(console, "error").mockImplementation(() => {})
  try {
    const clock = controlledClock()
    const queue = new LifecycleLockQueue({ stallMs: 100, lagToleranceMs: 10, schedule: clock.schedule, now: clock.now })
    const holder = Promise.withResolvers<void>()
    const active = queue.run("store", undefined, () => holder.promise)
    clock.advance(250)
    holder.resolve()
    await active
    expect(stderr.mock.calls.map(call => String(call[0]))).toContainEqual(
      expect.stringMatching(/^\[PROXY\] session\.lifecycle_stall_deadline_late late_ms=150 queued=0;/),
    )
    expect(diagnosticLog.getRecent({ category: "session" }).map(entry => entry.message)).toContainEqual(
      expect.stringMatching(/^session\.lifecycle_stall_deadline_late late_ms=150 queued=0;/),
    )
  } finally {
    stderr.mockRestore()
  }
})

it("still declares a stall when the rearmed deadline passes on time", async () => {
  const clock = controlledClock()
  const logged: string[] = []
  const queue = new LifecycleLockQueue({ stallMs: 100, lagToleranceMs: 10, schedule: clock.schedule, now: clock.now, log: message => logged.push(message) })
  const holder = Promise.withResolvers<void>()
  const active = queue.run("store", undefined, () => holder.promise)
  const waiting = queue.run("store", undefined, async () => {}).then(() => undefined, error => error)
  clock.advance(400)
  clock.advance(100)
  expect(await waiting).toBeInstanceOf(SessionLifecycleQueueStalledError)
  // Only the late run was an extension; the on-time one is a real stall.
  expect(logged).toHaveLength(1)
  holder.resolve()
  await active
})

it("rejects recurrently delayed deadlines after one grace window without releasing the holder", async () => {
  const clock = controlledClock()
  const queue = new LifecycleLockQueue({ stallMs: 100, lagToleranceMs: 10, schedule: clock.schedule, now: clock.now, log: () => {} })
  const holder = Promise.withResolvers<void>()
  let activeCount = 0
  let maxActive = 0
  const active = queue.run("store", undefined, async () => {
    activeCount++
    maxActive = Math.max(maxActive, activeCount)
    await holder.promise
    activeCount--
  })
  let waiterStarted = false
  let waiterError: unknown
  const waiting = queue.run("store", undefined, async () => {
    waiterStarted = true
    activeCount++
    maxActive = Math.max(maxActive, activeCount)
    activeCount--
  }).catch(error => { waiterError = error })
  try {
    clock.advance(111)
    await Promise.resolve()
    expect(waiterError).toBeUndefined()
    expect(waiterStarted).toBe(false)
    // Every firing is late; lateness alone must not renew the allowance.
    clock.advance(111)
    await Promise.resolve()
    await Promise.resolve()
    expect(waiterError).toBeInstanceOf(SessionLifecycleQueueStalledError)
    await expect(queue.run("store", undefined, async () => { waiterStarted = true }))
      .rejects.toBeInstanceOf(SessionLifecycleQueueStalledError)
    expect(waiterStarted).toBe(false)
    expect(activeCount).toBe(1)
  } finally {
    holder.resolve()
    await Promise.all([active, waiting])
  }
  await queue.run("store", undefined, async () => {
    activeCount++
    maxActive = Math.max(maxActive, activeCount)
    activeCount--
  })
  expect(maxActive).toBe(1)
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
