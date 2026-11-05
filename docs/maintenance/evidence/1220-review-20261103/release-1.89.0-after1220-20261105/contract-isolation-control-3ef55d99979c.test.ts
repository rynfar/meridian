import { expect, it, spyOn } from "bun:test"
import * as fsp from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGc } from "/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105/src/proxy/sessionLifecycle.ts"
import { setSessionStoreDir, storeSharedSession } from "/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105/src/proxy/sessionStore.ts"
import { migrateBookkeeping } from "/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105/src/proxy/session/bookkeeping/migration.ts"
it("a foreign fixture sweep blocks same-process migration but not the isolated contract", async () => {
  const root = mkdtempSync(join(tmpdir(), "contract-isolation-control-"))
  const first = join(root, "first"), second = join(root, "second")
  let entered!: () => void, release!: () => void
  const holding = new Promise<void>(resolve => { entered = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  const originalLink = fsp.link
  const spy = spyOn(fsp, "link").mockImplementation(async (source, target) => {
    if (String(target) === join(second, "session-gc.json.lock")) { entered(); await resume }
    return originalLink(source, target)
  })
  let gc: Promise<unknown> | undefined
  try {
    setSessionStoreDir(second)
    await storeSharedSession("key", "id")
    setSessionStoreDir(first)
    let moved = false
    gc = runGc([], { pinProvider: () => { if (!moved) { moved = true; setSessionStoreDir(second) }; return [] } })
    await holding
    await expect(migrateBookkeeping(second, { writersStopped: true })).rejects.toThrow("live residue:")
    const child = spawnSync(process.execPath, ["test", "--timeout", "30000", "src/__tests__/bookkeeping-store-contract.test.ts"], {
      cwd: "/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105", env: { ...process.env }, encoding: "utf8", timeout: 30000,
    })
    expect(child.error).toBeUndefined()
    expect(child.status, child.stdout + child.stderr).toBe(0)
    expect(child.stdout + child.stderr).toContain("6 pass")
    console.log(JSON.stringify({ sameProcess: "migration correctly refuses live foreign candidate", isolatedContract: "6 pass, 0 fail", processIsolation: true }))
    release(); await gc
    await expect(migrateBookkeeping(second, { writersStopped: true })).resolves.toMatchObject({ phase: "READY" })
  } finally {
    release(); await gc
    spy.mockRestore(); setSessionStoreDir(null)
    rmSync(root, { recursive: true, force: true })
  }
}, 30000)
