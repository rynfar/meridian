import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { Incident } from '../../apps/desktop/src/core'
import { Manager } from '../../apps/desktop/src/manager'

const fixtures: { manager: Manager; directory: string }[] = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    const deadline = Date.now() + 5000
    while (fixture.manager.state.busy && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await fixture.manager.shutdown()
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing address')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'meridian-desktop-test-'))
  const runner = join(directory, 'runner.mjs')
  await writeFile(runner, await readFile(join(import.meta.dir, '../../apps/desktop/src/runner.ts'), 'utf8'))
  const manager = new Manager({ directory, runner, node: 'node', npm: 'unused', desktopVersion: 'test', encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(), changed: () => {}, notify: () => {} })
  fixtures.push({ manager, directory })
  await manager.init()
  await manager.configure({ mode: 'managed', port: await freePort() })
  return { manager, directory }
}
async function installed(directory: string, release: string, broken = false) {
  const root = join(directory, 'versions', release, 'node_modules/@rynfar/meridian')
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@rynfar/meridian', version: release, type: 'module' }))
  await writeFile(join(root, 'dist/cli.js'), broken ? 'throw new Error("Deliberate bad release")' : `
    import { createServer } from 'node:http';
    export async function runCli() {
      let providerFailure = false;
      const server = createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/health') return res.end(JSON.stringify({ pid:process.pid, status:'healthy', backend:process.env.AGY_FIXTURE_LEGACY ? undefined : process.env.MERIDIAN_BACKEND || 'claude', version:${JSON.stringify(release)}, plugin:{ opencode:'configured' } }));
        if (req.url === '/provider-fail') { providerFailure = true; return res.end('{}'); }
        if (req.url === '/providers/status') {
          if (providerFailure) { res.statusCode=503; return res.end(JSON.stringify({error:{message:'Fixture provider refresh failed'}})); }
          return res.end(JSON.stringify({fetchedAt:Date.now(),providers:[{id:'antigravity',name:'Antigravity',enabled:true,status:'healthy',endpoint:'/antigravity/v1/messages',activity:{requests:1,errors:0,inputTokens:10,outputTokens:2,cacheReadTokens:0},accounts:[{id:'Google account',fetchedAt:Date.now(),windows:[{type:'5h',utilization:.25,resetsAt:Date.now()+60000}]}]}]}));
        }
        if (process.env.MERIDIAN_BACKEND === 'antigravity' && ['/telemetry/routes', '/telemetry/retention'].includes(req.url)) { res.statusCode=404; return res.end('{}'); }
        if (req.url === '/backend') return res.end(JSON.stringify({backend:process.env.MERIDIAN_BACKEND, tools:process.env.MERIDIAN_AGY_ALLOW_TOOL_BRIDGE,browser:process.env.MERIDIAN_AGY_ALLOW_NATIVE_BROWSER,subagents:process.env.MERIDIAN_AGY_ALLOW_NATIVE_SUBAGENTS}));
        if (req.url === '/crash') return process.exit(19);
        if (req.url === '/slow') return setTimeout(() => res.end(JSON.stringify({ done:true })), 250);
        res.end(JSON.stringify({}));
      });
      await new Promise(resolve => server.listen(Number(process.env.MERIDIAN_PORT), '127.0.0.1', resolve));
      process.on('SIGTERM', () => server.close(() => process.exit(0)));
    }
    await runCli();
  `)
}
describe('desktop manager real child lifecycle', () => {
  test('provider settings persist, reach the owned process, and require stop before changes', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory()
    await manager.configure({ backend: 'combined', allowAntigravityTools: true, allowAntigravityBrowser: true, allowAntigravitySubagents: false })
    manager.preferences.selected = '1.0.0'
    await manager.start()
    expect(await manager.api('/backend')).toEqual({backend:'combined',tools:'1',browser:'1',subagents:'0'})
    await expect(manager.configure({backend:'antigravity'})).rejects.toThrow('Stop the managed service')
    await manager.stop()
    await manager.configure({backend:'antigravity',allowAntigravityTools:false})
    expect(JSON.parse(await readFile(join(directory,'desktop.json'),'utf8')).backend).toBe('antigravity')
    await expect(manager.configure({backend:'unknown'})).rejects.toThrow('Unknown backend')
    manager.options.serviceEnvironment = {AGY_FIXTURE_LEGACY:'1'}
    await expect(manager.start()).rejects.toThrow('does not support the selected providers')
    expect(manager.snapshot().owned).toBe(false)
  })

  test('does not request Claude routing and retention data from standalone Antigravity', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory()
    await manager.configure({ backend: 'antigravity' })
    manager.preferences.selected = '1.0.0'
    await manager.start()
    expect(manager.state.dataErrors).toEqual([])
    expect(manager.state.routesSummary).toBeNull()
    expect(manager.state.retention).toBeNull()
  })

  test('retains provider data with stale labels when the provider refresh fails', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory(); await manager.activate('1.0.0'); await manager.start()
    expect(manager.state.providers?.providers[0]?.status).toBe('healthy')
    await manager.api('/provider-fail'); await manager.refresh()
    const provider = manager.state.providers?.providers[0]
    expect(provider?.status).toBe('unavailable')
    expect(provider?.accounts[0]?.windows[0]?.utilization).toBe(.25)
    expect(provider?.accounts[0]?.error).toContain('refresh failed')
    expect(provider?.activity?.requests).toBe(1)
  })

  test('notification preferences and cooldown survive clearing history and reopening', async () => {
    const { manager, directory } = await fixture()
    const delivered: Incident[] = []
    manager.options.notify = incident => delivered.push(incident)
    await manager.configure({ notifications: true, notificationCache: true, openWindowAtLaunch: false })
    manager.addIncident({ id: 'cache:first', title: 'Cache', detail: 'private detail', timestamp: Date.now(), severity: 'warning' })
    expect(delivered).toHaveLength(1)
    await manager.acknowledge()
    await manager.shutdown()
    const reopened = new Manager({ ...manager.options })
    const cleanup = fixtures.find(item => item.manager === manager)
    if (cleanup) cleanup.manager = reopened
    await reopened.init()
    expect(reopened.preferences.openWindowAtLaunch).toBe(false)
    expect(reopened.preferences.notificationCache).toBe(true)
    reopened.addIncident({ id: 'cache:second', title: 'Cache', detail: 'private detail', timestamp: Date.now(), severity: 'warning' })
    expect(delivered).toHaveLength(1)
    expect(reopened.state.incidents).toHaveLength(1)
  })

  test('plugin inventory follows the selected installation even while stopped', async () => {
    const { manager, directory } = await fixture()
    const plugin = join(directory, 'plugin')
    await mkdir(plugin)
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: '@rynfar/meridian-plugin-opencode-scrub', version: '0.2.0' }))
    const config = join(directory, 'plugins.json')
    await writeFile(config, JSON.stringify({ plugins: [{ path: join(plugin, 'index.js'), enabled: true }] }))
    manager.options.serviceEnvironment = { MERIDIAN_PLUGIN_CONFIG: config }
    await manager.refresh()
    expect(manager.state.catalog?.find(item => item.id === 'opencode-scrub')?.installed).toBe('0.2.0')
    await manager.configure({ mode: 'attached', endpoint: 'http://127.0.0.1:1' })
    expect(manager.state.catalog?.every(item => item.installed === undefined)).toBe(true)
  })
  test('starts the CLI, preserves a request during drain, and keeps the selected version after restart', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory(); await manager.activate('1.0.0')
    await manager.start()
    expect(manager.snapshot().owned).toBe(true)
    expect(manager.state.running).toBe('1.0.0')
    const response = fetch(manager.baseUrl() + '/slow')
    await new Promise(resolve => setTimeout(resolve, 75))
    await manager.stop()
    expect(await (await response).json()).toEqual({ done: true })
    expect(manager.snapshot().owned).toBe(false)
    await manager.start()
    expect(manager.state.running).toBe('1.0.0')
  }, 20000)
  test('a failed activation restarts the previous CLI and restores its saved selection', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await installed(directory, '2.0.0', true); await manager.inventory()
    await manager.activate('1.0.0'); await manager.start()
    await expect(manager.activate('2.0.0')).rejects.toThrow('restored 1.0.0')
    expect(manager.preferences.selected).toBe('1.0.0')
    expect(manager.state.running).toBe('1.0.0')
    expect(manager.snapshot().owned).toBe(true)
    const saved = JSON.parse(await readFile(join(directory, 'desktop.json'), 'utf8'))
    expect(saved.selected).toBe('1.0.0')
  }, 20000)
  test('an unexpected process exit triggers bounded automatic recovery', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory(); await manager.activate('1.0.0'); await manager.start()
    const firstPid = (manager.state.health as { pid: number }).pid
    await fetch(manager.baseUrl() + '/crash').catch(() => undefined)
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      if (!manager.state.busy && manager.snapshot().owned && (manager.state.health as { pid: number } | null)?.pid !== firstPid && manager.state.running === '1.0.0') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(manager.snapshot().owned).toBe(true)
    expect((manager.state.health as { pid: number }).pid).not.toBe(firstPid)
    expect(manager.state.incidents.some(incident => incident.title === 'Meridian stopped unexpectedly')).toBe(true)
  }, 20000)
  test('only exhausted recovery notifies when a real child cannot restart', async () => {
    const { manager, directory } = await fixture()
    const delivered: Incident[] = []
    manager.options.notify = incident => delivered.push(incident)
    await manager.configure({ notifications: true })
    await installed(directory, '1.0.0'); await manager.inventory(); await manager.activate('1.0.0'); await manager.start()
    await installed(directory, '1.0.0', true)
    await fetch(manager.baseUrl() + '/crash').catch(() => undefined)
    const deadline = Date.now() + 28_000
    while (Date.now() < deadline && !delivered.length) await new Promise(resolve => setTimeout(resolve, 100))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.id.startsWith('service:')).toBe(true)
    expect(manager.state.error).toContain('three attempts')
    expect(manager.snapshot().owned).toBe(false)
  }, 30_000)
  test('an occupied port is never adopted or stopped by managed startup', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory(); await manager.activate('1.0.0')
    const external = createServer()
    await new Promise<void>(resolve => external.listen(manager.preferences.port, '127.0.0.1', resolve))
    try {
      await expect(manager.start()).rejects.toThrow('already occupied')
      expect(external.listening).toBe(true)
      expect(manager.snapshot().owned).toBe(false)
    } finally { await new Promise<void>(resolve => external.close(() => resolve())) }
  })
  test('credentials and connection cannot change under a running child', async () => {
    const { manager, directory } = await fixture()
    await installed(directory, '1.0.0'); await manager.inventory(); await manager.activate('1.0.0'); await manager.start()
    await expect(manager.configure({ apiKey: 'replacement' })).rejects.toThrow('Stop the managed service')
    await expect(manager.configure({ mode: 'attached' })).rejects.toThrow('Stop the managed service')
    expect(manager.preferences.apiKey).toBeUndefined()
    expect(manager.snapshot().owned).toBe(true)
  }, 15000)
  test('non-Meridian HTTP data does not masquerade as a connected service', async () => {
    const { manager } = await fixture()
    await manager.configure({ mode: 'attached', endpoint: 'http://127.0.0.1:1' })
    expect(manager.state.running).toBeUndefined()
    expect(manager.state.lastChecked).toBeUndefined()
    await expect(manager.start()).rejects.toThrow('External instances')
  })
})
