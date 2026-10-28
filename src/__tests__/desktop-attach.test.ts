import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer as createNetServer } from 'node:net'
import { createServer, type Server } from 'node:http'
import { Manager } from '../../apps/desktop/src/manager'
import type { Detection, DetectedService } from '../../apps/desktop/src/detect'
import type { DesktopState } from '../../apps/desktop/src/contracts'

// Everything here runs against temp dirs and in-test HTTP servers on free
// ports; detection is injected, so the machine's launchd jobs and :3456 are
// never touched.
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step() })

async function freePort() {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}

interface FakeOptions { apiKey?: string; timeseries?: boolean }
interface Fake { baseUrl: string; port: number; calls: { method: string; url: string; body: unknown }[]; options: FakeOptions }
/** A minimal Meridian: public /health, keyed /telemetry and /profiles, the routes the desktop calls. */
async function fakeMeridian(options: FakeOptions = {}): Promise<Fake> {
  const port = await freePort()
  const fake: Fake = { baseUrl: `http://127.0.0.1:${port}`, port, calls: [], options }
  const server: Server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const url = req.url ?? '/'
    fake.calls.push({ method: req.method ?? 'GET', url, body: raw ? JSON.parse(raw) : undefined })
    const json = (status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
    const path = url.split('?')[0] ?? ''
    if (path === '/health') return json(200, { status: 'healthy', version: '9.9.9', build: { source: 'npm', version: '9.9.9' } })
    if (fake.options.apiKey && (path.startsWith('/telemetry') || path.startsWith('/profiles') || path.startsWith('/v1/')) && req.headers['x-api-key'] !== fake.options.apiKey) return json(401, { error: 'Unauthorized' })
    if (path === '/telemetry/requests') return json(200, [{ requestId: 'r1', timestamp: Date.now(), status: 200 }])
    if (path === '/telemetry/summary') return json(200, { totalRequests: 1 })
    if (path === '/telemetry/timeseries') {
      // Older Meridian: Hono's plain-text 404.
      if (!fake.options.timeseries) { res.statusCode = 404; return res.end('404 Not Found') }
      const query = new URL(url, fake.baseUrl).searchParams
      return json(200, { start: Number(query.get('start')), end: Number(query.get('end')), bucketMs: Number(query.get('bucket')), truncated: false, buckets: [{ start: Number(query.get('start')), requests: 1, errors: 0, inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 1, cacheHitRate: null, p50TotalMs: 10, p50TtfbMs: null, costUsd: null }] })
    }
    if (path === '/profiles/list') return json(200, { profiles: [{ id: 'personal', type: 'claude-max' }, { id: 'seat-a', seat: 'acct-1' }], activeProfile: 'personal' })
    if (path === '/profiles/login/start') return json(200, { loginId: 'L1', pasteAuthorizeUrl: 'https://claude.com/cai/oauth/authorize?x=1', authorizeUrl: 'http://localhost/callback' })
    if (path === '/profiles/login/complete') {
      const body = JSON.parse(raw) as { code: string }
      return body.code === 'good' ? json(200, { success: true, profile: 'personal' }) : json(400, { error: 'That code did not work.', retryable: true })
    }
    if (path === '/profiles/chatgpt/connect/device') return json(200, { connectId: 'C1', userCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device', expiresAt: Date.now() + 60_000 })
    if (path === '/profiles/chatgpt/connect/status') return json(200, fake.calls.filter(call => call.url.startsWith('/profiles/chatgpt/connect/status')).length > 1 ? { status: 'completed', profile: 'seat-b', email: 'b@example.com' } : { status: 'waiting' })
    if (path === '/providers/status') { res.statusCode = 404; return res.end('404 Not Found') }
    if (path === '/settings/api/claude-executable') { res.statusCode = 404; return res.end('404 Not Found') }
    if (path.startsWith('/settings/api/')) return json(200, { section: path })
    return json(200, {})
  })
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  return fake
}

function service(baseUrl: string, extra: Partial<DetectedService> = {}): DetectedService {
  return { baseUrl, port: Number(new URL(baseUrl).port), sources: ['launchd: com.test.meridian'], probe: { status: 'meridian', version: '9.9.9' }, supervisor: { kind: 'launchd', label: 'com.test.meridian', plistPath: '/tmp/x.plist' }, ...extra }
}

async function makeManager(directory: string, detect: () => Detection | Promise<Detection>, states: DesktopState[] = []) {
  const runner = join(directory, 'runner.mjs')
  await writeFile(runner, await readFile(join(import.meta.dir, '../../apps/desktop/src/runner.ts'), 'utf8'))
  const manager = new Manager({ directory, runner, node: 'node', npm: 'unused', desktopVersion: 'test', encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(), changed: state => states.push(state), notify: () => {}, detect: async () => detect() })
  cleanup.push(async () => {
    const deadline = Date.now() + 5000
    while (manager.state.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
    await manager.shutdown()
  })
  return manager
}
async function tempDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'meridian-desktop-attach-'))
  cleanup.unshift(() => rm(directory, { recursive: true, force: true }))
  return directory
}
/** A stand-in Meridian CLI the app can run as its managed child. */
async function installed(directory: string, release: string) {
  const root = join(directory, 'versions', release, 'node_modules/@rynfar/meridian')
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@rynfar/meridian', version: release, type: 'module' }))
  await writeFile(join(root, 'dist/cli.js'), `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/health') return res.end(JSON.stringify({ pid: process.pid, status: 'healthy', backend: 'claude', version: ${JSON.stringify(release)}, plugin: { opencode: 'configured' } }));
      res.end('{}');
    });
    await new Promise(resolve => server.listen(Number(process.env.MERIDIAN_PORT), '127.0.0.1', resolve));
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `)
}
const none = (): Detection => ({ at: Date.now(), services: [], rejected: [] })

describe('attach decision in the manager', () => {
  test('a found external service is attached, the managed child drained, and not restarted next launch', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    let detection = none()
    const manager = await makeManager(directory, () => detection)
    await installed(directory, '1.0.0')
    await manager.init()
    expect(manager.preferences.mode).toBe('managed')
    await manager.configure({ port: await freePort(), autoStart: true })
    await manager.activate('1.0.0'); await manager.start()
    expect(manager.snapshot().owned).toBe(true)
    const ownBase = manager.baseUrl()
    const childPid = (manager.state.health as { pid: number }).pid
    // Detection sees the app's own child too; it must be skipped, not attached.
    detection = { at: Date.now(), services: [service(ownBase, { pid: childPid, sources: ['preference: x'] }), service(external.baseUrl, { pid: 999_999 })], rejected: [] }
    await manager.redetect()
    expect(manager.snapshot().owned).toBe(false)
    expect(manager.preferences.mode).toBe('attached')
    expect(manager.preferences.endpoint).toBe(external.baseUrl)
    expect(manager.shouldStartManaged()).toBe(false)
    const state = manager.snapshot()
    expect(state.connection.kind).toBe('ok')
    expect(state.instance).toMatchObject({ baseUrl: external.baseUrl, port: external.port, version: '9.9.9', supervisor: { kind: 'launchd', label: 'com.test.meridian', plistPath: '/tmp/x.plist' }, detectedFrom: 'launchd: com.test.meridian' })
    expect(state.detection?.services.find(item => item.baseUrl === ownBase)?.own).toBe(false) // child is gone now
    expect(state.detection?.note).toContain('not started')
    // Next launch: autoStart is still on, but the external service wins again.
    await manager.shutdown()
    const next = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await next.init()
    expect(next.preferences.autoStart).toBe(true)
    expect(next.preferences.mode).toBe('attached')
    expect(next.shouldStartManaged()).toBe(false)
  }, 30_000)

  test('nothing found selects the managed copy, says so, and allows its autostart', async () => {
    const directory = await tempDirectory()
    await installed(directory, '1.0.0')
    await writeFile(join(directory, 'desktop.json'), JSON.stringify({ mode: 'attached', endpoint: 'http://127.0.0.1:1', port: await freePort(), autoStart: true, selected: '1.0.0' }))
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service('http://127.0.0.1:1', { probe: { status: 'unreachable' } })], rejected: [] }))
    await manager.init()
    expect(manager.preferences.mode).toBe('managed')
    expect(manager.shouldStartManaged()).toBe(true)
    expect(manager.state.detection?.note).toBe('No running Meridian service was found (checked 127.0.0.1:1). Running the app-managed Meridian 1.0.0 on port ' + manager.preferences.port + '.')
    expect(JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')).mode).toBe('managed')
    await manager.refresh()
    expect(manager.state.connection.kind).toBe('stopped')
    expect(manager.state.connection.fix).toContain('app-managed copy')
    expect(manager.state.instance?.supervisor.kind).toBe('app')
  })

  test("the app's own child is not mistaken for an external service", async () => {
    const directory = await tempDirectory()
    await installed(directory, '1.0.0')
    let detection = none()
    const manager = await makeManager(directory, () => detection)
    await manager.init()
    await manager.configure({ port: await freePort() })
    await manager.activate('1.0.0'); await manager.start()
    const pid = (manager.state.health as { pid: number }).pid
    // A client config names the child's port through another loopback spelling.
    detection = { at: Date.now(), services: [service(`http://[::1]:${manager.preferences.port}`, { pid, supervisor: { kind: 'unknown' } }), service(manager.baseUrl(), { pid })], rejected: [] }
    await manager.redetect()
    expect(manager.snapshot().owned).toBe(true)
    expect(manager.preferences.mode).toBe('managed')
    expect(manager.state.instance).toMatchObject({ supervisor: { kind: 'app' }, detectedFrom: 'app-managed', version: '1.0.0' })
    expect(manager.state.detection?.services.every(item => item.own)).toBe(true)
  }, 30_000)
})

describe('typed connection status and windowed data', () => {
  test('a 401 on telemetry is unauthorized, never an empty request list', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian({ apiKey: 'right' })
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await manager.init(); await manager.refresh()
    expect(manager.state.connection).toEqual({ kind: 'unauthorized', message: `Meridian on 127.0.0.1:${external.port} requires an API key (401).`, fix: 'Enter the key in Service → Connection.' })
    expect(manager.state.requests).toBeNull()
    await manager.configure({ apiKey: 'wrong' })
    expect(manager.state.connection.message).toContain('rejected the API key (401)')
    await manager.configure({ apiKey: 'right' })
    expect(manager.state.connection.kind).toBe('ok')
    expect(manager.state.requests).toEqual([{ requestId: 'r1', timestamp: expect.any(Number), status: 200 }])
  })

  test('stopped endpoint with another verified Meridian is wrong-port', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    const dead = await freePort()
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await manager.init()
    await manager.configure({ mode: 'attached', endpoint: `http://127.0.0.1:${dead}` })
    expect(manager.state.connection.kind).toBe('wrong-port')
    expect(manager.state.connection.fix).toContain(`127.0.0.1:${external.port}`)
    expect(manager.state.requests).toBeNull()
  })

  test('timeseries 404 is null with a note; window changes push at once and refetch with the window', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    const states: DesktopState[] = []
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }), states)
    await manager.init(); await manager.refresh()
    expect(manager.state.window).toEqual({ kind: 'today' })
    expect(manager.state.timeseries).toBeNull()
    expect(manager.state.timeseriesNote).toContain('no /telemetry/timeseries')
    expect(external.calls.some(call => /^\/telemetry\/summary\?window=\d+$/.test(call.url))).toBe(true)
    external.options.timeseries = true
    states.length = 0; external.calls.length = 0
    await manager.setWindow('1h')
    // First push carries the new window and no stale data.
    expect(states[0]?.window).toEqual({ kind: '1h' })
    expect(states[0]?.summary).toBeNull()
    expect(states[0]?.timeseries).toBeNull()
    expect(external.calls.map(call => call.url)).toContain('/telemetry/summary?window=3600000')
    const series = external.calls.find(call => call.url.startsWith('/telemetry/timeseries'))
    expect(series?.url).toMatch(/bucket=300000$/)
    expect(manager.state.timeseries?.bucketMs).toBe(300000)
    expect(manager.state.timeseriesNote).toBeUndefined()
    expect(JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8')).window).toBe('1h')
  })

  test('settings sections are read and written through the web page routes', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await manager.init(); await manager.refresh()
    expect(manager.state.settings.values.routing).toEqual({ section: '/settings/api/routing' })
    expect(manager.state.settings.unavailable).toEqual(['claude-executable'])
    await manager.updateSettings({ section: 'layout', body: { layout: 'wide' } })
    await manager.updateSettings({ section: 'chatgpt', body: { creditsPolicy: 'never' } })
    await manager.resetSettings({ section: 'chatgpt' })
    await manager.setPricing({ model: 'claude-x', pricing: { input: 1 } })
    await manager.deletePricing('claude-x')
    await expect(manager.updateSettings({ section: 'pricing', body: {} })).rejects.toThrow('Unknown settings section')
    const writes = external.calls.filter(call => call.method !== 'GET').map(call => [call.method, call.url, call.body])
    expect(writes).toEqual([['PUT', '/settings/api/layout', { layout: 'wide' }], ['PATCH', '/settings/api/chatgpt', { creditsPolicy: 'never' }], ['DELETE', '/settings/api/chatgpt', undefined], ['PUT', '/settings/api/pricing/claude-x', { input: 1 }], ['DELETE', '/settings/api/pricing/claude-x', undefined]])
  })
})

describe('account management on an attached service', () => {
  test('switch, rename, reorder and seat removal use the server routes; Claude removal stays on the host', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await manager.init(); await manager.refresh()
    expect(manager.preferences.mode).toBe('attached')
    await manager.switchProfile('seat-a')
    await manager.renameProfile({ from: 'personal', to: 'home' })
    await manager.reorderProfiles(['seat-a', 'personal'])
    await manager.removeProfile('seat-a')
    await expect(manager.removeProfile('personal')).rejects.toThrow('meridian profile remove personal')
    await expect(manager.reorderProfiles(['a', 'a'])).rejects.toThrow('once')
    const writes = external.calls.filter(call => call.method === 'POST' || call.method === 'PUT').map(call => [call.url, call.body])
    expect(writes).toEqual([['/profiles/active', { profile: 'seat-a' }], ['/profiles/rename', { from: 'personal', to: 'home' }], ['/settings/api/routing', { profileOrder: ['seat-a', 'personal'] }], ['/profiles/chatgpt/remove', { profile: 'seat-a' }]])
  })

  test('Claude sign-in works over HTTP when attached, with retryable code errors', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await manager.init(); await manager.refresh()
    await manager.profileLogin('personal', false)
    expect(manager.state.login).toMatchObject({ profile: 'personal', phase: 'waiting', via: 'http', provider: 'claude', url: 'https://claude.com/cai/oauth/authorize?x=1' })
    await expect(manager.profileLogin('other', false)).rejects.toThrow('already in progress')
    await manager.loginCode('bad')
    expect(manager.state.login).toMatchObject({ phase: 'waiting', output: 'That code did not work.' })
    await manager.loginCode('good')
    expect(manager.state.login).toMatchObject({ phase: 'success', url: undefined })
    expect(external.calls.filter(call => call.url === '/profiles/login/complete').map(call => call.body)).toEqual([{ loginId: 'L1', code: 'bad' }, { loginId: 'L1', code: 'good' }])
    manager.loginCode('dismiss')
    expect(manager.state.login).toBeUndefined()
  })
})

describe('account management specifics', () => {
  test('ChatGPT seats sign in with a device code and the status poll', async () => {
    const directory = await tempDirectory()
    const external = await fakeMeridian()
    const manager = await makeManager(directory, () => ({ at: Date.now(), services: [service(external.baseUrl)], rejected: [] }))
    await manager.init(); await manager.refresh()
    await manager.chatGptConnect({ name: 'seat-b' })
    expect(manager.state.login).toMatchObject({ profile: 'seat-b', provider: 'chatgpt', phase: 'waiting', userCode: 'ABCD-1234', url: 'https://auth.openai.com/codex/device' })
    const deadline = Date.now() + 8000
    while (manager.state.login?.phase !== 'success' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    expect(manager.state.login).toMatchObject({ phase: 'success', output: 'Connected b@example.com.' })
    expect(external.calls.find(call => call.url === '/profiles/chatgpt/connect/device')?.body).toEqual({ name: 'seat-b' })
  }, 15_000)

  test('managed mode removes a Claude account with the selected CLI', async () => {
    const directory = await tempDirectory()
    const root = join(directory, 'versions', '1.0.0', 'node_modules/@rynfar/meridian')
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@rynfar/meridian', version: '1.0.0', type: 'module' }))
    const record = join(directory, 'argv.json')
    await writeFile(join(root, 'dist/cli.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)))`)
    const manager = await makeManager(directory, none)
    await manager.init()
    await manager.configure({ port: await freePort() })
    await manager.activate('1.0.0')
    expect(manager.preferences.mode).toBe('managed')
    await manager.removeProfile('work')
    expect(JSON.parse(await readFile(record, 'utf8'))).toEqual(['profile', 'remove', 'work'])
  })
})
