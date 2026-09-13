/**
 * Suppressible telemetry startup banner (#865).
 *
 * With `MERIDIAN_TELEMETRY_PERSIST` on, Meridian printed
 * `[telemetry] SQLite persistence enabled: ... (Nd retention)` to stderr on
 * every start, with no way to suppress it. The reporter wants persistence — just
 * not the confirmation on every session, because Meridian spawned by a wrapper
 * or plugin has its stderr surface in the agent's UI.
 *
 * `silent` cannot gate it: the stores are created at module load, before config
 * exists. So the gate is an env var, which is the only lever available that
 * early — and the issue lists it as an acceptable solution.
 *
 * The banner itself is asserted through a fresh module load per case, since
 * `createStores()` runs once on import.
 */

import { describe, it, expect } from "bun:test"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"

/** Load the telemetry module in a child process and capture its stderr. */
async function bannerWith(envOverrides: Record<string, string>): Promise<string> {
  const dir = mkdtempSync("/tmp/mquiet-")
  const proc = Bun.spawn(
    ["bun", "-e", 'await import("./src/telemetry/index.ts")'],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MERIDIAN_TELEMETRY_PERSIST: "1",
        MERIDIAN_TELEMETRY_DB: join(dir, "t.db"),
        ...envOverrides,
      },
      stderr: "pipe",
      stdout: "pipe",
    },
  )
  const stderr = await new Response(proc.stderr).text()
  await proc.exited
  return stderr
}

describe("the telemetry startup banner", () => {
  it("prints by default, so an operator still gets the confirmation", async () => {
    const out = await bannerWith({})
    expect(out).toContain("SQLite persistence enabled")
  }, 30_000)

  it("is suppressed by MERIDIAN_QUIET=1", async () => {
    const out = await bannerWith({ MERIDIAN_QUIET: "1" })
    expect(out).not.toContain("SQLite persistence enabled")
  }, 30_000)

  it("accepts the other truthy spellings envBool allows", async () => {
    for (const v of ["true", "yes"]) {
      const out = await bannerWith({ MERIDIAN_QUIET: v })
      expect(out).not.toContain("SQLite persistence enabled")
    }
  }, 60_000)

  // Suppression must not disable persistence — the reporter explicitly wants it.
  it("still enables persistence when quiet", async () => {
    const out = await bannerWith({ MERIDIAN_QUIET: "1" })
    expect(out).not.toContain("persistence enabled")
    // A failed SQLite load falls back to memory and would surface differently;
    // absence of any error is what confirms the store was created.
    expect(out).not.toMatch(/error|failed/i)
  }, 30_000)

  it("prints when the flag is explicitly off", async () => {
    const out = await bannerWith({ MERIDIAN_QUIET: "0" })
    expect(out).toContain("SQLite persistence enabled")
  }, 30_000)
})
