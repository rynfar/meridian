import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import { observeChildClosure, stopAndJoinChild } from "../../scripts/lib/e2eProcessCustody.mjs"

function fakeChild() {
  const signals: string[] = []
  const child = Object.assign(new EventEmitter(), {
    pid: 12345, stdout: new EventEmitter(), stderr: new EventEmitter(),
    kill: (signal: string) => { signals.push(signal); return true },
  })
  return { child, signals }
}

describe("headless proof process custody", () => {
  it("bounds an exited leader with missing pipe/close witnesses and never signals it", async () => {
    const { child, signals } = fakeChild(), witness = observeChildClosure(child)
    child.emit("exit", 0, null)
    const report = await stopAndJoinChild(child, witness, { graceMs: 5, forceMs: 5 })
    expect(report.joined).toBe(false)
    expect(report.exitSeen).toBe(true)
    expect(signals).toEqual([])
    child.emit("close"); child.stdout.emit("close")
    expect(witness.state.joined).toBe(false)
    child.stderr.emit("close"); await witness.joined
    expect(witness.state.joined).toBe(true)
  })

  it("escalates the same live child without treating a sent signal as a join", async () => {
    const { child, signals } = fakeChild(), witness = observeChildClosure(child)
    const report = await stopAndJoinChild(child, witness, { graceMs: 5, forceMs: 5 })
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(report.joined).toBe(false)
    child.emit("exit", null, "SIGKILL"); child.emit("close")
    child.stdout.emit("close"); child.stderr.emit("close"); await witness.joined
  })

  it("captures actual Node exit, close and both pipe closures", async () => {
    const child = spawn("node", ["-e", "process.stdout.write('fixture');process.stderr.write('fixture')"], { stdio: ["ignore", "pipe", "pipe"] })
    const witness = observeChildClosure(child)
    child.stdout.resume(); child.stderr.resume()
    await witness.joined
    const report = await stopAndJoinChild(child, witness, { graceMs: 5, forceMs: 5 })
    expect(report).toMatchObject({ exitSeen: true, closeSeen: true, stdoutClosed: true, stderrClosed: true, exitCode: 0, joined: true, termSent: false, killSent: false })
  })

  it("retains an actual inherited-pipe failure after leader exit until the descendant closes", async () => {
    const child = spawn("node", ["-e", "require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},300)'],{stdio:['ignore',1,2]});process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] })
    const witness = observeChildClosure(child)
    child.stdout.resume(); child.stderr.resume()
    await new Promise<void>(resolve => child.once("exit", () => resolve()))
    const report = await stopAndJoinChild(child, witness, { graceMs: 5, forceMs: 5 })
    expect(report.joined).toBe(false)
    expect(report.termSent).toBe(false); expect(report.killSent).toBe(false)
    await witness.joined
    expect(witness.state.joined).toBe(true)
  })
})
