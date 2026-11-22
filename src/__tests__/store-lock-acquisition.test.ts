import { expect, it, spyOn } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import * as processIdentity from "../proxy/session/processIncarnation"
import { barrierBytes } from "../proxy/session/bookkeeping/maintenanceJournal"
import { SessionStoreLockTimeoutError } from "../proxy/session/storeErrors"
import { withLegacyStoreMaintenanceLock } from "../proxy/sessionStore"

function observeCandidates(lockPath: string, onOccupiedSync?: () => void) {
  const nativeOpen = fs.openSync
  const nativeSync = fs.fsyncSync
  const candidateFds = new Set<number>()
  let opened = 0
  let synced = 0
  let occupiedSyncs = 0
  const openSpy = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    const fd = nativeOpen(path, flags, mode)
    if (typeof path === "string" && path.startsWith(`${lockPath}.candidate-`)) {
      candidateFds.add(fd)
      opened++
    } else candidateFds.delete(fd)
    return fd
  })
  const syncSpy = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    nativeSync(fd)
    if (!candidateFds.delete(fd)) return
    synced++
    if (fs.existsSync(lockPath)) {
      occupiedSyncs++
      onOccupiedSync?.()
    }
  })
  return {
    counts: () => ({ opened, synced, occupiedSyncs }),
    restore: () => { syncSpy.mockRestore(); openSpy.mockRestore() },
  }
}

it("recovers a real dead owner before paying an occupied candidate's durable-write cost", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "meridian-store-lock-cost-"))
  const lockPath = join(directory, "sessions.json.lock")
  try {
    const child = spawnSync(process.execPath, ["-e", `
      import { withLegacyStoreMaintenanceLock } from ${JSON.stringify(join(import.meta.dir, "../proxy/sessionStore.ts"))}
      withLegacyStoreMaintenanceLock(${JSON.stringify(directory)}, () => process.kill(process.pid, "SIGKILL"))
    `], { encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL" })
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.status).toBeNull()
    expect(child.signal).toBe("SIGKILL")
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"))
    const incarnation = processIdentity.parseProcessIncarnation(owner.incarnation)
    expect(incarnation?.pid).toBe(child.pid)
    if (!incarnation) throw new Error("child lock has no process incarnation")
    expect(processIdentity.probeProcessIncarnation(incarnation)).toBe("dead")
    const oldTime = (Date.now() - 1_000) / 1000
    fs.utimesSync(lockPath, oldTime, oldTime)

    // Charge only a real fsync of a contender while the dead owner's lock is
    // present. No sleep or universal death stub can make this regression pass.
    let clock = 0
    const nowSpy = spyOn(performance, "now").mockImplementation(() => clock)
    const candidates = observeCandidates(lockPath, () => { clock += 101 })
    const nativeIsDead = processIdentity.processIncarnationIsDead
    const deadProbes: Array<{ pid: number; dead: boolean }> = []
    const deadSpy = spyOn(processIdentity, "processIncarnationIsDead").mockImplementation(identity => {
      const dead = nativeIsDead(identity)
      deadProbes.push({ pid: identity.pid, dead })
      return dead
    })
    let failure: unknown
    let entered = false
    try {
      try {
        withLegacyStoreMaintenanceLock(directory, () => {
          entered = true
          expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid).toBe(process.pid)
          expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600)
        })
      } catch (error) { failure = error }
      expect(candidates.counts()).toEqual({ opened: 1, synced: 1, occupiedSyncs: 0 })
      expect(deadProbes).toEqual([{ pid: child.pid, dead: true }, { pid: child.pid, dead: true }])
      expect(failure).toBeUndefined()
      expect(entered).toBe(true)
      expect(clock).toBe(0)
      expect(fs.readdirSync(directory)).toEqual([])
    } finally {
      deadSpy.mockRestore()
      candidates.restore()
      nowSpy.mockRestore()
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}, 25_000)

it.each(["live", "empty", "malformed", "barrier"])("keeps an occupied %s lock without staging a contender", kind => {
  const directory = fs.mkdtempSync(join(tmpdir(), "meridian-store-lock-occupied-"))
  const lockPath = join(directory, "sessions.json.lock")
  const incarnation = processIdentity.captureProcessIncarnation()
  if (!incarnation) throw new Error("test process incarnation unavailable")
  const contents = kind === "live"
    ? JSON.stringify({ pid: process.pid, hostname: hostname(), token: "live-owner", incarnation })
    : kind === "barrier" ? barrierBytes("11111111-1111-4111-8111-111111111111")
    : kind === "empty" ? "" : "{invalid-json"
  fs.writeFileSync(lockPath, contents, { mode: 0o600 })
  const oldTime = (Date.now() - 1_000) / 1000
  fs.utimesSync(lockPath, oldTime, oldTime)
  const nowSpy = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(100)
  const candidates = observeCandidates(lockPath)
  const deadSpy = spyOn(processIdentity, "processIncarnationIsDead")
  let entered = false
  try {
    expect(() => withLegacyStoreMaintenanceLock(directory, () => { entered = true }))
      .toThrow(SessionStoreLockTimeoutError)
    expect(entered).toBe(false)
    expect(fs.readFileSync(lockPath, "utf8")).toBe(contents)
    expect(candidates.counts()).toEqual({ opened: 0, synced: 0, occupiedSyncs: 0 })
    expect(deadSpy).toHaveBeenCalledTimes(kind === "live" ? 1 : 0)
    expect(fs.readdirSync(directory)).toEqual(["sessions.json.lock"])
  } finally {
    deadSpy.mockRestore()
    candidates.restore()
    nowSpy.mockRestore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === "win32")("treats a dangling symlink as occupied", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "meridian-store-lock-symlink-"))
  const lockPath = join(directory, "sessions.json.lock")
  fs.symlinkSync("missing-owner", lockPath)
  const nowSpy = spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(100)
  const candidates = observeCandidates(lockPath)
  try {
    expect(() => withLegacyStoreMaintenanceLock(directory, () => "never entered"))
      .toThrow(SessionStoreLockTimeoutError)
    expect(fs.lstatSync(lockPath).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(lockPath)).toBe("missing-owner")
    expect(candidates.counts()).toEqual({ opened: 0, synced: 0, occupiedSyncs: 0 })
  } finally {
    candidates.restore()
    nowSpy.mockRestore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it("refuses an owner arriving after the occupancy check through atomic EEXIST", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "meridian-store-lock-race-"))
  const lockPath = join(directory, "sessions.json.lock")
  const contents = barrierBytes("11111111-1111-4111-8111-111111111111")
  let clock = 0
  let entered = false
  let collisions = 0
  const nowSpy = spyOn(performance, "now").mockImplementation(() => clock)
  const candidates = observeCandidates(lockPath)
  const nativeLink = fs.linkSync
  const linkSpy = spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (destination === lockPath) {
      fs.writeFileSync(lockPath, contents, { flag: "wx", mode: 0o600 })
      clock = 100
      try { return nativeLink(source, destination) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") collisions++
        throw error
      }
    }
    return nativeLink(source, destination)
  })
  try {
    expect(() => withLegacyStoreMaintenanceLock(directory, () => { entered = true }))
      .toThrow(SessionStoreLockTimeoutError)
    expect(entered).toBe(false)
    expect(collisions).toBe(1)
    expect(fs.readFileSync(lockPath, "utf8")).toBe(contents)
    expect(candidates.counts()).toEqual({ opened: 1, synced: 1, occupiedSyncs: 0 })
    expect(fs.readdirSync(directory)).toEqual(["sessions.json.lock"])
  } finally {
    linkSpy.mockRestore()
    candidates.restore()
    nowSpy.mockRestore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

it("propagates non-ENOENT occupancy inspection errors without staging", () => {
  const directory = fs.mkdtempSync(join(tmpdir(), "meridian-store-lock-stat-"))
  const lockPath = join(directory, "sessions.json.lock")
  const denied = Object.assign(new Error("occupancy inspection denied"), { code: "EACCES" })
  processIdentity.captureProcessIncarnation()
  const candidates = observeCandidates(lockPath)
  const lstatSpy = spyOn(fs, "lstatSync").mockImplementationOnce(() => { throw denied })
  let failure: unknown
  try {
    try { withLegacyStoreMaintenanceLock(directory, () => "never entered") } catch (error) { failure = error }
    expect(failure).toHaveProperty("cause", denied)
    expect(lstatSpy).toHaveBeenCalledWith(lockPath)
    expect(candidates.counts()).toEqual({ opened: 0, synced: 0, occupiedSyncs: 0 })
  } finally {
    lstatSpy.mockRestore()
    candidates.restore()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
