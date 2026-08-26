import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk"
import {
  captureProcessIncarnation,
  type ProcessIncarnation,
} from "./processIncarnation"

export interface SdkProcessGate {
  readonly executor: ProcessIncarnation
  /** False means a crashed proxy's lease must remain fail-closed forever. */
  readonly recoverableAfterCrash: boolean
  readonly spawnClaudeCodeProcess: (options: SpawnOptions) => SpawnedProcess
  /** True only after the exact wrapper/CLI process has exited safely. */
  closeAndJoin(timeoutMs?: number): Promise<boolean>
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function posixGateScript(options: SpawnOptions): string {
  const environment = Object.entries(options.env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => shellQuote(`${key}=${value}`))
  const command = [options.command, ...options.args].map(shellQuote)
  return [
    options.cwd ? `cd -- ${shellQuote(options.cwd)} || exit 72` : undefined,
    `exec /usr/bin/env -i ${environment.join(" ")} ${command.join(" ")}`,
    "",
  ].filter((line): line is string => line !== undefined).join("\n")
}

function gateContents(options: SpawnOptions): string {
  if (process.platform !== "win32") return posixGateScript(options)
  return JSON.stringify({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    env: Object.fromEntries(Object.entries(options.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)),
  })
}

function publishGate(path: string, contents: string): void {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, contents, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temporary, path)
    if (process.platform !== "win32") {
      const parent = openSync(dirname(path), "r")
      try {
        fsyncSync(parent)
      } finally {
        closeSync(parent)
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function asSpawnedProcess(child: ChildProcess, killOwned: (signal: NodeJS.Signals) => void): SpawnedProcess {
  if (!child.stdin || !child.stdout) throw new Error("SDK gate process is missing stdio")
  if (process.platform !== "win32") return child as ChildProcess & SpawnedProcess
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() { return child.killed },
    get exitCode() { return child.exitCode },
    kill(signal) {
      killOwned(signal)
      return true
    },
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  } as SpawnedProcess
}

function spawnGateWrapper(gatePath: string, cancelPath: string): ChildProcess {
  if (process.platform !== "win32") {
    const wrapper = String.raw`
gate=$1
remaining=6000
while [ ! -r "$gate" ]; do
  [ "$remaining" -le 0 ] && exit 75
  remaining=$((remaining - 1))
  sleep 0.01
done
. "$gate"
exit $?
`
    return spawn("/bin/sh", ["-c", wrapper, "meridian-sdk-gate", gatePath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
  }
  // Windows cannot exec in-place. This exact wrapper owns the native CLI
  // handle, forwards all three standard streams, and exits only after that
  // exact child settles. A cancel request terminates the child handle rather
  // than killing the wrapper first.
  const wrapper = String.raw`
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
const gate = process.env.MERIDIAN_SDK_GATE_PATH;
const cancel = process.env.MERIDIAN_SDK_CANCEL_PATH;
const gateDeadline = Date.now() + 60_000;
while (!existsSync(gate)) {
  if (existsSync(cancel)) process.exit(0);
  if (Date.now() >= gateDeadline) process.exit(75);
  await wait(10);
}
if (existsSync(cancel)) process.exit(0);
const job = JSON.parse(readFileSync(gate, "utf8"));
const child = spawn(job.command, job.args, {
  cwd: job.cwd || undefined,
  env: job.env,
  stdio: "inherit",
  windowsHide: true,
});
let escalated = false;
const cancellation = setInterval(() => {
  if (!existsSync(cancel)) return;
  child.kill(escalated ? "SIGKILL" : "SIGTERM");
  escalated = true;
}, 50);
cancellation.unref?.();
const status = await new Promise((resolve) => {
  child.once("close", (code, signal) => resolve({ code, signal }));
  child.once("error", (error) => resolve({ code: 70, signal: String(error) }));
});
clearInterval(cancellation);
process.exit(status.code ?? (status.signal ? 1 : 0));
`
  return spawn(process.execPath, ["--input-type=module", "--eval", wrapper], {
    env: {
      ...process.env,
      MERIDIAN_SDK_GATE_PATH: gatePath,
      MERIDIAN_SDK_CANCEL_PATH: cancelPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
}

async function waitForExit(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(false), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([exited.then(() => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Start a harmless gated wrapper and capture its exact incarnation before the
 * SDK can execute Claude Code. POSIX wrappers `exec` the CLI in the same PID.
 * Windows keeps a PowerShell parent for the complete CLI lifetime; crash
 * recovery of that lease is deliberately disabled because Windows has no
 * built-in, authoritative descendant-group incarnation.
 */
export async function createSdkProcessGate(
  root: string,
  attachExecutor: (executor: ProcessIncarnation, recoverableAfterCrash: boolean) => Promise<void>,
  onStderr?: (data: string) => void,
): Promise<SdkProcessGate> {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const token = `${process.pid}-${randomUUID()}`
  const gatePath = join(root, `${token}.gate`)
  const cancelPath = join(root, `${token}.cancel`)
  const child = spawnGateWrapper(gatePath, cancelPath)
  const recoverableAfterCrash = process.platform !== "win32"
  const killOwned = (signal: NodeJS.Signals): void => {
    if (process.platform === "win32") {
      try {
        const fd = openSync(cancelPath, "wx", 0o600)
        closeSync(fd)
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
      }
      return
    }
    if (child.exitCode === null) child.kill(signal)
  }
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const data = chunk.toString()
    if (!onStderr) return
    try {
      onStderr(data)
    } catch (error) {
      console.error("[sdkProcessGate] stderr callback failed:", error)
    }
  })
  // `error` does not prove process exit. Node emits `close` only after the
  // process has ended (or spawn failed) and all owned stdio handles close.
  const exited = new Promise<void>((resolveExit) => {
    child.once("close", () => resolveExit())
  })
  let attached = false
  let spawned = false
  try {
    if (!child.pid) throw new Error("SDK gate process has no PID")
    const executor = captureProcessIncarnation(child.pid)
    if (!executor) throw new Error("cannot capture SDK writer process incarnation")
    await attachExecutor(executor, recoverableAfterCrash)
    attached = true

    const spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
      if (spawned) throw new Error("SDK process gate may be opened only once")
      spawned = true
      const abortError = (): Error => Object.assign(new Error("SDK process spawn was aborted"), {
        name: "AbortError",
      })
      if (options.signal.aborted) {
        killOwned("SIGTERM")
        throw abortError()
      }
      const onAbort = (): void => { killOwned("SIGTERM") }
      options.signal.addEventListener("abort", onAbort, { once: true })
      void exited.then(() => options.signal.removeEventListener("abort", onAbort))
      if (options.signal.aborted) {
        onAbort()
        throw abortError()
      }
      publishGate(gatePath, gateContents(options))
      return asSpawnedProcess(child, killOwned)
    }

    return {
      executor,
      recoverableAfterCrash,
      spawnClaudeCodeProcess,
      async closeAndJoin(timeoutMs = 7_000): Promise<boolean> {
        let joined = child.exitCode !== null
        // Give a terminal SDK process a short chance to report its natural exit
        // before cancellation turns Windows recovery into a permanent fence.
        if (!joined) joined = await waitForExit(exited, Math.min(250, timeoutMs))
        if (!joined) {
          killOwned("SIGTERM")
          joined = await waitForExit(exited, timeoutMs)
        }
        if (!joined && process.platform !== "win32") {
          killOwned("SIGKILL")
          joined = await waitForExit(exited, Math.min(2_000, timeoutMs))
        }
        if (joined) {
          rmSync(gatePath, { force: true })
          rmSync(cancelPath, { force: true })
        } else {
          void exited.then(() => {
            rmSync(gatePath, { force: true })
            rmSync(cancelPath, { force: true })
          })
        }
        return joined
      },
    }
  } catch (error) {
    if (!attached || child.exitCode === null) killOwned("SIGKILL")
    await waitForExit(exited, 2_000)
    rmSync(gatePath, { force: true })
    rmSync(cancelPath, { force: true })
    throw error
  }
}
