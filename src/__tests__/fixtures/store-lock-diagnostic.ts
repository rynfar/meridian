import { spyOn } from "bun:test"
import * as fs from "node:fs"
import { createHash } from "node:crypto"
import { join, sep } from "node:path"
import * as incarnations from "../../proxy/session/processIncarnation"

type Health = { observerError: boolean }
type Event = Record<string, unknown>
type Native = (this: unknown, ...args: unknown[]) => unknown
const MAX_EVENTS = 10_000, MAX_BYTES = 4 * 1024 * 1024
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
const code = (error: unknown): string | undefined => error instanceof Error && "code" in error
  && typeof error.code === "string" ? error.code : undefined

// Only owned lock metadata is decoded. No hostname, nonce or file contents escape.
export function lockMetadata(raw: string | Uint8Array): Event {
  const tokenSha256 = hash(raw)
  try {
    const value: unknown = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"))
    if (typeof value !== "object" || value === null) return { tokenSha256, parsed: false }
    const owner = value as Record<string, unknown>
    return { tokenSha256, parsed: true, pid: typeof owner.pid === "number" ? owner.pid : undefined,
      nonceSha256: typeof owner.token === "string" ? hash(owner.token) : undefined,
      incarnation: incarnations.parseProcessIncarnation(owner.incarnation) }
  } catch { return { tokenSha256, parsed: false } }
}

export function eventBuffer(maxEvents = MAX_EVENTS, maxBytes = MAX_BYTES) {
  const events: Event[] = []
  let bytes = 0, capped = false
  return { events, get bytes() { return bytes }, get capped() { return capped },
    add(event: Event) {
      if (capped) return
      const size = Buffer.byteLength(JSON.stringify(event)) + 1
      if (events.length >= maxEvents || bytes + size > maxBytes) { capped = true; return }
      bytes += size; events.push(event)
    } }
}

// A failing recorder must never replace the native return value or thrown object.
export function observedCall(original: Native, receiver: unknown, args: unknown[],
  record: (event: Event, result: unknown) => void, health: Health): unknown {
  let start: { mono: number; wall: number } | undefined
  try { start = { mono: performance.now(), wall: Date.now() } }
  catch { health.observerError = true }
  const finish = (result: unknown, thrown: boolean, error?: unknown): void => {
    try {
      const mono = performance.now(), wall = Date.now()
      if (!start) { health.observerError = true; return }
      record({ startMonotonicMs: start.mono, endMonotonicMs: mono, startWallMs: start.wall,
        endWallMs: wall, elapsedMs: mono - start.mono, thrown, errorCode: code(error) }, result)
    } catch { health.observerError = true }
  }
  try {
    const result = Reflect.apply(original, receiver, args) as unknown
    finish(result, false)
    return result
  } catch (error) { finish(undefined, true, error); throw error }
}

const FS_NAMES = ["openSync", "closeSync", "fchmodSync", "fsyncSync", "fstatSync", "writeFileSync",
  "linkSync", "unlinkSync", "readFileSync", "statSync", "lstatSync", "renameSync", "mkdirSync",
  "rmSync", "readdirSync", "readlinkSync"] as const

export async function diagnoseStoreLockResume<T>(directory: string,
  child: { pid: number; status: number | null; signal: string | null; joinedWallMs: number; joinedMonotonicMs: number },
  resume: () => Promise<T>): Promise<T> {
  const output = process.env.BOOKKEEPING_LOCK_DIAGNOSTIC_DIR
  if (!output) return resume()
  const health: Health = { observerError: false }, buffer = eventBuffer(), invalid: string[] = []
  const counters: Record<string, number> = {}, fds = new Map<number, string>()
  const restorers: (() => void)[] = []
  let before: Event | undefined, after: Event | undefined, outcome = "not-entered", failureCode: string | undefined
  let parentOwner: Event | undefined, failureName: string | undefined, deathProbeHookInstalled = false
  const guard = (operation: () => void): void => {
    try { operation() } catch { health.observerError = true }
  }
  const classify = (value: unknown): string => {
    if (typeof value === "number") return fds.get(value) ?? "other-fd"
    if (typeof value !== "string") return "other"
    if (value === `/proc/${child.pid}/stat`) return "child-proc-stat"
    if (!value.startsWith(directory + sep)) return "other"
    const name = value.slice(directory.length + 1)
    for (const [file, label] of [["sessions.json.lock", "store"], ["session-gc.json.lock", "lifecycle"]]) {
      if (name === file) return `${label}-lock`
      if (name.startsWith(file + ".candidate-")) return `${label}-candidate`
      if (name.startsWith(file + ".recover-")) return `${label}-recovery`
      if (name.startsWith(file + ".stale-")) return `${label}-retired`
    }
    return "owned-other"
  }
  const statMetadata = (value: unknown): Event | undefined => {
    if (typeof value !== "object" || value === null) return undefined
    const stat = value as Record<string, unknown>
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size }
  }
  const snapshot = (): Event => {
    const locks = ["sessions.json.lock", "session-gc.json.lock"].map(name => {
      try {
        const raw = fs.readFileSync(join(directory, name), "utf8"), stat = fs.statSync(join(directory, name))
        const wallMs = Date.now(), monotonicMs = performance.now()
        return { name, ...lockMetadata(raw), ...statMetadata(stat), wallMs, monotonicMs, ageMs: wallMs - stat.mtimeMs }
      } catch (error) { return { name, errorCode: code(error) } }
    })
    let journalPhase: unknown
    try {
      const journal: unknown = JSON.parse(fs.readFileSync(join(directory, "session-bookkeeping-migration.json"), "utf8"))
      if (typeof journal === "object" && journal !== null && "phase" in journal && typeof journal.phase === "string") {
        journalPhase = journal.phase
      }
    } catch (error) { journalPhase = { errorCode: code(error) } }
    return { wallMs: Date.now(), monotonicMs: performance.now(), locks, journalPhase }
  }
  guard(() => { before = snapshot() }) // Deliberately no setup owner-death probe.
  for (const name of FS_NAMES) guard(() => {
    const original = fs[name]
    const replacement = function(this: unknown, ...args: unknown[]): unknown {
      let target = "unobserved", destination: string | undefined
      guard(() => { target = classify(args[0]); if (name === "linkSync" || name === "renameSync") destination = classify(args[1]) })
      return observedCall(original as Native, this, args, (event, result) => {
        counters[`${name}:${target}`] = (counters[`${name}:${target}`] ?? 0) + 1
        if (name === "openSync" && typeof result === "number") fds.set(result, target)
        if (name === "closeSync" && typeof args[0] === "number") fds.delete(args[0])
        if (target === "other" || target === "other-fd" || target === "owned-other") return
        const details: Event = { op: name, target, destination, ...event }
        if ((name === "statSync" || name === "lstatSync" || name === "fstatSync") && !event.thrown) {
          details.stat = statMetadata(result)
          if (details.stat) details.ageAtEndMs = Number(event.endWallMs) - Number((details.stat as Event).mtimeMs)
        }
        if (name === "readFileSync" && target.endsWith("-lock") && (typeof result === "string" || result instanceof Uint8Array)) {
          details.lock = lockMetadata(result)
        }
        if (name === "writeFileSync" && target.endsWith("-candidate") && (typeof args[1] === "string" || args[1] instanceof Uint8Array)) {
          details.lock = lockMetadata(args[1]); if (target === "store-candidate") parentOwner = details.lock as Event
        }
        buffer.add(details)
      }, health)
    }
    const spy = spyOn(fs, name).mockImplementation(replacement as typeof original)
    restorers.push(() => spy.mockRestore())
  })
  guard(() => {
    const original = incarnations.processIncarnationIsDead
    const spy = spyOn(incarnations, "processIncarnationIsDead").mockImplementation(function(this: unknown, owner) {
      return observedCall(original as Native, this, [owner], (event, result) => {
        counters.deathProbe = (counters.deathProbe ?? 0) + 1
        const parsed = incarnations.parseProcessIncarnation(owner)
        if (parsed?.pid === child.pid) counters.childDeathProbe = (counters.childDeathProbe ?? 0) + 1
        buffer.add({ op: "processIncarnationIsDead", owner: parsed, dead: result, ...event })
      }, health) as boolean
    })
    restorers.push(() => spy.mockRestore())
    deathProbeHookInstalled = true
  })
  let startWallMs: number | undefined, startMonotonicMs: number | undefined, startCpu: NodeJS.CpuUsage | undefined
  guard(() => { startWallMs = Date.now(); startMonotonicMs = performance.now(); startCpu = process.cpuUsage() })
  try {
    const result = await resume()
    outcome = "returned"
    return result
  } catch (error) {
    outcome = "threw"
    guard(() => { failureCode = code(error); failureName = error instanceof Error ? error.constructor.name : typeof error })
    throw error
  }
  finally {
    let endCpu: NodeJS.CpuUsage | undefined, endMonotonicMs: number | undefined, endWallMs: number | undefined
    guard(() => { endCpu = process.cpuUsage(); endMonotonicMs = performance.now(); endWallMs = Date.now() })
    for (const restore of restorers.reverse()) guard(restore)
    guard(() => { after = snapshot() })
    guard(() => {
      if (process.platform !== "linux") invalid.push("not-linux")
      if (child.status !== null || child.signal !== "SIGKILL" || !Number.isSafeInteger(child.pid) || child.pid <= 0) invalid.push("child-receipt")
      if (before?.journalPhase !== "PREPARED") invalid.push("required-case-not-reached")
      for (const operation of ["openSync", "fsyncSync", "linkSync"]) {
        if (!(counters[`${operation}:store-candidate`]! > 0)) invalid.push(`missing-${operation}-store-candidate`)
      }
      if (!deathProbeHookInstalled) invalid.push("death-probe-hook-not-installed")
      if (outcome === "returned" && !(counters.childDeathProbe! > 0)) invalid.push("returned-without-child-death-probe-interception")
      const locks = before?.locks as Event[] | undefined
      const killedOwner = locks?.find(lock => lock.name === "sessions.json.lock")?.incarnation as Event | undefined
      const currentOwner = parentOwner?.incarnation as Event | undefined
      if (!killedOwner || !currentOwner) invalid.push("missing-owner-metadata")
      else if (counters.childDeathProbe! > 0 && killedOwner.hostId === currentOwner.hostId && killedOwner.bootId === currentOwner.bootId
        && !(counters["readFileSync:child-proc-stat"]! > 0)) invalid.push("missing-native-linux-proc-interception")
      if (buffer.capped) invalid.push("trace-capped")
      if (health.observerError) invalid.push("observer-error")
      const artifact = { schema: 1, case: "SIGKILL migration 2/1 PREPARED", valid: invalid.length === 0,
        invalid, child, outcome, failureCode, failureName, before, after, counters, startWallMs, startMonotonicMs,
        deathProbeHookInstalled, probeObservation: counters.deathProbe! > 0 ? "death-probe-observed" : "no-death-probe-observed",
        endWallMs, endMonotonicMs, cpuStart: startCpu, cpuEnd: endCpu,
        limits: { maxEvents: MAX_EVENTS, maxBytes: MAX_BYTES, bytes: buffer.bytes, capped: buffer.capped },
        limitation: "Observer adds clock/hash/serialization overhead; native timing is not transparent. Snapshot follows helper import; joined clocks precede import. False death conflates alive and indeterminate. Zero observed probe calls cannot prove a caller used the spied export binding. No source/proc buffers are retained.",
        events: buffer.events }
      let encoded = JSON.stringify(artifact)
      if (Buffer.byteLength(encoded) > MAX_BYTES) {
        invalid.push("artifact-byte-cap")
        encoded = JSON.stringify({ schema: 1, case: artifact.case, valid: false, invalid, child, outcome,
          failureCode, failureName, counters, traceOmitted: true, maxBytes: MAX_BYTES })
      }
      fs.mkdirSync(output, { recursive: true, mode: 0o700 })
      fs.writeFileSync(join(output, "store-lock-diagnostic.json"), encoded, { mode: 0o600, flag: "wx" })
    })
    if (health.observerError) guard(() => console.error("[store-lock-diagnostic] invalid: recorder error; native outcome preserved"))
  }
}
