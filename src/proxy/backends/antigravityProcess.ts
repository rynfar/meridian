import { execFile, type ChildProcessWithoutNullStreams } from 'node:child_process'

export function agHookCommand(executable: string, script: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    // cmd expands percent variables even inside quotes. Reject such install
    // paths rather than risk executing a different hook.
    if ([executable, script].some(value => /["%\r\n]/.test(value))) throw new Error('Windows hook paths cannot contain quotes, percent signs or newlines')
    return `"${executable}" "${script}"`
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  return `${quote(executable)} ${quote(script)}`
}

export function signalAgProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    // Windows has no POSIX process-group signal. taskkill joins the whole tree,
    // including native helpers; terminating only the parent leaks those helpers.
    execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5000, windowsHide: true }, error => {
      if (error && child.exitCode === null) console.error('[antigravity] Process-tree termination failed:', error.message)
    })
    return
  }
  try { process.kill(-child.pid, signal) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) child.kill(signal) }
}
