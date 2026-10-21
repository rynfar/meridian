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
import { observeLifecycleState } from "./fixtures/bookkeeping-lifecycle-observer"

installSdkMock(() => ({
  query: () => (async function* () {})(),
  createSdkMcpServer: () => ({ type: "sdk", name: "test", instance: {} }),
  tool: () => ({}),
}), "proxy-session-gc-capacity.test.ts")
installLoggerMock(() => ({ claudeLog: () => {}, withClaudeLogContext: (_ctx, fn) => fn() }))
installMcpToolsMock(() => ({ createOpencodeMcpServer: () => ({ type: "sdk", name: "opencode", instance: {} }) }))

const { createProxyServer, startProxyServer, initializeProxyBookkeeping } = await import("../proxy/server")
const { setSessionStoreDir } = await import("../proxy/sessionStore")
const lifecycle = await import("../proxy/sessionLifecycle")
const { registerLiveTranscript } = lifecycle

const GC_SETTINGS = [
  "MERIDIAN_SESSION_GC_MAX_PENDING", "MERIDIAN_SESSION_GC_MAX_DELETES", "MERIDIAN_SESSION_GC_GRACE_MS",
  "MERIDIAN_SESSION_GC_INTERVAL_MS", "MERIDIAN_WORKDIR", "MERIDIAN_CONFIG_DIR", "MERIDIAN_BOOKKEEPING",
]
let root: string
const savedEnv: Record<string, string | undefined> = {}

function gate() {
  let release = () => {}
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

function resourceStates(): string[] {
  const state = observeLifecycleState(join(root, "sessions"), process.env.MERIDIAN_BOOKKEEPING === "sqlite")
  return Object.values(state.resources).map(resource => resource.state)
}

async function seedRetiredTranscripts(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await registerLiveTranscript({ sessionId: crypto.randomUUID(), configDir: join(root, "profile") })
  }
  // The proxy's clock sees these retirements as eligible without sleeping out
  // its production grace. All claims and settlements still use the real store.
  await lifecycle.reconcile([], { now: () => 0, retiredGraceMs: 0 })
}

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
  for (const [label, draining, configuredCap, expected] of [
    ["ordinary throughput", false, undefined, 64],
    ["draining throughput", true, undefined, 16],
    ["lower configured drain cap", true, "8", 8],
  ] as const) {
    it(`preserves ${label} through joined deletion transactions`, async () => {
      if (configuredCap) process.env.MERIDIAN_SESSION_GC_MAX_DELETES = configuredCap
      await seedRetiredTranscripts(70)
      const runGc = lifecycle.runGc
      let deletions = 0
      const spy = spyOn(lifecycle, "runGc").mockImplementation((pins, options) => runGc(pins, {
        ...options,
        deleter: async () => { deletions++ },
      }))
      try {
        const proxy = createProxyServer({ port: 0, host: "127.0.0.1" })
        if (draining) proxy.beginDrain?.()
        const sweep = proxy.sweepSessionGc?.()
        expect(proxy.sweepSessionGc?.()).toBe(sweep)
        await sweep
        expect(deletions).toBe(expected)
        expect(resourceStates().filter(state => state === "deleted")).toHaveLength(expected)
        expect(resourceStates()).not.toContain("deleting")
      } finally {
        spy.mockRestore()
      }
    }, 60_000)
  }

  for (const backend of ["json", "sqlite"] as const) for (const pauseAt of [1, 25]) {
    it(`lowers the remaining allowance when idle close joins deletion ${pauseAt} (${backend})`, async () => {
      process.env.MERIDIAN_SESSION_GC_INTERVAL_MS = "0"
      process.env.MERIDIAN_BOOKKEEPING = backend
      const started = gate()
      const release = gate()
      const runGc = lifecycle.runGc
      let deletions = 0
      let sweeps = 0
      let closeSettled = false
      const spy = spyOn(lifecycle, "runGc").mockImplementation((pins, options) => {
        sweeps++
        return runGc(pins, {
          ...options,
          deleter: async () => {
            if (++deletions === pauseAt) {
              started.release()
              await release.promise
            }
          },
        })
      })
      let instance: Awaited<ReturnType<typeof startProxyServer>> | undefined
      let owner: Awaited<ReturnType<typeof initializeProxyBookkeeping>> = undefined
      let embedded: ReturnType<typeof createProxyServer> | undefined
      let embeddedSweep: Promise<void> | undefined
      try {
        owner = await initializeProxyBookkeeping()
        expect(owner !== undefined).toBe(backend === "sqlite")
        await seedRetiredTranscripts(70)
        if (backend === "sqlite") {
          // An initialized embedding owns this exact SQL store. Avoid a second
          // startup-maintenance pass deleting the fixture before its tested sweep.
          embedded = createProxyServer({ port: 0, host: "127.0.0.1" })
          embeddedSweep = embedded.sweepSessionGc?.()
          if (!embeddedSweep) throw new Error("Owned SQL proxy has no GC sweep")
        } else {
          instance = await startProxyServer({ port: 0, host: "127.0.0.1", silent: true })
        }
        await started.promise
        expect(resourceStates().filter(state => state === "deleting")).toHaveLength(1)
        const close = instance ? instance.close() : embedded?.closeBackend?.()
        if (!close) throw new Error("Owned proxy has no close operation")
        const closing = close.then(() => { closeSettled = true })
        // close must await the active deletion, even with no HTTP requests.
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(closeSettled).toBe(false)
        expect(deletions).toBe(pauseAt)
        expect(resourceStates().filter(state => state === "deleting")).toHaveLength(1)
        release.release()
        await closing
        expect(sweeps).toBe(1)
        // The active deletion counts toward the 16 remaining at shutdown;
        // completed pre-drain deletions do not consume the drain allowance.
        expect(deletions).toBe(pauseAt - 1 + 16)
        expect(resourceStates().filter(state => state === "deleted")).toHaveLength(deletions)
        expect(resourceStates()).not.toContain("deleting")
      } finally {
        release.release()
        try {
          await instance?.close()
          await embedded?.closeBackend?.()
          await embeddedSweep
        } finally {
          try { await owner?.close() }
          finally { spy.mockRestore() }
        }
      }
    }, 60_000)
  }

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
