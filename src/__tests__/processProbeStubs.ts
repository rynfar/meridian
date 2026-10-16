import { spyOn } from "bun:test"
import * as childProcess from "node:child_process"

/**
 * Run with `process.platform` reading as another platform, so the darwin and
 * win32 probe paths can be driven on any host. Restored afterwards.
 */
export async function onPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  if (!descriptor) throw new Error("process.platform has no own descriptor to restore")
  Object.defineProperty(process, "platform", { ...descriptor, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
}

export interface StubbedProbeCall {
  file: string
  args: readonly string[]
  options: childProcess.ExecFileOptions
  /** Answer the probe as execFile would: an exit code (0 = success) and stdout. */
  answer: (status: number, stdout: string) => void
}

type ExecFileCallback = (error: childProcess.ExecFileException | null, stdout: string, stderr: string) => void

/**
 * Replace execFile with a probe that answers only when the test says so.
 * Each call is recorded with its own `answer`; nothing runs.
 */
export function stubProbeExecFile(): { calls: StubbedProbeCall[]; restore: () => void } {
  const calls: StubbedProbeCall[] = []
  const stub = (
    file: string,
    args: readonly string[],
    options: childProcess.ExecFileOptions,
    callback: ExecFileCallback,
  ): childProcess.ChildProcess => {
    calls.push({
      file,
      args,
      options,
      answer: (status, stdout) => {
        const error = status === 0
          ? null
          : Object.assign(new Error(`Command failed: ${file}`), { code: status })
        callback(error, stdout, "")
      },
    })
    return new childProcess.ChildProcess()
  }
  const spy = spyOn(childProcess, "execFile").mockImplementation(stub as unknown as typeof childProcess.execFile)
  return { calls, restore: () => spy.mockRestore() }
}
