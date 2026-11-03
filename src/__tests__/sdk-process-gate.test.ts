import { afterEach, describe, expect, it, spyOn } from "bun:test"
import * as childProcess from "node:child_process"
import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { open, type FileHandle } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { createSdkProcessGate, getSdkGateNodeExecutable } from "../proxy/session/sdkProcessGate"
import * as processIncarnation from "../proxy/session/processIncarnation"
import { captureProcessIncarnation, type ProcessIncarnation } from "../proxy/session/processIncarnation"
import { onPlatform, stubProbeExecFile } from "./processProbeStubs"

/** Observe the opening under test without attributing another request's probe
 * to it. Delegate every call so a forbidden synchronous spawn still executes
 * and is reported, including after an asynchronous continuation. */
async function observeOpening<T>(openGate: () => Promise<T>) {
  const scope = new AsyncLocalStorage<boolean>()
  const captures: Array<{ executable: string; stack: string | undefined }> = []
  const original = childProcess.spawnSync
  const observer = spyOn(childProcess, "spawnSync").mockImplementation(new Proxy(original, {
    apply(target, receiver, args) {
      if (scope.getStore()) captures.push({ executable: String(args[0]), stack: new Error("Synchronous process during gate opening").stack })
      return Reflect.apply(target, receiver, args)
    },
  }))
  try { return { gate: await scope.run(true, openGate), captures } }
  finally { observer.mockRestore() }
}

describe("SDK process gate", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it("resolves the actual Node executable under an embedded Bun host", () => {
    const executable = getSdkGateNodeExecutable()
    expect(isAbsolute(executable)).toBe(true)
    if (typeof process.versions.bun === "string") {
      expect(basename(executable).toLowerCase()).toMatch(/^node(?:\.exe)?$/)
    }
  })

  it("persists the exact wrapper incarnation before opening the child command", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    let attached: ProcessIncarnation | undefined
    const gate = await createSdkProcessGate(root, async (executor) => { attached = executor })
    expect(attached).toEqual(gate.executor)

    const child = gate.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      env: { ...process.env },
      signal: new AbortController().signal,
    })
    const output = new Promise<string>((resolve) => {
      child.stdout.once("data", (chunk) => resolve(chunk.toString()))
    })
    child.stdin.write("gated-writer\n")
    expect(await output).toBe("gated-writer\n")
    child.stdin.end()
    expect(await gate.closeAndJoin()).toBe(true)
  })

  // Every request opens a gate. A synchronous probe of the wrapper held every
  // other request while it ran, and gave up after 2 s: on a host loaded near
  // 40, a request failed before any call with "cannot capture SDK writer
  // process incarnation".
  it("captures the wrapper's incarnation without holding the event loop", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    // What a running proxy captured of its host at start.
    expect(captureProcessIncarnation()).toBeDefined()
    let gate: Awaited<ReturnType<typeof createSdkProcessGate>> | undefined
    try {
      const observed = await observeOpening(() => createSdkProcessGate(root, async () => undefined))
      gate = observed.gate
      expect(observed.captures).toEqual([])
      expect(gate.executor.pid).toBeGreaterThan(0)
    } finally {
      // An assertion failure must not orphan the already-open wrapper.
      if (gate) expect(await gate.closeAndJoin()).toBe(true)
    }
  })

  it("does not attribute another operation's synchronous spawn to gate opening", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    expect(captureProcessIncarnation()).toBeDefined()
    // This callback is registered outside the opening's asynchronous context.
    const unrelated = new Promise<void>(resolve => setTimeout(() => {
      childProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"])
      resolve()
    }, 0))
    const observed = await observeOpening(async () => {
      const gate = await createSdkProcessGate(root, async () => undefined)
      await unrelated
      return gate
    })
    try { expect(observed.captures).toEqual([]) }
    finally { expect(await observed.gate.closeAndJoin()).toBe(true) }
  })

  for (const position of ["before", "after"] as const) {
    it(`retains a real forbidden synchronous spawn ${position} an asynchronous continuation`, async () => {
      const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
      roots.push(root)
      expect(captureProcessIncarnation()).toBeDefined()
      const original = processIncarnation.captureProcessIncarnationAsync
      const capture = spyOn(processIncarnation, "captureProcessIncarnationAsync").mockImplementation(async (...args) => {
        if (position === "after") await Promise.resolve()
        childProcess.spawnSync(process.execPath, ["-e", "process.exit(0)"])
        return original(...args)
      })
      let gate: Awaited<ReturnType<typeof createSdkProcessGate>> | undefined
      try {
        const observed = await observeOpening(() => createSdkProcessGate(root, async () => undefined))
        gate = observed.gate
        expect(observed.captures).toHaveLength(1)
        expect(observed.captures[0]?.executable).toBe(process.execPath)
        expect(observed.captures[0]?.stack).toContain("Synchronous process during gate opening")
      } finally {
        capture.mockRestore()
        if (gate) expect(await gate.closeAndJoin()).toBe(true)
      }
    })
  }

  // CI runs this suite on Linux, where the capture reads /proc. This drives
  // the darwin capture, a ps child process, with execFile stubbed.
  it("awaits the wrapper's ps probe on darwin while the event loop runs", async () => {
    // The wrapper itself is spawned for the stubbed platform: POSIX only.
    if (process.platform === "win32") return
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    expect(captureProcessIncarnation()).toBeDefined()
    const darwinStart = "Mon Jan  5 03:04:05 2026"
    const probe = stubProbeExecFile()
    let gate: Awaited<ReturnType<typeof createSdkProcessGate>> | undefined
    try {
      const observed = await observeOpening(() => onPlatform("darwin", async () => {
        let settled = false
        const opening = createSdkProcessGate(root, async () => undefined).finally(() => { settled = true })
        await new Promise(resolve => setTimeout(resolve, 20))
        expect(settled).toBe(false)
        expect(probe.calls).toHaveLength(1)
        const call = probe.calls[0]!
        expect(call.file).toBe("/bin/ps")
        expect(call.args.slice(2)).toEqual(["-o", "lstart="])
        call.answer(0, `${darwinStart}\n`)
        return opening
      }))
      gate = observed.gate
      expect(observed.captures).toEqual([])
      expect(probe.calls[0]!.args.slice(0, 2)).toEqual(["-p", String(gate.executor.pid)])
      expect(gate.executor).toMatchObject({ startId: darwinStart, startIdKind: "darwin-ps-lstart" })
    } finally {
      probe.restore()
      if (gate) expect(await gate.closeAndJoin()).toBe(true)
    }
  })

  // The capture is awaited, so the wrapper can die and be reaped while it runs,
  // and its pid can be reused: the capture may then describe another process.
  it("refuses a capture that finished after its wrapper exited", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    const host = captureProcessIncarnation()
    expect(host).toBeDefined()
    const capture = spyOn(processIncarnation, "captureProcessIncarnationAsync")
      .mockImplementation(async (pid) => {
        process.kill(pid, "SIGKILL")
        await waitUntilReaped(pid, 5_000)
        // What a probe of a reused pid would answer.
        return { ...host!, pid }
      })
    const attached: ProcessIncarnation[] = []
    try {
      await expect(createSdkProcessGate(root, async (executor) => { attached.push(executor) }))
        .rejects.toThrow("cannot capture SDK writer process incarnation")
      expect(capture).toHaveBeenCalledTimes(1)
    } finally {
      capture.mockRestore()
    }
    expect(attached).toEqual([])
    expect(readdirSync(root)).toEqual([])
  })

  it("drains large stderr output and forwards it without stalling stdout", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    let stderrBytes = 0
    const gate = await createSdkProcessGate(root, async () => undefined, (data) => {
      stderrBytes += Buffer.byteLength(data)
    })
    const child = gate.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", 'process.stderr.write("x".repeat(2 * 1024 * 1024)); process.stdout.write("done")'],
      env: { ...process.env },
      signal: new AbortController().signal,
    })
    let output = ""
    child.stdout.on("data", (chunk) => { output += chunk.toString() })
    await Promise.race([
      new Promise<void>((resolveExit, rejectExit) => {
        child.once("exit", () => resolveExit())
        child.once("error", rejectExit)
      }),
      Bun.sleep(5_000).then(() => { throw new Error("gated child stdout timed out") }),
    ])
    expect(output).toBe("done")
    expect(stderrBytes).toBe(2 * 1024 * 1024)
    expect(await gate.closeAndJoin()).toBe(true)
  })

  it("never opens the command for an already-aborted SpawnOptions signal", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    const gate = await createSdkProcessGate(root, async () => undefined)
    const controller = new AbortController()
    controller.abort()
    expect(() => gate.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", 'process.stdout.write("must-not-run")'],
      env: { ...process.env },
      signal: controller.signal,
    })).toThrow("aborted")
    expect(await gate.closeAndJoin()).toBe(true)
  })

  it("keeps serving the event loop while the gate waits for the disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    const gate = await createSdkProcessGate(root, async () => undefined)
    const disk = holdDisk()
    const restore = await replaceFileHandleSync(root, async (sync) => {
      await disk.held
      return sync()
    })
    let ticks = 0
    const heartbeat = setInterval(() => { ticks++ }, 5)
    let output = ""
    try {
      const child = gate.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", 'process.stdout.write("gated")'],
        env: { ...process.env },
        signal: new AbortController().signal,
      })
      const drained = new Promise<void>((resolve) => child.stdout.once("end", () => resolve()))
      child.stdout.on("data", (chunk) => { output += chunk.toString() })
      await Bun.sleep(100)
      expect(ticks).toBeGreaterThanOrEqual(5)
      expect(output).toBe("")
      disk.release()
      await drained
    } finally {
      clearInterval(heartbeat)
      disk.release()
      restore()
    }
    expect(output).toBe("gated")
    expect(await gate.closeAndJoin()).toBe(true)
  })

  it("leaves no gate behind when an abort lands while the gate is being written", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    const marker = join(root, "command-ran")
    const gate = await createSdkProcessGate(root, async () => undefined)
    const disk = holdDisk()
    const restore = await replaceFileHandleSync(root, async (sync) => {
      await disk.held
      return sync()
    })
    try {
      const controller = new AbortController()
      const child = gate.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
        env: { ...process.env },
        signal: controller.signal,
      })
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
      controller.abort()
      await exited
      const joining = gate.closeAndJoin()
      await Bun.sleep(50)
      disk.release()
      expect(await joining).toBe(true)
    } finally {
      disk.release()
      restore()
    }
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(root).filter((name) => name.includes(".gate"))).toEqual([])
  })

  it("bounds join while publication is stuck and removes its late sensitive gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    const marker = join(root, "must-not-run")
    const gate = await createSdkProcessGate(root, async () => undefined)
    const disk = holdDisk()
    const restore = await replaceFileHandleSync(root, async (sync) => {
      await disk.held
      return sync()
    })
    let joining: Promise<boolean> | undefined
    try {
      const controller = new AbortController()
      const child = gate.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
        env: { ...process.env }, signal: controller.signal,
      })
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()))
      controller.abort()
      await exited
      joining = gate.closeAndJoin(30)
      expect(await Promise.race([joining, Bun.sleep(300).then(() => "unbounded")])).toBe(false)
      disk.release()
      const deadline = Date.now() + 2000
      while (readdirSync(root).some(name => name.includes(".gate")) && Date.now() < deadline) await Bun.sleep(10)
      expect(readdirSync(root).filter(name => name.includes(".gate"))).toEqual([])
      expect(existsSync(marker)).toBe(false)
      expect(await gate.closeAndJoin()).toBe(true)
    } finally {
      disk.release()
      restore()
      await joining
      await gate.closeAndJoin()
    }
  })

  it("stops the wrapper instead of opening the command when the gate cannot be published", async () => {
    const root = mkdtempSync(join(tmpdir(), "meridian-sdk-gate-"))
    roots.push(root)
    const marker = join(root, "command-ran")
    const gate = await createSdkProcessGate(root, async () => undefined)
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const restore = await replaceFileHandleSync(root, async () => {
      throw new Error("injected sync failure")
    })
    try {
      const child = gate.spawnClaudeCodeProcess({
        command: process.execPath,
        args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
        env: { ...process.env },
        signal: new AbortController().signal,
      })
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      expect(errorSpy).toHaveBeenCalledWith("[sdkProcessGate] gate publication failed:", expect.any(Error))
    } finally {
      restore()
      errorSpy.mockRestore()
    }
    expect(await gate.closeAndJoin()).toBe(true)
    expect(existsSync(marker)).toBe(false)
    expect(readdirSync(root).filter((name) => name.includes(".gate"))).toEqual([])
  })
})

function holdDisk(): { held: Promise<void>; release: () => void } {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  return { held, release }
}

async function replaceFileHandleSync(
  dir: string,
  replacement: (sync: () => Promise<void>) => Promise<void>,
): Promise<() => void> {
  const probe = await open(join(dir, "sync-probe"), "w")
  const prototype = Object.getPrototypeOf(probe) as FileHandle
  await probe.close()
  rmSync(join(dir, "sync-probe"), { force: true })
  const sync = prototype.sync
  prototype.sync = function (this: FileHandle) {
    return replacement(() => sync.call(this))
  }
  return () => { prototype.sync = sync }
}

/** True once the pid is gone, which on POSIX means its parent reaped it. */
async function waitUntilReaped(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        // Let the runtime deliver the exit it recorded while reaping.
        await new Promise(resolve => setTimeout(resolve, 50))
        return true
      }
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}
