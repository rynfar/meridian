/**
 * The idle transcript sweep's decisions, with the Claude Code child replaced
 * by a stub that behaves like one: it writes `.last-cleanup` when its cleanup
 * finishes and exits only when stopped, optionally some time after.
 *
 * What is pinned: which roots get a child at all (due, idle, retention on, a
 * login that cannot be refreshed during the child's life, a free SDK slot);
 * process custody (the slot is held, and stop() waits, until the child has
 * exited, however late); the root reservation in both race orders with a
 * request; how a stored login changing under a child is read; and that the
 * transcripts Meridian still needs survive the cleanup.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AbortableSemaphore } from "../proxy/concurrency"
import type { TranscriptLocator } from "../proxy/session/bookkeeping/locator"
import type { CredentialsFile } from "../proxy/tokenRefresh"
import {
  classifyLoginChange,
  classifyStoredLogin,
  createTranscriptSweep,
  listSweepRoots,
  protectPinnedTranscripts,
  type IdleChildOutcome,
  type RootReservation,
  type SweepRoot,
  type SweepSlot,
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
  age(path, ageMs)
}

function age(path: string, ageMs: number): void {
  const at = (Date.now() - ageMs) / 1000
  utimesSync(path, at, at)
}

/** A reservation the test can preempt, recording when it was released. */
function reservation() {
  const preempt = new AbortController()
  const state = { released: false, preempt }
  const handle: RootReservation = {
    preempted: preempt.signal,
    release: () => { state.released = true },
  }
  return { handle, state }
}

describe("idle transcript sweep", () => {
  let dir: string
  const savedConfigDir = process.env.MERIDIAN_CONFIG_DIR

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "meridian-transcript-sweep-"))
    process.env.MERIDIAN_CONFIG_DIR = join(dir, "meridian")
    mkdirSync(process.env.MERIDIAN_CONFIG_DIR, { recursive: true })
    // Retention is opt-in; the sweep only runs where it is on.
    setSetting("transcriptRetentionDays", 30)
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

  interface ChildCall {
    readonly root: SweepRoot
    readonly retentionDays: number
    readonly signal: AbortSignal
    exited: boolean
  }

  /**
   * Cleans after `cleanAfterMs` (never when null) and exits `exitDelayMs`
   * after it is stopped. Like the proxy's runner, it releases the slot only
   * once it has exited.
   */
  function stubChild(calls: ChildCall[], cleanAfterMs: number | null = 10, exitDelayMs = 0) {
    return (root: SweepRoot, retentionDays: number, slot: SweepSlot, signal: AbortSignal): Promise<IdleChildOutcome> => {
      const call: ChildCall = { root, retentionDays, signal, exited: false }
      calls.push(call)
      if (cleanAfterMs !== null) {
        setTimeout(() => {
          if (existsSync(root.configDir)) touch(join(root.configDir, ".last-cleanup"), 0)
        }, cleanAfterMs)
      }
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          setTimeout(() => {
            call.exited = true
            slot.release()
            resolve({ refusedConnections: 3 })
          }, exitDelayMs)
        }, { once: true })
      })
    }
  }

  function sweepWith(roots: SweepRoot[], overrides: Partial<TranscriptSweepOptions> = {}) {
    const calls: ChildCall[] = []
    const log: string[] = []
    const storedLogin = login(6 * HOUR)
    const sweep = createTranscriptSweep({
      listRoots: () => roots,
      reserveRoot: () => reservation().handle,
      isDraining: () => false,
      credentialsReadOnly: () => false,
      tryAcquireSlot: () => ({ release: () => undefined }),
      readCredentials: async () => storedLogin,
      pinnedTranscripts: () => [],
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
    const child = stubChild(calls, 15, 10)
    const { sweep } = sweepWith(roots, {
      runChild: async (sweepRoot, days, slot, signal) => {
        active++
        maxActive = Math.max(maxActive, active)
        try {
          return await child(sweepRoot, days, slot, signal)
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

  describe("process custody", () => {
    it("holds the SDK slot until the child has exited, however long it ignores its stop", async () => {
      const semaphore = new AbortableSemaphore(2)
      const calls: ChildCall[] = []
      let releases = 0
      let releasedWhileAlive = false
      const { sweep } = sweepWith([root("slow-exit", 2 * DAY)], {
        runChild: stubChild(calls, 10, 300),
        tryAcquireSlot: () => {
          const lease = semaphore.tryAcquire(1)
          return lease && {
            release: () => {
              releases++
              if (calls.some((call) => !call.exited)) releasedWhileAlive = true
              lease.release()
            },
          }
        },
      })
      const pass = sweep.runPass()
      await waitFor(() => calls[0]?.signal.aborted === true)
      // Stopped but not yet exited: the slot is still the child's.
      await Bun.sleep(150)
      expect(calls[0]?.exited).toBe(false)
      expect(semaphore.snapshot.active).toBe(1)
      expect((await pass)[0]?.outcome.kind).toBe("swept")
      expect(calls[0]?.exited).toBe(true)
      expect(releasedWhileAlive).toBe(false)
      // The runner and the sweep both release; the permit goes back once.
      expect(releases).toBe(1)
      expect(semaphore.snapshot).toEqual({ active: 0, queued: 0, limit: 2 })
    })

    it("stop() returns only once the running child has exited", async () => {
      const calls: ChildCall[] = []
      const { sweep } = sweepWith([root("stopping", 2 * DAY)], {
        runChild: stubChild(calls, null, 300),
        childTimeoutMs: 60_000,
      })
      const pass = sweep.runPass()
      await waitFor(() => calls.length === 1)
      await sweep.stop()
      expect(calls[0]?.signal.aborted).toBe(true)
      expect(calls[0]?.exited).toBe(true)
      expect((await pass)[0]?.outcome.kind).toBe("stopped")
    })

    it("takes only a free SDK slot that leaves one for a request, never queues, and gives it back", async () => {
      const semaphore = new AbortableSemaphore(2)
      const held = await semaphore.acquire()
      const { sweep, calls } = sweepWith([root("crowded", 2 * DAY)], { tryAcquireSlot: () => semaphore.tryAcquire(1) })
      expect((await sweep.runPass())[0]?.outcome).toEqual({ kind: "skipped", reason: "no-slot" })
      expect(semaphore.snapshot).toEqual({ active: 1, queued: 0, limit: 2 })
      held.release()
      expect((await sweep.runPass())[0]?.outcome.kind).toBe("swept")
      expect(calls).toHaveLength(1)
      expect(semaphore.snapshot).toEqual({ active: 0, queued: 0, limit: 2 })
    })
  })

  describe("the root reservation", () => {
    it("leaves a root alone, without reading its login, while a request runs there", async () => {
      const busy = root("busy", 2 * DAY)
      const idle = root("idle", 2 * DAY)
      const read: string[] = []
      const { sweep, calls } = sweepWith([busy, idle], {
        reserveRoot: (configDir) => configDir === busy.configDir ? undefined : reservation().handle,
        readCredentials: async (sweepRoot) => {
          read.push(sweepRoot.profileIds[0]!)
          return login(6 * HOUR)
        },
      })
      const results = await sweep.runPass()
      expect(results.map((result) => result.outcome.kind === "skipped" ? result.outcome.reason : result.outcome.kind))
        .toEqual(["busy", "swept"])
      expect(calls.map((call) => call.root.profileIds[0])).toEqual(["idle"])
      expect(read.filter((name) => name === "busy")).toHaveLength(0)
    })

    it("starts no child when a request arrives in the root while its login is read", async () => {
      const { handle, state } = reservation()
      const { sweep, calls } = sweepWith([root("racing", 2 * DAY)], {
        reserveRoot: () => handle,
        readCredentials: async () => {
          state.preempt.abort()
          return login(6 * HOUR)
        },
      })
      expect((await sweep.runPass())[0]?.outcome).toEqual({ kind: "skipped", reason: "busy" })
      expect(calls).toHaveLength(0)
      expect(state.released).toBe(true)
    })

    it("stops the child at once when a request arrives, and frees the root only after it exited", async () => {
      const { handle, state } = reservation()
      const calls: ChildCall[] = []
      let releasedWhileAlive = false
      const { sweep, log } = sweepWith([root("preempted", 2 * DAY)], {
        reserveRoot: () => ({
          preempted: handle.preempted,
          release: () => {
            if (calls.some((call) => !call.exited)) releasedWhileAlive = true
            handle.release()
          },
        }),
        runChild: stubChild(calls, null, 100),
        childTimeoutMs: 60_000,
      })
      const pass = sweep.runPass()
      await waitFor(() => calls.length === 1)
      state.preempt.abort()
      const [result] = await pass
      expect(result?.outcome.kind).toBe("preempted")
      expect(calls[0]?.signal.aborted).toBe(true)
      expect(state.released).toBe(true)
      expect(releasedWhileAlive).toBe(false)
      expect(sweep.disabled).toBe(false)
      expect(log.join("\n")).toContain("a request arrived there")
    })
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

    it("keeps sweeping when the login was renewed elsewhere while a child ran", async () => {
      let reads = 0
      const { sweep, calls, log } = sweepWith([root("renewed", 2 * DAY), root("next", 2 * DAY)], {
        // A refresh or sign-in elsewhere: new tokens, a later expiry.
        readCredentials: async () => (reads++ === 0
          ? login(6 * HOUR)
          : login(8 * HOUR, { accessToken: "renewed-access", refreshToken: "renewed-refresh" })),
      })
      const results = await sweep.runPass()
      expect(results.map((result) => result.outcome.kind)).toEqual(["swept", "swept"])
      expect(sweep.disabled).toBe(false)
      expect(calls).toHaveLength(2)
      expect(log.join("\n")).toContain("renewed elsewhere")
    })

    it("stops the sweep for good when a stored login changes in a way no renewal explains", async () => {
      let reads = 0
      const first = root("rotated", 2 * DAY)
      const second = root("untouched", 2 * DAY)
      const { sweep, calls, log } = sweepWith([first, second], {
        readCredentials: async () => (reads++ === 0 ? login(6 * HOUR) : login(2 * HOUR, { accessToken: "other" })),
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

    it("reads a change as a renewal only when the login is usable and no older afterwards", () => {
      const now = Date.now()
      const before = login(6 * HOUR)
      expect(classifyLoginChange(before, { ...before }, now)).toBe("none")
      expect(classifyLoginChange(before, login(8 * HOUR, { accessToken: "new" }), now)).toBe("renewed-elsewhere")
      expect(classifyLoginChange(before, login(2 * HOUR, { accessToken: "new" }), now)).toBe("unexplained")
      expect(classifyLoginChange(before, login(-HOUR, { accessToken: "new" }), now)).toBe("unexplained")
      expect(classifyLoginChange(before, null, now)).toBe("unexplained")
      expect(classifyLoginChange(before, undefined, now)).toBe("unexplained")
    })
  })

  describe("transcripts Meridian still needs", () => {
    /** projects/<project>/<id>.jsonl plus a sidecar file, `ageDays` old. */
    function transcript(configDir: string, id: string, ageDays: number): { file: string; sidecar: string } {
      const project = join(configDir, "projects", "-work-repo")
      mkdirSync(join(project, id, "subagents"), { recursive: true })
      const file = join(project, `${id}.jsonl`)
      const sidecar = join(project, id, "subagents", "agent-1.jsonl")
      touch(file, ageDays * DAY)
      touch(sidecar, ageDays * DAY)
      return { file, sidecar }
    }

    /** What Claude Code's cleanup does: delete transcripts older than the period, by mtime alone. */
    function cleanup(configDir: string, retentionDays: number): void {
      const projects = join(configDir, "projects")
      for (const project of readdirSync(projects)) {
        for (const name of readdirSync(join(projects, project))) {
          const path = join(projects, project, name)
          if (name.endsWith(".jsonl") && Date.now() - statSync(path).mtimeMs > retentionDays * DAY) unlinkSync(path)
        }
      }
    }

    it("keeps a pinned transcript the cleanup would have deleted, and deletes the rest", async () => {
      const sweepRoot = root("pinned", 2 * DAY)
      const pinned = transcript(sweepRoot.configDir, "pinned-session", 40)
      const loose = transcript(sweepRoot.configDir, "loose-session", 40)
      const elsewhere: TranscriptLocator = { sessionId: "loose-session", configDir: join(dir, "another-root") }
      const { sweep } = sweepWith([sweepRoot], {
        pinnedTranscripts: () => [{ sessionId: "pinned-session", configDir: sweepRoot.configDir }, elsewhere],
        runChild: async (child, days, slot) => {
          cleanup(child.configDir, days)
          touch(join(child.configDir, ".last-cleanup"), 0)
          slot.release()
          return { refusedConnections: 0 }
        },
      })
      const [result] = await sweep.runPass()
      expect(result?.outcome).toMatchObject({ kind: "swept", pinsProtected: 1 })
      expect(existsSync(pinned.file)).toBe(true)
      expect(existsSync(pinned.sidecar)).toBe(true)
      expect(Date.now() - statSync(pinned.sidecar).mtimeMs).toBeLessThan(HOUR)
      expect(existsSync(loose.file)).toBe(false)
    })

    it("refreshes only pinned transcripts the next cleanup could reach", async () => {
      const configDir = root("reach").configDir
      const young = transcript(configDir, "young", 10)
      const close = transcript(configDir, "close", 29.5)
      const youngMtime = statSync(young.file).mtimeMs
      const pins = ["young", "close"].map((sessionId) => ({ sessionId, configDir }))
      expect(await protectPinnedTranscripts(configDir, pins, 30)).toBe(1)
      expect(statSync(young.file).mtimeMs).toBe(youngMtime)
      expect(Date.now() - statSync(close.file).mtimeMs).toBeLessThan(HOUR)
      // A short period leaves no margin: half of it counts as reachable.
      expect(await protectPinnedTranscripts(configDir, pins, 2)).toBe(1)
      expect(await protectPinnedTranscripts(configDir, pins, 0)).toBe(0)
      expect(await protectPinnedTranscripts(join(dir, "missing"), pins, 30)).toBe(0)
    })

    it("keeps a transcript pinned under a symlink to the root", async () => {
      const configDir = root("linked").configDir
      const pinned = transcript(configDir, "linked-session", 40)
      const alias = join(dir, "linked-alias")
      symlinkSync(configDir, alias)
      expect(await protectPinnedTranscripts(configDir, [{ sessionId: "linked-session", configDir: alias }], 30)).toBe(1)
      expect(Date.now() - statSync(pinned.file).mtimeMs).toBeLessThan(HOUR)
    })

    it.skipIf(process.getuid?.() === 0)("runs no cleanup when a pinned transcript cannot be refreshed", async () => {
      const sweepRoot = root("unreadable-pin", 2 * DAY)
      transcript(sweepRoot.configDir, "stuck-session", 40)
      const sidecarDir = join(sweepRoot.configDir, "projects", "-work-repo", "stuck-session")
      chmodSync(sidecarDir, 0o000)
      let started = false
      try {
        const { sweep } = sweepWith([sweepRoot], {
          pinnedTranscripts: () => [{ sessionId: "stuck-session", configDir: sweepRoot.configDir }],
          runChild: async (_child, _days, slot) => {
            started = true
            slot.release()
            return { refusedConnections: 0 }
          },
        })
        const [result] = await sweep.runPass()
        expect(result?.outcome).toMatchObject({ kind: "failed" })
        expect(result?.outcome.kind === "failed" ? result.outcome.error : "").toContain("pins not protected")
        expect(started).toBe(false)
      } finally {
        chmodSync(sidecarDir, 0o755)
      }
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
    expect(calls[0]?.exited).toBe(true)
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

  it("names a directory reached through a symlink once", () => {
    const base = mkdtempSync(join(tmpdir(), "meridian-sweep-roots-"))
    try {
      mkdirSync(join(base, "real"))
      symlinkSync(join(base, "real"), join(base, "alias"))
      const roots = listSweepRoots([
        { id: "a", type: "claude-max", env: { CLAUDE_CONFIG_DIR: join(base, "real") } },
        { id: "b", type: "claude-max", env: { CLAUDE_CONFIG_DIR: join(base, "alias") } },
      ], { HOME: "/home/test" })
      expect(roots).toEqual([{ configDir: join(base, "real"), explicitConfigDir: true, profileIds: ["a", "b"] }])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it("uses the process's own CLAUDE_CONFIG_DIR where a profile names none", () => {
    expect(listSweepRoots([{ id: "default", type: "claude-max", env: {} }], { HOME: "/home/test", CLAUDE_CONFIG_DIR: "/srv/claude" }))
      .toEqual([{ configDir: "/srv/claude", explicitConfigDir: true, profileIds: ["default"] }])
  })
})
