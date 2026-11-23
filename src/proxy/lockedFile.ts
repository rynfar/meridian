/** Cross-process writer lock and atomic snapshots for Meridian's own files.
 * Leaf module: no server/session imports. Interrupted writers leave the lock
 * in place and fail closed; never steal a lock based only on elapsed time.
 */
import { randomUUID } from "node:crypto"
import { accessSync, constants, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"

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

/** Waits by blocking the thread: for CLI paths and callers already synchronous. */
export function withFileLockSync<T>(file: string, busy: string, operation: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const fd = acquire(file)
    if (fd !== undefined) return locked(file, fd, operation)
    if (Date.now() >= deadline) throw new Error(busy)
    Atomics.wait(pause, 0, 0, 10)
  }
}

export async function withFileLock<T>(file: string, busy: string, operation: () => T): Promise<T> {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const fd = acquire(file)
    if (fd !== undefined) return locked(file, fd, operation)
    if (Date.now() >= deadline) throw new Error(busy)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** Call under the writer lock; readers see the old or complete new snapshot. */
export function publishFileSnapshot(file: string, contents: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  // Atomic rename must not bypass an existing read-only file permission.
  if (existsSync(file)) accessSync(file, constants.W_OK)
  const temporary = join(dirname(file), `.${basename(file)}-${process.pid}-${randomUUID()}.tmp`)
  try {
    const fd = openSync(temporary, "wx", 0o600)
    try { writeFileSync(fd, contents); fsyncSync(fd) }
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
