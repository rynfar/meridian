import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("Node launchers exit while one owned child persists and fresh commands drain only its endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "meridian-detached-process-"))
  const foreign = createServer((_request, response) => response.end("unrelated service"))
  await new Promise<void>(resolve => foreign.listen(0, "127.0.0.1", resolve))
  const address = foreign.address()
  if (!address || typeof address === "string") throw new Error("Missing fixture port")
  const foreignPort = address.port
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve))
  const ownedAddress = reservation.address()
  if (!ownedAddress || typeof ownedAddress === "string") throw new Error("Missing owned port")
  const port = ownedAddress.port
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const command = (action: "start" | "stop", targetPort = port) => new Promise<{ code: number | null; value: { outcome: string; instanceId?: string; logPath?: string } }>((resolve, reject) => {
    const child = spawn("node", [join(root, "cli.js"), action], {
      env: { ...process.env, MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_PORT: String(targetPort) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = "", stderr = ""
    child.stdout.on("data", chunk => { stdout += chunk })
    child.stderr.on("data", chunk => { stderr += chunk })
    child.once("error", reject)
    child.once("close", code => {
      try { resolve({ code, value: JSON.parse(stdout) }) }
      catch { reject(new Error(`Fixture command failed (${code}): ${stderr}; ${stdout}`)) }
    })
  })
  try {
    const build = await Bun.build({ entrypoints: [resolve(import.meta.dir, "fixtures/detached/cli.ts")], outdir: root, target: "node" })
    expect(build.success).toBe(true)
    await writeFile(join(root, "package.json"), '{"type":"module"}')
    const starts = await Promise.all([command("start"), command("start")])
    expect(starts.map(item => item.code)).toEqual([0, 0])
    expect(starts.map(item => item.value.outcome).sort()).toEqual(["ready-created", "ready-existing"])
    expect(starts[0]!.value.instanceId).toBe(starts[1]!.value.instanceId)
    expect(await (await fetch(`http://127.0.0.1:${port}/readyz`)).text()).toBe("ok")
    expect((await command("start", foreignPort)).value.outcome).toBe("port-conflict")
    expect((await command("stop", foreignPort)).value.outcome).toBe("unmanaged")
    expect(await (await fetch(`http://127.0.0.1:${foreignPort}`)).text()).toBe("unrelated service")
    const stopped = await command("stop")
    expect(stopped.code, JSON.stringify(stopped.value)).toBe(0)
    expect(stopped.value.outcome).toBe("stopped")
    expect(stopped.value.instanceId).toBe(starts[0]!.value.instanceId)
    const log = await readFile(starts[0]!.value.logPath!, "utf8")
    expect(log).toContain("fixture stdout ready")
    expect(log).toContain("fixture stderr ready")
    expect(log).toContain("fixture graceful stop")
    expect((await command("stop")).value.outcome).toBe("already-stopped")
    // A launcher which disappears before commitment must not leave a server.
    // Keep the original supervisor handle and join it, rather than looking up
    // a PID in persistent state and assuming it still names our process.
    const abandoned = spawn("node", [join(root, "cli.js"), "__detached-supervisor"], {
      env: { ...process.env, MERIDIAN_CONFIG_DIR: join(root, "config"), MERIDIAN_PORT: String(port) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    let reachedReady = false
    let errors = ""
    abandoned.stderr?.on("data", chunk => { errors += chunk })
    abandoned.on("message", (value: unknown) => {
      if (typeof value === "object" && value !== null && "type" in value && value.type === "meridian-detached-ready") {
        reachedReady = true
        abandoned.disconnect()
      }
    })
    const abandonedExit = await new Promise<number | null>((resolve, reject) => {
      abandoned.once("error", reject)
      abandoned.once("close", resolve)
    })
    expect(reachedReady).toBe(true)
    expect(abandonedExit).toBe(1)
    expect(errors).toContain("Detached startup cancelled or timed out")
    expect((await command("stop")).value.outcome).toBe("already-stopped")
  } finally {
    await command("stop").catch(error => { console.error("Fixture cleanup failed", error) })
    await new Promise<void>((resolve, reject) => foreign.close(error => error ? reject(error) : resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
