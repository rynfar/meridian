import { describe, expect, it, spyOn } from "bun:test"
import * as childProcess from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  captureProcessIncarnation,
  captureProcessIncarnationAsync,
  evaluateProcessIncarnation,
  parseLinuxProcStatStartId,
  parseProcessIncarnation,
  parseProcessIncarnationJson,
  probeProcessIncarnation,
  processIncarnationPredatesBoot,
  runProcessProbeAsync,
  type LocalBootIdentity,
  type ProcessIncarnation,
} from "../proxy/session/processIncarnation"
import { onPlatform, stubProbeExecFile, type StubbedProbeCall } from "./processProbeStubs"

const hostId = "a".repeat(64)
const otherHostId = "b".repeat(64)
const bootId = "11111111-1111-4111-8111-111111111111"
const otherBootId = "22222222-2222-4222-8222-222222222222"

const linuxOwner: ProcessIncarnation = {
  version: 1,
  pid: 123,
  hostId,
  bootId,
  startId: "987654",
  startIdKind: "linux-proc-start-ticks",
}

const localBoot: LocalBootIdentity = { hostId, bootId }

describe("process incarnation protocol", () => {
  it("strictly parses complete versioned identities", () => {
    expect(parseProcessIncarnation(linuxOwner)).toEqual(linuxOwner)
    expect(parseProcessIncarnationJson(JSON.stringify(linuxOwner))).toEqual(linuxOwner)
    expect(parseProcessIncarnationJson("not json")).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, version: 2 })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, pid: 0 })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, hostId: "local" })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, bootId: "boot" })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, startId: "0" })).toBeUndefined()
    expect(parseProcessIncarnation({ ...linuxOwner, startIdKind: "unknown" })).toBeUndefined()
    expect(parseProcessIncarnation({
      ...linuxOwner,
      startId: "638602697690000000",
      startIdKind: "windows-start-ticks",
    })).toBeDefined()
  })

  it("fails closed when host identity or the probe is uncertain", () => {
    expect(evaluateProcessIncarnation(linuxOwner, undefined, { status: "missing" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, { hostId: otherHostId, bootId }, { status: "missing" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, undefined))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, { status: "indeterminate" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: "987654",
      startIdKind: "darwin-ps-lstart",
    })).toBe("indeterminate")
    expect(evaluateProcessIncarnation({ ...linuxOwner, hostId: "bad" }, localBoot, { status: "missing" }))
      .toBe("indeterminate")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: "malformed",
      startIdKind: "linux-proc-start-ticks",
    })).toBe("indeterminate")
  })

  it("proves death across a reboot, ESRCH, or exact Linux start mismatch", () => {
    expect(evaluateProcessIncarnation(
      linuxOwner,
      { hostId, bootId: otherBootId },
      { status: "indeterminate" },
    )).toBe("dead")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, { status: "missing" }))
      .toBe("dead")
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: "987655",
      startIdKind: "linux-proc-start-ticks",
    })).toBe("dead")
  })

  it("recognizes an exact Linux incarnation match", () => {
    expect(evaluateProcessIncarnation(linuxOwner, localBoot, {
      status: "found",
      startId: linuxOwner.startId,
      startIdKind: linuxOwner.startIdKind,
    })).toBe("alive")
  })

  it("keeps a same-second Darwin birth-time collision fail closed", () => {
    const darwinOwner: ProcessIncarnation = {
      ...linuxOwner,
      startId: "Wed Aug 26 11:49:29 2026",
      startIdKind: "darwin-ps-lstart",
    }
    expect(evaluateProcessIncarnation(darwinOwner, localBoot, {
      status: "found",
      startId: darwinOwner.startId,
      startIdKind: darwinOwner.startIdKind,
    })).toBe("indeterminate")
    expect(evaluateProcessIncarnation(darwinOwner, localBoot, {
      status: "found",
      startId: "Wed Aug 26 11:49:30 2026",
      startIdKind: darwinOwner.startIdKind,
    })).toBe("dead")
  })

  it("parses Linux proc stat field 22 after the final comm parenthesis", () => {
    const fieldsFromState = ["S", ...Array.from({ length: 18 }, () => "0"), "987654", "0"]
    const stat = `123 (worker ) with spaces) ${fieldsFromState.join(" ")}
`
    expect(parseLinuxProcStatStartId(stat, 123)).toBe("987654")
    expect(parseLinuxProcStatStartId(stat, 124)).toBeUndefined()
    expect(parseLinuxProcStatStartId("123 malformed", 123)).toBeUndefined()
  })

  it("captures and conservatively probes the current process on every supported platform", () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    const current = captureCurrentProcessIncarnation()
    expect(parseProcessIncarnation(current)).toEqual(current)
    expect(probeProcessIncarnation(current))
      .toBe(process.platform === "linux" ? "alive" : "indeterminate")
  }, 25_000) // Windows can run two cold PowerShell probes at up to 10s each.

  it("probes this process from its capture without spawning an observer", () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    const current = captureCurrentProcessIncarnation()
    // Another start behind this pid is an earlier process whose pid was reused.
    const earlier = {
      ...current,
      startId: current.startIdKind === "darwin-ps-lstart" ? "Mon Jan 01 00:00:00 2001" : "1",
    }
    const spawned = spyOn(childProcess, "spawnSync")
    try {
      expect(probeProcessIncarnation(current))
        .toBe(process.platform === "linux" ? "alive" : "indeterminate")
      expect(probeProcessIncarnation(earlier)).toBe("dead")
      expect(spawned).not.toHaveBeenCalled()
    } finally {
      spawned.mockRestore()
    }
  }, 25_000)

  it("recognizes an owner from an earlier boot of this host without a probe", () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    const current = captureCurrentProcessIncarnation()
    const spawned = spyOn(childProcess, "spawnSync")
    try {
      expect(processIncarnationPredatesBoot(current)).toBe(false)
      expect(processIncarnationPredatesBoot({ ...current, bootId: otherBootId })).toBe(true)
      // Another host's boots say nothing about this one.
      expect(processIncarnationPredatesBoot({ ...current, hostId: otherHostId, bootId: otherBootId }))
        .toBe(false)
      expect(spawned).not.toHaveBeenCalled()
    } finally {
      spawned.mockRestore()
    }
  }, 25_000)

  // The SDK gate captures each request's wrapper while other requests stream:
  // a synchronous probe held them all, and gave up after 2 s on a loaded host.
  it("captures another process's incarnation, as the synchronous capture does, without holding the event loop", async () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    captureCurrentProcessIncarnation()
    const child = childProcess.spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"])
    try {
      const synchronous = spyOn(childProcess, "spawnSync")
      let captured: ProcessIncarnation | undefined
      try {
        captured = await captureProcessIncarnationAsync(child.pid!)
        expect(synchronous).not.toHaveBeenCalled()
      } finally {
        synchronous.mockRestore()
      }
      expect(captured).toBeDefined()
      expect(captured).toEqual(captureProcessIncarnation(child.pid!))
    } finally {
      child.kill()
    }
  }, 25_000)

  it("captures nothing of a process that has exited", async () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    captureCurrentProcessIncarnation()
    const child = childProcess.spawn(process.execPath, ["-e", ""])
    await new Promise(resolve => child.once("exit", resolve))
    expect(await captureProcessIncarnationAsync(child.pid!)).toBeUndefined()
  }, 25_000)
})

describe("awaited process probe deadline", () => {
  it("answers a probe that exits with its status and output", async () => {
    const result = await runProcessProbeAsync(process.execPath, ["-e", "process.stdout.write('probed')"])
    expect(result).toEqual({ status: 0, stdout: "probed" })
  }, 25_000)

  // execFile's timeout only sends SIGTERM and then waits for the probe to exit.
  // A probe that ignores it held the request awaiting it with no end.
  it("answers a probe that ignores its timeout by the outer deadline, and kills it", async () => {
    // win32 terminates on timeout outright; a probe cannot ignore it there.
    if (process.platform === "win32") return
    const root = mkdtempSync(join(tmpdir(), "meridian-probe-deadline-"))
    try {
      const pidFile = join(root, "pid")
      const script = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`
        + "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"
      const started = performance.now()
      const result = await runProcessProbeAsync(process.execPath, ["-e", script], { timeoutMs: 200, deadlineMs: 1_500 })
      const elapsed = performance.now() - started
      expect(result).toEqual({ status: null })
      // Answered by the deadline, not by execFile's timeout.
      expect(elapsed).toBeGreaterThanOrEqual(1_400)
      expect(elapsed).toBeLessThan(10_000)
      const pid = Number(readFileSync(pidFile, "utf8"))
      expect(pid).toBeGreaterThan(0)
      expect(await waitUntilGone(pid, 5_000)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
})

// CI runs the unit suite on Linux, where capture reads /proc and no probe runs.
// These drive the darwin and win32 probes, which are child processes, with
// execFile stubbed so the probe answers only when the test says so.
describe("awaited capture through the darwin and win32 probes", () => {
  const darwinStart = "Mon Jan  5 03:04:05 2026"
  const windowsTicks = "638712345678901234"

  async function captureOn(
    platform: NodeJS.Platform,
    pid: number,
    respond: (call: StubbedProbeCall) => void,
  ): Promise<{ captured: ProcessIncarnation | undefined; call: StubbedProbeCall }> {
    const probe = stubProbeExecFile()
    const synchronous = spyOn(childProcess, "spawnSync")
    try {
      const outcome = await onPlatform(platform, async () => {
        let settled = false
        const pending = captureProcessIncarnationAsync(pid).finally(() => { settled = true })
        // Timers keep firing while the probe is outstanding.
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(settled).toBe(false)
        expect(probe.calls).toHaveLength(1)
        const call = probe.calls[0]!
        respond(call)
        return { captured: await pending, call }
      })
      expect(synchronous).not.toHaveBeenCalled()
      return outcome
    } finally {
      synchronous.mockRestore()
      probe.restore()
    }
  }

  it("captures with ps on darwin without holding the event loop", async () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    const host = captureCurrentProcessIncarnation()
    const pid = process.ppid
    const { captured, call } = await captureOn("darwin", pid, probe => probe.answer(0, `${darwinStart}\n`))
    expect(call.file).toBe("/bin/ps")
    expect(call.args).toEqual(["-p", String(pid), "-o", "lstart="])
    expect(call.options.env).toMatchObject({ LC_ALL: "C", LANG: "C", TZ: "UTC0" })
    expect(captured).toEqual({ ...host, pid, startId: darwinStart, startIdKind: "darwin-ps-lstart" })
  })

  it("captures nothing when ps on darwin fails", async () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    captureCurrentProcessIncarnation()
    const { captured } = await captureOn("darwin", process.ppid, probe => probe.answer(1, ""))
    expect(captured).toBeUndefined()
  })

  it("captures with PowerShell on win32 without holding the event loop", async () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    const host = captureCurrentProcessIncarnation()
    const pid = process.ppid
    const { captured, call } = await captureOn("win32", pid, probe => probe.answer(0, `${windowsTicks}\r\n`))
    expect(call.file).toBe("powershell.exe")
    expect(call.args.slice(0, -1)).toEqual([
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    ])
    expect(call.args.at(-1)).toContain(`Get-Process -Id ${pid} -ErrorAction Stop`)
    expect(call.options.windowsHide).toBe(true)
    expect(captured).toEqual({ ...host, pid, startId: windowsTicks, startIdKind: "windows-start-ticks" })
  })

  it("captures nothing when PowerShell on win32 finds no such process", async () => {
    if (!(["darwin", "linux", "win32"] as string[]).includes(process.platform)) return
    captureCurrentProcessIncarnation()
    const { captured } = await captureOn("win32", process.ppid, probe => probe.answer(3, ""))
    expect(captured).toBeUndefined()
  })
})

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

async function waitUntilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (!processExists(pid)) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return !processExists(pid)
}

function captureCurrentProcessIncarnation(): ProcessIncarnation {
  // Retried, mirroring what startProxyServer now does. On Linux the identity
  // is read from files and is deterministic, but darwin and win32 derive it
  // from a subprocess with a 10s budget. This test failed on Windows CI at
  // 10265ms — the probe expired and the module correctly FAILED CLOSED,
  // returning undefined, while this assertion demanded success (#917/#933).
  //
  // The strict assertion is kept deliberately: a capture that never succeeds
  // across three attempts is a real defect, and loosening this to "defined or
  // undefined" would assert nothing at all.
  let current = captureProcessIncarnation()
  for (let attempt = 0; current === undefined && attempt < 2; attempt++) {
    current = captureProcessIncarnation()
  }
  expect(current).toBeDefined()
  return current!
}
