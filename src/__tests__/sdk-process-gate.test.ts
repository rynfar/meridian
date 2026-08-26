import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSdkProcessGate } from "../proxy/session/sdkProcessGate"
import type { ProcessIncarnation } from "../proxy/session/processIncarnation"

describe("SDK process gate", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
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

})
