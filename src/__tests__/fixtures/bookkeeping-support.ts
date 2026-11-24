import { expect } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"

export function bookkeepingBunPreloadArgs(): string[] {
  return ["--preload", resolve("src/__tests__/fixtures/bookkeeping-engine-preload.mjs")]
}

/**
 * A test actor ran on real Node, not Bun (whose `process.versions.node` is a
 * compatibility version), at or above package.json's engines floor. Any newer
 * Node major qualifies: the native engine's own WAL-reset gate still applies.
 */
export function expectRealNodeRuntime(runtime: { node: string; bun: string | null }): void {
  expect(runtime.bun).toBeNull()
  const engines = (JSON.parse(readFileSync(resolve("package.json"), "utf8")) as { engines: { node: string } }).engines.node
  const floor = /^>=(\d+)$/.exec(engines)
  expect(floor).not.toBeNull()
  expect(Number(runtime.node.split(".")[0])).toBeGreaterThanOrEqual(Number(floor![1]))
}

/** Keep unexpected native stderr fatal while allowing Node 22's exact builtin SQLite notice. */
export function unexpectedNodeSqliteStderr(stderr: string): string {
  return stderr.replace(
    /^\(node:[1-9]\d*\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/gm,
    "",
  )
}

/** Real idle read-only connection retains WAL inodes without blocking TRUNCATE. */
export async function withIdleWalReader<T>(
  directory: string, script: string, operation: () => T | Promise<T>,
): Promise<T> {
  const child = spawn("node", [script, directory], { stdio: ["ignore", "pipe", "pipe", "ipc"] })
  let stderr = ""
  child.stdout?.resume()
  child.stderr?.on("data", chunk => { stderr += String(chunk) })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }))
    child.once("error", () => { if (child.pid === undefined) resolve({ code: null, signal: null }) })
  })
  const closed = new Promise<void>(resolve => { child.once("close", () => resolve()) })
  const stdoutClosed = child.stdout
    ? new Promise<void>(resolve => { child.stdout!.once("close", () => resolve()) }) : Promise.resolve()
  const stderrClosed = child.stderr
    ? new Promise<void>(resolve => { child.stderr!.once("close", () => resolve()) }) : Promise.resolve()
  let startupTimer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("message", message => {
          if (message && typeof message === "object" && "ready" in message && message.ready === true
            && "transaction" in message && message.transaction === false) resolve()
          else reject(new Error("invalid idle reader readiness"))
        })
      }),
      exited.then(status => { throw new Error(`idle reader exited before readiness: ${JSON.stringify(status)} ${stderr}`) }),
      new Promise<never>((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error("idle reader readiness timed out")), 5000)
      }),
    ])
    clearTimeout(startupTimer)
    return await operation()
  } finally {
    clearTimeout(startupTimer)
    if (child.connected) child.send("close")
    else if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
    const stop = setTimeout(() => { child.kill("SIGKILL") }, 5000)
    let joinTimeout: ReturnType<typeof setTimeout> | undefined
    const joined = await Promise.race([
      Promise.all([exited, closed, stdoutClosed, stderrClosed]),
      new Promise<never>((_, reject) => {
        joinTimeout = setTimeout(() => reject(new Error("idle reader original actor/pipes did not join")), 10000)
      }),
    ]).finally(() => { clearTimeout(stop); clearTimeout(joinTimeout) })
    if (joined[0].code !== 0 || joined[0].signal || unexpectedNodeSqliteStderr(stderr)) {
      throw new Error(`idle reader failed to close cleanly: ${JSON.stringify(joined[0])} ${stderr}`)
    }
  }
}

/** Acceptance output wins over the development artifact directory when both are set. */
export function writeBenchArtifact(name: string, value: unknown): void {
  const directory = process.env.BOOKKEEPING_ACCEPTANCE_OUT || process.env.BOOKKEEPING_BENCH_ARTIFACTS
  if (!directory) return
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2) + "\n")
}
export function buildNodeFixture(name: string, output: string, directory: string) {
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"), "junction")
  return Bun.build({
    entrypoints: [resolve("src/__tests__/fixtures", name)],
    target: "node",
    naming: output,
    outdir: directory,
    external: ["libsql"],
  })
}
