/**
 * The idle transcript sweep's decisions, with the Claude Code child replaced
 * by a stub that behaves like one: it writes `.last-cleanup` when its cleanup
 * finishes and exits only when aborted.
 *
 * What is pinned: which roots get a child at all (due, idle, retention on, a
 * login that cannot be refreshed during the child's life, a free SDK slot),
 * that a child is stopped as soon as the cleanup lands or after the timeout,
 * that roots are visited strictly one at a time, and that a stored login
 * changing under a child stops the sweep for good.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AbortableSemaphore } from "../proxy/concurrency"
import type { CredentialsFile } from "../proxy/tokenRefresh"
import {
  classifyStoredLogin,
  createTranscriptSweep,
  listSweepRoots,
  type IdleChildOutcome,
  type SweepRoot,
  type TranscriptSweepOptions,
} from "../proxy/transcriptSweep"
import { setSetting } from "../settings"

const HOUR = 3_600_000
const DAY = 24 * HOUR

function login(expiresInMs: number, overrides: Partial<CredentialsFile["claudeAiOauth"]> = {}): CredentialsFile {
  return {
    claudeAiOauth: {
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      expiresAt: Date.now() + expiresInMs,
      ...overrides,
    },
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

function touch(path: string, ageMs: number): void {
  writeFileSync(path, new Date().toISOString())
  const at = (Date.now() - ageMs) / 1000
  utimesSync(path, at, at)
}

describe("idle transcript sweep", () => {
  let dir: string
  const savedConfigDir = process.env.MERIDIAN_CONFIG_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-transcript-sweep-"))
    process.env.MERIDIAN_CONFIG_DIR = join(dir, "meridian")
    mkdirSync(process.env.MERIDIAN_CONFIG_DIR, { recursive: true })
  })

  afterEach(() => {
    process.env.MERIDIAN_CONFIG_DIR = savedConfigDir
    rmSync(dir, { recursive: true, force: true })
  })

  /** A config root last cleaned `ageMs` ago, or never. */
  function root(name: string, lastCleanupAgeMs?: number): SweepRoot {
    const configDir = join(dir, name)
    mkdirSync(configDir, { recursive: true })
    if (lastCleanupAgeMs !== undefined) touch(join(configDir, ".last-cleanup"), lastCleanupAgeMs)
    return { configDir, explicitConfigDir: true, profileIds: [name] }
  }

  interface ChildCall { readonly root: SweepRoot; readonly retentionDays: number; readonly signal: AbortSignal }

  /** Cleans after `cleanAfterMs` (never when null) and exits when aborted. */
  function stubChild(calls: ChildCall[], cleanAfterMs: number | null = 10) {
    return (root: SweepRoot, retentionDays: number, signal: AbortSignal): Promise<IdleChildOutcome> => {
      calls.push({ root, retentionDays, signal })
      if (cleanAfterMs !== null) {
        setTimeout(() => {
          if (existsSync(root.configDir)) touch(join(root.configDir, ".last-cleanup"), 0)
        }, cleanAfterMs)
      }
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ refusedConnections: 3 }), { once: true })
      })
    }
  }

  function sweepWith(roots: SweepRoot[], overrides: Partial<TranscriptSweepOptions> = {}) {
    const calls: ChildCall[] = []
    const log: string[] = []
    const storedLogin = login(6 * HOUR)
    const sweep = createTranscriptSweep({
      listRoots: () => roots,
      isRootBusy: () => false,
      isDraining: () => false,
      credentialsReadOnly: () => false,
      tryAcquireSlot: () => ({ release: () => undefined }),
      readCredentials: async () => storedLogin,
      runChild: stubChild(calls),
      log: (line) => log.push(line),
      pollMs: 5,
      childTimeoutMs: 2_000,
      ...overrides,
    })
    return { sweep, calls, log }
  }

  it("cleans a due idle root and stops its child as soon as .last-cleanup advances", async () => {
    const due = root("due", 2 * DAY)
    const { sweep, calls, log } = sweepWith([due])
    const [result] = await sweep.runPass()
    expect(result?.outcome).toMatchObject({ kind: "swept", refusedConnections: 3 })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.retentionDays).toBe(30)
    expect(calls[0]?.signal.aborted).toBe(true)
    expect(log.join("\n")).toContain("due cleaned in")
  })

  it("treats a root Claude Code never cleaned as due", async () => {
    const { sweep, calls } = sweepWith([root("never")])
    expect((await sweep.runPass())[0]?.outcome.kind).toBe("swept")
    expect(calls).toHaveLength(1)
  })

  it("leaves a root cleaned within the last day alone", async () => {
    const { sweep, calls } = sweepWith([root("recent", 23 * HOUR)])
    expect((await sweep.runPass())[0]?.outcome).toEqual({ kind: "skipped", reason: "fresh" })
    expect(calls).toHaveLength(0)
  })

  it("stops a child that never finishes its cleanup once the timeout passes", async () => {
    const calls: ChildCall[] = []
    const { sweep } = sweepWith([root("stuck", 2 * DAY)], { runChild: stubChild(calls, null), childTimeoutMs: 60 })
    const [result] = await sweep.runPass()
    expect(result?.outcome.kind).toBe("timed-out")
    expect(calls[0]?.signal.aborted).toBe(true)
  })

  it("reports a child that exits before its cleanup ran", async () => {
    const { sweep } = sweepWith([root("crashing", 2 * DAY)], {
      runChild: async () => ({ refusedConnections: 0, error: "Claude Code process exited with code 1" }),
    })
    expect((await sweep.runPass())[0]?.outcome).toMatchObject({ kind: "failed", error: "Claude Code process exited with code 1" })
  })

  it("never starts a child beside a request running in the same root", async () => {
    const busy = root("busy", 2 * DAY)
    const idle = root("idle", 2 * DAY)
    const { sweep, calls } = sweepWith([busy, idle], { isRootBusy: (configDir) => configDir === busy.configDir })
    const results = await sweep.runPass()
    expect(results.map((result) => result.outcome.kind === "skipped" ? result.outcome.reason : result.outcome.kind))
      .toEqual(["busy", "swept"])
    expect(calls.map((call) => call.root.profileIds[0])).toEqual(["idle"])
  })

  it("starts nothing while Meridian drains", async () => {
    const { sweep, calls } = sweepWith([root("draining", 2 * DAY)], { isDraining: () => true })
    expect((await sweep.runPass())[0]?.outcome).toEqual({ kind: "skipped", reason: "draining" })
    expect(calls).toHaveLength(0)
  })

  it("starts nothing when retention is off, or a root's own settings make it pass no period", async () => {
    const own = root("own-settings", 2 * DAY)
    writeFileSync(join(own.configDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 0 }))
    const plain = root("plain", 2 * DAY)

    const { sweep, calls } = sweepWith([own, plain])
    const results = await sweep.runPass()
    expect(results[0]?.outcome).toEqual({ kind: "skipped", reason: "off" })
    expect(results[1]?.outcome.kind).toBe("swept")

    setSetting("transcriptRetentionDays", 0)
    const again = sweepWith([root("plain-again", 2 * DAY)])
    expect((await again.sweep.runPass())[0]?.outcome).toEqual({ kind: "skipped", reason: "off" })
    expect(calls).toHaveLength(1)
    expect(again.calls).toHaveLength(0)
  })

  it("hands the child the period a root's own settings.json names", async () => {
    const own = root("own-period", 2 * DAY)
    writeFileSync(join(own.configDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 90 }))
    const { sweep, calls } = sweepWith([own])
    await sweep.runPass()
    expect(calls[0]?.retentionDays).toBe(90)
  })

  it("visits roots strictly one at a time", async () => {
    const roots = [root("one", 2 * DAY), root("two", 2 * DAY), root("three")]
    let active = 0
    let maxActive = 0
    const calls: ChildCall[] = []
    const child = stubChild(calls, 15)
    const { sweep } = sweepWith(roots, {
      runChild: async (sweepRoot, days, signal) => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
          return await child(sweepRoot, days, signal)
        } finally {
          active--
        }
      },
    })
    const results = await sweep.runPass()
    expect(results.map((result) => result.outcome.kind)).toEqual(["swept", "swept", "swept"])
    expect(calls.map((call) => call.root.profileIds[0])).toEqual(["one", "two", "three"])
    expect(maxActive).toBe(1)
  })

  it("joins a pass that is already running instead of starting a second", async () => {
    const calls: ChildCall[] = []
    const { sweep } = sweepWith([root("shared", 2 * DAY)], { runChild: stubChild(calls, 20) })
    const [first, second] = await Promise.all([sweep.runPass(), sweep.runPass()])
    expect(second).toBe(first)
    expect(calls).toHaveLength(1)
  })

  describe("the stored login", () => {
    async function outcomeFor(credentials: CredentialsFile | null | Error) {
      const { sweep, calls } = sweepWith([root("login", 2 * DAY)], {
        readCredentials: async () => {
          if (credentials instanceof Error) throw credentials
          return credentials
        },
      })
      const [result] = await sweep.runPass()
      return { outcome: result?.outcome, started: calls.length }
    }

    it("skips a root whose access token Claude Code would refresh while the child runs", async () => {
      for (const credentials of [
        login(10 * 60_000),
        login(-HOUR),
        login(6 * HOUR, { accessToken: "" }),
        { claudeAiOauth: { accessToken: "a", refreshToken: "r" } } as unknown as CredentialsFile,
      ]) {
        expect(await outcomeFor(credentials)).toEqual({ outcome: { kind: "skipped", reason: "refresh-due" }, started: 0 })
      }
    })

    it("cleans a root whose login is dead, since there is nothing left to refresh", async () => {
      const dead = login(-DAY, { accessToken: "", refreshToken: "", expiresAt: 0 })
      expect(await outcomeFor(dead)).toMatchObject({ outcome: { kind: "swept" }, started: 1 })
    })

    it("skips a root whose login cannot be read", async () => {
      expect(await outcomeFor(null)).toEqual({ outcome: { kind: "skipped", reason: "login-unreadable" }, started: 0 })
      expect(await outcomeFor(new Error("keychain refused"))).toEqual({ outcome: { kind: "skipped", reason: "login-unreadable" }, started: 0 })
    })

    it("stops the sweep for good when a stored login changes while a child runs", async () => {
      let reads = 0
      const first = root("rotated", 2 * DAY)
      const second = root("untouched", 2 * DAY)
      const { sweep, calls, log } = sweepWith([first, second], {
        readCredentials: async () => (reads++ === 0 ? login(6 * HOUR) : login(8 * HOUR)),
      })
      const results = await sweep.runPass()
      expect(results).toHaveLength(1)
      expect(results[0]?.outcome.kind).toBe("login-changed")
      expect(sweep.disabled).toBe(true)
      expect(log.join("\n")).toContain("transcript sweep STOPPED")
      expect(await sweep.runPass()).toEqual([])
      expect(calls).toHaveLength(1)
    })

    it("keeps sweeping when the same login is merely rewritten while a child runs", async () => {
      const stored = login(6 * HOUR)
      let reads = 0
      const { sweep, calls } = sweepWith([root("rewritten", 2 * DAY), root("next", 2 * DAY)], {
        readCredentials: async () => (reads++ === 0
          ? stored
          : { ...stored, claudeAiOauth: { ...stored.claudeAiOauth, subscriptionType: "max" } }),
      })
      const results = await sweep.runPass()
      expect(results.map((result) => result.outcome.kind)).toEqual(["swept", "swept"])
      expect(sweep.disabled).toBe(false)
      expect(calls).toHaveLength(2)
    })

    it("classifies a login by what Claude Code could still refresh", () => {
      const now = Date.now()
      expect(classifyStoredLogin(undefined, now)).toBe("unreadable")
      expect(classifyStoredLogin({} as CredentialsFile, now)).toBe("no-login")
      expect(classifyStoredLogin(login(HOUR), now)).toBe("valid")
      expect(classifyStoredLogin(login(29 * 60_000), now)).toBe("refresh-due")
    })
  })

  it("never starts a child under MERIDIAN_CREDENTIALS_READONLY", async () => {
    const { sweep, calls, log } = sweepWith([root("shared-login", 2 * DAY)], { credentialsReadOnly: () => true, initialDelayMs: 1 })
    expect(await sweep.runPass()).toEqual([])
    sweep.start()
    await Bun.sleep(30)
    expect(calls).toHaveLength(0)
    expect(log.join("\n")).toContain("MERIDIAN_CREDENTIALS_READONLY")
    await sweep.stop()
  })

  it("takes only a free SDK slot, never queues for one, and gives it back", async () => {
    const semaphore = new AbortableSemaphore(1)
    const held = await semaphore.acquire()
    const { sweep, calls } = sweepWith([root("crowded", 2 * DAY)], { tryAcquireSlot: () => semaphore.tryAcquire() })
    expect((await sweep.runPass())[0]?.outcome).toEqual({ kind: "skipped", reason: "no-slot" })
    expect(semaphore.snapshot).toEqual({ active: 1, queued: 0, limit: 1 })
    held.release()
    expect((await sweep.runPass())[0]?.outcome.kind).toBe("swept")
    expect(calls).toHaveLength(1)
    expect(semaphore.snapshot).toEqual({ active: 0, queued: 0, limit: 1 })
  })

  it("runs a pass after the initial delay and again every interval, and stop() ends a running child", async () => {
    let listed = 0
    const calls: ChildCall[] = []
    const { sweep } = sweepWith([], {
      listRoots: () => {
        listed++
        return listed === 3 ? [root("late", 2 * DAY)] : []
      },
      runChild: stubChild(calls, null),
      initialDelayMs: 5,
      intervalMs: 30,
      childTimeoutMs: 60_000,
    })
    sweep.start()
    expect(listed).toBe(0)
    await waitFor(() => calls.length === 1)
    // A pass still running is joined, never doubled, while its child lives.
    await Bun.sleep(100)
    expect(listed).toBe(3)
    expect(calls[0]?.signal.aborted).toBe(false)
    await sweep.stop()
    expect(calls[0]?.signal.aborted).toBe(true)
    await Bun.sleep(100)
    expect(listed).toBe(3)
  })

  it("does not start at all when the interval is 0", async () => {
    let listed = 0
    const { sweep } = sweepWith([], { listRoots: () => { listed++; return [] }, initialDelayMs: 1, intervalMs: 0 })
    sweep.start()
    await Bun.sleep(20)
    expect(listed).toBe(0)
    await sweep.stop()
  })
})

describe("listSweepRoots", () => {
  it("names each config root once, with every profile served from it", () => {
    const roots = listSweepRoots([
      { id: "a", type: "claude-max", env: { CLAUDE_CONFIG_DIR: "/profiles/a" } },
      { id: "a-alias", type: "claude-max", env: { CLAUDE_CONFIG_DIR: "/profiles/a" } },
      { id: "b", type: "claude-max", env: { CLAUDE_CONFIG_DIR: "/profiles/b" } },
      { id: "api", type: "api", env: { ANTHROPIC_API_KEY: "unused" } },
    ], { HOME: "/home/test" })
    expect(roots).toEqual([
      { configDir: "/profiles/a", explicitConfigDir: true, profileIds: ["a", "a-alias"] },
      { configDir: "/profiles/b", explicitConfigDir: true, profileIds: ["b"] },
      { configDir: "/home/test/.claude", explicitConfigDir: false, profileIds: ["api"] },
    ])
  })

  it("uses the process's own CLAUDE_CONFIG_DIR where a profile names none", () => {
    expect(listSweepRoots([{ id: "default", type: "claude-max", env: {} }], { HOME: "/home/test", CLAUDE_CONFIG_DIR: "/srv/claude" }))
      .toEqual([{ configDir: "/srv/claude", explicitConfigDir: true, profileIds: ["default"] }])
  })
})
