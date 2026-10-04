import { expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

test("denied native probes expose only safe diagnostics and keep HTTP/lock admission fail closed", async () => {
  // Separate processes prevent existing identity caches and module mocks from
  // hiding a denied probe; the gate also checks normal capture/recovery.
  const script = join(dirname(fileURLToPath(import.meta.url)), "../../scripts/e2e-process-incarnation-diagnostics.mjs")
  const child = Bun.spawn([process.execPath, script], {
    env: { ...process.env, E2E_SOURCE_ROOT: join(dirname(script), "..") },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 25_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
    const result = JSON.parse(stdout) as { result: string; controls: Array<{ exit: number; result: { sdkCalls: number } }> }
    expect(result.result).toBe("PASS")
    expect(result.controls).toHaveLength(5)
    expect(result.controls.every(control => control.exit === 0 && control.result.sdkCalls === 0)).toBe(true)
  } finally {
    clearTimeout(timer)
  }
}, 30_000)
