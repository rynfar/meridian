import { randomUUID } from "node:crypto"
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { parseStoreDocument, serializeLegacyStore, withLegacyStoreMaintenanceLock } from "../../proxy/sessionStore"
import { syncDirectoryDurablySync } from "../../proxy/session/durableFileSystem"

/** Full-document legacy comparison: real lock and the same durable write protocol, without memoization. */
export function rewriteFullStore(directory: string): void {
  withLegacyStoreMaintenanceLock(directory, () => {
    const path = join(directory, "sessions.json")
    const document = parseStoreDocument(readFileSync(path, "utf8"))
    const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
    let fd: number | undefined
    try {
      fd = openSync(temporary, "wx", 0o600)
      fchmodSync(fd, 0o600)
      writeFileSync(fd, serializeLegacyStore(document), "utf8")
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, path)
      try { syncDirectoryDurablySync(dirname(path)) } catch (error) { void error }
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch (closeError) {
          console.error("[sessionStore] temp close failed:", (closeError as Error).message)
        }
      }
      try { unlinkSync(temporary) } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT")
          console.error("[sessionStore] temp cleanup failed:", (cleanupError as Error).message)
      }
      throw new Error(`[sessionStore] write failed: ${(error as Error).message}`, { cause: error })
    }
  })
}
