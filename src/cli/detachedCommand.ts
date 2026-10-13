import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { configDir } from "../configDir"
import { isPortAvailable, isMeridianHealthBody, probeUrlBase } from "../proxy/statusProbe"
import { socketActivationFd } from "../proxy/socketActivation"
import { CrossProcessTurnCoordinator } from "../proxy/session/crossProcessTurnCoordinator"
import { processIncarnationIsDead } from "../proxy/session/processIncarnation"
import { detachedPaths, detachedControlPath, readDetachedRecord } from "./detachedStore"
import { requestDetachedControl } from "./detachedControl"
import { locallyReady, DETACHED_START_TIMEOUT_MS, DETACHED_STOP_TIMEOUT_MS } from "./detachedSupervisor"

export interface DetachedCommandResult {
  schemaVersion: 1
  action: "start" | "stop"
  outcome: string
  endpoint: string
  managed: boolean
  logPath?: string
  instanceId?: string
  diagnostic?: string
}
export function detachedCommandSucceeded(result: DetachedCommandResult): boolean {
  return ["ready-created", "ready-existing", "stopped", "already-stopped"].includes(result.outcome)
}

async function identifiableMeridian(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(probeUrlBase(host, port) + "/health", {
      signal: AbortSignal.timeout(2000), redirect: "error",
      headers: process.env.MERIDIAN_API_KEY ? { "x-api-key": process.env.MERIDIAN_API_KEY } : {},
    })
    if (response.status === 401) { await response.body?.cancel(); return false }
    const reader = response.body?.getReader()
    if (!reader) return false
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > 8192) return false
        chunks.push(next.value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    return isMeridianHealthBody(value) && typeof value === "object" && value !== null && "version" in value && typeof value.version === "string"
  } catch { return false }
}

export async function runDetachedCommand(action: "start" | "stop", cliEntry: string, host: string, port: number): Promise<DetachedCommandResult> {
  const endpoint = probeUrlBase(host, port)
  const result = (outcome: string, managed = false, extra: Partial<DetachedCommandResult> = {}): DetachedCommandResult => ({ schemaVersion: 1, action, outcome, endpoint, managed, ...extra })
  if (socketActivationFd() !== undefined) return result("unsupported", false, { diagnostic: "socket-activation" })
  // Server-oriented coordination waits use unreferenced timers. Keep this
  // standalone command alive until its result, including concurrent startup.
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(), action === "start" ? DETACHED_START_TIMEOUT_MS : DETACHED_STOP_TIMEOUT_MS)
  const signal = deadline.signal
  let logPath: string | undefined
  let stopStage = "stop-configuration"
  try {
    const paths = await detachedPaths(configDir(), host, port, action === "start")
    if (!paths) return result(await isPortAvailable(host, port) ? "already-stopped" : "unmanaged", false)
    logPath = paths.log
    const extra = { logPath }
    if (action === "stop") {
      stopStage = "stop-record"
      const record = await readDetachedRecord(paths)
      if (!record) return result(await isPortAvailable(host, port) ? "already-stopped" : "unmanaged", false)
      if (processIncarnationIsDead(record.owner)) return result("owner-unavailable", true, { ...extra, instanceId: record.instanceId })
      stopStage = "stop-control"
      await requestDetachedControl(await detachedControlPath(paths, record.instanceId), { version: 1, action: "stop", instanceId: record.instanceId, nonce: record.nonce })
      stopStage = "stop-observe"
      for (;;) {
        const current = await readDetachedRecord(paths)
        if (!current && processIncarnationIsDead(record.owner)) return result("stopped", true, { ...extra, instanceId: record.instanceId })
        if (current && current.instanceId !== record.instanceId) return result("owner-replaced", true, { ...extra, instanceId: record.instanceId })
        await delay(100, undefined, { signal })
      }
    }
    // Serialize short launch transactions; the detached supervisor separately
    // holds the endpoint's lifetime lease. No lock ownership is transferred.
    const launch = await new CrossProcessTurnCoordinator(paths.locks, { acquireTimeoutMs: DETACHED_START_TIMEOUT_MS }).acquire(`launch:${paths.key}`, signal)
    try {
      const record = await readDetachedRecord(paths)
      if (record && !processIncarnationIsDead(record.owner)) {
        const reply = await requestDetachedControl(await detachedControlPath(paths, record.instanceId), { version: 1, action: "inspect", instanceId: record.instanceId, nonce: record.nonce })
        return result(reply.phase === "ready" && await locallyReady(host, port, signal) ? "ready-existing" : reply.phase, true, { ...extra, instanceId: record.instanceId })
      }
      if (!await isPortAvailable(host, port)) {
        if (!record && await identifiableMeridian(host, port) && await locallyReady(host, port, signal)) return result("ready-existing", false)
        return result("port-conflict", false)
      }
      signal.throwIfAborted()
      const supervisor = spawn(process.execPath, [cliEntry, "__detached-supervisor"], { cwd: process.cwd(), env: process.env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] })
      const created = await new Promise<string>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error, id?: string) => {
          if (settled) return
          settled = true
          signal.removeEventListener("abort", abort)
          supervisor.off("message", message)
          if (error) {
            // An uncommitted launcher's disconnect is itself cancellation;
            // do not wait for an IPC send callback from a wedged supervisor.
            if (supervisor.connected) supervisor.disconnect()
            supervisor.unref()
            reject(error)
          } else {
            if (supervisor.connected) supervisor.disconnect()
            supervisor.unref()
            resolve(id!)
          }
        }
        const abort = () => finish(new Error("Detached start timed out"))
        let readyId: string | undefined
        const message = (value: unknown) => {
          if (typeof value !== "object" || value === null || !("type" in value)) return
          if (value.type === "meridian-detached-failed") { finish(new Error("Detached startup failed; inspect its log")); return }
          if (!("instanceId" in value) || typeof value.instanceId !== "string" || !/^[a-f0-9]{32}$/.test(value.instanceId)) return
          if (value.type === "meridian-detached-ready") {
            readyId = value.instanceId
            try { supervisor.send({ type: "meridian-detached-commit" }, error => { if (error) finish(error) }) }
            catch (error) { finish(error instanceof Error ? error : new Error("Detached commitment failed")) }
          } else if (value.type === "meridian-detached-committed" && value.instanceId === readyId) finish(undefined, readyId)
        }
        supervisor.on("message", message)
        supervisor.once("error", error => finish(error))
        supervisor.once("close", () => finish(new Error("Detached supervisor exited before commitment")))
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
      return result("ready-created", true, { ...extra, instanceId: created })
    } finally { await launch.release() }
  } catch {
    return result(action === "stop" && signal.aborted ? "draining" : "failed", false, { ...(logPath ? { logPath } : {}), diagnostic: signal.aborted ? "deadline" : action === "stop" ? stopStage : "ownership-or-startup-failure" })
  } finally {
    clearTimeout(timer)
  }
}
