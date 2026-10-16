/**
 * The proxy's session GC, at its default settings, can retire as many
 * transcripts as turns create.
 *
 * A retired transcript waits out the grace (the session turn's hold and a
 * minute) before it can be deleted, and a fixed 256 could wait. Live,
 * 2026-10-09, parallel runs created 1,100-1,700 transcripts an hour; orphaned
 * transcripts stayed live until they filled the ownership ceiling, and every
 * request that needed a new one was refused 503 `session transcript ownership
 * capacity is full`.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { installSdkMock } from "./sdkMock"
import { installLoggerMock } from "./loggerMock"
import { installMcpToolsMock } from "./mcpToolsMock"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-session-gc-capacity.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx, fn) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, startProxyServer } = await import("../proxy/server")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const lifecycle = await import("../proxy/sessionLifecycle")
const { registerLiveTranscript } = lifecycle

const GC_SETTINGS = [
  "MERIDIAN_SESSION_GC_MAX_PENDING", "MERIDIAN_SESSION_GC_MAX_DELETES", "MERIDIAN_SESSION_GC_GRACE_MS",
  "MERIDIAN_SESSION_GC_INTERVAL_MS", "MERIDIAN_WORKDIR", "MERIDIAN_CONFIG_DIR",
]
let root: string
const savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "meridian-gc-capacity-")))
  for (const key of GC_SETTINGS) savedEnv[key] = process.env[key]
  // The test preload raises the backlog for the whole run; this file is
  // about the default.
  for (const key of GC_SETTINGS) delete process.env[key]
  Object.assign(process.env, { MERIDIAN_WORKDIR: root, MERIDIAN_CONFIG_DIR: join(root, "config") })
  setSessionStoreDir(join(root, "sessions"))
  mkdirSync(join(root, "profile"))
})

afterEach(() => {
  setSessionStoreDir(null)
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe("session GC capacity", () => {
  it("retires every orphaned transcript in one sweep, past the 256 the backlog used to hold", async () => {
    const configDir = join(root, "profile")
    for (let i = 0; i < 300; i++) {
      await registerLiveTranscript({ sessionId: crypto.randomUUID(), configDir })
    }
    const proxy = createProxyServer({
      port: 0, host: "127.0.0.1", defaultProfile: "p",
      profiles: [{ id: "p", claudeConfigDir: configDir }],
    })
    await proxy.sweepSessionGc?.()

    const sidecar = JSON.parse(readFileSync(join(root, "sessions", "session-gc.json"), "utf8")) as {
      resources: Record<string, { state: string }>
    }
    const states = Object.values(sidecar.resources).map(resource => resource.state)
    expect(states.filter(state => state === "retired")).toHaveLength(300)
  }, 60_000)

  it("keeps a draining proxy's sweeps, close()'s final one among them, to 16 deletions", async () => {
    process.env.MERIDIAN_SESSION_GC_INTERVAL_MS = "0"
    const runGc = lifecycle.runGc
    const limits: number[] = []
    const sweeps: Promise<unknown>[] = []
    const spy = spyOn(lifecycle, "runGc").mockImplementation((pins, options) => {
      limits.push(options?.maxDeletesPerRun ?? -1)
      const sweep = runGc(pins, options)
      sweeps.push(sweep)
      return sweep
    })
    try {
      const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
      await proxy.sweepSessionGc?.()
      proxy.beginDrain?.()
      await proxy.sweepSessionGc?.()
      expect(limits).toEqual([64, 16])

      limits.length = 0
      const instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
      // Let the startup sweep finish, so close() starts its own.
      while (sweeps.length < 3) await new Promise(resolve => setTimeout(resolve, 5))
      await Promise.all(sweeps)
      expect(limits).toEqual([64])
      await instance.close()
      expect(limits).toEqual([64, 16])
    } finally {
      spy.mockRestore()
    }
  }, 60_000)
})
