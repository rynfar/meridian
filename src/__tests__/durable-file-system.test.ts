import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
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
})
