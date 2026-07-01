/**
 * Upstream-idle guard for proxied model streams.
 *
 * Wraps the provider SDK's streaming async iterable and enforces a maximum gap
 * between *real* upstream messages. If the source goes silent for longer than
 * `idleMs` — before the first chunk (slow TTFB) or mid-stream — the guard
 * aborts iteration and throws `UpstreamIdleError`.
 *
 * Why this is needed: the proxy emits downstream SSE heartbeats (`: ping`) on a
 * fixed interval, which resets the *client's* (pi's) byte-level idle timer. A
 * stalled upstream is therefore invisible to the client and would wedge the
 * turn forever. This guard is the authoritative upstream-liveness check.
 *
 * COORDINATION CONTRACT (Pylon Orchestrator): this guard owns *model-stream*
 * liveness. Pylon's runtime stall watchdog is only a BACKSTOP for the
 * model-wait gap with no tool in flight, and keeps its abort threshold above
 * this guard's idle limit (default MERIDIAN_IDLE_TIMEOUT_SECONDS = 120s) so the
 * two layers never race to abort the same hung model. If this default rises,
 * re-check Pylon's STALL_ABORT_MS. See
 * pylon-orchestrator/docs/circuit/specs/stall-watchdog-tool-exempt.md.
 */
export class UpstreamIdleError extends Error {
  readonly idleMs: number
  readonly sinceLastMs: number
  constructor(idleMs: number, sinceLastMs: number) {
    super(`upstream idle for ${sinceLastMs}ms (limit ${idleMs}ms)`)
    this.name = "UpstreamIdleError"
    this.idleMs = idleMs
    this.sinceLastMs = sinceLastMs
  }
}

/** Opaque handle returned by a clock's timer scheduler. */
type IdleTimerHandle = ReturnType<typeof setTimeout> | number

/**
 * Time source the guard depends on. Injectable so tests can drive idle
 * detection deterministically instead of racing the real wall clock. Defaults
 * to the platform clock in production.
 */
export interface IdleGuardClock {
  now(): number
  setTimeout(fn: () => void, ms: number): IdleTimerHandle
  clearTimeout(handle: IdleTimerHandle): void
}

const realClock: IdleGuardClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
}

export async function* guardUpstreamIdle<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onStall?: (sinceLastMs: number) => void,
  clock: IdleGuardClock = realClock,
): AsyncGenerator<T> {
  if (idleMs <= 0) {
    yield* source
    return
  }
  const it = source[Symbol.asyncIterator]()
  let lastAt = clock.now()
  try {
    while (true) {
      // Start the next pull and swallow any late rejection if we abandon it
      // via the idle deadline (prevents an unhandled-rejection on teardown).
      const nextP = it.next()
      nextP.catch(() => {})

      let timer: IdleTimerHandle | undefined
      const idle = new Promise<never>((_, reject) => {
        const remaining = Math.max(0, idleMs - (clock.now() - lastAt))
        timer = clock.setTimeout(() => {
          const sinceLastMs = clock.now() - lastAt
          try {
            onStall?.(sinceLastMs)
          } catch {
            // Observer errors must not prevent rejecting the guarded iterator.
          }
          reject(new UpstreamIdleError(idleMs, sinceLastMs))
        }, remaining)
      })

      let res: IteratorResult<T>
      try {
        res = await Promise.race([nextP, idle])
      } finally {
        if (timer !== undefined) clock.clearTimeout(timer)
      }
      if (res.done) return
      lastAt = clock.now()
      yield res.value
    }
  } finally {
    // Runs on normal completion, stall throw, AND consumer break — ask the
    // upstream iterator to tear down without hanging on a stalled pull.
    const returnP = it.return?.(undefined as never)
    returnP?.catch(() => {})
  }
}
