import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  directoryRenameWasBlocked,
  directoryRenameWasBlockedSync,
  syncDirectoryDurably,
  syncDirectoryDurablySync,
} from "../proxy/session/durableFileSystem"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("platform directory durability", () => {
  it("uses the platform-supported directory metadata barrier", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-directory-sync-"))
    roots.push(root)

    expect(() => syncDirectoryDurablySync(root)).not.toThrow()
    await expect(syncDirectoryDurably(root)).resolves.toBeUndefined()
  })

  it("classifies Windows rename contention only when the destination exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-directory-conflict-"))
    roots.push(root)
    const standardConflict = Object.assign(new Error("collision"), { code: "EEXIST" })
    const windowsConflict = Object.assign(new Error("collision"), { code: "EPERM" })
    const unrelated = Object.assign(new Error("I/O failure"), { code: "EIO" })

    expect(await directoryRenameWasBlocked(standardConflict, root)).toBe(true)
    expect(directoryRenameWasBlockedSync(standardConflict, root)).toBe(true)
    expect(await directoryRenameWasBlocked(windowsConflict, root)).toBe(process.platform === "win32")
    expect(directoryRenameWasBlockedSync(windowsConflict, root)).toBe(process.platform === "win32")
    expect(await directoryRenameWasBlocked(windowsConflict, join(root, "missing"))).toBe(false)
    expect(directoryRenameWasBlockedSync(windowsConflict, join(root, "missing"))).toBe(false)
    expect(await directoryRenameWasBlocked(unrelated, root)).toBe(false)
    expect(directoryRenameWasBlockedSync(unrelated, root)).toBe(false)
  })
})
