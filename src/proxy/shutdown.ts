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
      // shim exposes closeAllConnections() without fully implementing it.
      server.closeAllConnections()
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
  else server.closeAllConnections()
  await closePromise
}
