export interface SemaphoreLease {
  readonly waitedMs: number
  release(): void
}

export interface SemaphoreSnapshot {
  readonly active: number
  readonly queued: number
  readonly limit: number
}

interface Waiter {
  readonly enqueuedAt: number
  readonly resolve: (lease: SemaphoreLease) => void
  readonly reject: (error: Error) => void
  readonly signal?: AbortSignal
  abortListener?: () => void
}

const DEFAULT_MAX_CONCURRENT = 10
let didWarnInvalidMaxConcurrent = false
let processSdkSemaphore: AbortableSemaphore | undefined

export function requestCancelledError(reason?: unknown): Error {
  if (reason instanceof Error) return reason
  return new DOMException(
    typeof reason === "string" && reason ? reason : "The request was cancelled",
    "AbortError",
  )
}

export function resolveMaxConcurrent(
  source: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn,
): number {
  const raw = source.MERIDIAN_MAX_CONCURRENT ?? source.CLAUDE_PROXY_MAX_CONCURRENT
  if (raw === undefined) return DEFAULT_MAX_CONCURRENT

  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw)
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
  }

  if (!didWarnInvalidMaxConcurrent) {
    didWarnInvalidMaxConcurrent = true
    warn(`[PROXY] Invalid MERIDIAN_MAX_CONCURRENT value \"${raw}\"; using default ${DEFAULT_MAX_CONCURRENT}`)
  }
  return DEFAULT_MAX_CONCURRENT
}

function assertPositiveLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Semaphore limit must be a positive integer")
  }
  return limit
}

/** FIFO semaphore whose queued acquisitions can be cancelled safely. */
export class AbortableSemaphore {
  private activeCount = 0
  private currentLimit: number
  private readonly waiters: Waiter[] = []

  constructor(limit: number) {
    this.currentLimit = assertPositiveLimit(limit)
  }

  get limit(): number {
    return this.currentLimit
  }

  /**
   * Change the budget in place.
   *
   * Mutating beats swapping the instance: queued waiters and in-flight leases
   * belong to this object, so replacing it would strand them holding permits
   * nobody counts. Raising the limit immediately grants whoever is already
   * waiting; lowering it never revokes a live lease — the extra permits simply
   * stop being reissued as the current holders release, so the semaphore
   * converges on the new budget without killing work already underway.
   */
  setLimit(next: number): void {
    const limit = assertPositiveLimit(next)
    if (limit === this.currentLimit) return
    const raised = limit > this.currentLimit
    this.currentLimit = limit
    if (raised) this.grantNext()
  }

  get snapshot(): SemaphoreSnapshot {
    return { active: this.activeCount, queued: this.waiters.length, limit: this.currentLimit }
  }

  acquire(signal?: AbortSignal): Promise<SemaphoreLease> {
    if (signal?.aborted) return Promise.reject(requestCancelledError(signal.reason))

    const enqueuedAt = Date.now()
    if (this.activeCount < this.limit && this.waiters.length === 0) {
      this.activeCount++
      return Promise.resolve(this.createLease(enqueuedAt))
    }

    return new Promise<SemaphoreLease>((resolve, reject) => {
      const waiter: Waiter = { enqueuedAt, resolve, reject, signal }
      if (signal) {
        waiter.abortListener = () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1) return
          this.waiters.splice(index, 1)
          reject(requestCancelledError(signal.reason))
        }
        signal.addEventListener("abort", waiter.abortListener, { once: true })
      }
      this.waiters.push(waiter)
    })
  }

  private createLease(enqueuedAt: number): SemaphoreLease {
    let released = false
    return {
      waitedMs: Date.now() - enqueuedAt,
      release: () => {
        if (released) return
        released = true
        this.activeCount--
        this.grantNext()
      },
    }
  }

  private grantNext(): void {
    while (this.activeCount < this.limit) {
      const waiter = this.waiters.shift()
      if (!waiter) return
      if (waiter.abortListener && waiter.signal) {
        waiter.signal.removeEventListener("abort", waiter.abortListener)
      }
      if (waiter.signal?.aborted) {
        waiter.reject(requestCancelledError(waiter.signal.reason))
        continue
      }
      this.activeCount++
      waiter.resolve(this.createLease(waiter.enqueuedAt))
    }
  }
}

/**
 * One SDK subprocess budget per process, shared by every ProxyServer instance.
 *
 * The identity of the semaphore is stable — every caller gets the same object,
 * which is the whole point of a shared budget — but its limit is reconciled
 * against the environment on each call. Caching the limit at first use made the
 * value depend on which proxy happened to start first, so a later instance (or
 * a test that set MERIDIAN_MAX_CONCURRENT) was silently ignored.
 */
export function getProcessSdkSemaphore(): AbortableSemaphore {
  const limit = resolveMaxConcurrent()
  if (!processSdkSemaphore) {
    processSdkSemaphore = new AbortableSemaphore(limit)
    return processSdkSemaphore
  }
  processSdkSemaphore.setLimit(limit)
  return processSdkSemaphore
}

/** Reset process-scoped state between tests that override concurrency env vars. */
export function resetProcessSdkSemaphoreForTests(): void {
  processSdkSemaphore = undefined
  didWarnInvalidMaxConcurrent = false
}
