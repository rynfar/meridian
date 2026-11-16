import type { Server } from "node:http"
import type { Socket } from "node:net"

export interface CloseServerOptions {
  graceMs: number
  getInFlightCount(): number
  warn?: (message: string) => void
  forceCloseConnections?: () => void
}

export interface ServerConnectionTracker {
  forceCloseAll(): void
  dispose(): void
}

/** Join the admitted work, including finalizers after HTTP has been closed. */
export async function waitForShutdownIdle(hasPendingWork: () => boolean): Promise<void> {
  while (hasPendingWork()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 25)
      timer.unref?.()
    })
  }
}

export interface ShutdownCleanupSteps {
  /** Admitted work, including finalizers after HTTP has been closed. */
  idle: Promise<void>
  /** Session GC and backend close. */
  durable: () => Promise<void>
  /** Stop ChatGPT renewal and release its writer lease. */
  chatGpt: () => Promise<void>
}

/**
 * How long each named shutdown cleanup step has taken, so a shutdown that is
 * slow or misses its deadline can say which step held it.
 */
export class ShutdownProgress {
  private readonly steps = new Map<string, { startedAt: number; tookMs?: number }>()

  run<T>(name: string, work: () => Promise<T>): Promise<T> {
    const step: { startedAt: number; tookMs?: number } = { startedAt: Date.now() }
    this.steps.set(name, step)
    const settle = () => { step.tookMs = Date.now() - step.startedAt }
    return work().then(
      (value) => { settle(); return value },
      (error: unknown) => { settle(); throw error },
    )
  }

  describe(): string {
    const now = Date.now()
    return [...this.steps].map(([name, step]) => step.tookMs === undefined
      ? `${name} still running after ${now - step.startedAt}ms`
      : `${name} ${step.tookMs}ms`).join(", ") || "no cleanup step started"
  }
}

/**
 * Join shutdown cleanup. ChatGPT ownership is released as soon as admitted
 * work has joined, beside durable cleanup rather than after it: a session GC
 * sweep can outlast the shutdown deadline, and a process that exits holding
 * the writer lease refuses its successor's start. Every step runs even when
 * another fails; the first failure is reported once all have settled.
 */
export async function joinShutdownCleanup(
  steps: ShutdownCleanupSteps,
  progress: ShutdownProgress = new ShutdownProgress(),
): Promise<void> {
  const admitted = progress.run("admitted work", () => steps.idle)
  const idle = admitted.then(() => undefined, () => undefined)
  const settled = await Promise.allSettled([
    admitted,
    idle.then(steps.durable),
    idle.then(() => progress.run("ChatGPT release", steps.chatGpt)),
  ])
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failure) throw failure.reason
}

export interface ShutdownDeadlineOptions {
  /** Report on the cleanup still running after this long, without failing it. */
  slowAfterMs?: number
  /** The cleanup's progress, for the slow report and the deadline error. */
  describe?: () => string
  warn?: (message: string) => void
}

/** Bound the caller's wait without abandoning or releasing the original owner. */
export function withShutdownDeadline(
  joined: Promise<void>,
  timeoutMs = 2_000,
  options: ShutdownDeadlineOptions = {},
): Promise<void> {
  let timedOut = false
  let timer: ReturnType<typeof setTimeout>
  let slowTimer: ReturnType<typeof setTimeout> | undefined
  const progress = () => options.describe ? ` (${options.describe()})` : ""
  if (options.slowAfterMs !== undefined && options.slowAfterMs < timeoutMs && options.warn) {
    const warn = options.warn
    slowTimer = setTimeout(() => {
      warn(`[PROXY] Shutdown cleanup still running after ${options.slowAfterMs}ms${progress()}`)
    }, options.slowAfterMs)
  }
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`Proxy shutdown did not join admitted work before its deadline; ownership retained until cleanup settles${progress()}`))
    }, timeoutMs)
  })
  void joined.catch(error => {
    if (timedOut) {
      try { console.error("[PROXY] Deferred shutdown cleanup failed:", error) }
      catch { return /* Reporting must not release uncertain ownership. */ }
    }
  })
  return Promise.race([joined, deadline]).finally(() => {
    clearTimeout(timer)
    if (slowTimer) clearTimeout(slowTimer)
  })
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

/**
 * Keep serving drain responses while active HTTP work finishes, then stop the
 * server. Connections still open at the hard deadline are forcibly closed.
 */
export async function closeServerWithGracePeriod(
  server: Server,
  options: CloseServerOptions,
): Promise<void> {
  const graceMs = Math.max(0, options.graceMs)
  const deadlineAt = Date.now() + graceMs

  // Keep the listener alive during the drain window so health checks and new
  // message requests can receive the explicit draining response. Stop early
  // when all admitted message requests have completed.
  while (options.getInFlightCount() > 0) {
    const remainingMs = deadlineAt - Date.now()
    if (remainingMs <= 0) break
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(50, remainingMs))
      timer.unref?.()
    })
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
