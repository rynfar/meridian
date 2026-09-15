import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, writeFile, stat, open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { discoverLaunchAgent, suspendAgent, restoreAgent, listeningPid, savedAgent, waitForExit, type LaunchAgent } from './migration'
import { randomBytes } from 'node:crypto'
import { defaults, endpoint, object, port, redact, rows, text, version, IncidentDetector, type Preferences, type Incident, incidents, isMeridianHealth } from './core'
import type { DesktopState } from './contracts'

export interface ManagerOptions {
  /** Trusted harness overrides; never exposed through IPC. */
  serviceEnvironment?: Record<string, string>;
  directory: string; node: string; npm: string; runner: string; desktopVersion: string;
  encrypt(value: string): string; decrypt(value: string): string;
  changed(state: DesktopState): void; notify(incident: Incident): void;
}
export class Manager {
  preferences: Preferences = { ...defaults }
  state: DesktopState
  private child?: ChildProcess
  private loginChild?: ChildProcess
  private stopping = false
  private restartCount = 0
  private restartTimer?: ReturnType<typeof setTimeout>
  private refreshPromise?: Promise<void>
  private incidentWrites: Promise<void> = Promise.resolve()
  private closing = false
  private desiredRunning = false
  private configurationError?: string
  private detector = new IncidentDetector()
  private inheritedEnvironment: Record<string, string> = {}
  private adopted?: LaunchAgent
  private handoff?: { phase: 'prepared' | 'managed' | 'returning'; previous: Preferences; agent: LaunchAgent }
  private candidate?: LaunchAgent
  constructor(readonly options: ManagerOptions) {
    this.state = { desktopVersion: options.desktopVersion, platform: process.platform, glass: 'Standard appearance', preferences: defaults, hasApiKey: false, installed: [], available: [], owned: false, health: null, quota: null, requests: [], summary: null, logs: [], profiles: null, plugins: null, features: null, dataErrors: [], incidents: [], serviceLog: [] }
  }
  async init() {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    try {
      const saved = object(JSON.parse(await readFile(join(this.options.directory, 'desktop.json'), 'utf8')))
      this.preferences = this.validatePreferences(saved)
      if (saved.secret) {
        const secrets = object(JSON.parse(this.options.decrypt(text(saved.secret))))
        this.preferences.apiKey = text(secrets.apiKey) || undefined
        this.inheritedEnvironment = Object.fromEntries(Object.entries(object(secrets.environment)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        if (secrets.adopted) this.adopted = savedAgent(secrets.adopted)
        if (secrets.handoff) {
          const journal = object(secrets.handoff)
          if (!['prepared', 'managed', 'returning'].includes(text(journal.phase))) throw new Error('Invalid handoff phase.')
          this.handoff = { phase: journal.phase as 'prepared' | 'managed' | 'returning', agent: savedAgent(journal.agent), previous: { ...this.validatePreferences(journal.previous), apiKey: text(object(journal.previous).apiKey) || undefined } }
        }
      }
    } catch (error) { if (object(error).code !== 'ENOENT') this.state.error = this.configurationError = `Could not load preferences: ${String(error)}. Resolve the saved configuration before managing a service.` }
    try { this.state.incidents = incidents(JSON.parse(await readFile(join(this.options.directory, 'incidents.json'), 'utf8'))) } catch (error) { if (object(error).code !== 'ENOENT') this.log('Could not read incident history.') }
    await this.inventory()
    if (this.handoff && this.handoff.phase !== 'managed' && !this.configurationError) {
      try { await this.restoreHandoff() } catch (error) { this.state.error = this.configurationError = `Handoff recovery needs attention: ${String(error)}` }
    }
    // Existing headless installs stay running. Merely opening the app cannot
    // take over a service or change client authentication.
    if (!this.preferences.selected) {
      try {
        const response = await fetch(this.preferences.endpoint + '/health', { signal: AbortSignal.timeout(2000) })
        const health = object(await response.json())
        if (isMeridianHealth(health)) this.preferences.mode = 'attached'
      } catch { /* No local headless instance: offer the managed installer. */ }
    }
    this.publish()
  }
  private validatePreferences(value: unknown): Preferences {
    const input = object(value)
    const result = { ...this.preferences }
    if (input.mode !== undefined) { if (input.mode !== 'managed' && input.mode !== 'attached') throw new Error('Unknown service mode'); result.mode = input.mode }
    if (input.endpoint !== undefined) result.endpoint = endpoint(input.endpoint)
    if (input.port !== undefined) result.port = port(input.port)
    for (const key of ['autoStart', 'notifications'] as const) if (typeof input[key] === 'boolean') result[key] = input[key]
    if (typeof input.quietUntil === 'number' && Number.isFinite(input.quietUntil)) result.quietUntil = Math.max(0, input.quietUntil)
    if (input.selected) result.selected = version(input.selected)
    if (input.previous) result.previous = version(input.previous)
    return result
  }
  private async save() {
    const { apiKey, ...preferences } = this.preferences
    const secret = apiKey || this.adopted || this.handoff || Object.keys(this.inheritedEnvironment).length ? this.options.encrypt(JSON.stringify({ apiKey, environment: this.inheritedEnvironment, adopted: this.adopted, handoff: this.handoff })) : undefined
    const content = { ...preferences, secret }
    const file = join(this.options.directory, 'desktop.json')
    const handle = await open(file + '.tmp', 'w', 0o600)
    try { await handle.writeFile(JSON.stringify(content, null, 2)); await handle.sync() } finally { await handle.close() }
    await rename(file + '.tmp', file)
  }
  async configure(value: unknown) {
    if (this.configurationError) throw new Error(this.configurationError)
    await this.refreshPromise
    const input = object(value)
    const next = this.validatePreferences({ ...input, selected: undefined, previous: undefined })
    if (typeof input.apiKey === 'string') next.apiKey = input.apiKey.trim() || undefined
    const connectionChanged = next.mode !== this.preferences.mode || next.port !== this.preferences.port || next.endpoint !== this.preferences.endpoint || next.apiKey !== this.preferences.apiKey
    if ((this.child || this.adopted) && connectionChanged) throw new Error('Stop the managed service, or return the adopted service to headless, before changing its connection.')
    const previous = this.preferences
    this.preferences = next
    try { await this.save() } catch (error) { this.preferences = previous; throw error }
    if (connectionChanged) { this.detector = new IncidentDetector(); this.state.incidents = []; await this.persistIncidents() }
    await this.refresh()
  }
  snapshot(): DesktopState {
    const { apiKey, ...preferences } = this.preferences
    return { ...this.state, preferences, hasApiKey: Boolean(apiKey), owned: Boolean(this.child) }
  }
  publish() { this.options.changed(this.snapshot()) }
  log(line: string) { this.state.serviceLog.push(redact(line).slice(0, 2000)); this.state.serviceLog = this.state.serviceLog.slice(-300); this.publish() }
  async mutate(label: string, operation: () => Promise<void>) {
    if (this.closing) throw new Error('Meridian Desktop is shutting down.')
    if (this.state.busy) throw new Error(`Wait for ${this.state.busy.toLowerCase()} to finish.`)
    if (this.loginChild) throw new Error('Complete or cancel the profile login first.')
    this.state.busy = label; this.state.error = undefined; this.publish()
    try { await operation() } catch (error) { this.state.error = redact(error instanceof Error ? error.message : String(error)); throw error }
    finally { this.state.busy = undefined; this.publish() }
  }
  baseUrl() { return this.preferences.mode === 'managed' ? `http://127.0.0.1:${this.preferences.port}` : this.preferences.endpoint }
  async api(path: string, method = 'GET', body?: unknown): Promise<unknown> {
    const key = this.preferences.apiKey
    const response = await fetch(this.baseUrl() + path, { method, redirect: 'error', headers: { ...(key ? { 'x-api-key': key } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) })
    const data: unknown = await response.json()
    if (!response.ok && path !== '/health') throw new Error(`${path}: HTTP ${response.status} ${text(object(data).error) || text(object(object(data).error).message)}`)
    return data
  }
  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.readState().finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }
  private async readState() {
    try {
      this.state.dataErrors = []
      const health = await this.api('/health')
      if (!isMeridianHealth(health)) throw new Error('The endpoint did not return Meridian health data.')
      const routes = { quota: '/v1/usage/quota/all', requests: '/telemetry/requests?limit=500', summary: '/telemetry/summary', logs: '/telemetry/logs?limit=500', profiles: '/profiles/list', plugins: '/plugins/list', features: '/settings/api/features' } as const
      const data = await Promise.all(Object.entries(routes).map(async ([key, route]) => {
        try { return { key: key as keyof typeof routes, value: await this.api(route) } }
        catch (error) { return { key: key as keyof typeof routes, value: null, error: redact(String(error)) } }
      }))
      this.state.health = health
      this.state.running = text(object(health).version)
      for (const item of data) { this.state[item.key] = item.value; if (item.error) this.state.dataErrors.push(item.error) }
      for (const incident of this.detector.collect(this.state.requests, this.state.quota)) this.addIncident(incident)
      this.state.lastChecked = Date.now()
    } catch (error) {
      this.state.health = null; this.state.running = undefined; this.state.lastChecked = undefined
      this.state.quota = null; this.state.requests = []; this.state.summary = null; this.state.logs = []; this.state.profiles = null; this.state.plugins = null; this.state.features = null
      this.state.dataErrors = [redact(`Cannot reach ${this.baseUrl()}: ${String(error)}`)]
    } finally { this.publish() }
  }
  addIncident(incident: Incident) {
    if (this.state.incidents.some(item => item.id === incident.id)) return
    this.state.incidents = [incident, ...this.state.incidents].slice(0, 200)
    void this.persistIncidents()
    if (this.preferences.notifications && Date.now() >= this.preferences.quietUntil) this.options.notify(incident)
  }
  private persistIncidents() {
    const content = JSON.stringify(this.state.incidents)
    this.incidentWrites = this.incidentWrites.then(async () => {
      const file = join(this.options.directory, 'incidents.json')
      await writeFile(file + '.tmp', content, { mode: 0o600 }); await rename(file + '.tmp', file)
    }).catch(error => { this.log(`Cannot save incident history: ${String(error)}`) })
    return this.incidentWrites
  }
  async acknowledge() { this.state.incidents = []; await this.persistIncidents(); this.publish() }
  async inventory() {
    const directory = join(this.options.directory, 'versions'); await mkdir(directory, { recursive: true })
    const entries = await readdir(directory)
    this.state.installed = []
    for (const entry of entries) {
      try {
        version(entry)
        const manifest = object(JSON.parse(await readFile(join(directory, entry, 'node_modules/@rynfar/meridian/package.json'), 'utf8')))
        if (manifest.version === entry && manifest.name === '@rynfar/meridian') this.state.installed.push(entry)
      } catch { /* Interrupted staging directories are not installed versions. */ }
    }
    this.state.installed.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  }
  async checkUpdates() {
    const response = await fetch('https://registry.npmjs.org/@rynfar%2fmeridian', { signal: AbortSignal.timeout(15000), headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`)
    const data = object(await response.json())
    this.state.available = Object.keys(object(data.versions)).filter(item => /^\d+\.\d+\.\d+$/.test(item)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 100)
    this.state.latest = version(object(data['dist-tags']).latest)
    this.publish()
  }
  private environment(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_PROXY_|MERIDIAN_|CLAUDE_CODE_|NODE_OPTIONS$|ELECTRON_|npm_config_|NPM_CONFIG_)/.test(key)) delete env[key]
    env.PATH = [dirname(this.options.node), join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', env.PATH].filter(Boolean).join(process.platform === 'win32' ? ';' : ':')
    return env
  }
  private async command(args: string[], cwd: string, timeout = 600_000) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.node, args, { cwd, env: this.environment(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (process.platform !== 'win32' && child.pid) {
          try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (object(error).code !== 'ESRCH') this.log(String(error)) }
        } else child.kill()
      }, timeout)
      child.stdout?.on('data', chunk => this.log(String(chunk)))
      child.stderr?.on('data', chunk => this.log(String(chunk)))
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('close', code => {
        clearTimeout(timer)
        if (timedOut) reject(new Error('Installation timed out. The current version was not replaced.'))
        else if (code === 0) resolve()
        else reject(new Error(`Installer exited with code ${code}. See service logs.`))
      })
    })
  }
  async install(raw: unknown) {
    if (this.configurationError) throw new Error(this.configurationError)
    const target = version(raw)
    if (this.state.installed.includes(target)) return
    if (!this.state.available.includes(target)) { await this.checkUpdates(); if (!this.state.available.includes(target)) throw new Error('Select a published stable version from the list.') }
    if (this.state.installed.includes(target)) return
    const directory = join(this.options.directory, 'versions')
    const staging = join(directory, `.stage-${target}-${randomBytes(6).toString('hex')}`)
    await mkdir(staging, { recursive: true })
    try {
      await writeFile(join(staging, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
      await writeFile(join(staging, '.global-npmrc'), '')
      await this.command([this.options.npm, 'install', '--prefix', staging, '--userconfig', join(staging, '.npmrc'), '--globalconfig', join(staging, '.global-npmrc'), '--registry=https://registry.npmjs.org/', '--omit=dev', '--no-audit', '--no-fund', '--save-exact', `@rynfar/meridian@${target}`], staging)
      const manifest = object(JSON.parse(await readFile(join(staging, 'node_modules/@rynfar/meridian/package.json'), 'utf8')))
      if (manifest.version !== target || manifest.name !== '@rynfar/meridian') throw new Error('Installed package does not match the selected version.')
      await this.command(['--check', join(staging, 'node_modules/@rynfar/meridian/dist/cli.js')], staging, 15000)
      await rename(staging, join(directory, target))
      if (!this.preferences.selected) { this.preferences.selected = target; await this.save() }
      await this.inventory()
    } finally { await rm(staging, { recursive: true, force: true }) }
  }
  async activate(raw: unknown) {
    if (this.preferences.mode !== 'managed') throw new Error('External installations are updated by their existing package manager.')
    const target = version(raw)
    if (!this.state.installed.includes(target)) throw new Error('Install that version first.')
    const previous = { ...this.preferences }
    if (previous.selected === target) return
    const wasRunning = Boolean(this.child)
    if (wasRunning) await this.stop()
    this.preferences.selected = target; this.preferences.previous = previous.selected
    try {
      if (wasRunning) await this.start()
      await this.save()
    } catch (error) {
      if (this.child) await this.stop()
      this.preferences = previous
      try {
        if (wasRunning) await this.start()
        await this.save()
      } catch (rollbackError) {
        throw new Error(`Activation failed: ${String(error)}. Rollback also failed: ${String(rollbackError)}. Previous selection remains ${previous.selected}.`)
      }
      throw new Error(`Activation failed; restored ${previous.selected ?? 'the previous selection'}. ${String(error)}`)
    }
  }
  async start() {
    if (this.configurationError) throw new Error(this.configurationError)
    if (this.preferences.mode !== 'managed') throw new Error('External instances are controlled by their existing supervisor.')
    if (this.child) return
    await this.refreshPromise
    const selected = version(this.preferences.selected)
    if (!this.state.installed.includes(selected)) throw new Error('Install a Meridian version first.')
    await new Promise<void>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', () => reject(new Error(`Port ${this.preferences.port} is already occupied. Connect to that instance, or stop its current supervisor before starting managed Meridian.`)))
      probe.listen(this.preferences.port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()))
    })
    const entry = join(this.options.directory, 'versions', selected, 'node_modules/@rynfar/meridian/dist/cli.js')
    await stat(entry)
    this.stopping = false; this.desiredRunning = true
    const child = spawn(this.options.node, ['--import', this.options.runner, entry], {
      cwd: this.adopted?.workingDirectory || homedir(),
      env: { ...this.environment(), ...this.inheritedEnvironment, ...this.options.serviceEnvironment, MERIDIAN_PORT: String(this.preferences.port), MERIDIAN_HOST: '127.0.0.1', MERIDIAN_API_KEY: this.preferences.apiKey || '', MERIDIAN_SHUTDOWN_GRACE_MS: '30000' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    this.child = child
    child.stdout?.on('data', chunk => this.log(String(chunk)))
    child.stderr?.on('data', chunk => this.log(String(chunk)))
    child.on('error', error => { if (!child.pid && this.child === child) this.child = undefined; this.log(String(error)) })
    let ready = false
    const started = Date.now()
    child.once('exit', code => {
      if (this.child === child) this.child = undefined
      this.state.running = undefined
      if (ready && !this.stopping && !this.closing && this.desiredRunning) {
        if (Date.now() - started > 60000) this.restartCount = 0
        this.addIncident({ id: `exit:${Date.now()}`, title: 'Meridian stopped unexpectedly', detail: `Process exited with code ${code}.`, timestamp: Date.now(), severity: 'error' })
        this.scheduleRecovery()
      }
      this.publish()
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error('Meridian did not initialize within 45 seconds.')), 45000)
        const onMessage = (message: unknown) => { if (object(message).ready) finish() }
        const onExit = (code: number | null) => finish(new Error(`Meridian exited before initialization (${code}).`))
        const onError = (error: Error) => finish(error)
        function finish(error?: Error) {
          clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError)
          if (error) reject(error); else resolve()
        }
        child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit)
      })
      const deadline = Date.now() + 60000
      let lastError = 'No HTTP health response'
      while (Date.now() < deadline) {
        if (this.child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('Meridian exited during startup.')
        try {
          const health = await this.api('/health')
          if (!isMeridianHealth(health) || object(health).version !== selected) throw new Error('The service did not report the selected Meridian version.')
          if (process.platform === 'darwin' && await listeningPid(this.preferences.port) !== child.pid) throw new Error('The listening process is not owned by this app.')
          ready = true; break
        } catch (error) { lastError = String(error) }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      if (!ready) throw new Error(`Startup verification failed: ${lastError}`)
      await this.refresh()
    } catch (error) { await this.stop(); throw error }
    this.publish()
  }
  private scheduleRecovery() {
    if (this.restartCount >= 3) { this.state.error = 'Crash recovery paused after three attempts. Inspect service logs before restarting.'; this.publish(); return }
    clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      if (this.stopping || this.closing || !this.desiredRunning) return
      if (this.state.busy) { this.scheduleRecovery(); return }
      this.restartCount++
      void this.mutate('Recovering service', () => this.start()).catch(error => {
        this.log(String(error))
        // start() stops a failed child; this remains a requested recovery.
        this.stopping = false; this.desiredRunning = true; this.scheduleRecovery()
      })
    }, Math.min(30000, (this.restartCount + 1) * 3000))
  }
  async stop() {
    await this.refreshPromise
    this.stopping = true; this.desiredRunning = false
    clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) return
    if (child.exitCode !== null || child.signalCode !== null) { this.child = undefined; return }
    await new Promise<void>((resolve, reject) => {
      const onExit = () => { clearTimeout(timeout); resolve() }
      const timeout = setTimeout(() => { child.off('exit', onExit); reject(new Error('The service is still draining. It has not been force-killed.')) }, 45000)
      child.once('exit', onExit)
      child.kill('SIGTERM')
    })
    this.publish()
  }
  async restart() { this.restartCount = 0; await this.stop(); await this.start() }
  async profileLogin(raw: unknown, add: boolean) {
    if (this.preferences.mode !== 'managed') throw new Error('Use the existing installation to manage external profiles.')
    if (this.loginChild) throw new Error('A profile login is already in progress.')
    const name = text(raw)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Use a profile name containing letters, numbers, dashes or underscores.')
    const selected = version(this.preferences.selected)
    const cli = join(this.options.directory, 'versions', selected, 'node_modules/@rynfar/meridian/dist/cli.js')
    await stat(cli)
    const child = spawn(this.options.node, [cli, 'profile', add ? 'add' : 'login', name, '--headless'], { env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.loginChild = child; this.state.login = { output: '' }
    const capture = (chunk: Buffer) => {
      if (!this.state.login) return
      this.state.login.output = (this.state.login.output + String(chunk)).slice(-12000)
      const match = this.state.login.output.match(/https:\/\/(?:claude\.com|platform\.claude\.com)\/[^\s\u001b]+/)
      if (match) this.state.login.url = match[0]
      this.publish()
    }
    child.stdout?.on('data', capture); child.stderr?.on('data', capture)
    child.on('error', error => { this.state.error = String(error); this.loginChild = undefined; this.publish() })
    child.once('exit', code => { this.loginChild = undefined; if (code !== 0) this.state.error = `Profile login ended (${code}).`; this.state.login = undefined; void this.refresh() })
  }
  loginCode(raw: unknown) {
    if (raw === 'cancel') { this.loginChild?.kill(); return }
    const code = text(raw).trim()
    if (!code || code.includes('\n') || code.length > 4000) throw new Error('Paste the authorization code returned by Claude.')
    if (!this.loginChild?.stdin) throw new Error('No login is waiting for a code.')
    this.loginChild.stdin.write(code + '\n')
  }
  async inspectOwnership() {
    if (this.adopted) { this.state.migration = { label: this.adopted.label, canAdopt: false, adopted: true }; return }
    this.candidate = await discoverLaunchAgent(Number(new URL(this.baseUrl()).port) || 80)
    this.state.migration = this.candidate ? { label: this.candidate.label, canAdopt: true, adopted: false } : undefined
  }
  async takeOwnership() {
    if (this.configurationError) throw new Error(this.configurationError)
    if (this.child || this.preferences.mode !== 'attached') throw new Error('Connect to the existing instance first.')
    await this.refresh(); await this.inspectOwnership()
    const candidate = this.candidate
    if (!candidate) throw new Error('This supervisor cannot be safely adopted automatically. Keep it connected, or migrate it manually.')
    const currentVersion = version(this.state.running)
    const old = { ...this.preferences }
    const servicePort = Number(new URL(this.baseUrl()).port) || 80
    await this.install(currentVersion)
    // The encrypted journal is durable BEFORE any launchd mutation. A crash
    // anywhere in the handoff restores the previous supervisor on next launch.
    this.handoff = { phase: 'prepared', previous: old, agent: candidate }
    await this.save()
    try {
      await suspendAgent(candidate, servicePort)
      await waitForExit(candidate.pid)
      if (await listeningPid(servicePort)) throw new Error('Another process took the port during handoff.')
      this.adopted = candidate; this.inheritedEnvironment = candidate.environment
      this.preferences = { ...this.preferences, mode: 'managed', port: port(servicePort), selected: currentVersion, autoStart: true, apiKey: candidate.environment.MERIDIAN_API_KEY || candidate.environment.CLAUDE_PROXY_API_KEY || old.apiKey }
      await this.start()
      this.handoff.phase = 'managed'
      await this.save()
    } catch (error) {
      if (this.child) await this.stop()
      try { await this.restoreHandoff() }
      catch (restoreError) { throw new Error(`Handoff failed: ${String(error)}. Recovery journal retained: ${String(restoreError)}`) }
      throw error
    }
    await this.inspectOwnership()
  }
  private async restoreHandoff() {
    const journal = this.handoff
    if (!journal) throw new Error('No original supervisor recorded.')
    const servicePort = Number(new URL(journal.previous.endpoint).port) || 80
    // A child from a crashed desktop may still be draining via its watchdog.
    const current = await listeningPid(servicePort)
    if (current && current !== journal.agent.pid) {
      await waitForExit(current)
      if (await listeningPid(servicePort)) throw new Error('The port is occupied. The original supervisor was not restarted.')
    }
    await restoreAgent(journal.agent)
    const previous = this.preferences
    const adopted = this.adopted
    const environment = this.inheritedEnvironment
    this.preferences = journal.previous; this.adopted = undefined; this.inheritedEnvironment = {}; this.handoff = undefined
    try { await this.save() }
    catch (error) { this.preferences = previous; this.adopted = adopted; this.inheritedEnvironment = environment; this.handoff = journal; throw error }
    await this.refresh(); await this.inspectOwnership()
  }
  async returnHeadless() {
    if (!this.handoff) throw new Error('No adopted launchd service to restore.')
    this.handoff.phase = 'returning'; await this.save()
    await this.stop(); await this.restoreHandoff()
  }
  async shutdown() {
    if (this.state.busy) throw new Error(`Wait for ${this.state.busy.toLowerCase()} to finish before quitting.`)
    this.closing = true
    try { this.loginChild?.kill(); await this.stop(); await this.incidentWrites } catch (error) { this.closing = false; throw error }
  }
}
