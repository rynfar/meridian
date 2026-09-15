/** Conservative discovery for a direct, current-user launchd Meridian process.
 * Shell wrappers, Docker, Nix and system daemons remain connect-only. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, dirname, isAbsolute, basename } from 'node:path'
import { homedir } from 'node:os'
import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { object, text } from './core'
const exec = promisify(execFile)
export interface LaunchAgent { label: string; plist: string; pid: number; fingerprint: string; environment: Record<string, string>; workingDirectory: string }
export function savedAgent(value: unknown): LaunchAgent {
  const input = object(value)
  const label = text(input.label)
  const plist = text(input.plist)
  const workingDirectory = text(input.workingDirectory)
  if (!/^[\w.-]+$/.test(label) || plist !== join(homedir(), 'Library/LaunchAgents', label + '.plist') || !isAbsolute(workingDirectory) || !Number.isInteger(input.pid) || Number(input.pid) <= 1 || !/^[a-f0-9]{64}$/.test(text(input.fingerprint))) throw new Error('Invalid saved launchd handoff.')
  const environment = Object.fromEntries(Object.entries(object(input.environment)).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('Invalid saved launchd environment.')
    return [key, value]
  }))
  return { label, plist, workingDirectory, pid: Number(input.pid), fingerprint: text(input.fingerprint), environment }
}
export async function listeningPid(port: number): Promise<number | undefined> {
  try {
    const { stdout } = await exec('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])
    const ids = [...new Set(stdout.trim().split('\n'))]
    if (ids.length !== 1) throw new Error('Multiple listeners share the port; ownership is ambiguous.')
    return Number(ids[0]) || undefined
  } catch (error) { if (object(error).code === 1) return undefined; throw error }
}
async function fingerprint(plist: string) { return createHash('sha256').update(await readFile(plist)).digest('hex') }
export async function discoverLaunchAgent(port: number): Promise<LaunchAgent | undefined> {
  if (process.platform !== 'darwin') return undefined
  const pid = await listeningPid(port)
  if (!pid) return undefined
  const { stdout } = await exec('/bin/launchctl', ['list'])
  const row = stdout.split('\n').find(line => Number(line.trim().split(/\s+/)[0]) === pid)
  const label = row?.trim().split(/\s+/)[2]
  if (!label || !/^[\w.-]+$/.test(label)) return undefined
  const plist = join(homedir(), 'Library/LaunchAgents', label + '.plist')
  try {
    const before = await fingerprint(plist)
    const { stdout: json } = await exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])
    const data = object(JSON.parse(json))
    const args = Array.isArray(data.ProgramArguments) ? data.ProgramArguments.map(text) : [text(data.Program)]
    if (data.Label !== label || (data.Program && data.Program !== args[0])) return undefined
    const cli = args.length === 1 ? args[0] : args.length === 2 && basename(args[0] || '') === 'node' ? args[1] : undefined
    if (!cli || !isAbsolute(cli)) return undefined
    const resolved = await realpath(cli)
    if (basename(resolved) !== 'cli.js' || basename(dirname(resolved)) !== 'dist') return undefined
    const manifest = object(JSON.parse(await readFile(join(dirname(dirname(resolved)), 'package.json'), 'utf8')))
    if (manifest.name !== '@rynfar/meridian') return undefined
    // launchd otherwise allows a shorter force-kill deadline than Meridian's
    // drain. Such jobs require manual migration rather than truncating work.
    if (data.ExitTimeOut !== 0 && !(typeof data.ExitTimeOut === 'number' && data.ExitTimeOut >= 45)) return undefined
    const environment = object(data.EnvironmentVariables)
    const host = environment.MERIDIAN_HOST ?? environment.CLAUDE_PROXY_HOST ?? '127.0.0.1'
    if (host !== '127.0.0.1') return undefined
    if (Number(environment.MERIDIAN_PORT ?? environment.CLAUDE_PROXY_PORT ?? 3456) !== port) return undefined
    if (await fingerprint(plist) !== before) return undefined
    return savedAgent({ label, plist, pid, fingerprint: before, environment, workingDirectory: data.WorkingDirectory || '/' })
  } catch { /* A job that cannot be fully inspected stays with its supervisor. */ return undefined }
}
function domain() { return `gui/${process.getuid?.()}` }
async function unchanged(agent: LaunchAgent) {
  if (await fingerprint(agent.plist) !== agent.fingerprint) throw new Error('The original launchd plist changed. Restore it or finish the handoff manually; the app will not run a different command.')
}
export async function suspendAgent(agent: LaunchAgent, port: number) {
  await unchanged(agent)
  if (await listeningPid(port) !== agent.pid) throw new Error('Service ownership changed. Inspect the handoff again.')
  await exec('/bin/launchctl', ['disable', `${domain()}/${agent.label}`])
  try { await exec('/bin/launchctl', ['bootout', `${domain()}/${agent.label}`]) }
  catch (error) { await exec('/bin/launchctl', ['enable', `${domain()}/${agent.label}`]); throw error }
}
export async function restoreAgent(agent: LaunchAgent) {
  await unchanged(agent)
  await exec('/bin/launchctl', ['enable', `${domain()}/${agent.label}`])
  let loaded = false
  try { await exec('/bin/launchctl', ['print', `${domain()}/${agent.label}`]); loaded = true } catch { /* An unloaded original job needs bootstrap. */ }
  if (!loaded) await exec('/bin/launchctl', ['bootstrap', domain(), agent.plist])
}
export async function waitForExit(pid: number, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) { if (object(error).code === 'ESRCH') return; throw error }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  throw new Error('The previous process has not finished draining. No replacement was started.')
}
