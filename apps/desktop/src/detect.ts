/**
 * Find the Meridian the coding clients actually use.
 *
 * Sources, in order, deduplicated by base URL and each verified with /health:
 *   1. loaded launchd jobs that mention meridian (port from `launchctl print`'s
 *      environment, falling back to the job's plist);
 *   2. client configs, read-only: OpenCode provider baseURL, Pi
 *      MERIDIAN_BASE_URL / ~/.pi/agent/models.json baseUrl;
 *   3. the default http://127.0.0.1:3456;
 *   4. the saved preference endpoint.
 * Only loopback HTTP addresses are accepted. Parsing is pure; all I/O goes
 * through DetectIO so the policy is unit-testable. Nothing here writes, and
 * no secret from a job's environment or a client config is retained.
 */
import { execFile } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { endpoint, isMeridianHealth, object, text } from './core'
import { agentAddress, launchctl, launchDomain, listeningPid, plistJson } from './migration'

export type SupervisorKind = 'launchd' | 'docker' | 'app' | 'unknown'
export interface Supervisor { kind: SupervisorKind; label?: string; plistPath?: string }
export type DetectionSource = 'launchd' | 'opencode' | 'pi' | 'default' | 'preference'
export interface Candidate { baseUrl: string; source: DetectionSource; detail: string; supervisor?: Supervisor; pid?: number }
export interface Rejected { source: DetectionSource; detail: string; url: string; reason: string }
export interface Probe { status: 'meridian' | 'not-meridian' | 'unreachable'; version?: string; error?: string }
export interface DetectedService {
  baseUrl: string; port: number;
  /** "source: detail" for every source that named this URL, first wins. */
  sources: string[];
  probe: Probe; supervisor: Supervisor; pid?: number;
}
export interface Detection { at: number; services: DetectedService[]; rejected: Rejected[] }

// ---------------------------------------------------------------- parsing

export interface LaunchctlJob { path?: string; pid?: number; state?: string; program?: string; arguments: string[]; environment: Record<string, string> }
/**
 * Parse `launchctl print gui/<uid>/<label>`. Only top-level fields and the
 * top-level `environment` / `arguments` blocks are read; `inherited
 * environment`, `default environment` and nested blocks are ignored.
 */
export function parseLaunchctlPrint(output: string): LaunchctlJob {
  const job: LaunchctlJob = { arguments: [], environment: {} }
  let depth = 0
  let block: 'environment' | 'arguments' | undefined
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line === '}') { depth = Math.max(0, depth - 1); if (depth <= 1) block = undefined; continue }
    if (line.endsWith('{')) {
      depth++
      if (depth === 2) block = line === 'environment = {' ? 'environment' : line === 'arguments = {' ? 'arguments' : undefined
      continue
    }
    if (depth === 2 && block === 'environment') {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*) => (.*)$/)
      if (match?.[1]) job.environment[match[1]] = match[2] ?? ''
    } else if (depth === 2 && block === 'arguments') job.arguments.push(line)
    else if (depth === 1) {
      const match = line.match(/^([a-z ]+) = (.*)$/)
      if (!match) continue
      const [, key, value = ''] = match
      if (key === 'path') job.path = value
      else if (key === 'pid' && /^\d+$/.test(value)) job.pid = Number(value)
      else if (key === 'state') job.state = value
      else if (key === 'program') job.program = value
    }
  }
  return job
}

/**
 * Labels in `launchctl list` output that mention meridian. GUI app instances
 * (`application.<bundle id>.<n>`, e.g. Meridian Desktop itself) are not services.
 */
export function meridianLabels(list: string): string[] {
  return list.split('\n').map(line => line.trim().split(/\s+/)[2] ?? '').filter(label => /^[\w.-]+$/.test(label) && /meridian/i.test(label) && !label.startsWith('application.'))
}

/**
 * Whether a loaded job runs a Meridian service. A job named only by its label
 * (not by a LaunchAgents plist that mentions meridian) needs evidence: a
 * Meridian port in its environment, or a program/argument naming meridian.
 * An app bundle (Meridian Desktop) is never one.
 */
export function isMeridianJob(job: LaunchctlJob, namedByPlist: boolean): boolean {
  const command = [job.program ?? '', ...job.arguments]
  if (command.some(part => /\.app\/Contents\/MacOS\//.test(part))) return false
  if (namedByPlist) return true
  return job.environment.MERIDIAN_PORT !== undefined || job.environment.CLAUDE_PROXY_PORT !== undefined || command.some(part => /meridian/i.test(part))
}

/** Whether a LaunchAgents plist (as JSON) runs something called meridian. */
export function plistMentionsMeridian(data: unknown): boolean {
  const plist = object(data)
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments.map(text) : []
  return [text(plist.Label), text(plist.Program), ...args].some(value => /meridian/i.test(value))
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])
/**
 * Normalise a client base URL (which may carry a path such as /v1) to a
 * Meridian origin. Throws for anything that is not plain loopback HTTP, so
 * a remote URL in a client config can never be auto-attached.
 */
export function loopbackBase(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('not a URL') }
  if (url.protocol !== 'http:') throw new Error(`${url.protocol.replace(':', '')} is not supported; only local HTTP`)
  if (!loopbackHosts.has(url.hostname)) throw new Error(`${url.hostname} is not a loopback host`)
  const hostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
  return endpoint(`http://${hostname}${url.port ? `:${url.port}` : ''}/`)
}

/** Base URL a launchd job listens on; wildcard binds are reached via 127.0.0.1. */
export function launchdBase(environment: Record<string, unknown>): string {
  const address = agentAddress(environment)
  if (!Number.isInteger(address.port) || address.port < 1 || address.port > 65535) throw new Error('invalid MERIDIAN_PORT')
  const host = ['', '0.0.0.0', '::', '[::]'].includes(address.host) ? '127.0.0.1' : address.host === '::1' ? '[::1]' : address.host
  return loopbackBase(`http://${host}:${address.port}/`)
}

/** JSON with // and /* *\/ comments and trailing commas (opencode.jsonc). */
export function parseJsonc(source: string): unknown {
  let output = ''
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '"') {
      let end = index + 1
      while (end < source.length && source[end] !== '"') end += source[end] === '\\' ? 2 : 1
      output += source.slice(index, end + 1); index = end; continue
    }
    if (char === '/' && source[index + 1] === '/') { while (index < source.length && source[index] !== '\n') index++; output += '\n'; continue }
    if (char === '/' && source[index + 1] === '*') { const end = source.indexOf('*/', index + 2); index = end < 0 ? source.length : end + 1; continue }
    output += char
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1'))
}

/** Provider base URLs in an OpenCode config: provider.<id>.options.baseURL. */
export function openCodeBaseUrls(config: unknown): { provider: string; url: string }[] {
  return Object.entries(object(object(config).provider)).flatMap(([provider, value]) => {
    const options = object(object(value).options)
    const url = text(options.baseURL) || text(options.baseUrl)
    return url ? [{ provider, url }] : []
  })
}

/** Pi: MERIDIAN_BASE_URL wins, then ~/.pi/agent/models.json providers.<id>.baseUrl. */
export function piBaseUrls(models: unknown, env: Record<string, string | undefined>): { provider: string; url: string }[] {
  const found: { provider: string; url: string }[] = []
  if (env.MERIDIAN_BASE_URL) found.push({ provider: 'MERIDIAN_BASE_URL', url: env.MERIDIAN_BASE_URL })
  for (const [provider, value] of Object.entries(object(object(models).providers))) {
    const url = text(object(value).baseUrl) || text(object(value).baseURL)
    if (url) found.push({ provider, url })
  }
  return found
}

/** First source wins; later sources only add their name and missing supervisor/pid facts. */
export function dedupeCandidates(candidates: Candidate[]): (Candidate & { sources: string[] })[] {
  const byUrl = new Map<string, Candidate & { sources: string[] }>()
  for (const candidate of candidates) {
    const label = `${candidate.source}: ${candidate.detail}`
    const existing = byUrl.get(candidate.baseUrl)
    if (!existing) { byUrl.set(candidate.baseUrl, { ...candidate, sources: [label] }); continue }
    if (!existing.sources.includes(label)) existing.sources.push(label)
    if (!existing.supervisor && candidate.supervisor) existing.supervisor = candidate.supervisor
    if (existing.pid === undefined && candidate.pid !== undefined) existing.pid = candidate.pid
  }
  return [...byUrl.values()]
}

const containerProcess = /docker|vpnkit|orbstack|colima|limactl|lima|podman|gvproxy|rancher|containerd/i
/** Who supervises a listener: a launchd job (by source or by pid), a container runtime, or unknown. */
export function classifySupervisor(candidate: { supervisor?: Supervisor; pid?: number }, launchdJobs: { label: string; pid?: number; plistPath?: string }[], command?: string): Supervisor {
  if (candidate.supervisor) return candidate.supervisor
  const job = candidate.pid !== undefined ? launchdJobs.find(item => item.pid === candidate.pid) : undefined
  if (job) return { kind: 'launchd', label: job.label, ...(job.plistPath ? { plistPath: job.plistPath } : {}) }
  if (command && containerProcess.test(command)) return { kind: 'docker' }
  return { kind: 'unknown' }
}

export type AttachDecision = { kind: 'attach'; service: DetectedService } | { kind: 'managed'; reason: string }
/**
 * The first verified Meridian that is not the app's own child wins. The own
 * child is recognised by URL or by listener pid, so a managed copy on a
 * port some client also names is never mistaken for an external service.
 */
export function attachDecision(services: DetectedService[], own?: { baseUrl?: string; pid?: number }): AttachDecision {
  const external = services.filter(service => service.probe.status === 'meridian' && !(own && (service.baseUrl === own.baseUrl || (own.pid !== undefined && service.pid === own.pid))))
  const service = external[0]
  if (service) return { kind: 'attach', service }
  const checked = services.filter(item => !(own && item.baseUrl === own.baseUrl)).map(item => new URL(item.baseUrl).host)
  return { kind: 'managed', reason: checked.length ? `No running Meridian service was found (checked ${checked.join(', ')}).` : 'No running Meridian service was found.' }
}

// ---------------------------------------------------------------- I/O

export interface DetectIO {
  platform: NodeJS.Platform; home: string; env: Record<string, string | undefined>;
  /** UTF-8 text; rejects when missing. */
  readText(path: string): Promise<string>;
  /** Plists in ~/Library/LaunchAgents whose content may mention meridian, as JSON. */
  launchAgents(): Promise<{ path: string; data: unknown }[]>;
  launchctlList(): Promise<string>;
  /** `launchctl print gui/<uid>/<label>`; undefined when the job is not loaded. */
  launchctlPrint(label: string): Promise<string | undefined>;
  plist(path: string): Promise<unknown>;
  probe(baseUrl: string): Promise<Probe>;
  listenerPid(port: number): Promise<number | undefined>;
  processCommand(pid: number): Promise<string | undefined>;
}

export async function probeHealth(baseUrl: string, timeout = 1500): Promise<Probe> {
  try {
    const response = await fetch(baseUrl + '/health', { redirect: 'error', signal: AbortSignal.timeout(timeout) })
    const body: unknown = await response.json().catch(() => undefined)
    if (isMeridianHealth(body)) return { status: 'meridian', version: text(object(body).version) }
    return { status: 'not-meridian', error: `HTTP ${response.status}` }
  } catch (error) { return { status: 'unreachable', error: error instanceof Error ? error.message : String(error) } }
}

const exec = promisify(execFile)
export function nodeDetectIO(): DetectIO {
  const home = homedir()
  return {
    platform: process.platform, home, env: process.env,
    readText: path => readFile(path, 'utf8'),
    async launchAgents() {
      const directory = join(home, 'Library/LaunchAgents')
      const files = (await readdir(directory).catch(() => [] as string[])).filter(file => file.endsWith('.plist'))
      const found: { path: string; data: unknown }[] = []
      for (const file of files) {
        const path = join(directory, file)
        // Cheap prefilter: XML and binary plists both store strings as plain bytes.
        if (!/meridian/i.test(await readFile(path, 'latin1').catch(() => ''))) continue
        try { found.push({ path, data: await plistJson(path) }) } catch { /* unreadable plist: skip */ }
      }
      return found
    },
    launchctlList: () => launchctl(['list']).catch(() => ''),
    launchctlPrint: label => /^[\w.-]+$/.test(label) ? launchctl(['print', `${launchDomain()}/${label}`]).catch(() => undefined) : Promise.resolve(undefined),
    plist: path => plistJson(path),
    probe: baseUrl => probeHealth(baseUrl),
    listenerPid: port => process.platform === 'darwin' ? listeningPid(port).catch(() => undefined) : Promise.resolve(undefined),
    processCommand: pid => exec('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).then(result => result.stdout.trim() || undefined, () => undefined),
  }
}

export interface DetectOptions { preferenceEndpoint?: string }
/** Gather candidates from every source, in order, without probing. */
export async function gatherCandidates(io: DetectIO, options: DetectOptions = {}): Promise<{ candidates: Candidate[]; rejected: Rejected[]; launchdJobs: { label: string; pid?: number; plistPath?: string }[] }> {
  const candidates: Candidate[] = []
  const rejected: Rejected[] = []
  const launchdJobs: { label: string; pid?: number; plistPath?: string }[] = []
  const add = (source: DetectionSource, detail: string, url: string, extra: Partial<Candidate> = {}) => {
    try { candidates.push({ baseUrl: loopbackBase(url), source, detail, ...extra }) }
    catch (error) { rejected.push({ source, detail, url, reason: error instanceof Error ? error.message : String(error) }) }
  }
  // 1. Loaded launchd jobs.
  if (io.platform === 'darwin') {
    const agents = await io.launchAgents().catch(() => [])
    const files = new Map<string, string>()
    for (const agent of agents) if (plistMentionsMeridian(agent.data)) { const label = text(object(agent.data).Label); if (/^[\w.-]+$/.test(label)) files.set(label, agent.path) }
    const labels = [...new Set([...files.keys(), ...meridianLabels(await io.launchctlList().catch(() => ''))])]
    for (const label of labels) {
      const printed = await io.launchctlPrint(label)
      if (!printed) continue // Not loaded: a plist on disk is not a running service.
      const job = parseLaunchctlPrint(printed)
      if (!isMeridianJob(job, files.has(label))) continue
      const plistPath = job.path || files.get(label)
      launchdJobs.push({ label, pid: job.pid, plistPath })
      let environment: Record<string, unknown> = job.environment
      if (environment.MERIDIAN_PORT === undefined && environment.CLAUDE_PROXY_PORT === undefined) {
        // The loaded job's plist can live outside LaunchAgents; read that one first.
        for (const path of [job.path, files.get(label)].filter((item): item is string => Boolean(item))) {
          const env = object(object(await io.plist(path).catch(() => undefined)).EnvironmentVariables)
          if (env.MERIDIAN_PORT !== undefined || env.CLAUDE_PROXY_PORT !== undefined) { environment = { ...env, ...environment }; break }
        }
      }
      let url: string
      try { url = launchdBase(environment) } catch (error) { rejected.push({ source: 'launchd', detail: label, url: text(environment.MERIDIAN_HOST) || '?', reason: error instanceof Error ? error.message : String(error) }); continue }
      add('launchd', label, url, { supervisor: { kind: 'launchd', label, ...(plistPath ? { plistPath } : {}) }, ...(job.pid ? { pid: job.pid } : {}) })
    }
  }
  // 2. Client configs (read-only).
  const configHome = io.env.XDG_CONFIG_HOME || join(io.home, '.config')
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const path = join(configHome, 'opencode', name)
    let config: unknown
    try { config = parseJsonc(await io.readText(path)) } catch { continue }
    for (const item of openCodeBaseUrls(config)) add('opencode', `${name} provider ${item.provider}`, item.url)
  }
  let models: unknown
  try { models = JSON.parse(await io.readText(join(io.home, '.pi/agent/models.json'))) } catch { models = undefined }
  for (const item of piBaseUrls(models, io.env)) add('pi', item.provider === 'MERIDIAN_BASE_URL' ? 'MERIDIAN_BASE_URL' : `models.json provider ${item.provider}`, item.url)
  // 3. Default, 4. saved preference.
  add('default', 'http://127.0.0.1:3456', 'http://127.0.0.1:3456')
  if (options.preferenceEndpoint) add('preference', options.preferenceEndpoint, options.preferenceEndpoint)
  return { candidates, rejected, launchdJobs }
}

export async function detectServices(io: DetectIO, options: DetectOptions = {}): Promise<Detection> {
  const { candidates, rejected, launchdJobs } = await gatherCandidates(io, options)
  const services = await Promise.all(dedupeCandidates(candidates).map(async candidate => {
    const port = Number(new URL(candidate.baseUrl).port) || 80
    const [probe, listener] = await Promise.all([io.probe(candidate.baseUrl), io.listenerPid(port).catch(() => undefined)])
    const pid = listener ?? candidate.pid
    const command = pid !== undefined && !candidate.supervisor ? await io.processCommand(pid).catch(() => undefined) : undefined
    return { baseUrl: candidate.baseUrl, port, sources: candidate.sources, probe, pid, supervisor: classifySupervisor({ ...candidate, pid }, launchdJobs, command) } satisfies DetectedService
  }))
  return { at: Date.now(), services, rejected }
}
