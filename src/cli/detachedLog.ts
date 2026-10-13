import { constants } from "node:fs"
import { lstat, open, rename, unlink } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import { Writable } from "node:stream"
import { checkDetachedWindowsAcl } from "./detachedWindowsAcl"

export const DETACHED_LOG_BYTES = 10 * 1024 * 1024

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}

async function inspect(path: string): Promise<{ dev: number; ino: number; size: number } | undefined> {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Detached log must be a single-link regular file")
    if (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {
      throw new Error("Detached log must be private to the current user")
    }
    if (process.platform === "win32") await checkDetachedWindowsAcl(path, "inspect-file")
    return { dev: stat.dev, ino: stat.ino, size: stat.size }
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/**
 * A backpressure-aware sink owned by the detached supervisor. The caller owns
 * the private containing directory and serializes one writer per endpoint.
 * Two retained files bound storage across launches, not only within one run.
 */
export class DetachedLog extends Writable {
  private file: FileHandle | undefined
  private size = 0

  private constructor(private readonly path: string, private readonly limit: number) {
    super({ highWaterMark: 64 * 1024 })
  }

  static async create(path: string, limit = DETACHED_LOG_BYTES): Promise<DetachedLog> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > DETACHED_LOG_BYTES) throw new Error("Invalid detached log limit")
    const sink = new DetachedLog(path, limit)
    const previous = await inspect(path + ".1")
    if (previous && previous.size > limit) throw new Error("Existing detached log exceeds its storage limit")
    await sink.openFile()
    if (sink.size > limit) {
      await sink.closeFile()
      throw new Error("Existing detached log exceeds its storage limit")
    }
    return sink
  }

  private async openFile(): Promise<void> {
    const existing = await inspect(this.path)
    const flags = constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0)
      | (existing ? 0 : constants.O_CREAT | constants.O_EXCL)
    const file = await open(this.path, flags, 0o600)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1
        || (existing && (existing.dev !== stat.dev || existing.ino !== stat.ino))
        || (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
        throw new Error("Detached log changed while opening")
      }
      if (process.platform === "win32") await checkDetachedWindowsAcl(this.path, "inspect-file")
      this.file = file
      this.size = stat.size
    } catch (error) {
      await file.close()
      throw error
    }
  }

  private async closeFile(): Promise<void> {
    const file = this.file
    this.file = undefined
    if (file) await file.close()
  }

  private async rotate(): Promise<void> {
    const owned = await this.file?.stat()
    const current = await inspect(this.path)
    if (!owned || !current || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new Error("Detached log changed before rotation")
    }
    const previous = await inspect(this.path + ".1")
    if (previous) await unlink(this.path + ".1")
    await this.closeFile()
    await rename(this.path, this.path + ".1")
    await this.openFile()
  }

  private async append(chunk: Buffer): Promise<void> {
    let offset = 0
    while (offset < chunk.byteLength) {
      if (this.size === this.limit) await this.rotate()
      const length = Math.min(this.limit - this.size, chunk.byteLength - offset)
      if (!this.file) throw new Error("Detached log is closed")
      const { bytesWritten } = await this.file.write(chunk, offset, length)
      if (bytesWritten === 0) throw new Error("Detached log write made no progress")
      offset += bytesWritten
      this.size += bytesWritten
    }
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.append(chunk).then(() => callback(), error => callback(error instanceof Error ? error : new Error(String(error))))
  }
  override _final(callback: (error?: Error | null) => void): void {
    this.closeFile().then(() => callback(), error => callback(error instanceof Error ? error : new Error(String(error))))
  }
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.closeFile().then(() => callback(error), closeError => callback(error ?? (closeError instanceof Error ? closeError : new Error(String(closeError)))))
  }
}
