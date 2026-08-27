import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, readlinkSync } from "node:fs"

export const PROCESS_INCARNATION_VERSION = 1

export type ProcessStartIdKind =
  | "linux-proc-start-ticks"
  | "darwin-ps-lstart"
  | "windows-start-ticks"

/**
 * OS-backed identity for one process incarnation.
 *
 * `hostId` identifies the machine (and Linux PID namespace), `bootId`
 * identifies one boot of that machine, and `startId` distinguishes PID reuse
 * within the boot. Raw machine IDs are hashed before they are persisted.
 */
export interface ProcessIncarnation {
  version: typeof PROCESS_INCARNATION_VERSION
  pid: number
  hostId: string
  bootId: string
  startId: string
  startIdKind: ProcessStartIdKind
}

export type ProcessIncarnationProbe = "alive" | "dead" | "indeterminate"

export interface LocalBootIdentity {
  hostId: string
  bootId: string
}

export type ProcessStartObservation =
  | { status: "found"; startId: string; startIdKind: ProcessStartIdKind }
  | { status: "missing" }
  | { status: "indeterminate" }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const LINUX_START_PATTERN = /^[1-9][0-9]{0,31}$/
const WINDOWS_START_PATTERN = /^[1-9][0-9]{0,31}$/
const DARWIN_START_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 0-3][0-9] [0-2][0-9]:[0-5][0-9]:[0-6][0-9] [0-9]{4}$/
const PROBE_TIMEOUT_MS = 2_000
// PowerShell/CIM startup can exceed two seconds on a cold Windows host. This
// path runs before the SDK command opens, so wait long enough to capture the
// durable writer identity instead of failing every first launch closed.
const WINDOWS_PROBE_TIMEOUT_MS = 10_000

let cachedLocalBootIdentity: LocalBootIdentity | undefined
let cachedCurrentProcessIncarnation: ProcessIncarnation | undefined

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function isPositivePid(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
}

function validStartId(kind: unknown, value: unknown): kind is ProcessStartIdKind {
  if (typeof value !== "string") return false
  if (kind === "linux-proc-start-ticks") return LINUX_START_PATTERN.test(value)
  if (kind === "darwin-ps-lstart") return DARWIN_START_PATTERN.test(value)
  if (kind === "windows-start-ticks") return WINDOWS_START_PATTERN.test(value)
  return false
}

export function parseProcessIncarnation(value: unknown): ProcessIncarnation | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const identity = value as Record<string, unknown>
  if (
    identity.version !== PROCESS_INCARNATION_VERSION
    || !isPositivePid(identity.pid)
    || typeof identity.hostId !== "string"
    || !SHA256_PATTERN.test(identity.hostId)
    || typeof identity.bootId !== "string"
    || !UUID_PATTERN.test(identity.bootId)
    || typeof identity.startId !== "string"
    || !validStartId(identity.startIdKind, identity.startId)
  ) return undefined
  return {
    version: PROCESS_INCARNATION_VERSION,
    pid: identity.pid,
    hostId: identity.hostId,
    bootId: identity.bootId,
    startId: identity.startId,
    startIdKind: identity.startIdKind,
  }
}

export function parseProcessIncarnationJson(raw: string): ProcessIncarnation | undefined {
  try {
    return parseProcessIncarnation(JSON.parse(raw) as unknown)
  } catch {
    return undefined
  }
}

/**
 * Pure recovery decision. Only `dead` is permission to retire an owner's lock.
 * Unknown hosts and every unavailable or malformed observation fail closed.
 */
export function evaluateProcessIncarnation(
  owner: ProcessIncarnation,
  localBoot: LocalBootIdentity | undefined,
  observedStart: ProcessStartObservation | undefined,
): ProcessIncarnationProbe {
  const parsedOwner = parseProcessIncarnation(owner)
  if (
    !parsedOwner
    || !localBoot
    || !SHA256_PATTERN.test(localBoot.hostId)
    || !UUID_PATTERN.test(localBoot.bootId)
    || parsedOwner.hostId !== localBoot.hostId
  ) return "indeterminate"
  if (parsedOwner.bootId !== localBoot.bootId) return "dead"
  if (!observedStart || observedStart.status === "indeterminate") return "indeterminate"
  if (observedStart.status === "missing") return "dead"
  if (
    !validStartId(observedStart.startIdKind, observedStart.startId)
    || observedStart.startIdKind !== parsedOwner.startIdKind
  ) return "indeterminate"
  if (observedStart.startId !== parsedOwner.startId) return "dead"

  // Linux start ticks are an exact kernel process-birth marker. Darwin's stock
  // ps only exposes birth time to one second, so equality cannot exclude an
  // extremely fast same-second PID reuse. Treat that collision as unknown.
  return parsedOwner.startIdKind === "linux-proc-start-ticks" ? "alive" : "indeterminate"
}

function normalizeUuid(raw: string): string | undefined {
  const value = raw.trim().toLowerCase()
  return UUID_PATTERN.test(value) ? value : undefined
}

function readFirst(paths: readonly string[]): string | undefined {
  for (const path of paths) {
    try {
      const value = readFileSync(path, "utf8").trim()
      if (value) return value
    } catch {
      // Try the next canonical OS location. Failure remains fail-closed.
    }
  }
  return undefined
}

function linuxLocalBootIdentity(): LocalBootIdentity | undefined {
  const machineId = readFirst(["/etc/machine-id", "/var/lib/dbus/machine-id"])
  const bootId = normalizeUuid(readFileSync("/proc/sys/kernel/random/boot_id", "utf8"))
  const pidNamespace = readlinkSync("/proc/self/ns/pid")
  if (!machineId || !/^[0-9a-fA-F]{32}$/.test(machineId) || !bootId || !/^pid:\[[0-9]+\]$/.test(pidNamespace)) {
    return undefined
  }
  return {
    hostId: hashIdentity(`linux:${machineId.toLowerCase()}:${pidNamespace}`),
    bootId,
  }
}

function runDarwin(command: string, args: readonly string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C", TZ: "UTC0" },
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return undefined
  return result.stdout
}

function darwinLocalBootIdentity(): LocalBootIdentity | undefined {
  const ioreg = runDarwin("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"])
  const boot = runDarwin("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])
  const machineMatch = ioreg?.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/)
  const machineId = machineMatch?.[1] ? normalizeUuid(machineMatch[1]) : undefined
  const bootId = boot ? normalizeUuid(boot) : undefined
  if (!machineId || !bootId) return undefined
  return {
    hostId: hashIdentity(`darwin:${machineId}`),
    bootId,
  }
}

function uuidFromIdentity(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function runWindowsPowerShell(script: string): { status: number | null; stdout?: string } {
  const result = spawnSync("powershell.exe", [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy", "Bypass",
    "-Command", script,
  ], {
    encoding: "utf8",
    windowsHide: true,
    timeout: WINDOWS_PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  })
  return {
    status: result.error ? null : result.status,
    ...(typeof result.stdout === "string" ? { stdout: result.stdout } : {}),
  }
}

function windowsLocalBootIdentity(): LocalBootIdentity | undefined {
  const result = runWindowsPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
$machine = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid
try { $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime }
catch { $boot = (Get-WmiObject Win32_OperatingSystem).ConvertToDateTime((Get-WmiObject Win32_OperatingSystem).LastBootUpTime) }
Write-Output $machine
Write-Output $boot.ToUniversalTime().Ticks
`)
  if (result.status !== 0 || !result.stdout) return undefined
  const [machine, bootTicks] = result.stdout.trim().split(/\r?\n/).map((part) => part.trim())
  if (!machine || !bootTicks || !WINDOWS_START_PATTERN.test(bootTicks)) return undefined
  return {
    hostId: hashIdentity(`windows:${machine.toLowerCase()}`),
    bootId: uuidFromIdentity(`windows-boot:${machine.toLowerCase()}:${bootTicks}`),
  }
}

function getLocalBootIdentity(): LocalBootIdentity | undefined {
  if (cachedLocalBootIdentity) return cachedLocalBootIdentity
  try {
    const identity = process.platform === "linux"
      ? linuxLocalBootIdentity()
      : process.platform === "darwin"
        ? darwinLocalBootIdentity()
        : process.platform === "win32"
          ? windowsLocalBootIdentity()
          : undefined
    if (identity) cachedLocalBootIdentity = identity
    return identity
  } catch {
    return undefined
  }
}

function pidPresence(pid: number): "present" | "missing" | "indeterminate" {
  try {
    process.kill(pid, 0)
    return "present"
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    return code === "ESRCH" ? "missing" : "indeterminate"
  }
}

/** Parse field 22 (`starttime`) without assuming that comm contains no `)`. */
export function parseLinuxProcStatStartId(raw: string, expectedPid: number): string | undefined {
  const prefix = `${expectedPid} (`
  if (!raw.startsWith(prefix)) return undefined
  const commEnd = raw.lastIndexOf(")")
  if (commEnd < prefix.length || raw[commEnd + 1] !== " ") return undefined
  const fieldsFromState = raw.slice(commEnd + 2).trim().split(/\s+/)
  const startId = fieldsFromState[19]
  return startId && LINUX_START_PATTERN.test(startId) ? startId : undefined
}

function linuxProcessStart(pid: number): ProcessStartObservation {
  let raw: string
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8")
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined
    if (code === "ENOENT" || code === "ESRCH") return { status: "missing" }
    return { status: "indeterminate" }
  }
  const startId = parseLinuxProcStatStartId(raw, pid)
  if (startId) return { status: "found", startId, startIdKind: "linux-proc-start-ticks" }
  return pidPresence(pid) === "missing" ? { status: "missing" } : { status: "indeterminate" }
}

function darwinProcessStart(pid: number): ProcessStartObservation {
  const output = runDarwin("/bin/ps", ["-p", String(pid), "-o", "lstart="])
  if (output !== undefined) {
    const startId = output.trimEnd().trimStart()
    if (DARWIN_START_PATTERN.test(startId)) {
      return { status: "found", startId, startIdKind: "darwin-ps-lstart" }
    }
  }
  return pidPresence(pid) === "missing" ? { status: "missing" } : { status: "indeterminate" }
}

function windowsProcessStart(pid: number): ProcessStartObservation {
  const result = runWindowsPowerShell(String.raw`
$ErrorActionPreference = 'Stop'
try {
  $process = Get-Process -Id ${pid} -ErrorAction Stop
  Write-Output $process.StartTime.ToUniversalTime().Ticks
} catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
  exit 3
} catch {
  exit 4
}
`)
  const startId = result.stdout?.trim()
  if (result.status === 0 && startId && WINDOWS_START_PATTERN.test(startId)) {
    return { status: "found", startId, startIdKind: "windows-start-ticks" }
  }
  if (result.status === 3) return { status: "missing" }
  return pidPresence(pid) === "missing" ? { status: "missing" } : { status: "indeterminate" }
}

function observeProcessStart(pid: number): ProcessStartObservation {
  if (process.platform === "linux") return linuxProcessStart(pid)
  if (process.platform === "darwin") return darwinProcessStart(pid)
  if (process.platform === "win32") return windowsProcessStart(pid)
  return { status: "indeterminate" }
}

/** Capture metadata for a lock created by `pid` (normally the current process). */
export function captureProcessIncarnation(pid = process.pid): ProcessIncarnation | undefined {
  if (!isPositivePid(pid)) return undefined
  if (pid === process.pid && cachedCurrentProcessIncarnation) {
    return { ...cachedCurrentProcessIncarnation }
  }
  const localBoot = getLocalBootIdentity()
  if (!localBoot) return undefined
  const start = observeProcessStart(pid)
  if (start.status !== "found") return undefined
  const identity: ProcessIncarnation = {
    version: PROCESS_INCARNATION_VERSION,
    pid,
    ...localBoot,
    startId: start.startId,
    startIdKind: start.startIdKind,
  }
  if (pid === process.pid) cachedCurrentProcessIncarnation = identity
  return { ...identity }
}

/** Probe one stored owner. Recovery callers must act only on `dead`. */
export function probeProcessIncarnation(owner: ProcessIncarnation): ProcessIncarnationProbe {
  const parsed = parseProcessIncarnation(owner)
  if (!parsed) return "indeterminate"
  const localBoot = getLocalBootIdentity()
  if (!localBoot || parsed.hostId !== localBoot.hostId) return "indeterminate"
  if (parsed.bootId !== localBoot.bootId) {
    return evaluateProcessIncarnation(parsed, localBoot, undefined)
  }
  return evaluateProcessIncarnation(parsed, localBoot, observeProcessStart(parsed.pid))
}

export function processIncarnationIsDead(owner: ProcessIncarnation): boolean {
  return probeProcessIncarnation(owner) === "dead"
}
