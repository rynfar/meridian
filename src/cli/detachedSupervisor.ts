import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { finished } from "node:stream/promises"
import { setTimeout as delay } from "node:timers/promises"
import { configDir } from "../configDir"
import { isPortAvailable, probeUrlBase } from "../proxy/statusProbe"
import { DetachedOwnerLease, detachedPaths, detachedControlPath } from "./detachedStore"
import { DetachedLifecycle } from "./detachedProtocol"
import { listenDetachedControl } from "./detachedControl"
import { DetachedLog } from "./detachedLog"

export const DETACHED_START_TIMEOUT_MS = 60_000
export const DETACHED_STOP_TIMEOUT_MS = 45_000

export async function locallyReady(host: string, port: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(probeUrlBase(host, port) + "/readyz", {
      headers: process.env.MERIDIAN_API_KEY ? { "x-api-key": process.env.MERIDIAN_API_KEY } : {},
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000),
      redirect: "error",
    })
    // The readiness route is deliberately a tiny text response; do not consume
    // an arbitrary service's unbounded body when the port changed underneath us.
    const reader = response.body?.getReader()
    if (!reader) return false
    let text = ""
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (chunk.value.byteLength > 64 - Buffer.byteLength(text)) return false
        text += Buffer.from(chunk.value).toString("utf8")
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    return response.status === 200 && text.trim() === "ok"
  } catch { return false }
}

function messageType(value: unknown, type: string): boolean {
  return typeof value === "object" && value !== null && "type" in value && value.type === type
}
function sendParent(value: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send || !process.connected) { reject(new Error("Detached launcher disconnected")); return }
    process.send(value, error => error ? reject(error) : resolve())
  })
}
function stopChild(child: ChildProcess | undefined): void {
  if (!child?.connected) return
  try { child.send({ type: "meridian-detached-stop" }, error => { if (error && child.connected) child.disconnect() }) }
  catch { if (child.connected) child.disconnect() }
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => { cleanup(); reject(new Error("Detached startup cancelled or timed out")) }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    work.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Owns one exact CLI child until its original close event and log sink join. */
export async function runDetachedSupervisor(cliEntry: string, host: string, port: number): Promise<void> {
  if (!process.send || !process.connected) throw new Error("Detached supervisor requires its launcher channel")
  const deadline = AbortSignal.timeout(DETACHED_START_TIMEOUT_MS)
  const cancelled = new AbortController()
  const lifecycle = new DetachedLifecycle()
  let committed = false
  let child: ChildProcess | undefined
  let childClosed: Promise<void> | undefined
  let exited = false
  let childError: Error | undefined
  let committedResolve: (() => void) | undefined
  const commitment = new Promise<void>(resolve => { committedResolve = resolve })
  const requestStop = () => {
    cancelled.abort(new Error("Detached startup cancelled"))
    if (lifecycle.stop()) stopChild(child)
  }
  const onDisconnect = () => { if (!committed) requestStop() }
  const onMessage = (value: unknown) => {
    if (messageType(value, "meridian-detached-abort")) requestStop()
    if (messageType(value, "meridian-detached-commit") && lifecycle.phase === "ready") {
      committed = true
      committedResolve?.()
    }
  }
  process.on("disconnect", onDisconnect)
  process.on("message", onMessage)
  process.on("SIGTERM", requestStop)
  process.on("SIGINT", requestStop)
  const signal = AbortSignal.any([deadline, cancelled.signal])
  let owner: DetachedOwnerLease | undefined
  let control: Awaited<ReturnType<typeof listenDetachedControl>> | undefined
  let log: DetachedLog | undefined
  let logJoined: Promise<void> | undefined
  let failure: unknown
  try {
    const paths = await detachedPaths(configDir(), host, port, true)
    if (!paths) throw new Error("Detached configuration is unavailable")
    owner = await DetachedOwnerLease.acquire(paths, signal)
    if (!await isPortAvailable(host, port)) throw new Error("Detached endpoint is already occupied")
    const identity = { instanceId: randomBytes(16).toString("hex"), nonce: randomBytes(32).toString("hex") }
    log = await DetachedLog.create(paths.log)
    logJoined = finished(log)
    // Observe immediately, including errors before the final join.
    void logJoined.catch(() => {
      child?.stdout?.unpipe(log); child?.stderr?.unpipe(log)
      child?.stdout?.resume(); child?.stderr?.resume()
      requestStop()
    })
    control = await listenDetachedControl({
      path: await detachedControlPath(paths, identity.instanceId), identity, lifecycle,
      onStop: () => { cancelled.abort(); stopChild(child) },
      onError: () => requestStop(),
    })
    await owner.publish(identity)
    signal.throwIfAborted()
    child = spawn(process.execPath, [cliEntry, "__detached-child"], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    childClosed = new Promise<void>(resolve => child!.once("close", () => { exited = true; resolve() }))
    child.on("error", error => { childError = error })
    child.stdout?.pipe(log, { end: false })
    child.stderr?.pipe(log, { end: false })
    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (value: unknown) => {
        if (!messageType(value, "meridian-detached-ready")) return
        cleanup(); resolve()
      }
      const onClose = () => { cleanup(); reject(childError ?? new Error("Detached CLI exited before readiness")) }
      const onAbort = () => { cleanup(); reject(new Error("Detached startup cancelled or timed out")) }
      const cleanup = () => { child?.off("message", onReady); child?.off("close", onClose); signal.removeEventListener("abort", onAbort) }
      child!.on("message", onReady); child!.once("close", onClose); signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    await ready
    while (!exited && !await locallyReady(host, port, signal)) await delay(100, undefined, { signal })
    signal.throwIfAborted()
    if (exited || !lifecycle.ready()) throw new Error("Detached child is no longer ready")
    await sendParent({ type: "meridian-detached-ready", instanceId: identity.instanceId })
    await abortable(Promise.race([commitment, childClosed.then(() => { throw new Error("Detached CLI exited before commitment") })]), signal)
    signal.throwIfAborted()
    await sendParent({ type: "meridian-detached-committed", instanceId: identity.instanceId })
    await childClosed
    if (child.exitCode !== 0) throw new Error("Detached CLI exited unexpectedly")
  } catch (error) {
    failure = error
    requestStop()
    if (process.connected) await sendParent({ type: "meridian-detached-failed" }).catch(() => undefined)
  } finally {
    // Ownership survives timeout: wait on the original child, never kill a PID
    // looked up from a record. The CLI's close path owns its drain deadline.
    if (childClosed) await childClosed
    lifecycle.exited()
    if (log) log.end()
    try { if (logJoined) await logJoined }
    catch (error) { failure ??= error }
    try { if (control) await control.close() }
    catch (error) { failure ??= error }
    try { await owner?.release() }
    catch (error) { failure ??= error }
    process.off("disconnect", onDisconnect); process.off("message", onMessage)
    process.off("SIGTERM", requestStop); process.off("SIGINT", requestStop)
  }
  if (failure) throw failure
}
