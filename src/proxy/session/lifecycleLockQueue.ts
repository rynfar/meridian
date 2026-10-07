import { AsyncLocalStorage } from "node:async_hooks"
import {
  SessionLifecycleQueueCapacityError,
  SessionLifecycleQueueStalledError,
  SessionLifecycleReentrancyError,
} from "./lifecycleErrors"
import { pdiagnostic, plog } from "../operationalLog"

interface QueueOptions {
  readonly maxPending?: number
  readonly stallMs?: number
  /** A stall deadline running later than this was held up by the event loop. */
  readonly lagToleranceMs?: number
  readonly schedule?: (callback: () => void, delay: number) => () => void
  readonly now?: () => number
  readonly log?: (message: string) => void
}

const logQueueEvent = (message: string): void => {
  plog(`[PROXY] ${message}`)
  pdiagnostic(message)
}

interface Pending {
  readonly start: (finish: () => void) => void
  readonly reject: (error: unknown) => void
  cancelWait: () => void
}

interface QueueState {
  active: boolean
  stalled: boolean
  readonly pending: Map<symbol, Pending>
}

/** A holder remains active through its actual finally, even after its stall deadline. */
export class LifecycleLockQueue {
  private readonly queues = new Map<string, QueueState>()
  private readonly context = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
  private readonly maxPending: number
  private readonly stallMs: number
  private readonly lagToleranceMs: number
  private readonly schedule: (callback: () => void, delay: number) => () => void
  private readonly now: () => number
  private readonly log: (message: string) => void

  constructor(options: QueueOptions = {}) {
    this.log = options.log ?? logQueueEvent
    this.maxPending = options.maxPending ?? 256
    this.stallMs = options.stallMs ?? 60_000
    this.lagToleranceMs = options.lagToleranceMs ?? 1_000
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 0) throw new RangeError("invalid queue capacity")
    if (!Number.isSafeInteger(this.stallMs) || this.stallMs <= 0) throw new RangeError("invalid queue stall deadline")
    if (!Number.isSafeInteger(this.lagToleranceMs) || this.lagToleranceMs < 0) throw new RangeError("invalid queue lag tolerance")
    this.now = options.now ?? (() => performance.now())
    this.schedule = options.schedule ?? ((callback, delay) => {
      const timer = setTimeout(callback, delay)
      timer.unref()
      return () => clearTimeout(timer)
    })
  }

  async run<T>(path: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    signal?.throwIfAborted()
    const ancestors = this.context.getStore()
    if (ancestors?.get(path)?.active) {
      throw new SessionLifecycleReentrancyError(`recursive lifecycle acquisition for ${path}`)
    }
    const state = this.queues.get(path) ?? { active: false, stalled: false, pending: new Map<symbol, Pending>() }
    if (state.stalled) throw this.stallError(path)
    if (state.active && state.pending.size >= this.maxPending) {
      throw new SessionLifecycleQueueCapacityError(`lifecycle queue capacity reached for ${path}`)
    }
    this.queues.set(path, state)
    return new Promise<T>((resolve, reject) => {
      const id = Symbol()
      const pending: Pending = {
        reject,
        cancelWait: () => undefined,
        start: finish => {
          const holder = { active: true }
          const scope = new Map(ancestors)
          scope.set(path, holder)
          const settle = () => { holder.active = false; finish() }
          void this.context.run(scope, async () => {
            signal?.throwIfAborted()
            return operation()
          }).then(value => { settle(); resolve(value) }, error => { settle(); reject(error) })
        },
      }
      if (state.active) {
        state.pending.set(id, pending)
        const abort = () => {
          if (!state.pending.delete(id)) return
          pending.cancelWait()
          reject(signal?.reason)
        }
        signal?.addEventListener("abort", abort, { once: true })
        pending.cancelWait = () => signal?.removeEventListener("abort", abort)
      } else {
        this.start(path, state, pending)
      }
    })
  }

  private stallError(path: string): SessionLifecycleQueueStalledError {
    return new SessionLifecycleQueueStalledError(`active lifecycle holder stalled for ${path}`)
  }

  private start(path: string, state: QueueState, pending: Pending): void {
    state.active = true
    pending.cancelWait()
    // A deadline that runs late was held up with everything else on the event
    // loop - synchronous store I/O, a CPU-starved host - including the holder's
    // own continuations, which are runnable now. Declaring the holder stalled
    // then rejects every waiter moments before it would have handed off, so a
    // late deadline gets one fresh window instead. Repeated lag must not grant
    // an unbounded wait: after that grace, reject waiters even if the second
    // deadline is late. The holder retains ownership until it actually settles.
    let graceUsed = false
    const armStallTimer = (): (() => void) => {
      const dueAt = this.now() + this.stallMs
      return this.schedule(() => {
        const lateMs = this.now() - dueAt
        if (lateMs > this.lagToleranceMs && !graceUsed) {
          graceUsed = true
          this.log(`session.lifecycle_stall_deadline_late late_ms=${Math.round(lateMs)} queued=${state.pending.size}; event loop was blocked, extending the holder's deadline`)
          stopTimer = armStallTimer()
          return
        }
        state.stalled = true
        for (const waiter of state.pending.values()) {
          waiter.cancelWait()
          waiter.reject(this.stallError(path))
        }
        state.pending.clear()
      }, this.stallMs)
    }
    let stopTimer = armStallTimer()
    pending.start(() => {
      stopTimer()
      state.active = false
      state.stalled = false
      const next = state.pending.entries().next().value
      if (next) {
        state.pending.delete(next[0])
        this.start(path, state, next[1])
      } else {
        this.queues.delete(path)
      }
    })
  }
}

export const lifecycleLockQueue = new LifecycleLockQueue()
