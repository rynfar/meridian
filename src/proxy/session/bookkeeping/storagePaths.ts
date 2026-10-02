import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from "node:fs"
import { SessionLifecycleCorruptError, SessionLifecycleError, SessionLifecycleLockError } from "../lifecycleErrors"

export class BookkeepingBusyError extends SessionLifecycleLockError {}
export class BookkeepingMaintenanceRequiredError extends SessionLifecycleError {}
export class BookkeepingFormatError extends SessionLifecycleCorruptError { readonly exitCode = 5 }

export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined
}

export function assertSupportedFilesystem(type: number, platform = process.platform): void {
  const APFS = 26,
    HFS = 17,
    EXT = 0xef53,
    XFS = 0x58465342,
    BTRFS = 0x9123683e,
    TMPFS = 0x01021994
  const allowed = platform === "darwin" ? [APFS, HFS] : platform === "linux" ? [EXT, XFS, BTRFS, TMPFS] : []
  if (!allowed.includes(type >>> 0) && process.env.BOOKKEEPING_ALLOW_UNVERIFIED_FS !== "1") {
    throw new Error(
      `unsupported bookkeeping filesystem ${platform}/${type}; ` +
        "operator may explicitly set BOOKKEEPING_ALLOW_UNVERIFIED_FS=1",
    )
  }
}

/** Shared main/guard filesystem boundary; callers own the returned descriptor. */
export function ownedFd(path: string, directory = false, bootstrapLink = false, readOnly = false): number {
  const before = lstatSync(path)
  if (directory ? !before.isDirectory() : !before.isFile()) {
    throw new Error(`not an owned regular path: ${path}`)
  }
  if (process.getuid && before.uid !== process.getuid()) throw new Error(`not an owned regular path: ${path}`)
  if (!directory && before.nlink === 2 && path.endsWith(".sqlite")) {
    throw new BookkeepingBusyError("bootstrap publication is unlinking its temporary name")
  }
  if (!directory && before.nlink !== 1 && !(bootstrapLink && before.nlink === 2)) {
    throw new Error(`not an owned regular path: ${path}`)
  }
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new Error(`not an owned regular path: ${path}`, { cause: error })
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (before.dev !== stat.dev || before.ino !== stat.ino) throw new Error(`path replaced: ${path}`)
    if (!directory && stat.isFile() && stat.nlink === 2 && path.endsWith(".sqlite")) {
      throw new BookkeepingBusyError("bootstrap publication is unlinking its temporary name")
    }
    const linksOkay = stat.nlink === 1 || (bootstrapLink && stat.nlink === 2)
    if (
      (directory ? !stat.isDirectory() : !stat.isFile() || !linksOkay) ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error(`not an owned regular path: ${path}`)
    if (directory) {
      if ((stat.mode & 0o777) !== 0o700) {
        throw new Error(`bookkeeping directory must already be private (0700): ${path}`)
      }
    } else {
      if (!readOnly) fchmodSync(fd, 0o600)
      if ((fstatSync(fd).mode & 0o777) !== 0o600) throw new Error(`bookkeeping file permissions: ${path}`)
    }
    return fd
  } catch (error) {
    closeSync(fd)
    throw error
  }
}
