import { createConnection, createServer } from "node:net"
import type { Socket } from "node:net"
import { DetachedLifecycle, DetachedRequestFrame, DETACHED_FRAME_BYTES, authenticatesDetachedRequest, parseDetachedRequest } from "./detachedProtocol"
import type { DetachedIdentity, DetachedPhase, DetachedRequest } from "./detachedProtocol"

export interface DetachedReply {
  version: 1
  instanceId: string
  phase: DetachedPhase
  accepted: boolean
}
const PHASES = new Set(["starting", "ready", "draining", "exited"])

/** Caller owns the private socket directory (or named-pipe identity) and nonce. */
export async function listenDetachedControl(options: {
  path: string
  identity: DetachedIdentity
  lifecycle: DetachedLifecycle
  onStop: () => void
  onError: (error: Error) => void
  timeoutMs?: number
}): Promise<{ close(): Promise<void> }> {
  if (!parseDetachedRequest({ version: 1, action: "inspect", ...options.identity })) throw new Error("Invalid detached control identity")
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    if (sockets.size >= 8) { socket.destroy(); return }
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.on("error", () => { /* Connection failures do not authorize an action. */ })
    socket.setTimeout(options.timeoutMs ?? 2000, () => socket.destroy())
    const frame = new DetachedRequestFrame()
    let handled = false
    socket.on("data", data => {
      if (handled) { socket.destroy(); return }
      try {
        const request = frame.push(data)
        if (!request) return
        handled = true
        if (!authenticatesDetachedRequest(request, options.identity)) {
          socket.end('{"error":"unauthorized"}\n')
          return
        }
        const accepted = request.action === "stop" && options.lifecycle.stop()
        if (accepted) {
          try { options.onStop() }
          catch (error) {
            options.onError(error instanceof Error ? error : new Error("Detached stop failed"))
            socket.destroy()
            return
          }
        }
        const response: DetachedReply = {
          version: 1, instanceId: options.identity.instanceId,
          phase: options.lifecycle.phase, accepted,
        }
        socket.end(JSON.stringify(response) + "\n")
      } catch {
        handled = true
        socket.destroy()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.path, () => { server.off("error", reject); resolve() })
  })
  server.on("error", options.onError)
  let closing: Promise<void> | undefined
  return {
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        for (const socket of sockets) socket.destroy()
      })
      return closing
    },
  }
}

/** Resolve/reject only after the original connection closes, including timeout. */
export function requestDetachedControl(path: string, request: DetachedRequest, timeoutMs = 2000): Promise<DetachedReply> {
  const validated = parseDetachedRequest(request)
  if (!validated) return Promise.reject(new Error("Invalid detached control request"))
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let failure: Error | undefined
    let bytes = Buffer.alloc(0)
    let ended = false
    const timer = setTimeout(() => socket.destroy(new Error("Detached control timed out")), timeoutMs)
    socket.once("connect", () => socket.write(JSON.stringify(validated) + "\n"))
    socket.on("error", error => { failure ??= error })
    socket.on("data", chunk => {
      if (chunk.byteLength > DETACHED_FRAME_BYTES - bytes.byteLength) {
        socket.destroy(new Error("Detached control response is too large"))
        return
      }
      bytes = Buffer.concat([bytes, chunk])
    })
    socket.once("end", () => { ended = true })
    socket.once("close", () => {
      clearTimeout(timer)
      if (failure) { reject(failure); return }
      try {
        if (!ended || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.byteLength - 1) throw new Error("Incomplete detached control response")
        const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1)))
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid detached control response")
        const reply = value as Record<string, unknown>
        if (Object.keys(reply).length !== 4 || reply.version !== 1 || reply.instanceId !== validated.instanceId
          || typeof reply.phase !== "string" || !PHASES.has(reply.phase) || typeof reply.accepted !== "boolean") {
          throw new Error("Detached control identity or response mismatch")
        }
        resolve({ version: 1, instanceId: validated.instanceId, phase: reply.phase as DetachedPhase, accepted: reply.accepted })
      } catch (error) { reject(error instanceof Error ? error : new Error("Invalid detached control response")) }
    })
  })
}
