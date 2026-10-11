import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import { createOwnedClientProcess } from "../../scripts/e2e-claude-code-auto-mode.mjs"

class Child extends EventEmitter {
  pid = 71001
  stdout = new EventEmitter()
  stderr = new EventEmitter()
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned control join deadline")), 5000)
    })])
  } finally { clearTimeout(timer) }
}

function closePipes(child: Child) {
  for (const stream of [child.stdout, child.stderr]) {
    stream.emit("end"); stream.emit("close")
  }
}

describe("E71 owned client handle", () => {
  it("binds signals to the observed birth PID and retires them at exit", async () => {
    const child = new Child(), calls: Array<[number, string]> = []
    const owner = createOwnedClientProcess(child, (pid: number, signal: string) => { calls.push([pid, signal]); return true })
    expect(owner.signal("SIGTERM")).toBe("RETIRED_OR_NOT_STARTED")
    child.emit("spawn")
    child.pid = 71002
    expect(owner.signal("SIGTERM")).toBe("SENT")
    expect(calls).toEqual([[-71001, "SIGTERM"]])
    child.emit("exit")
    expect(owner.signal("SIGKILL")).toBe("RETIRED_OR_NOT_STARTED")
    expect(owner.isJoined()).toBe(false)
    child.emit("close")
    expect(owner.isJoined()).toBe(false)
    closePipes(child)
    await bounded(owner.joined)
    expect(owner.snapshot().join).toBe("JOINED")
    expect(calls).toHaveLength(1)
  })

  it("does not infer a physical join from a missing group or a signal failure", async () => {
    for (const code of ["ESRCH", "EPERM"]) {
      const child = new Child()
      const owner = createOwnedClientProcess(child, () => { throw Object.assign(new Error("owned control"), { code }) })
      child.emit("spawn")
      expect(owner.signal("SIGKILL")).toBe(code === "ESRCH" ? "NOT_FOUND" : "FAILED")
      expect(owner.isJoined()).toBe(false)
      expect(owner.snapshot().signals).toEqual([{ signal: "SIGKILL", result: code === "ESRCH" ? "NOT_FOUND" : "FAILED", code }])
      child.emit("exit"); child.emit("close"); closePipes(child)
      await bounded(owner.joined)
      expect(owner.snapshot().signals[0]?.code).toBe(code)
    }
  })

  it("rejects invalid birth authority and joins a failed spawn only after close and pipes", async () => {
    const invalid = new Child(); invalid.pid = 1
    let calls = 0
    const owner = createOwnedClientProcess(invalid, () => { calls++; return true })
    invalid.emit("spawn")
    expect(owner.signal("SIGKILL")).toBe("FAILED")
    expect(calls).toBe(0)
    invalid.emit("exit"); invalid.emit("close"); closePipes(invalid)
    await bounded(owner.joined)
    const child = new Child(), failed = createOwnedClientProcess(child, () => { calls++; return true })
    child.emit("error", new Error("synthetic spawn failure"))
    expect(failed.signal("SIGKILL")).toBe("RETIRED_OR_NOT_STARTED")
    child.emit("close")
    expect(failed.isJoined()).toBe(false)
    closePipes(child); await bounded(failed.joined)
    expect(failed.snapshot().join).toBe("JOINED")
    expect(calls).toBe(0)
  })

  it("retains signal failure authority beyond the bounded observation list", async () => {
    const child = new Child(); let calls = 0
    const owner = createOwnedClientProcess(child, () => {
      calls++
      throw Object.assign(new Error("owned control"), { code: calls === 17 ? "EPERM" : "ESRCH" })
    })
    child.emit("spawn")
    for (let index = 0; index < 18; index++) owner.signal("SIGTERM")
    expect(owner.snapshot().signals).toHaveLength(16)
    expect(owner.snapshot().signalFailures).toBe(1)
    expect(owner.snapshot().signalAttempts).toBe(18)
    child.emit("exit"); child.emit("close"); closePipes(child)
    await bounded(owner.joined)
    expect(owner.snapshot().signalFailures).toBe(1)
  })

  it("coalesces successful termination before exit without skipping KILL or inferring a join", async () => {
    const child = new Child(), calls: string[] = []
    const owner = createOwnedClientProcess(child, (_pid: number, signal: string) => {
      if (calls.includes(signal)) throw Object.assign(new Error("duplicate termination control"), { code: "EPERM" })
      calls.push(signal); return true
    })
    child.emit("spawn")
    expect(owner.signal("SIGTERM")).toBe("SENT")
    expect(owner.signal("SIGTERM")).toBe("ALREADY_SENT")
    expect(owner.isJoined()).toBe(false)
    expect(owner.signal("SIGKILL")).toBe("SENT")
    expect(owner.signal("SIGKILL")).toBe("ALREADY_SENT")
    expect(owner.signal("SIGTERM")).toBe("ALREADY_SENT")
    expect(calls).toEqual(["SIGTERM", "SIGKILL"])
    expect(owner.snapshot().signalFailures).toBe(0)
    child.emit("exit"); child.emit("close"); closePipes(child)
    await bounded(owner.joined)
  })

  it("retries a refused first signal and retains that failure after the successful retry", async () => {
    const child = new Child(); let calls = 0
    const owner = createOwnedClientProcess(child, () => {
      if (++calls === 1) throw Object.assign(new Error("first termination refusal"), { code: "EPERM" })
      return true
    })
    child.emit("spawn")
    expect(owner.signal("SIGTERM")).toBe("FAILED")
    expect(owner.signal("SIGTERM")).toBe("SENT")
    expect(owner.signal("SIGTERM")).toBe("ALREADY_SENT")
    expect(calls).toBe(2)
    expect(owner.snapshot().signalFailures).toBe(1)
    child.emit("exit"); child.emit("close"); closePipes(child)
    await bounded(owner.joined)
    expect(owner.snapshot().signalFailures).toBe(1)
  })

  it("joins a real owned Node client and prevents post-close group signals", async () => {
    const child = spawn("node", ["-e", "process.stdout.write('owned-ready');process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      detached: true, stdio: ["ignore", "pipe", "pipe"],
    })
    const owner = createOwnedClientProcess(child)
    try {
      await bounded(new Promise<void>(resolve => { child.stdout.once("data", () => resolve()) }))
      child.stderr.resume()
      expect(owner.signal("SIGKILL")).toBe("SENT")
      await bounded(owner.joined)
      expect(owner.signal("SIGTERM")).toBe("RETIRED_OR_NOT_STARTED")
      const facts = owner.snapshot()
      expect(facts.join).toBe("JOINED")
      expect(facts.exit && facts.close && facts.stdoutEnd && facts.stdoutClose && facts.stderrEnd && facts.stderrClose).toBe(true)
      expect(facts.signals).toHaveLength(1)
    } finally {
      owner.signal("SIGKILL")
      await bounded(owner.joined)
    }
  })
})
