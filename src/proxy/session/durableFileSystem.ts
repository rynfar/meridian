import { closeSync, fsyncSync, openSync } from "node:fs"
import { open } from "node:fs/promises"

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
