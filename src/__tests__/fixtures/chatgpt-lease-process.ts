import * as fs from "node:fs"
import { join } from "node:path"
import { mock } from "bun:test"

const [mode, root, name] = process.argv.slice(2)
if (!mode || !root || !name) throw new Error("mode, root and worker name required")
const actual = { ...fs }
const lockPath = join(root, "writer.lock")
// Existence is the parent's completion signal. Publish only complete bytes:
// open/write on the canonical name lets a polling parent observe an empty file.
const publishReceipt = (suffix: string, value: string) => {
  const target = join(root, `${name}.${suffix}`)
  const pending = `${target}.pending-${process.pid}`
  actual.writeFileSync(pending, value)
  actual.renameSync(pending, target)
}
const report = (value: string) => publishReceipt("result", value)
let intercepted = false
mock.module("node:fs", () => ({
  ...actual,
  renameSync(from: fs.PathLike, to: fs.PathLike) {
    const canonical = from === lockPath
    const claim = String(from).startsWith(`${lockPath}.recover-`)
      && String(to).includes(".orphan-")
    if (!intercepted && ((canonical && mode === "pause-writer") || (claim && mode === "pause-claim"))) {
      intercepted = true
      publishReceipt("paused", "ready")
      const deadline = Date.now() + 30_000
      while (!actual.existsSync(join(root, `${name}.resume`))) {
        if (Date.now() > deadline) throw new Error("schedule controller did not resume worker")
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    if (canonical && mode === "crash-claim") process.exit(0)
    return actual.renameSync(from, to)
  },
}))

const { acquireWriterLease, WriterLeaseUnavailableError } = await import("../../proxy/chatgpt/lease")
try {
  const lease = await acquireWriterLease({ lockPath, staleMs: 0, heartbeatMs: 60_000, waitMs: 0 })
  lease.assertValid()
  if (mode === "dead") process.exit(0)
  report("admitted")
  process.on("SIGTERM", () => { lease.release(); process.exit(0) })
  const timer = setInterval(() => {
    if (actual.existsSync(join(root, `${name}.release`))) {
      lease.release()
      process.exit(0)
    }
    if (actual.existsSync(join(root, `${name}.validate`))) {
      lease.assertValid()
      publishReceipt("validated", "still-valid")
      actual.unlinkSync(join(root, `${name}.validate`))
    }
  }, 10)
  process.on("exit", () => clearInterval(timer))
} catch (error) {
  if (!(error instanceof WriterLeaseUnavailableError)) throw error
  report("denied")
}
