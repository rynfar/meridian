import { parseProviderSnapshot } from '../../../src/telemetry/providerView'
import { createRequire } from 'node:module'
import { stripVTControlCharacters } from 'node:util'
import { catalogPlugin, pluginCatalog, registerPlugin } from './pluginCatalog'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rename, rm, writeFile, stat, open } from 'node:fs/promises'
import { dirname, join, isAbsolute, sep } from 'node:path'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import * as launchd from './migration'
import { savedAgent, type LaunchAgent } from './migration'
import { randomBytes } from 'node:crypto'
import { defaults, endpoint, object, port, redact, rows, text, version, IncidentDetector, type Preferences, type Incident, incidents, isMeridianHealth, ApiError, failureCode, classifyConnection, startingConnection, windowKind, httpStatus, readBody, API_BODY_LIMIT, ResponseTooLarge } from './core'
import { NotificationGate } from './notifications'
import type { DesktopState, DetectionReport, InstanceInfo, SettingsSection } from './contracts'
import { attachDecision, detectServices, loopbackBase, nodeDetectIO, type Detection, type DetectOptions } from './detect'
import { parseTimeseries, routesPath, summaryPath, timeseriesPath, windowRange, windowReadTtl, type Timeseries } from './uiData'

/** Claude ids are [A-Za-z0-9_-]; ChatGPT seat names may also contain dots. The server validates further. */
const profileName = /^\w[\w.-]{0,63}$/
const settingsRoutes: Record<SettingsSection, string> = { routing: '/settings/api/routing', telemetry: '/settings/api/telemetry', transcripts: '/settings/api/transcripts', updates: '/settings/api/updates', header: '/settings/api/header', layout: '/settings/api/layout', 'claude-executable': '/settings/api/claude-executable', pricing: '/settings/api/pricing', chatgpt: '/settings/api/chatgpt' }
/** The same methods the web settings page uses; pricing has its own per-model actions. */
const settingsWrites: Record<Exclude<SettingsSection, 'pricing'>, 'PUT' | 'PATCH'> = { routing: 'PUT', telemetry: 'PUT', transcripts: 'PUT', updates: 'PUT', header: 'PUT', layout: 'PUT', 'claude-executable': 'PUT', chatgpt: 'PATCH' }
const SETTINGS_TTL = 60_000

/**
 * The identity a saved key is bound to: the endpoint as detection names it
 * (`localhost` and `127.0.0.1` are one service), else the URL as saved.
 */
function serviceKey(url: string | undefined): string | undefined {
  if (!url) return undefined
  try { return loopbackBase(url) } catch { return url }
}

export interface ManagerOptions {
  /** Trusted harness overrides; never exposed through IPC. */
  serviceEnvironment?: Record<string, string>;
  directory: string; node: string; npm: string; runner: string; desktopVersion: string;
  encrypt(value: string): string; decrypt(value: string): string;
  changed(state: DesktopState): void; notify(incident: Incident): void;
  /** Service detection; tests inject a fake. Defaults to the real launchd/client-config scan. */
  detect?(options: DetectOptions): Promise<Detection>;
  /** launchd/port inspection and handoff steps; tests inject fakes. Defaults to ./migration. */
  supervisor?: Partial<Supervisor>;
}
export interface Supervisor {
  discoverLaunchAgent(port: number): Promise<LaunchAgent | undefined>;
  suspendAgent(agent: LaunchAgent, port: number): Promise<void>;
  restoreAgent(agent: LaunchAgent): Promise<void>;
  listeningPid(port: number): Promise<number | undefined>;
  waitForExit(pid: number): Promise<void>;
  /** How long a restored supervisor has to become healthy. */
  restoreTimeoutMs: number;
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
  private saving: Promise<void> = Promise.resolve()
  private incidentWrites: Promise<void> = Promise.resolve()
  private closing = false
  private desiredRunning = false
  /** desktop.json exists but could not be read: every write would replace its secrets and journal. */
  private loadError?: string
  /** The handoff journal could not be restored; returning to headless may still be retried. */
  private recoveryError?: string
  private get configurationError() { return this.loadError ?? this.recoveryError }
  /**
   * The attached endpoint the saved API key was entered for. The key is only
   * sent there (or to the app's own child, which is started with it); detection
   * switching the viewed service never carries the key to another listener.
   */
  private keyFor?: string
  private detector = new IncidentDetector()
  private notificationGate = new NotificationGate()
  private inheritedEnvironment: Record<string, string> = {}
  private adopted?: LaunchAgent
  private handoff?: { phase: 'prepared' | 'managed' | 'returning'; previous: Preferences; agent: LaunchAgent; previousKeyFor?: string }
  private candidate?: LaunchAgent
  private detection?: Detection
  private detectionNote = ''
  private attachedBase?: string
  private attachedAt = Date.now()
  private starting = false
  private settingsFetchedAt = 0
  /** When the window-scoped reads were last taken, for windowReadTtl. */
  private windowRead?: { key: string; summaryAt: number; seriesAt: number }
  private httpLogin?: { kind: 'claude-login' | 'claude-add' | 'chatgpt'; id: string }
  private chatGptTimer?: ReturnType<typeof setTimeout>
  private supervisor: Supervisor
  constructor(readonly options: ManagerOptions) {
    this.supervisor = { discoverLaunchAgent: launchd.discoverLaunchAgent, suspendAgent: launchd.suspendAgent, restoreAgent: launchd.restoreAgent, listeningPid: launchd.listeningPid, waitForExit: pid => launchd.waitForExit(pid), restoreTimeoutMs: 45000, ...options.supervisor }
    this.state = { desktopVersion: options.desktopVersion, platform: process.platform, glass: 'Standard appearance', preferences: defaults, hasApiKey: false, installed: [], available: [], owned: false, health: null, quota: null, requests: null, summary: null, logs: [], profiles: null, plugins: null, catalog: pluginCatalog, features: null, dataErrors: [], incidents: [], serviceLog: [], connection: { kind: 'stopped', message: 'Looking for Meridian…', fix: '' }, instance: null, window: { kind: defaults.window }, timeseries: null, settings: { values: {}, unavailable: [], errors: [] } }
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
          const previous = { ...this.validatePreferences(journal.previous), apiKey: text(object(journal.previous).apiKey) || undefined }
          // Journals written before keys were bound: the key was in use with that endpoint.
          this.handoff = { phase: journal.phase as 'prepared' | 'managed' | 'returning', agent: savedAgent(journal.agent), previous, previousKeyFor: serviceKey('previousKeyFor' in journal ? text(journal.previousKeyFor) || undefined : previous.endpoint) }
        }
        // Files written before keys were bound: the key was entered for the
        // saved endpoint (the only place the UI takes a key), in either mode.
        this.keyFor = serviceKey('apiKeyFor' in secrets ? text(secrets.apiKeyFor) || undefined
          : this.handoff ? this.handoff.previousKeyFor
          : this.preferences.apiKey ? this.preferences.endpoint : undefined)
      }
    } catch (error) { if (object(error).code !== 'ENOENT') this.state.error = this.loadError = `Could not load preferences: ${String(error)}. Resolve the saved configuration before managing a service.` }
    try { this.state.incidents = incidents(JSON.parse(await readFile(join(this.options.directory, 'incidents.json'), 'utf8'))) } catch (error) { if (object(error).code !== 'ENOENT') this.log('Could not read incident history.') }
    try { this.notificationGate = new NotificationGate(JSON.parse(await readFile(join(this.options.directory, 'notification-history.json'), 'utf8'))) } catch (error) { if (object(error).code !== 'ENOENT') this.log('Could not read notification history.') }
    await this.inventory()
    if (this.handoff && this.handoff.phase !== 'managed' && !this.configurationError) {
      try { await this.restoreHandoff() } catch (error) { this.state.error = this.recoveryError = `Handoff recovery needs attention: ${String(error)}` }
    }
    this.state.window = { kind: this.preferences.window }
    // View the Meridian the clients use. Attaching never takes over a service
    // or changes client authentication; it only chooses what to read.
    if (!this.configurationError) await this.detectService()
    this.publish()
  }
  private ownBaseUrl() { return `http://127.0.0.1:${this.preferences.port}` }
  /**
   * Find the running service and decide what to view. A verified external
   * Meridian is attached (draining the app's own child if one runs); with
   * none, the app-managed copy is selected. Returns whether that copy should
   * be started (it is never started here).
   */
  async detectService(): Promise<{ startManaged: boolean }> {
    if (this.adopted) {
      this.detectionNote = `Meridian Desktop manages ${this.adopted.label} after takeover; detection is paused until it is returned to headless.`
      this.state.detection = this.detectionReport(); return { startManaged: false }
    }
    const own = this.child ? { baseUrl: this.ownBaseUrl(), pid: this.child.pid } : undefined
    try { this.detection = await (this.options.detect ?? (options => detectServices(nodeDetectIO(), options)))({ preferenceEndpoint: this.preferences.endpoint }) }
    catch (error) { this.log(`Service detection failed: ${String(error)}`); this.detection = { at: Date.now(), services: [], rejected: [] } }
    const decision = attachDecision(this.detection.services, own)
    let startManaged = false
    if (decision.kind === 'attach') {
      const service = decision.service
      if (this.child) {
        // The clients use another service: drain the managed copy rather than run two.
        this.log(`Meridian found at ${service.baseUrl}; draining the app-managed copy.`)
        await this.stop()
      }
      const changed = this.preferences.mode !== 'attached' || this.preferences.endpoint !== service.baseUrl
      if (changed) {
        const endpointChanged = this.preferences.endpoint !== service.baseUrl
        this.preferences = { ...this.preferences, mode: 'attached', endpoint: service.baseUrl }
        try { await this.save() } catch (error) { this.log(`Could not save the detected connection: ${String(error)}`) }
        if (endpointChanged) { this.state.providers = undefined; this.detector = new IncidentDetector() }
      }
      this.detectionNote = `Viewing the Meridian your clients use at ${new URL(service.baseUrl).host} (${service.sources[0] ?? 'detected'}). The app-managed copy is not started.`
    } else if (this.child) {
      this.detectionNote = `${decision.reason} Viewing the app-managed copy on ${new URL(this.ownBaseUrl()).host}.`
    } else if (this.preferences.selected && this.state.installed.includes(this.preferences.selected)) {
      if (this.preferences.mode !== 'managed') {
        this.preferences = { ...this.preferences, mode: 'managed' }
        try { await this.save() } catch (error) { this.log(`Could not save the managed selection: ${String(error)}`) }
      }
      startManaged = this.preferences.autoStart
      this.detectionNote = startManaged
        ? `${decision.reason} Running the app-managed Meridian ${this.preferences.selected} on port ${this.preferences.port}.`
        : `${decision.reason} The app-managed Meridian ${this.preferences.selected} can run on port ${this.preferences.port}; start it in Service (automatic start is off).`
    } else {
      this.detectionNote = `${decision.reason} Start your Meridian service and choose Re-detect, or install a version in Versions.`
    }
    this.state.detection = this.detectionReport()
    return { startManaged }
  }
  /** Re-detect on request, then start the managed copy only when nothing else serves the clients. */
  async redetect() {
    if (this.configurationError) throw new Error(this.configurationError)
    const { startManaged } = await this.detectService()
    if (startManaged && !this.child) await this.start()
    else await this.refresh()
  }
  /** Launch policy: start the managed copy only when detection chose it. */
  shouldStartManaged() {
    return this.preferences.mode === 'managed' && this.preferences.autoStart && Boolean(this.preferences.selected) && !this.child && !this.configurationError
  }
  private detectionReport(): DetectionReport {
    const ownPid = this.child?.pid
    return {
      at: this.detection?.at ?? Date.now(), note: this.detectionNote,
      services: (this.detection?.services ?? []).map(service => ({ baseUrl: service.baseUrl, port: service.port, sources: service.sources, status: service.probe.status, ...(service.probe.version ? { version: service.probe.version } : {}), supervisor: service.supervisor, ...(service.pid !== undefined ? { pid: service.pid } : {}), own: Boolean(this.child) && (service.baseUrl === this.ownBaseUrl() || (ownPid !== undefined && service.pid === ownPid)) })),
      rejected: this.detection?.rejected ?? [],
    }
  }
  private describeInstance(): InstanceInfo {
    const baseUrl = this.baseUrl()
    if (baseUrl !== this.attachedBase) { this.attachedBase = baseUrl; this.attachedAt = Date.now() }
    const port = Number(new URL(baseUrl).port) || 80
    const version = this.state.running ?? null
    if (this.preferences.mode === 'managed') {
      return { baseUrl, port, version, attachedAt: this.attachedAt, supervisor: { kind: 'app', ...(this.adopted ? { label: this.adopted.label, plistPath: this.adopted.plist } : {}) }, detectedFrom: this.adopted ? `app-managed (taken over from ${this.adopted.label})` : 'app-managed' }
    }
    const match = this.detection?.services.find(service => service.baseUrl === baseUrl)
    return { baseUrl, port, version, attachedAt: this.attachedAt, supervisor: match?.supervisor ?? { kind: 'unknown' }, detectedFrom: match?.sources.join(', ') || 'preference: saved endpoint' }
  }
  /** Another verified Meridian from the last detection, for the wrong-port hint. */
  private alternative(baseUrl: string) {
    return this.detection?.services.find(service => service.probe.status === 'meridian' && service.baseUrl !== baseUrl && !(this.child && service.baseUrl === this.ownBaseUrl()))?.baseUrl
  }
  /** Change the dashboard window; pushes state at once, then re-reads. */
  async setWindow(raw: unknown) {
    const kind = windowKind(raw)
    if (this.configurationError) throw new Error(this.configurationError)
    if (kind === this.preferences.window && this.state.window.kind === kind) return
    this.preferences = { ...this.preferences, window: kind }
    // Data for the previous window must not be shown under the new label.
    this.state.window = { kind }; this.state.summary = null; this.state.timeseries = null; this.state.timeseriesNote = undefined; this.state.routesSummary = null
    this.publish()
    try { await this.save() } catch (error) { this.log(`Could not save the window: ${String(error)}`) }
    await this.refresh(true)
  }
  private validatePreferences(value: unknown): Preferences {
    const input = object(value)
    const result = { ...this.preferences }
    if (input.mode !== undefined) { if (input.mode !== 'managed' && input.mode !== 'attached') throw new Error('Unknown service mode'); result.mode = input.mode }
    if (input.backend !== undefined) { if (!['claude', 'antigravity', 'combined'].includes(String(input.backend))) throw new Error('Unknown backend'); result.backend = input.backend as Preferences['backend'] }
    if (typeof input.allowAntigravityTools === 'boolean') result.allowAntigravityTools = input.allowAntigravityTools
    if (typeof input.allowAntigravityBrowser === 'boolean') result.allowAntigravityBrowser = input.allowAntigravityBrowser
    if (typeof input.persistAntigravityHistory === 'boolean') result.persistAntigravityHistory = input.persistAntigravityHistory
    if (typeof input.allowAntigravitySubagents === 'boolean') result.allowAntigravitySubagents = input.allowAntigravitySubagents
    if (input.endpoint !== undefined) result.endpoint = endpoint(input.endpoint)
    if (input.port !== undefined) result.port = port(input.port)
    for (const key of ['autoStart', 'notifications', 'notificationCritical', 'notificationRequests', 'notificationCache', 'notificationQuota', 'openWindowAtLaunch', 'hideDockIcon'] as const) if (typeof input[key] === 'boolean') result[key] = input[key]
    if (typeof input.quietUntil === 'number' && Number.isFinite(input.quietUntil)) result.quietUntil = Math.max(0, input.quietUntil)
    if (input.window !== undefined) result.window = windowKind(input.window)
    if (input.selected) result.selected = version(input.selected)
    if (input.previous) result.previous = version(input.previous)
    return result
  }
  /**
   * Persist preferences. Refuses while the saved configuration could not be
   * read (writing would replace its encrypted secrets and handoff journal). A
   * failed handoff recovery does not block writes: retrying the return to
   * headless must update the journal it read successfully. Also
   * serializes writes so overlapping saves cannot interleave on the temp file;
   * each write snapshots the preferences when it runs, so the last one wins.
   */
  private save(): Promise<void> {
    if (this.loadError) return Promise.reject(new Error(this.loadError))
    const write = this.saving.then(() => this.writePreferences(), () => this.writePreferences())
    this.saving = write.then(() => undefined, () => undefined)
    return write
  }
  private async writePreferences() {
    const { apiKey, ...preferences } = this.preferences
    const secret = apiKey || this.adopted || this.handoff || Object.keys(this.inheritedEnvironment).length ? this.options.encrypt(JSON.stringify({ apiKey, apiKeyFor: apiKey ? this.keyFor ?? '' : '', environment: this.inheritedEnvironment, adopted: this.adopted, handoff: this.handoff ? { ...this.handoff, previousKeyFor: this.handoff.previousKeyFor ?? '' } : undefined })) : undefined
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
    // Entering a key binds it to the endpoint being saved with it. Changing the
    // address alone keeps the key with the endpoint it was entered for.
    const keyEntered = typeof input.apiKey === 'string'
    if (typeof input.apiKey === 'string') next.apiKey = input.apiKey.trim() || undefined
    const nextKeyFor = !next.apiKey ? undefined : keyEntered ? serviceKey(next.endpoint) : this.keyFor
    const connectionChanged = next.persistAntigravityHistory !== this.preferences.persistAntigravityHistory || next.allowAntigravityBrowser !== this.preferences.allowAntigravityBrowser || next.allowAntigravitySubagents !== this.preferences.allowAntigravitySubagents || next.backend !== this.preferences.backend || next.allowAntigravityTools !== this.preferences.allowAntigravityTools || next.mode !== this.preferences.mode || next.port !== this.preferences.port || next.endpoint !== this.preferences.endpoint || next.apiKey !== this.preferences.apiKey
    if ((this.child || this.adopted) && connectionChanged) throw new Error('Stop the managed service, or return the adopted service to headless, before changing its connection.')
    const previous = this.preferences
    const previousKeyFor = this.keyFor
    this.preferences = next; this.keyFor = nextKeyFor
    try { await this.save() } catch (error) { this.preferences = previous; this.keyFor = previousKeyFor; throw error }
    if (connectionChanged) { this.state.providers = undefined; this.detector = new IncidentDetector(); this.state.incidents = []; await this.persistIncidents() }
    await this.refresh()
  }
  snapshot(): DesktopState {
    const { apiKey, ...preferences } = this.preferences
    return { ...this.state, preferences, hasApiKey: Boolean(apiKey) && this.keyApplies(), owned: Boolean(this.child) }
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
  baseUrl() { return this.preferences.mode === 'managed' ? this.ownBaseUrl() : this.preferences.endpoint }
  /** Whether the saved key belongs to the selected service (the app's own child, or the endpoint it was entered for). */
  private keyApplies() { return this.preferences.mode === 'managed' || (this.keyFor !== undefined && this.keyFor === serviceKey(this.preferences.endpoint)) }
  /** The key to send to the viewed service, if any. */
  private sendableKey() {
    const key = this.preferences.apiKey
    if (!key) return undefined
    // The managed key is only ever sent to the child the app started with it.
    if (this.preferences.mode === 'managed') return this.child ? key : undefined
    return this.keyFor !== undefined && this.keyFor === serviceKey(this.preferences.endpoint) ? key : undefined
  }
  /** The other endpoint a saved key belongs to, when it is withheld from the viewed one. */
  private keyElsewhere() { return this.preferences.apiKey && !this.keyApplies() ? this.keyFor : undefined }
  /** HTTP to the viewed Meridian. Failures are ApiError (status/code) so callers can classify them. */
  async api(path: string, method = 'GET', body?: unknown, timeout = 8000): Promise<unknown> {
    const key = this.sendableKey()
    let response: Response
    try {
      response = await fetch(this.baseUrl() + path, { method, redirect: 'error', headers: { ...(key ? { 'x-api-key': key } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) })
    } catch (error) {
      const code = failureCode(error)
      throw new ApiError(`${path}: ${code === 'refused' ? 'connection refused' : code === 'timeout' ? 'timed out' : error instanceof Error ? error.message : String(error)}`, path, code)
    }
    let raw: string
    try { raw = await readBody(response, API_BODY_LIMIT) }
    catch (error) {
      if (error instanceof ResponseTooLarge) throw new ApiError(`${path}: ${error.message}`, path, response.ok ? 'invalid' : 'http', response.status)
      // A body that stalls or resets is a connection failure, not a non-Meridian answer.
      const code = failureCode(error)
      throw new ApiError(`${path}: ${code === 'timeout' ? 'timed out' : error instanceof Error ? error.message : String(error)}`, path, code, response.status)
    }
    let data: unknown
    try { data = raw ? JSON.parse(raw) : null } catch { throw new ApiError(`${path}: HTTP ${response.status} (not JSON)`, path, response.ok ? 'invalid' : 'http', response.status) }
    if (!response.ok && path !== '/health') throw new ApiError(`${path}: HTTP ${response.status} ${text(object(data).error) || text(object(object(data).error).message)}`.trim(), path, 'http', response.status, data)
    return data
  }
  /** `force` re-reads after an in-flight refresh, e.g. when the window changed under it. */
  /** `force` also re-reads window-scoped data that windowReadTtl would reuse. */
  refresh(force = false): Promise<void> {
    if (this.refreshPromise) return force ? this.refreshPromise.then(() => this.refresh(true)) : this.refreshPromise
    this.refreshPromise = this.readState(force).finally(() => { this.refreshPromise = undefined })
    return this.refreshPromise
  }
  private async readState(force = false) {
    const baseUrl = this.baseUrl()
    // What is actually sent: a managed key with no child running is not.
    const hasApiKey = Boolean(this.sendableKey())
    const keyElsewhere = this.keyElsewhere()
    const managed = this.preferences.mode === 'managed'
    const now = Date.now()
    const window = this.preferences.window
    let health: unknown
    try {
      this.state.dataErrors = []
      try { health = await this.api('/health', 'GET', undefined, 4000) }
      catch (error) { throw Object.assign(new Error(String(error)), { healthError: error }) }
      if (!isMeridianHealth(health)) throw Object.assign(new Error('The endpoint did not return Meridian health data.'), { notMeridian: true })
      const routes = { quota: '/v1/usage/quota/all', requests: '/telemetry/requests?limit=500', summary: summaryPath(window, now), logs: '/telemetry/logs?limit=500', profiles: '/profiles/list', plugins: '/plugins/list', features: '/settings/api/features', routesSummary: routesPath(window, now), retention: '/telemetry/retention' } as const
      // Reuse window-scoped reads within their TTL (same service, window and range start).
      const readKey = `${baseUrl}|${window}|${windowRange(window, now).start}`
      const ttl = windowReadTtl[window]
      const previousRead = !force && this.windowRead?.key === readKey ? this.windowRead : undefined
      const reuseSummary = previousRead !== undefined && now - previousRead.summaryAt < ttl.summary && this.state.summary !== null
      const reuseSeries = previousRead !== undefined && now - previousRead.seriesAt < ttl.series && (this.state.timeseries !== null || this.state.timeseriesNote !== undefined)
      const skipped = new Set<string>([...(reuseSummary ? ['summary'] : []), ...(reuseSeries ? ['routesSummary'] : [])])
      const data = await Promise.all(Object.entries(routes).filter(([key]) => !skipped.has(key)).map(async ([key, route]) => {
        if (object(health).backend === 'antigravity' && (key === 'routesSummary' || key === 'retention')) return { key: key as keyof typeof routes, value: null }
        try { return { key: key as keyof typeof routes, value: await this.api(route) } }
        catch (error) { return { key: key as keyof typeof routes, value: null, error: redact(String(error)), status: httpStatus(error) } }
      }))
      // Optional on older Meridian versions. Provider data has its own scope;
      // never feed Google quota windows into Claude's profile switcher.
      try {
        this.state.providers = parseProviderSnapshot(await this.api('/providers/status'))
      } catch (error) {
        if (httpStatus(error) === 404) this.state.providers = undefined
        else {
          this.state.dataErrors.push(redact(`Providers: ${String(error)}`))
          if (this.state.providers) this.state.providers = { ...this.state.providers, fetchedAt: Date.now(), providers: this.state.providers.providers.map(p => p.enabled ? { ...p, status: 'unavailable', error: 'Provider refresh failed. Last known data shown.', accounts: p.accounts.map(a => ({ ...a, error: a.error || 'Usage refresh failed' })) } : p) }
        }
      }
      // Older Meridian has no /telemetry/timeseries: null + note, and the UI
      // buckets `requests` itself (uiData.bucketRequests).
      let timeseriesStatus: number | undefined
      let timeseries: Timeseries | null = this.state.timeseries
      let timeseriesNote: string | undefined = this.state.timeseriesNote
      if (!reuseSeries) try {
        const series = parseTimeseries(await this.api(timeseriesPath(window, now)))
        timeseries = series ?? null
        timeseriesNote = series ? undefined : 'The timeseries response was not understood; charts use the recent requests list.'
      } catch (error) {
        timeseriesStatus = httpStatus(error)
        timeseries = null
        timeseriesNote = timeseriesStatus === 404
          ? `Meridian ${text(object(health).version)} has no /telemetry/timeseries; charts are estimated from the latest 500 requests.`
          : redact(`Timeseries unavailable: ${String(error)}`)
      }
      if (this.preferences.window !== window) return // A newer window is being read.
      this.state.timeseries = timeseries; this.state.timeseriesNote = timeseriesNote
      // A failed read is retried on the next poll, never reused.
      const summaryRead = data.find(item => item.key === 'summary')
      const routesRead = data.find(item => item.key === 'routesSummary')
      this.windowRead = {
        key: readKey,
        summaryAt: reuseSummary && previousRead ? previousRead.summaryAt : summaryRead && !summaryRead.error ? now : 0,
        seriesAt: reuseSeries && previousRead ? previousRead.seriesAt : (timeseriesStatus === undefined || timeseriesStatus === 404) && !routesRead?.error ? now : 0,
      }
      this.state.health = health
      this.state.running = text(object(health).version)
      for (const item of data) { this.state[item.key] = item.value; if (item.error) this.state.dataErrors.push(item.error) }
      const denied = [...data.map(item => item.status), timeseriesStatus].find(status => status === 401 || status === 403)
      if (this.state.providers?.providers.some(p => p.id === 'claude' && p.enabled) && this.state.providers.providers.some(p => p.id === 'antigravity' && p.enabled) && this.state.requests !== null) {
        try { this.state.requests = [...rows(this.state.requests).map(r => ({ ...r, provider: 'claude' })), ...rows(await this.api('/antigravity/telemetry/requests'))].sort((a, b) => Number(object(b).timestamp) - Number(object(a).timestamp)).slice(0, 500) }
        catch (error) { this.state.dataErrors.push(redact(`Antigravity requests: ${String(error)}`)) }
      }
      if (!denied) await this.readSettings()
      this.state.connection = classifyConnection({ baseUrl, hasApiKey, managed, health, dataStatus: denied, ...(keyElsewhere ? { keyElsewhere } : {}) })
      if (this.state.requests !== null) for (const incident of this.detector.collect(this.state.requests, this.state.quota)) this.addIncident(incident)
      this.state.lastChecked = Date.now()
      // Handoff inspection failing (e.g. ambiguous listeners) must not blank readable data.
      try { await this.inspectOwnership() } catch (error) { this.state.migration = undefined; this.state.dataErrors.push(redact(`Supervisor inspection: ${String(error)}`)) }
    } catch (error) {
      this.state.providers = undefined
      this.state.health = null; this.state.running = undefined; this.state.lastChecked = undefined
      this.state.quota = null; this.state.requests = null; this.state.summary = null; this.state.logs = []; this.state.profiles = null; this.state.plugins = null; this.state.features = null; this.state.routesSummary = null; this.state.retention = null
      this.state.timeseries = null; this.state.timeseriesNote = undefined; this.windowRead = undefined
      const failure = object(error)
      this.state.connection = classifyConnection({ baseUrl, hasApiKey, managed, alternative: this.alternative(baseUrl), ...(keyElsewhere ? { keyElsewhere } : {}), ...(failure.healthError !== undefined ? { healthError: failure.healthError } : failure.notMeridian ? { health } : { healthError: error }) })
      this.state.dataErrors = [redact(`Cannot read ${baseUrl}: ${String(failure.healthError ?? error)}`)]
    } finally {
      if (this.starting) this.state.connection = startingConnection(baseUrl)
      this.state.instance = this.describeInstance()
      this.state.detection = this.detection || this.detectionNote ? this.detectionReport() : undefined
      try {
        const configured = this.preferences.mode === 'managed' ? await this.configuredPlugins() : []
        this.state.catalog = this.state.catalog?.map(plugin => ({ ...plugin, installed: configured.find(item => item.name === plugin.package && item.enabled)?.version }))
      } catch (error) { this.state.dataErrors.push(redact(`Plugin configuration: ${String(error)}`)) }
      this.publish()
    }
  }
  /** GET every /settings/api section the web settings page reads; at most once a minute unless forced. */
  async readSettings(force = false) {
    if (!force && Date.now() - this.settingsFetchedAt < SETTINGS_TTL) return
    const values: Partial<Record<SettingsSection, unknown>> = {}
    const unavailable: SettingsSection[] = []
    const errors: string[] = []
    await Promise.all((Object.entries(settingsRoutes) as [SettingsSection, string][]).map(async ([section, route]) => {
      try { values[section] = await this.api(route) }
      catch (error) { values[section] = null; if (httpStatus(error) === 404) unavailable.push(section); else errors.push(redact(`${section}: ${String(error)}`)) }
    }))
    this.settingsFetchedAt = Date.now()
    this.state.settings = { fetchedAt: this.settingsFetchedAt, values, unavailable, errors }
  }
  async updateSettings(raw: unknown) {
    const input = object(raw)
    const section = text(input.section) as keyof typeof settingsWrites
    if (!Object.hasOwn(settingsWrites, section)) throw new Error('Unknown settings section.')
    if (input.body === null || typeof input.body !== 'object' || Array.isArray(input.body) || JSON.stringify(input.body).length > 32_000) throw new Error('Settings must be a JSON object.')
    await this.api(settingsRoutes[section], settingsWrites[section], input.body)
    await this.readSettings(true); await this.refresh(true)
  }
  /** DELETE where the web page offers a reset: ChatGPT features, or one adapter's SDK features. */
  async resetSettings(raw: unknown) {
    const input = object(raw)
    if (text(input.section) === 'chatgpt') await this.api('/settings/api/chatgpt', 'DELETE')
    else if (text(input.section) === 'features') {
      const adapter = text(input.adapter)
      if (!/^[\w-]{1,64}$/.test(adapter)) throw new Error('Invalid adapter.')
      await this.api('/settings/api/features/' + encodeURIComponent(adapter), 'DELETE')
    } else throw new Error('That section has no reset.')
    await this.readSettings(true); await this.refresh(true)
  }
  async setPricing(raw: unknown) {
    const input = object(raw)
    const model = this.pricingModel(input.model)
    if (input.pricing === null || typeof input.pricing !== 'object' || Array.isArray(input.pricing)) throw new Error('Pricing must be an object.')
    await this.api('/settings/api/pricing/' + encodeURIComponent(model), 'PUT', input.pricing)
    await this.readSettings(true); this.publish()
  }
  async deletePricing(raw: unknown) {
    await this.api('/settings/api/pricing/' + encodeURIComponent(this.pricingModel(typeof raw === 'string' ? raw : object(raw).model)), 'DELETE')
    await this.readSettings(true); this.publish()
  }
  private pricingModel(value: unknown) {
    const model = text(value)
    if (!/^[\w.:@/-]{1,128}$/.test(model)) throw new Error('Invalid model name.')
    return model
  }
  private profileEntry(id: string) { return rows(object(this.state.profiles).profiles).find(item => item.id === id) }
  private isChatGptSeat(id: string) { return typeof this.profileEntry(id)?.seat === 'string' }
  /** HTTP in every mode: /profiles/active serves Claude accounts and ChatGPT seats alike. */
  async switchProfile(raw: unknown) {
    const profile = text(raw)
    if (!profileName.test(profile)) throw new Error('Invalid profile name.')
    await this.api('/profiles/active', 'POST', { profile }); await this.refresh(true)
  }
  async renameProfile(raw: unknown) {
    const input = object(raw)
    const from = text(input.from), to = text(input.to)
    if (!profileName.test(from) || !profileName.test(to)) throw new Error('Invalid profile name.')
    await this.api('/profiles/rename', 'POST', { from, to }); await this.refresh(true)
  }
  /** Saves the pool order the way the web profile page does (PUT /settings/api/routing). */
  async reorderProfiles(raw: unknown) {
    const order = Array.isArray(raw) ? raw : object(raw).order
    if (!Array.isArray(order) || !order.length || order.length > 200 || order.some(item => typeof item !== 'string' || !profileName.test(item)) || new Set(order).size !== order.length) throw new Error('Provide each account once, in the new order.')
    await this.api('/settings/api/routing', 'PUT', { profileOrder: order })
    await this.readSettings(true); await this.refresh(true)
  }
  /**
   * ChatGPT seats are removed over HTTP in every mode. Claude accounts have
   * no HTTP removal route; the managed CLI removes them, so on an external
   * service the command must run on its host (copy-profile-remove).
   */
  async removeProfile(raw: unknown) {
    const profile = typeof raw === 'string' ? raw : text(object(raw).profile)
    if (!profileName.test(profile)) throw new Error('Invalid profile name.')
    if (this.isChatGptSeat(profile)) { await this.api('/profiles/chatgpt/remove', 'POST', { profile }); await this.refresh(true); return }
    if (this.preferences.mode !== 'managed') throw new Error(`Claude accounts on an external service are removed on its host: run "meridian profile remove ${profile}" there.`)
    const cli = join(this.options.directory, 'versions', version(this.preferences.selected), 'node_modules/@rynfar/meridian/dist/cli.js')
    await stat(cli)
    await this.command([cli, 'profile', 'remove', profile], homedir(), 60_000, 'Account removal')
    await this.refresh(true)
  }
  async chatGptRefresh(raw: unknown) {
    const profile = typeof raw === 'string' ? raw : text(object(raw).profile)
    if (!profileName.test(profile)) throw new Error('Invalid profile name.')
    await this.api('/profiles/chatgpt/refresh', 'POST', { profile }); await this.refresh(true)
  }
  /** ChatGPT seat sign-in over HTTP (any mode): device code first, browser redirect as the web page's fallback. */
  async chatGptConnect(raw: unknown) {
    this.assertNoLogin()
    const input = object(raw)
    const name = text(input.name).trim(), profile = text(input.profile)
    if ((name && !profileName.test(name)) || (profile && !profileName.test(profile))) throw new Error('Use a name containing letters, numbers, dashes or underscores.')
    const body = profile ? { profile } : name ? { name } : {}
    const label = profile || name || 'ChatGPT'
    let reply: Record<string, unknown>
    try {
      reply = object(await this.api('/profiles/chatgpt/connect/device', 'POST', body))
      this.state.login = { profile: label, phase: 'waiting', provider: 'chatgpt', via: 'http', url: text(reply.verificationUrl), userCode: text(reply.userCode), output: 'Open the link in any browser, sign in to ChatGPT and enter the one-time code.' }
    } catch (error) {
      const status = httpStatus(error), code = text(object(error instanceof ApiError ? error.data : undefined).code)
      if (status === 404 && !code) throw new Error('This Meridian version does not support ChatGPT sign-in.')
      if (['invalid_profile_id', 'chatgpt_signin_unavailable', 'unknown_profile'].includes(code) || status === 403) throw error
      reply = object(await this.api('/profiles/chatgpt/connect/start', 'POST', body))
      this.state.login = { profile: label, phase: 'waiting', provider: 'chatgpt', via: 'http', url: text(reply.authorizeUrl), output: 'Sign in to ChatGPT in the browser. If the page does not return to Meridian, paste the address it ended on.' }
    }
    const connectId = text(reply.connectId)
    if (!connectId || !this.state.login.url) { this.state.login = undefined; throw new Error('Meridian did not return a ChatGPT sign-in.') }
    this.httpLogin = { kind: 'chatgpt', id: connectId }
    this.publish(); this.pollChatGpt()
  }
  private pollChatGpt() {
    clearTimeout(this.chatGptTimer)
    const current = this.httpLogin
    if (current?.kind !== 'chatgpt') return
    this.chatGptTimer = setTimeout(async () => {
      if (this.httpLogin !== current || this.closing) return
      try {
        const status = object(await this.api('/profiles/chatgpt/connect/status?connectId=' + encodeURIComponent(current.id)))
        if (this.httpLogin !== current) return
        if (status.status === 'waiting' || status.status === 'exchanging') { this.pollChatGpt(); return }
        this.finishHttpLogin(status.status === 'completed' ? 'success' : 'error', status.status === 'completed' ? `Connected ${text(status.email) || text(status.profile) || 'the seat'}.` : text(status.message) || text(status.error) || 'The sign-in failed.')
      } catch (error) {
        if (this.httpLogin !== current) return
        const status = httpStatus(error)
        if (status === 410 || status === 404) this.finishHttpLogin('error', redact(String(error)))
        else this.pollChatGpt()
      }
    }, 1500)
  }
  private finishHttpLogin(phase: 'success' | 'error' | 'cancelled', output: string) {
    clearTimeout(this.chatGptTimer)
    this.httpLogin = undefined
    if (this.state.login) { this.state.login.phase = phase; this.state.login.output = output; this.state.login.url = undefined; this.state.login.userCode = undefined }
    this.publish(); if (phase === 'success') void this.refresh(true)
  }
  private assertNoLogin() {
    if (this.loginChild || this.httpLogin) throw new Error('A profile login is already in progress.')
  }
  /** Claude sign-in through the viewed server's /profiles/{login,add} routes (paste-code flow). */
  private async httpProfileLogin(name: string, add: boolean) {
    this.assertNoLogin()
    let reply: Record<string, unknown>
    try { reply = object(await this.api(add ? '/profiles/add/start' : '/profiles/login/start', 'POST', { profile: name })) }
    catch (error) {
      if (httpStatus(error) === 404 && !text(object(error instanceof ApiError ? error.data : undefined).code)) throw new Error(`This Meridian version cannot sign in over HTTP. Run "meridian profile ${add ? 'add' : 'login'} ${name}" on its host.`)
      throw error
    }
    const id = text(add ? reply.addId : reply.loginId)
    const url = text(add ? reply.authorizeUrl : reply.pasteAuthorizeUrl || reply.authorizeUrl)
    if (!id || !url) throw new Error('Meridian did not return a sign-in link.')
    this.httpLogin = { kind: add ? 'claude-add' : 'claude-login', id }
    this.state.login = { profile: name, phase: 'waiting', provider: 'claude', via: 'http', url, output: 'Open the sign-in link, authorize, then paste the code Claude shows.' }
    this.publish()
  }
  private async httpLoginCode(raw: unknown) {
    const current = this.httpLogin
    const login = this.state.login
    if (!current || !login) return
    if (raw === 'dismiss') throw new Error('Cancel sign-in before dismissing it.')
    if (raw === 'cancel') {
      if (current.kind === 'chatgpt') { try { await this.api('/profiles/chatgpt/connect/cancel', 'POST', { connectId: current.id }) } catch (error) { this.log(`ChatGPT sign-in cancel: ${String(error)}`) } }
      if (this.httpLogin === current) this.finishHttpLogin('cancelled', '')
      return
    }
    const code = text(raw).trim()
    if (!code || /[\r\n]/.test(code) || code.length > 4000) throw new Error(current.kind === 'chatgpt' ? 'Paste the address the sign-in tab ended on.' : 'Paste the authorization code returned by Claude.')
    if (login.phase !== 'waiting') throw new Error('Wait for the browser sign-in link before submitting a code.')
    login.phase = 'verifying'; this.publish()
    const [path, body] = current.kind === 'chatgpt' ? ['/profiles/chatgpt/connect/complete', { connectId: current.id, url: code }] : current.kind === 'claude-add' ? ['/profiles/add/complete', { addId: current.id, code }] : ['/profiles/login/complete', { loginId: current.id, code }]
    try {
      await this.api(path, 'POST', body)
      if (this.httpLogin === current) this.finishHttpLogin('success', `Signed in ${login.profile}.`)
    } catch (error) {
      if (this.httpLogin !== current) return
      const data = object(error instanceof ApiError ? error.data : undefined)
      const message = text(data.error) || redact(String(error))
      if (data.retryable === true) { login.phase = 'waiting'; login.output = message; this.publish() }
      else this.finishHttpLogin('error', message)
    }
  }
  addIncident(incident: Incident) {
    if (this.state.incidents.some(item => item.id === incident.id)) return
    this.state.incidents = [incident, ...this.state.incidents].slice(0, 200)
    const notification = this.notificationGate.choose(incident, this.preferences)
    void this.persistIncidents()
    if (notification) this.options.notify(notification)
  }
  private persistIncidents() {
    const content = JSON.stringify(this.state.incidents)
    const notificationHistory = JSON.stringify(this.notificationGate.snapshot())
    this.incidentWrites = this.incidentWrites.then(async () => {
      const file = join(this.options.directory, 'incidents.json')
      await writeFile(file + '.tmp', content, { mode: 0o600 }); await rename(file + '.tmp', file)
      const history = join(this.options.directory, 'notification-history.json')
      await writeFile(history + '.tmp', notificationHistory, { mode: 0o600 }); await rename(history + '.tmp', history)
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
  private async command(args: string[], cwd: string, timeout = 600_000, label = 'Installer') {
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
        if (timedOut) reject(new Error(label === 'Installer' ? 'Installation timed out. The current version was not replaced.' : `${label} timed out.`))
        else if (code === 0) resolve()
        else reject(new Error(`${label} exited with code ${code}. See service logs.`))
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
  private pluginConfigPath() { return this.options.serviceEnvironment?.MERIDIAN_PLUGIN_CONFIG || this.inheritedEnvironment.MERIDIAN_PLUGIN_CONFIG || join(homedir(), '.config/meridian/plugins.json') }
  private async configuredPlugins() {
    let source = ''
    try { source = await readFile(this.pluginConfigPath(), 'utf8') } catch (error) { if (object(error).code !== 'ENOENT') throw error }
    const found: { path: string; name: string; version: string; enabled: boolean }[] = []
    for (const item of rows(source ? object(JSON.parse(source)).plugins : [])) {
      const entry = text(item.path)
      if (!isAbsolute(entry)) continue
      let directory = dirname(entry)
      for (let depth = 0; depth < 8; depth++) {
        try {
          const manifest = object(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')))
          if (pluginCatalog.some(plugin => plugin.package === manifest.name)) found.push({path:entry, name:text(manifest.name), version:version(manifest.version), enabled:item.enabled !== false})
          break
        } catch (error) { if (object(error).code !== 'ENOENT') break }
        const parent = dirname(directory); if (parent === directory) break; directory = parent
      }
    }
    return found
  }
  async checkPlugins() {
    const configured = this.preferences.mode === 'managed' ? await this.configuredPlugins() : []
    this.state.catalog = await Promise.all(pluginCatalog.map(async plugin => {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(plugin.package)}/latest`, { signal: AbortSignal.timeout(15000) })
      if (!response.ok) throw new Error(`Cannot check ${plugin.title}: HTTP ${response.status}`)
      return { ...plugin, latest: version(object(await response.json()).version), installed: configured.find(item => item.name === plugin.package && item.enabled)?.version }
    }))
    this.publish()
  }
  async installPlugin(raw: unknown) {
    if (this.configurationError) throw new Error(this.configurationError)
    if (this.preferences.mode !== 'managed') throw new Error('External services manage their own plugin files. Select app management to install locally.')
    const plugin = catalogPlugin(raw)
    await this.checkPlugins()
    const target = version(this.state.catalog?.find(item => item.id === plugin.id)?.latest)
    const configPath = this.pluginConfigPath()
    const readConfig = async () => { try { return await readFile(configPath, 'utf8') } catch (error) { if (object(error).code === 'ENOENT') return ''; throw error } }
    const original = await readConfig()
    registerPlugin(original, '/validation-only', [])
    const root = join(dirname(configPath), 'desktop-plugins', plugin.id)
    const directory = join(root, target)
    const staging = join(root, `.stage-${randomBytes(6).toString('hex')}`)
    await mkdir(staging, { recursive: true })
    try {
      let installed = false
      try { const manifest = object(JSON.parse(await readFile(join(directory, 'node_modules', plugin.package, 'package.json'), 'utf8'))); installed = manifest.name === plugin.package && manifest.version === target } catch (error) { if (object(error).code !== 'ENOENT') throw error }
      if (!installed) {
        await writeFile(join(staging, 'package.json'), '{"private":true}\n')
        await writeFile(join(staging, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
        await writeFile(join(staging, '.global-npmrc'), '')
        await this.command([this.options.npm, 'install', '--prefix', staging, '--userconfig', join(staging, '.npmrc'), '--globalconfig', join(staging, '.global-npmrc'), '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--save-exact', `${plugin.package}@${target}`], staging)
        const manifest = object(JSON.parse(await readFile(join(staging, 'node_modules', plugin.package, 'package.json'), 'utf8')))
        if (manifest.name !== plugin.package || manifest.version !== target) throw new Error('Plugin package did not match the selected release.')
        await rename(staging, directory)
      }
      const entry = createRequire(join(directory, 'package.json')).resolve(plugin.package)
      await this.command(['--check', entry], directory, 15000)
      const previousPaths = rows(object(this.state.plugins).plugins).filter(item => item.name === plugin.id).map(item => text(item.path)).filter(Boolean)
      previousPaths.push(...(await this.configuredPlugins()).filter(item => item.name === plugin.package).map(item => item.path))
      // Also replace an older desktop installation when the service is stopped.
      if (original) for (const item of rows(object(JSON.parse(original)).plugins)) if (text(item.path).startsWith(root + sep)) previousPaths.push(text(item.path))
      const updated = registerPlugin(original, entry, previousPaths)
      if (await readConfig() !== original) throw new Error('Plugin configuration changed during installation. Retry to preserve the latest settings.')
      const temporary = configPath + `.desktop-${randomBytes(6).toString('hex')}`
      try { await writeFile(temporary, updated, { mode: 0o600, flag: 'wx' }); await rename(temporary, configPath) }
      finally { await rm(temporary, { force: true }) }
      this.state.catalog = this.state.catalog?.map(item => item.id === plugin.id ? { ...item, installed: target } : item)
      if (this.child) { await this.api('/plugins/reload', 'POST'); await this.refresh(); const loaded = rows(object(this.state.plugins).plugins).find(item => item.name === plugin.id); if (!loaded || loaded.status !== 'active') throw new Error('Plugin installed, but did not load. Inspect its status and logs.') }
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
    this.starting = true; this.state.connection = startingConnection(this.ownBaseUrl()); this.publish()
    const child = spawn(this.options.node, ['--import', this.options.runner, entry], {
      cwd: this.adopted?.workingDirectory || homedir(),
      env: { ...this.environment(), ...this.inheritedEnvironment, ...this.options.serviceEnvironment, MERIDIAN_PORT: String(this.preferences.port), MERIDIAN_HOST: '127.0.0.1', MERIDIAN_API_KEY: this.preferences.apiKey || '', MERIDIAN_SHUTDOWN_GRACE_MS: '30000', ...(this.preferences.persistAntigravityHistory !== undefined ? { MERIDIAN_AGY_STATE_PATH: this.preferences.persistAntigravityHistory ? join(this.options.directory, 'antigravity.sqlite') : '' } : {}), ...(this.preferences.backend ? { MERIDIAN_BACKEND: this.preferences.backend } : {}), ...(this.preferences.allowAntigravityTools !== undefined ? { MERIDIAN_AGY_ALLOW_TOOL_BRIDGE: this.preferences.allowAntigravityTools ? '1' : '0' } : {}), ...(this.preferences.allowAntigravityBrowser !== undefined ? { MERIDIAN_AGY_ALLOW_NATIVE_BROWSER: this.preferences.allowAntigravityBrowser ? '1' : '0' } : {}), ...(this.preferences.allowAntigravitySubagents !== undefined ? { MERIDIAN_AGY_ALLOW_NATIVE_SUBAGENTS: this.preferences.allowAntigravitySubagents ? '1' : '0' } : {}) },
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
      let reportedBackend = ''
      while (Date.now() < deadline) {
        if (this.child !== child || child.exitCode !== null || child.signalCode !== null) throw new Error('Meridian exited during startup.')
        try {
          const health = await this.api('/health')
          if (!isMeridianHealth(health) || object(health).version !== selected) throw new Error('The service did not report the selected Meridian version.')
          if (process.platform === 'darwin' && await this.supervisor.listeningPid(this.preferences.port) !== child.pid) throw new Error('The listening process is not owned by this app.')
          reportedBackend = text(object(health).backend)
          ready = true; break
        } catch (error) { lastError = String(error) }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      if (!ready) throw new Error(`Startup verification failed: ${lastError}`)
      const requestedBackend = this.preferences.backend
      if (requestedBackend && requestedBackend !== 'claude' && reportedBackend !== requestedBackend) throw new Error('This Meridian installation does not support the selected providers. Install a version with Antigravity support, or select Claude.')
      this.starting = false
      await this.refresh(true)
    } catch (error) { this.starting = false; await this.stop(); void this.refresh(); throw error }
    this.publish()
  }
  private scheduleRecovery() {
    if (this.restartCount >= 3) { this.state.error = 'Crash recovery paused after three attempts. Inspect service logs before restarting.'; this.addIncident({ id: `service:${Date.now()}`, title: 'Meridian needs a restart', detail: 'Automatic recovery failed after three attempts. Open Service to inspect the logs and restart.', timestamp: Date.now(), severity: 'error' }); this.publish(); return }
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
  /** Managed: the selected CLI (`profile add|login --headless`). Attached: the server's HTTP sign-in routes. */
  async profileLogin(raw: unknown, add: boolean) {
    this.assertNoLogin()
    const name = text(raw)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('Use a profile name containing letters, numbers, dashes or underscores.')
    if (this.preferences.mode !== 'managed') { await this.httpProfileLogin(name, add); return }
    const selected = version(this.preferences.selected)
    const cli = join(this.options.directory, 'versions', selected, 'node_modules/@rynfar/meridian/dist/cli.js')
    await stat(cli)
    const child = spawn(this.options.node, [cli, 'profile', add ? 'add' : 'login', name, '--headless'], { env: this.environment(), stdio: ['pipe', 'pipe', 'pipe'] })
    this.loginChild = child; this.state.login = { profile: name, phase: 'starting', output: '', provider: 'claude', via: 'cli' }
    const login = this.state.login
    const capture = (chunk: Buffer) => {
      if (this.loginChild !== child || this.state.login !== login) return
      this.state.login.output = (this.state.login.output + stripVTControlCharacters(String(chunk))).slice(-12000)
      const match = this.state.login.output.match(/https:\/\/(?:claude\.com|platform\.claude\.com)\/[^\s\u001b]+/)
      if (match) {
        this.state.login.url = match[0]
        if (login.phase === 'starting') login.phase = 'waiting'
      }
      this.publish()
    }
    child.stdout?.on('data', capture); child.stderr?.on('data', capture)
    child.stdin?.on('error', error => {
      if (this.loginChild !== child) return
      login.output = `Could not send the authorization code: ${String(error)}`
      child.kill()
    })
    child.on('error', error => {
      if (this.loginChild !== child) return
      login.phase = 'error'; login.url = undefined
      login.output = String(error); this.loginChild = undefined; this.publish()
    })
    child.once('exit', code => {
      if (this.loginChild !== child) return
      this.loginChild = undefined
      login.phase = login.phase === 'cancelling' ? 'cancelled' : code === 0 ? 'success' : 'error'
      login.url = undefined
      this.publish(); void this.refresh()
    })
  }
  /** Synchronous for the CLI flow; returns a promise for HTTP sign-ins. */
  loginCode(raw: unknown): void | Promise<void> {
    if (this.httpLogin) return this.httpLoginCode(raw)
    if (raw === 'dismiss') {
      if (this.loginChild) throw new Error('Cancel sign-in before dismissing it.')
      this.state.login = undefined; this.publish(); return
    }
    if (raw === 'cancel') {
      if (this.loginChild && this.state.login) {
        this.state.login.phase = 'cancelling'; this.loginChild.kill(); this.publish()
      }
      return
    }
    const code = text(raw).trim()
    if (!code || /[\r\n]/.test(code) || code.length > 4000) throw new Error('Paste the authorization code returned by Claude.')
    if (!this.loginChild?.stdin || this.state.login?.phase !== 'waiting') throw new Error('Wait for the browser sign-in link before submitting a code.')
    this.state.login.phase = 'verifying'
    this.loginChild.stdin.write(code + '\n')
    this.publish()
  }
  async inspectOwnership() {
    if (this.adopted) { this.state.migration = { label: this.adopted.label, canAdopt: false, adopted: true }; return }
    if (this.preferences.mode !== 'attached' || !this.state.running) { this.state.migration = undefined; return }
    this.candidate = await this.supervisor.discoverLaunchAgent(Number(new URL(this.baseUrl()).port) || 80)
    this.state.migration = this.candidate ? { label: this.candidate.label, canAdopt: true, adopted: false } : undefined
  }
  async takeOwnership(expectedLabel?: string) {
    if (this.configurationError) throw new Error(this.configurationError)
    if (this.child || this.preferences.mode !== 'attached') throw new Error('Connect to the existing instance first.')
    await this.refresh(); await this.inspectOwnership()
    const candidate = this.candidate
    if (!candidate) throw new Error('This supervisor cannot be safely adopted automatically. Keep it connected, or migrate it manually.')
    if (expectedLabel !== undefined && candidate.label !== expectedLabel) throw new Error('The service supervisor changed. Refresh and review the handoff again.')
    const currentVersion = version(this.state.running)
    const old = { ...this.preferences }
    const servicePort = Number(new URL(this.baseUrl()).port) || 80
    await this.install(currentVersion)
    // The encrypted journal is durable BEFORE any launchd mutation. A crash
    // anywhere in the handoff restores the previous supervisor on next launch.
    this.handoff = { phase: 'prepared', previous: old, agent: candidate, ...(this.keyFor !== undefined ? { previousKeyFor: this.keyFor } : {}) }
    await this.save()
    try {
      await this.supervisor.suspendAgent(candidate, servicePort)
      await this.supervisor.waitForExit(candidate.pid)
      if (await this.supervisor.listeningPid(servicePort)) throw new Error('Another process took the port during handoff.')
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
    const current = await this.supervisor.listeningPid(servicePort)
    const restoredAgent = current ? await this.supervisor.discoverLaunchAgent(servicePort) : undefined
    const alreadyRestored = restoredAgent?.label === journal.agent.label && restoredAgent.fingerprint === journal.agent.fingerprint
    if (current && current !== journal.agent.pid && !alreadyRestored) {
      await this.supervisor.waitForExit(current)
      if (await this.supervisor.listeningPid(servicePort)) throw new Error('The port is occupied. The original supervisor was not restarted.')
    }
    await this.supervisor.restoreAgent(journal.agent)
    // bootstrap returns before the replacement listener is ready. Keep the
    // recovery journal until the original supervisor owns a healthy service.
    const deadline = Date.now() + this.supervisor.restoreTimeoutMs
    let restored = false
    while (Date.now() < deadline) {
      const agent = await this.supervisor.discoverLaunchAgent(servicePort)
      if (agent?.label === journal.agent.label && agent.fingerprint === journal.agent.fingerprint) {
        try {
          const response = await fetch(journal.previous.endpoint + '/health', { headers: journal.previous.apiKey && journal.previousKeyFor === journal.previous.endpoint ? { 'x-api-key': journal.previous.apiKey } : {}, signal: AbortSignal.timeout(2000) })
          if (response.ok && isMeridianHealth(await response.json())) { restored = true; break }
        } catch { /* The restored process may still be initializing HTTP. */ }
      }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    if (!restored) throw new Error('Original supervisor has not become healthy. Recovery information is retained; retry returning to headless.')
    const previous = this.preferences
    const adopted = this.adopted
    const environment = this.inheritedEnvironment
    const keyFor = this.keyFor
    this.preferences = journal.previous; this.keyFor = journal.previousKeyFor; this.adopted = undefined; this.inheritedEnvironment = {}; this.handoff = undefined
    try { await this.save() }
    catch (error) { this.preferences = previous; this.keyFor = keyFor; this.adopted = adopted; this.inheritedEnvironment = environment; this.handoff = journal; throw error }
    if (this.recoveryError) { if (this.state.error === this.recoveryError) this.state.error = undefined; this.recoveryError = undefined }
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
    clearTimeout(this.chatGptTimer)
    try { this.loginChild?.kill(); await this.stop(); await this.incidentWrites } catch (error) { this.closing = false; throw error }
  }
}
