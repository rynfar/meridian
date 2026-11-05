import { expect, it, spyOn } from "bun:test"
import * as fsp from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runGc } from "/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105/src/proxy/sessionLifecycle.ts"
import { setSessionStoreDir } from "/Users/rynfar/Library/Caches/meridian-validation.noindex/release-1.89.0-after1220-20261105/src/proxy/sessionStore.ts"

for (const explicit of [false, true]) {
  it(`records directory targets across one GC (explicit=${explicit})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "gc-dir-drift-"))
    const first = join(root, "first")
    const second = join(root, "second")
    const targets: string[] = []
    const link = fsp.link
    const spy = spyOn(fsp, "link").mockImplementation(async (source, target) => {
      if (String(target).endsWith("session-gc.json.lock")) targets.push(String(target))
      return link(source, target)
    })
    setSessionStoreDir(first)
    let changed = false
    try {
      await runGc([], {
        ...(explicit ? { storeDir: first } : {}),
        pinProvider: () => {
          // reconcile already owns its first-directory paths at this callback.
          if (!changed) { changed = true; setSessionStoreDir(second) }
          return []
        },
        deleter: async () => { throw new Error("empty sidecars must not delete") },
      })
      console.log(JSON.stringify({ explicit, targets: targets.map(p => p.replace(root, "ROOT")) }))
      expect(targets[0]).toBe(join(first, "session-gc.json.lock"))
      expect(targets[1]).toBe(join(explicit ? first : second, "session-gc.json.lock"))
    } finally {
      spy.mockRestore()
      setSessionStoreDir(null)
      rmSync(root, { recursive: true, force: true })
    }
  })
}
