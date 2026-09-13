import { describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createSqliteStores } from "../telemetry/sqlite"

describe("test preload operator isolation (#927)", () => {
  for (const prefix of ["MERIDIAN_", "CLAUDE_PROXY_"]) {
    it(`protects operator telemetry and configuration inherited through ${prefix}`, () => {
      const root = mkdtempSync(join(tmpdir(), "meridian-preload-check-"))
      const dbPath = join(root, "operator.db")
      const stores = createSqliteStores(dbPath, 7)
      try {
        stores.telemetry.record({
          requestId: "operator-request", timestamp: Date.now(), model: "sonnet",
          mode: "non-stream", isResume: false, isPassthrough: false, status: 200,
          queueWaitMs: 0, proxyOverheadMs: 0, ttfbMs: null, upstreamDurationMs: 0,
          totalDurationMs: 0, contentBlocks: 1, textEvents: 1, error: null,
        })
        stores.diagnostics.session("operator diagnostic")
        expect(stores.telemetry.size).toBe(1)
        expect(stores.diagnostics.getRecent()).toHaveLength(1)

        const fixture = join(root, "operator-isolation.test.ts")
        const telemetryUrl = pathToFileURL(resolve(import.meta.dir, "../telemetry/index.ts")).href
        const envUrl = pathToFileURL(resolve(import.meta.dir, "../env.ts")).href
        // Run the real test runner and preload in a fresh process: an in-process
        // import cannot prove that isolation happens before singleton creation.
        writeFileSync(fixture, `
          import { expect, test } from "bun:test"
          import { telemetryStore, diagnosticLog, MemoryTelemetryStore, MemoryDiagnosticLogStore } from ${JSON.stringify(telemetryUrl)}
          import { env } from ${JSON.stringify(envUrl)}
          test("test cleanup is isolated from operator state", () => {
            telemetryStore.clear()
            diagnosticLog.clear()
            expect(telemetryStore).toBeInstanceOf(MemoryTelemetryStore)
            expect(diagnosticLog).toBeInstanceOf(MemoryDiagnosticLogStore)
            expect(env("NO_FILE_CHANGES")).toBeUndefined()
            expect(env("API_KEY")).toBeUndefined()
            expect(env("CONFIG_DIR")).not.toBe(${JSON.stringify(join(root, "operator-config"))})
            expect(env("SESSION_DIR")).not.toBe(${JSON.stringify(join(root, "operator-sessions"))})
            expect(env("TEST_DISABLE_SDK_PROCESS_GATE")).toBe("1")
            process.env.MERIDIAN_NO_FILE_CHANGES = "1"
            expect(env("NO_FILE_CHANGES")).toBe("1")
          })
        `)
        const childEnv = { ...process.env }
        for (const key of Object.keys(childEnv)) {
          if (key.startsWith("MERIDIAN_") || key.startsWith("CLAUDE_PROXY_")) delete childEnv[key]
        }
        Object.assign(childEnv, {
          // Even a broken preload can only touch this throwaway HOME/database.
          HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root,
          [`${prefix}TELEMETRY_PERSIST`]: "1",
          [`${prefix}TELEMETRY_DB`]: dbPath,
          [`${prefix}NO_FILE_CHANGES`]: "1",
          [`${prefix}API_KEY`]: "test-only-key",
          [`${prefix}CONFIG_DIR`]: join(root, "operator-config"),
          [`${prefix}SESSION_DIR`]: join(root, "operator-sessions"),
          [`${prefix}TEST_DISABLE_SDK_PROCESS_GATE`]: "0",
        })
        const result = spawnSync(process.execPath, [
          "test", "--preload", resolve(import.meta.dir, "preload.ts"), fixture,
        ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 10_000 })

        // Check the user's rows first: this must fail on the old preload even
        // though the child successfully performed its usual clear() cleanup.
        expect(stores.telemetry.getRecent().map(row => row.requestId)).toEqual(["operator-request"])
        expect(stores.diagnostics.getRecent().map(row => row.message)).toEqual(["operator diagnostic"])
        if (result.error) throw result.error
        expect({ status: result.status, output: result.stdout + result.stderr }).toMatchObject({ status: 0 })
      } finally {
        stores.close()
        rmSync(root, { recursive: true, force: true })
      }
    }, 15_000)
  }
})
