import { describe, expect, test } from 'bun:test'
import { attachDecision, classifySupervisor, dedupeCandidates, detectServices, gatherCandidates, isMeridianJob, launchdBase, loopbackBase, meridianLabels, openCodeBaseUrls, parseJsonc, parseLaunchctlPrint, piBaseUrls, plistMentionsMeridian, type DetectIO, type DetectedService, type Probe } from '../../apps/desktop/src/detect'

// Shape of real `launchctl print gui/501/<label>` output (values sanitised).
const printed = `gui/501/com.example.meridian = {
	active count = 1
	path = /Users/me/Documents/elsewhere/meridian-restart.plist
	type = LaunchAgent
	state = running

	program = /usr/local/bin/node
	arguments = {
		/usr/local/bin/node
		/opt/meridian/node_modules/@rynfar/meridian/dist/cli.js
	}

	working directory = /Users/me

	inherited environment = {
		MERIDIAN_PORT => 1111
		SSH_AUTH_SOCK => /var/run/x
	}

	default environment = {
		PATH => /usr/bin:/bin
	}

	environment = {
		MERIDIAN_PASSTHROUGH => 1
		MERIDIAN_PORT => 3456
		MERIDIAN_API_KEY => sk-secret
		MERIDIAN_HOST => 127.0.0.1
		XPC_SERVICE_NAME => com.example.meridian
	}

	domain = gui/501 [100023]
	pid = 88523
	resource coalition = {
		ID = 3937430
		state = active
	}
}
`

describe('launchctl print parsing', () => {
  test('reads the loaded plist path, pid and the top-level environment block only', () => {
    const job = parseLaunchctlPrint(printed)
    expect(job.path).toBe('/Users/me/Documents/elsewhere/meridian-restart.plist')
    expect(job.pid).toBe(88523)
    expect(job.state).toBe('running')
    expect(job.program).toBe('/usr/local/bin/node')
    expect(job.arguments).toEqual(['/usr/local/bin/node', '/opt/meridian/node_modules/@rynfar/meridian/dist/cli.js'])
    // Not the inherited environment's 1111.
    expect(job.environment.MERIDIAN_PORT).toBe('3456')
    expect(job.environment.PATH).toBeUndefined()
    expect(launchdBase(job.environment)).toBe('http://127.0.0.1:3456')
  })
  test('launchd addresses: wildcard binds are reached on loopback, remote hosts are rejected', () => {
    expect(launchdBase({ MERIDIAN_PORT: '3999', MERIDIAN_HOST: '0.0.0.0' })).toBe('http://127.0.0.1:3999')
    expect(launchdBase({})).toBe('http://127.0.0.1:3456')
    expect(launchdBase({ CLAUDE_PROXY_PORT: '4000' })).toBe('http://127.0.0.1:4000')
    expect(() => launchdBase({ MERIDIAN_HOST: '192.168.1.5' })).toThrow('not a loopback host')
    expect(() => launchdBase({ MERIDIAN_PORT: 'abc' })).toThrow('invalid MERIDIAN_PORT')
  })
  test('labels and plists that mention meridian', () => {
    expect(meridianLabels('PID\tStatus\tLabel\n88523\t0\tcom.rynfar.meridian\n-\t0\tcom.apple.thing\n')).toEqual(['com.rynfar.meridian'])
    expect(plistMentionsMeridian({ Label: 'x', ProgramArguments: ['/Users/me/bin/meridian-launchd.sh'] })).toBe(true)
    expect(plistMentionsMeridian({ Label: 'com.ollama', Program: '/bin/ollama' })).toBe(false)
  })
})

describe('client configs', () => {
  test('OpenCode JSONC with comments and trailing commas', () => {
    const source = `{
      // the proxy
      "provider": {
        "anthropic": { "options": { "apiKey": "dummy", /* local */ "baseURL": "http://localhost:3456/v1", }, },
        "other": { "options": { "baseURL": "https://api.example.com" } },
      },
      "url": "http://not-a-comment//here",
    }`
    const config = parseJsonc(source)
    expect((config as { url: string }).url).toBe('http://not-a-comment//here')
    expect(openCodeBaseUrls(config)).toEqual([{ provider: 'anthropic', url: 'http://localhost:3456/v1' }, { provider: 'other', url: 'https://api.example.com' }])
  })
  test('Pi: MERIDIAN_BASE_URL first, then models.json baseUrl', () => {
    expect(piBaseUrls({ providers: { meridian: { baseUrl: 'http://127.0.0.1:3460', apiKey: 'x' } } }, { MERIDIAN_BASE_URL: 'http://127.0.0.1:3470' })).toEqual([
      { provider: 'MERIDIAN_BASE_URL', url: 'http://127.0.0.1:3470' }, { provider: 'meridian', url: 'http://127.0.0.1:3460' },
    ])
    expect(piBaseUrls(undefined, {})).toEqual([])
  })
  test('only loopback HTTP is accepted; paths and localhost normalise', () => {
    expect(loopbackBase('http://localhost:3456/v1')).toBe('http://127.0.0.1:3456')
    expect(loopbackBase('http://[::1]:3456')).toBe('http://[::1]:3456')
    expect(() => loopbackBase('https://api.example.com')).toThrow('only local HTTP')
    expect(() => loopbackBase('http://10.0.0.2:3456')).toThrow('not a loopback host')
    expect(() => loopbackBase('http://meridian.lan:3456')).toThrow('not a loopback host')
  })
})

function fakeIO(overrides: Partial<DetectIO> & { files?: Record<string, string>; probes?: Record<string, Probe>; pids?: Record<number, number> } = {}): DetectIO {
  const files = overrides.files ?? {}
  return {
    platform: 'darwin', home: '/home/me', env: {},
    readText: async path => { const value = files[path]; if (value === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return value },
    launchAgents: async () => [],
    launchctlList: async () => '',
    launchctlPrint: async () => undefined,
    plist: async () => { throw new Error('no plist') },
    probe: async baseUrl => overrides.probes?.[baseUrl] ?? { status: 'unreachable', error: 'refused' },
    listenerPid: async port => overrides.pids?.[port],
    processCommand: async () => undefined,
    ...overrides,
  }
}

describe('detection order and dedup', () => {
  test('launchd, OpenCode, Pi, default, preference — deduplicated by base URL, first source wins', async () => {
    const io = fakeIO({
      env: { MERIDIAN_BASE_URL: 'http://127.0.0.1:3470' },
      files: {
        '/home/me/.config/opencode/opencode.json': '{ // c\n "provider": { "anthropic": { "options": { "baseURL": "http://localhost:3456" } }, "remote": { "options": { "baseURL": "http://203.0.113.9:3456" } } } }',
        '/home/me/.pi/agent/models.json': JSON.stringify({ providers: { m: { baseUrl: 'http://127.0.0.1:3460' } } }),
      },
      launchAgents: async () => [{ path: '/home/me/Library/LaunchAgents/com.example.meridian.plist', data: { Label: 'com.example.meridian', ProgramArguments: ['/x/meridian-launchd.sh'] } }],
      launchctlPrint: async label => label === 'com.example.meridian' ? printed : undefined,
      probes: { 'http://127.0.0.1:3456': { status: 'meridian', version: '1.86.0' } },
    })
    const gathered = await gatherCandidates(io, { preferenceEndpoint: 'http://127.0.0.1:3489' })
    expect(gathered.candidates.map(c => [c.source, c.baseUrl])).toEqual([
      ['launchd', 'http://127.0.0.1:3456'], ['opencode', 'http://127.0.0.1:3456'], ['pi', 'http://127.0.0.1:3470'], ['pi', 'http://127.0.0.1:3460'], ['default', 'http://127.0.0.1:3456'], ['preference', 'http://127.0.0.1:3489'],
    ])
    expect(gathered.rejected).toEqual([{ source: 'opencode', detail: 'opencode.json provider remote', url: 'http://203.0.113.9:3456', reason: '203.0.113.9 is not a loopback host' }])
    const detection = await detectServices(io, { preferenceEndpoint: 'http://127.0.0.1:3489' })
    expect(detection.services.map(s => s.baseUrl)).toEqual(['http://127.0.0.1:3456', 'http://127.0.0.1:3470', 'http://127.0.0.1:3460', 'http://127.0.0.1:3489'])
    const first = detection.services[0]!
    expect(first.sources).toEqual(['launchd: com.example.meridian', 'opencode: opencode.json provider anthropic', 'default: http://127.0.0.1:3456'])
    // The loaded job's plist path, not the LaunchAgents file, is reported.
    expect(first.supervisor).toEqual({ kind: 'launchd', label: 'com.example.meridian', plistPath: '/Users/me/Documents/elsewhere/meridian-restart.plist' })
    expect(first.probe.version).toBe('1.86.0')
    expect(first.pid).toBe(88523)
    // No secret from the job environment reaches the result.
    expect(JSON.stringify(detection)).not.toContain('sk-secret')
  })
  test('falls back to the plist file when launchctl print has no port', async () => {
    const withoutPort = printed.replace('\t\tMERIDIAN_PORT => 3456\n', '')
    const io = fakeIO({
      launchctlList: async () => '123\t0\tcom.example.meridian\n',
      launchctlPrint: async () => withoutPort,
      plist: async path => path === '/Users/me/Documents/elsewhere/meridian-restart.plist' ? { EnvironmentVariables: { MERIDIAN_PORT: '3999' } } : {},
    })
    const { candidates } = await gatherCandidates(io)
    expect(candidates[0]).toMatchObject({ source: 'launchd', baseUrl: 'http://127.0.0.1:3999' })
  })
  test('the Meridian Desktop app itself is not a launchd Meridian service', async () => {
    // Found on a real machine: runningboardd registers the running app under a label containing "meridian".
    const app = `application.dev.meridian.desktop.1.2 = {\n\tpath = (submitted by runningboardd.416)\n\tprogram = /Applications/Meridian Desktop.app/Contents/MacOS/Meridian Desktop\n\tpid = 26322\n}\n`
    expect(meridianLabels('26322\t0\tapplication.dev.meridian.desktop.1.2\n')).toEqual([])
    expect(isMeridianJob(parseLaunchctlPrint(app), true)).toBe(false)
    // A label-only match needs evidence of a Meridian service.
    expect(isMeridianJob(parseLaunchctlPrint('x = {\n\tprogram = /bin/sleep\n}\n'), false)).toBe(false)
    expect(isMeridianJob(parseLaunchctlPrint(printed), false)).toBe(true)
    const io = fakeIO({ launchctlList: async () => '26322\t0\tcom.example.meridian-helper\n', launchctlPrint: async () => 'x = {\n\tprogram = /bin/sleep\n\tpid = 4\n}\n' })
    expect((await gatherCandidates(io)).candidates.map(c => c.source)).toEqual(['default'])
  })
  test('an unloaded LaunchAgents plist is not a candidate', async () => {
    const io = fakeIO({ launchAgents: async () => [{ path: '/p', data: { Label: 'com.example.meridian', Program: '/bin/meridian' } }], launchctlPrint: async () => undefined })
    const { candidates } = await gatherCandidates(io)
    expect(candidates.map(c => c.source)).toEqual(['default'])
  })
  test('dedup keeps the first entry and merges later facts', () => {
    const merged = dedupeCandidates([
      { baseUrl: 'http://127.0.0.1:3456', source: 'opencode', detail: 'a' },
      { baseUrl: 'http://127.0.0.1:3456', source: 'default', detail: 'b', pid: 7 },
    ])
    expect(merged).toEqual([{ baseUrl: 'http://127.0.0.1:3456', source: 'opencode', detail: 'a', pid: 7, sources: ['opencode: a', 'default: b'] }])
  })
  test('supervisor: launchd by pid, Docker by listener process, else unknown', () => {
    expect(classifySupervisor({ pid: 5 }, [{ label: 'com.x.meridian', pid: 5, plistPath: '/p' }])).toEqual({ kind: 'launchd', label: 'com.x.meridian', plistPath: '/p' })
    expect(classifySupervisor({ pid: 9 }, [], 'com.docker.backend')).toEqual({ kind: 'docker' })
    expect(classifySupervisor({ pid: 9 }, [], 'node')).toEqual({ kind: 'unknown' })
  })
})

describe('attach decision', () => {
  const service = (baseUrl: string, status: Probe['status'], pid?: number): DetectedService => ({ baseUrl, port: Number(new URL(baseUrl).port), sources: ['default: x'], probe: { status }, supervisor: { kind: 'unknown' }, ...(pid ? { pid } : {}) })
  test('a verified external service is attached', () => {
    const decision = attachDecision([service('http://127.0.0.1:3460', 'unreachable'), service('http://127.0.0.1:3456', 'meridian', 10)])
    expect(decision.kind).toBe('attach')
    expect(decision.kind === 'attach' && decision.service.baseUrl).toBe('http://127.0.0.1:3456')
  })
  test('nothing verified means managed, with the checked addresses named', () => {
    const decision = attachDecision([service('http://127.0.0.1:3456', 'not-meridian'), service('http://127.0.0.1:3460', 'unreachable')])
    expect(decision).toEqual({ kind: 'managed', reason: 'No running Meridian service was found (checked 127.0.0.1:3456, 127.0.0.1:3460).' })
  })
  test("the app's own child is never mistaken for an external service, by URL or by pid", () => {
    expect(attachDecision([service('http://127.0.0.1:3489', 'meridian')], { baseUrl: 'http://127.0.0.1:3489', pid: 42 }).kind).toBe('managed')
    // Same process reached through another URL a client names.
    expect(attachDecision([service('http://[::1]:3489', 'meridian', 42)], { baseUrl: 'http://127.0.0.1:3489', pid: 42 }).kind).toBe('managed')
    const decision = attachDecision([service('http://127.0.0.1:3489', 'meridian', 42), service('http://127.0.0.1:3456', 'meridian', 7)], { baseUrl: 'http://127.0.0.1:3489', pid: 42 })
    expect(decision.kind === 'attach' && decision.service.baseUrl).toBe('http://127.0.0.1:3456')
  })
})
