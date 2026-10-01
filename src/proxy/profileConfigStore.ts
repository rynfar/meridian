/** Profile configuration writers share one lock and publish complete snapshots.
 * Leaf module: no server/session imports. Interrupted writers leave the lock
 * in place and fail closed; never steal a lock based only on elapsed time.
 */
import { randomUUID } from "node:crypto"
import { accessSync, constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { ProfileConfig } from "./profiles"

const LOCK_WAIT_MS = 5000
const pause = new Int32Array(new SharedArrayBuffer(4))

function acquire(file: string): number | undefined {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  try { return openSync(`${file}.lock`, "wx", 0o600) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined
    throw error
  }
}

function locked<T>(file: string, fd: number, operation: () => T): T {
  try { return operation() }
  finally { closeSync(fd); unlinkSync(`${file}.lock`) }
}

/** CLI-only waiting; HTTP account creation uses the nonblocking async form. */
export function withProfileConfigLockSync<T>(file: string, operation: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const fd = acquire(file)
    if (fd !== undefined) return locked(file, fd, operation)
    if (Date.now() >= deadline) throw new Error("Profile configuration is locked by another writer; retry after that writer finishes. An interrupted writer's lock requires cleanup while all writers are stopped.")
    Atomics.wait(pause, 0, 0, 10)
  }
}

export async function withProfileConfigLock<T>(file: string, operation: () => T): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const fd = acquire(file)
    if (fd !== undefined) return locked(file, fd, operation)
    if (Date.now() >= deadline) throw new Error("Profile configuration is locked by another writer; retry after that writer finishes. An interrupted writer's lock requires cleanup while all writers are stopped.")
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

function isProfile(value: unknown): value is ProfileConfig {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && value.id.length > 0
}

/** Writers must never turn a malformed existing file into an empty list. */
export function readProfileConfigForUpdate(file: string): ProfileConfig[] {
  if (!existsSync(file)) return []
  const decoded: unknown = JSON.parse(readFileSync(file, "utf8"))
  if (!Array.isArray(decoded)) throw new Error("Profile configuration must contain an array")
  const entries: unknown[] = decoded
  if (!entries.every(isProfile)) throw new Error("Profile configuration contains an invalid profile")
  return entries
}

/** Call under the writer lock; readers see the old or complete new snapshot. */
export function publishProfileConfig(file: string, profiles: ProfileConfig[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Atomic rename must not bypass an existing read-only file permission.
  if (existsSync(file)) accessSync(file, constants.W_OK)
  const temporary = join(dirname(file), `.${basename(file)}-${process.pid}-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, "wx", 0o600)
    try { writeFileSync(fd, `${JSON.stringify(profiles, null, 2)}\n`); fsyncSync(fd) }
    finally { closeSync(fd) }
    renameSync(temporary, file)
    if (process.platform !== "win32") {
      const directory = openSync(dirname(file), "r")
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary)
  }
}
