import type { Server } from "node:http"
import type { Socket } from "node:net"

export interface CloseServerOptions {
  graceMs: number
  getInFlightCount(): number
  warn?: (message: string) => void
  forceCloseConnections?: () => void
  /**
   * Abort the per-request controllers that are still in flight, returning how
   * many were aborted. Provided by the proxy instance so a forced shutdown
   * cancels the SDK queries instead of only tearing down their sockets — the
   * generator cleanup and session-store writes those queries own are async,
   * and the caller (`bin/cli.ts`) calls `process.exit(0)` the moment close()
   * resolves. Optional: callers that do not track controllers keep the
   * previous HTTP-only teardown exactly.
   */
  abortInFlight?: (reason?: unknown) => number
  /**
   * How much of `graceMs` to reserve for post-abort settlement. Ignored when
   * `abortInFlight` is absent. Defaults to `computeSettleReserveMs(graceMs)`.
   */
  settleReserveMs?: number
}

/**
 * Split the existing grace budget instead of stacking a second timeout on top
 * of it: the tail of the window is reserved so aborted requests have a bounded
 * chance to unwind (SDK subprocess teardown, session persistence) while the
 * hard deadline stays exactly `graceMs` from the start of the close.
 */
export function computeSettleReserveMs(graceMs: number, requestedMs?: number): number {
  const budget = Math.max(0, graceMs)
  if (requestedMs !== undefined) {
    if (!Number.isFinite(requestedMs)) return 0
    return Math.min(budget, Math.max(0, requestedMs))
  }
  // 10% of the window, capped at 2s: long enough for generator cleanup and a
  // session-store write, short enough that the natural-finish phase (which is
  // what a healthy shutdown uses) is not meaningfully shortened.
  return Math.min(budget, Math.min(2_000, Math.floor(budget * 0.1)))
}

/** Poll `predicate` until it holds or `deadlineAt` passes. Returns the final value. */
async function waitUntil(predicate: () => boolean, deadlineAt: number): Promise<boolean> {
  while (!predicate()) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) return false
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(50, remainingMs))
      timer.unref?.()
    })
  }
  return true
}

export interface ServerConnectionTracker {
  forceCloseAll(): void
  dispose(): void
}

/** Track sockets from server startup so forced shutdown works across runtimes. */
export function trackServerConnections(server: Server): ServerConnectionTracker {
  const sockets = new Set<Socket>()
  const onConnection = (socket: Socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
  }
  server.on("connection", onConnection)

  return {
    forceCloseAll() {
      // Native Node closes HTTP(S) connections efficiently. Explicit socket
      // destruction is the compatibility backstop for runtimes whose Node API
      // shim exposes closeAllConnections() without fully implementing it —
      // or omits it entirely, which is why the call is optional rather
      // than assumed present.
      server.closeAllConnections?.()
      for (const socket of sockets) socket.destroy()
    },
    dispose() {
      server.off("connection", onConnection)
      sockets.clear()
    },
  }
}

/** Reason handed to per-request abort controllers when shutdown forces a stop. */
export const SHUTDOWN_ABORT_REASON = "meridian shutting down"

/**
 * Keep serving drain responses while active HTTP work finishes, then stop the
 * server. Requests still running at the abort point are cancelled and given
 * the reserved tail of the same grace budget to settle; connections still open
 * at the hard deadline are forcibly closed.
 */
export async function closeServerWithGracePeriod(
  server: Server,
  options: CloseServerOptions,
): Promise<void> {
  const graceMs = Math.max(0, options.graceMs)
  const deadlineAt = Date.now() + graceMs
  // The settlement window is carved OUT of graceMs, never added to it: a
  // second timeout stacked on top of the deadline would let shutdown run past
  // the bound every caller already reasons about.
  const settleReserveMs = options.abortInFlight
    ? computeSettleReserveMs(graceMs, options.settleReserveMs)
    : 0
  const abortAt = deadlineAt - settleReserveMs

  // Keep the listener alive during the drain window so health checks and new
  // message requests can receive the explicit draining response. Stop early
  // when all admitted message requests have completed.
  const drainedNaturally = await waitUntil(() => options.getInFlightCount() === 0, abortAt)

  if (!drainedNaturally && options.abortInFlight) {
    const stillRunning = options.getInFlightCount()
    const aborted = options.abortInFlight(SHUTDOWN_ABORT_REASON)
    options.warn?.(
      `[PROXY] Aborting ${aborted} in-flight request(s) after ${Math.max(0, abortAt - (deadlineAt - graceMs))}ms; waiting up to ${settleReserveMs}ms for ${stillRunning} request(s) to settle.`,
    )
    // Aborting only STARTS the unwind — SDK generator cleanup and session-store
    // writes are async, and the CLI calls process.exit(0) the moment close()
    // resolves. Wait (bounded by the same deadline) for the in-flight count to
    // actually reach 0 so that work is not killed mid-write.
    await waitUntil(() => options.getInFlightCount() === 0, deadlineAt)
  }

  const closePromise = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })

  const remainingGraceMs = Math.max(0, deadlineAt - Date.now())
  if (remainingGraceMs > 0) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), remainingGraceMs)
      timeout.unref?.()
    })

    try {
      const outcome = await Promise.race([
        closePromise.then(() => "closed" as const),
        deadline,
      ])
      if (outcome === "closed") return
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  }

  const remaining = options.getInFlightCount()
  options.warn?.(
    `[PROXY] Grace period elapsed with ${remaining} request(s) still in flight after ${graceMs}ms; forcing remaining HTTP connections closed.`,
  )

  // Call after server.close() to avoid accepting a new connection between the
  // force-close and the server entering its closed state (Node.js guidance).
  if (options.forceCloseConnections) options.forceCloseConnections()
  else server.closeAllConnections?.()
  await closePromise
}
