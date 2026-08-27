import { closeSync, fsyncSync, lstatSync, openSync } from "node:fs"
import { lstat, open } from "node:fs/promises"

/**
 * Persist directory metadata where the runtime exposes a directory handle.
 *
 * Node on Windows does not support opening directories for fsync. Windows has
 * no equivalent API here, so preserve the fsynced-file + atomic-rename order
 * and skip only this unsupported metadata flush. On supported platforms every
 * open, sync, and close error remains fail-closed.
 */
export async function syncDirectoryDurably(path: string): Promise<void> {
  if (process.platform === "win32") return
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Synchronous form for the session store's synchronous lock protocol. */
export function syncDirectoryDurablySync(path: string): void {
  if (process.platform === "win32") return
  const fd = openSync(path, "r")
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const DIRECTORY_CONFLICT_CODES = new Set(["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR"])
const WINDOWS_DIRECTORY_CONFLICT_CODES = new Set(["EPERM", "EACCES"])

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined
}

/**
 * Classify an atomic directory publication collision without masking a real
 * Windows permission or filesystem error. Windows reports EPERM/EACCES rather
 * than EEXIST when the destination directory is already present, so accept
 * those codes only after proving that the destination currently exists.
 */
export async function directoryRenameWasBlocked(
  error: unknown,
  destination: string,
): Promise<boolean> {
  const code = errorCode(error)
  if (code && DIRECTORY_CONFLICT_CODES.has(code)) return true
  if (process.platform !== "win32" || !code || !WINDOWS_DIRECTORY_CONFLICT_CODES.has(code)) {
    return false
  }
  try {
    await lstat(destination)
    return true
  } catch (probeError) {
    if (errorCode(probeError) === "ENOENT") return false
    throw probeError
  }
}

/** Synchronous form for the session store's recovery-claim protocol. */
export function directoryRenameWasBlockedSync(error: unknown, destination: string): boolean {
  const code = errorCode(error)
  if (code && DIRECTORY_CONFLICT_CODES.has(code)) return true
  if (process.platform !== "win32" || !code || !WINDOWS_DIRECTORY_CONFLICT_CODES.has(code)) {
    return false
  }
  try {
    lstatSync(destination)
    return true
  } catch (probeError) {
    if (errorCode(probeError) === "ENOENT") return false
    throw probeError
  }
}
