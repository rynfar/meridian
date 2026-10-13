import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseProcessIncarnation, processIncarnationIsDead } from "../proxy/session/processIncarnation"
import type { ProcessIncarnation } from "../proxy/session/processIncarnation"
import { parseDetachedRequest } from "./detachedProtocol"
import type { DetachedIdentity } from "./detachedProtocol"
import { checkDetachedWindowsAcl, checkDetachedFileAclIfPresent } from "./detachedWindowsAcl"

const RECORD_BYTES = 4096
export interface DetachedRecord extends DetachedIdentity {
  version: 1
  owner: ProcessIncarnation
  host: string
  port: number
  startedAt: number
}
export interface DetachedPaths {
  root: string
  host: string
  port: number
  key: string
  record: string
  log: string
  locks: string
}
interface Snapshot { value: DetachedRecord; dev: number; ino: number; raw: string }
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

export function parseDetachedRecord(value: unknown): DetachedRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 7 || record.version !== 1
    || typeof record.host !== "string" || record.host.length < 1 || record.host.length > 253 || /[\s/\\\0]/.test(record.host)
    || typeof record.port !== "number" || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535
    || typeof record.startedAt !== "number" || !Number.isSafeInteger(record.startedAt) || record.startedAt < 1) return undefined
  const identity = parseDetachedRequest({ version: 1, action: "inspect", instanceId: record.instanceId, nonce: record.nonce })
  const owner = parseProcessIncarnation(record.owner)
  if (!identity || !owner) return undefined
  return { version: 1, instanceId: identity.instanceId, nonce: identity.nonce, owner, host: record.host, port: record.port, startedAt: record.startedAt }
}

/** Never chmod/adopt an existing foreign or broadly accessible control directory. */
async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  if (create && process.platform === "win32") await checkDetachedWindowsAcl(path, "create-directory")
  else if (create) await mkdir(path, { mode: 0o700 }).catch(error => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
  })
  let stat
  try { stat = await lstat(path) }
  catch (error) { if (missing(error)) return false; throw error }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== "win32" && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0))) {
    throw new Error("Detached state directory is not private to the current user")
  }
  if (process.platform === "win32" && !create) await checkDetachedWindowsAcl(path, "inspect-directory")
  return true
}

export async function detachedPaths(configurationRoot: string, host: string, port: number, create = false): Promise<DetachedPaths | undefined> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !host || host.length > 253 || /[\s/\\\0]/.test(host)) {
    throw new Error("Invalid detached endpoint")
  }
  if (create) await mkdir(resolve(configurationRoot), { recursive: true, mode: 0o700 })
  let canonical: string
  try { canonical = await realpath(resolve(configurationRoot)) }
  catch (error) { if (missing(error)) return undefined; throw error }
  const root = join(canonical, "detached")
  if (!await privateDirectory(root, create)) return undefined
  const key = createHash("sha256").update(JSON.stringify([canonical, host, port])).digest("hex")
  return { root, host, port, key, record: join(root, key + ".json"), log: join(root, key + ".log"), locks: join(root, "locks") }
}

async function snapshot(paths: DetachedPaths): Promise<Snapshot | undefined> {
  await privateDirectory(paths.root, false)
  let expected
  try { expected = await lstat(paths.record) }
  catch (error) { if (missing(error)) return undefined; throw error }
  if (!expected.isFile() || expected.isSymbolicLink() || expected.nlink !== 1) throw new Error("Invalid detached ownership file")
  if (process.platform === "win32" && !await checkDetachedFileAclIfPresent(paths.record)) return undefined
  let file
  try { file = await open(paths.record, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) }
  catch (error) { if (missing(error)) return undefined; throw error }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino || stat.size > RECORD_BYTES
      || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
      throw new Error("Invalid detached ownership file")
    }
    const buffer = Buffer.alloc(RECORD_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > RECORD_BYTES || bytesRead !== stat.size) throw new Error("Detached ownership file changed or is incomplete")
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))
    const value = parseDetachedRecord(JSON.parse(raw))
    if (!value || value.host !== paths.host || value.port !== paths.port) throw new Error("Malformed or mismatched detached ownership record")
    return { value, dev: stat.dev, ino: stat.ino, raw }
  } finally { await file.close() }
}

export async function readDetachedRecord(paths: DetachedPaths): Promise<DetachedRecord | undefined> {
  return (await snapshot(paths))?.value
}

/** Caller MUST hold this endpoint's lifetime lease throughout publication/use/removal. */
export async function publishDetachedRecord(paths: DetachedPaths, record: DetachedRecord): Promise<void> {
  const validated = parseDetachedRecord(record)
  if (!validated || validated.host !== paths.host || validated.port !== paths.port) throw new Error("Invalid detached ownership record")
  const before = await snapshot(paths)
  if (before && !processIncarnationIsDead(before.value.owner)) throw new Error("Previous detached owner is not confirmed dead")
  const staging = join(paths.root, `.record-${validated.instanceId}.tmp`)
  const file = await open(staging, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
  let staged = true
  try {
    try {
      await file.writeFile(JSON.stringify(validated) + "\n")
      await file.sync()
    } finally { await file.close() }
    const current = await snapshot(paths)
    if ((before === undefined) !== (current === undefined)
      || (before && current && (before.dev !== current.dev || before.ino !== current.ino || before.raw !== current.raw))) {
      throw new Error("Detached ownership changed before publication")
    }
    await rename(staging, paths.record)
    staged = false
  } finally { if (staged) await unlink(staging) }
}

/** Remove only our same record; never use its PID as signaling authority. */
export async function removeDetachedRecord(paths: DetachedPaths, identity: DetachedIdentity): Promise<void> {
  const before = await snapshot(paths)
  if (!before) return
  if (before.value.instanceId !== identity.instanceId || before.value.nonce !== identity.nonce) {
    throw new Error("Detached ownership changed before removal")
  }
  const current = await snapshot(paths)
  if (!current || current.dev !== before.dev || current.ino !== before.ino || current.raw !== before.raw) {
    throw new Error("Detached ownership changed before removal")
  }
  const tombstone = join(paths.root, `.retired-${identity.instanceId}-${randomBytes(8).toString("hex")}.json`)
  await rename(paths.record, tombstone)
  const moved = await snapshot({ ...paths, record: tombstone })
  if (!moved || moved.dev !== before.dev || moved.ino !== before.ino || moved.raw !== before.raw) {
    // Never unlink an unexpected file. Retain it for explicit recovery instead
    // of risking overwriting a new owner's record while trying to restore it.
    throw new Error("Detached ownership changed during removal; retained for recovery")
  }
  await unlink(tombstone)
}

export async function detachedControlPath(paths: DetachedPaths, instanceId: string): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(instanceId) || instanceId.length !== 32) throw new Error("Invalid detached instance ID")
  if (process.platform === "win32") return `\\\\.\\pipe\\meridian-${paths.key}-${instanceId}`
  // macOS TMPDIR can exceed sockaddr_un's path limit. /tmp's canonical private
  // per-user directory keeps this name short even with a long config root.
  const runtimeRoot = join(await realpath("/tmp"), `md-${process.getuid?.()}-${paths.key.slice(0, 16)}`)
  await privateDirectory(runtimeRoot, true)
  return join(runtimeRoot, instanceId + ".sock")
}

/** Lifetime ownership for one supervisor; release only after its child is joined. */
export class DetachedOwnerLease {
  private published: DetachedRecord | undefined
  private publication: Promise<DetachedRecord> | undefined
  private releasePromise: Promise<void> | undefined
  private constructor(
    readonly paths: DetachedPaths,
    private readonly lease: import("../proxy/session/crossProcessTurnCoordinator").CrossProcessTurnLease,
    private readonly owner: ProcessIncarnation,
  ) {}

  static async acquire(paths: DetachedPaths, signal?: AbortSignal, timeoutMs = 50_000): Promise<DetachedOwnerLease> {
    paths = Object.freeze({ ...paths })
    if (!await privateDirectory(paths.root, false)) throw new Error("Detached state directory is missing")
    const { CrossProcessTurnCoordinator } = await import("../proxy/session/crossProcessTurnCoordinator")
    const { captureProcessIncarnation } = await import("../proxy/session/processIncarnation")
    const coordinator = new CrossProcessTurnCoordinator(paths.locks, { acquireTimeoutMs: timeoutMs })
    const lease = await coordinator.acquire(`lifetime:${paths.key}`, signal)
    const owner = captureProcessIncarnation()
    if (!owner) {
      await lease.release()
      throw new Error("Cannot capture detached supervisor incarnation")
    }
    return new DetachedOwnerLease(paths, lease, owner)
  }

  publish(identity: DetachedIdentity): Promise<DetachedRecord> {
    if (this.releasePromise || this.publication) return Promise.reject(new Error("Detached ownership is already publishing or released"))
    this.publication = (async () => {
      const record: DetachedRecord = { version: 1, instanceId: identity.instanceId, nonce: identity.nonce, owner: this.owner, host: this.paths.host, port: this.paths.port, startedAt: Date.now() }
      await publishDetachedRecord(this.paths, record)
      this.published = { ...record, owner: { ...record.owner } }
      return record
    })()
    return this.publication
  }

  release(): Promise<void> {
    this.releasePromise ??= (async () => {
      const errors: unknown[] = []
      try { if (this.publication) await this.publication }
      catch (error) { errors.push(error) }
      try { if (this.published) await removeDetachedRecord(this.paths, this.published) }
      catch (error) { errors.push(error) }
      try { await this.lease.release() }
      catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, "Detached ownership cleanup failed")
    })()
    return this.releasePromise
  }
}
