#!/usr/bin/env node
// Live proof for Settings, Claude Code Executable: the executable chosen there
// runs the next turn of a proxy that keeps running, and a turn already in
// flight finishes on the executable it started with.
//
// Starts the built Node server (dist/cli.js) once, with a disposable config,
// session store, project, HOME/XDG and port. Credentials come read-only from
// E2E_PROFILE_CLAUDE_DIR. The `claude` on PATH and the custom executable are
// wrappers that log which of them started and then exec a real Claude Code
// (E2E_SYSTEM_CLAUDE and E2E_CUSTOM_CLAUDE, the bundled one by default); the
// bundled executable is the package's own. Every turn is a real request on
// E2E_MODEL. Linux procfs attributes each turn's Claude Code process to the
// executable that started it. Nothing replaces the SDK, the CLI or the model.
//
//   npm run build
//   E2E_PROFILE_CLAUDE_DIR="$HOME/.claude" node scripts/e2e-claude-executable-setting.mjs
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import {homedir, tmpdir} from 'node:os'
import {basename, dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {observeChildClosure, stopAndJoinChild} from './lib/e2eProcessCustody.mjs'

assert.equal(process.platform, 'linux', 'Process attribution reads Linux procfs')
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(repo, 'dist', 'cli.js')
assert(existsSync(cli), 'dist/cli.js is missing: run `npm run build` first')
assert(process.env.E2E_PROFILE_CLAUDE_DIR, 'Set E2E_PROFILE_CLAUDE_DIR to a logged-in Claude config directory')
const credentials = realpathSync(process.env.E2E_PROFILE_CLAUDE_DIR)
const packageDir = name => join(repo, 'node_modules', '@anthropic-ai', name)
const bundled = realpathSync(join(packageDir('claude-code'), 'bin', 'claude.exe'))
const bundledVersion = JSON.parse(readFileSync(join(packageDir('claude-code'), 'package.json'), 'utf8')).version
const sdkVersion = JSON.parse(readFileSync(join(packageDir('claude-agent-sdk'), 'package.json'), 'utf8')).version
const systemTarget = realpathSync(process.env.E2E_SYSTEM_CLAUDE ?? bundled)
const customTarget = realpathSync(process.env.E2E_CUSTOM_CLAUDE ?? bundled)
const model = process.env.E2E_MODEL ?? 'claude-haiku-4-5'
const longLines = Number(process.env.E2E_LONG_LINES ?? 200)
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'busybox'])
const sleep = ms => new Promise(done => setTimeout(done, ms))

// Also warms each binary: an evicted ~200 MB executable can miss the PATH
// probe's deadline on its first start, which is not what this run measures.
async function claudeVersion(executable) {
  const child = spawn(executable, ['--version'], {stdio: ['ignore', 'pipe', 'pipe']})
  const witness = observeChildClosure(child)
  let output = '', overflow = false, timer
  child.stdout.on('data', chunk => {
    output += chunk
    if (output.length > 16384) {
      overflow = true; output = output.slice(0, 16384)
      if (!witness.state.exitSeen && !witness.state.closeSeen) child.kill('SIGTERM')
    }
  })
  child.stderr.resume()
  try {
    await Promise.race([witness.joined, new Promise(resolve => { timer = setTimeout(resolve, 120000) })])
  } finally { clearTimeout(timer) }
  const closure = await stopAndJoinChild(child, witness, {graceMs: 0, forceMs: 3000})
  assert(closure.joined && closure.exitCode === 0 && closure.exitSignal === null && !overflow, `${executable} version probe did not close successfully`)
  const version = /^(\S+) \(Claude Code\)$/.exec(output.trim())?.[1]
  assert(version, `${executable} does not answer --version like Claude Code`)
  return version
}
assert.equal(await claudeVersion(bundled), bundledVersion)
const systemVersion = await claudeVersion(systemTarget)
const customVersion = await claudeVersion(customTarget)

const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-exe-setting-')))
for (const dir of ['bin', 'custom', 'config', 'sessions', 'project', 'home', 'xdg', 'claude-profile']) mkdirSync(join(root, dir), {mode: 0o700})
// Borrow only a credential snapshot. Native transcripts/settings belong to
// this private profile; the operator's profile is never scanned or written.
const credentialSnapshot = join(root, 'claude-profile', '.credentials.json')
process.once('exit', () => rmSync(credentialSnapshot, {force: true}))
copyFileSync(join(credentials, '.credentials.json'), credentialSnapshot)
chmodSync(credentialSnapshot, 0o600)
const log = join(root, 'invocations.log')
writeFileSync(log, '', {mode: 0o600})
const shim = join(root, 'bin', 'claude')
const custom = join(root, 'custom', 'claude')
function wrapper(path, name, target) {
  for (const value of [log, target]) assert(!value.includes("'"), `unsupported quote in ${value}`)
  writeFileSync(path, [
    '#!/bin/sh',
    'case "$1" in --version) kind=version ;; auth) kind=auth ;; *) kind=session ;; esac',
    `printf '%s %s %s\\n' ${name} "$kind" "$$" >> '${log}'`,
    `exec '${target}' "$@"`,
    '',
  ].join('\n'), {mode: 0o700})
}
wrapper(shim, 'system', systemTarget)
wrapper(custom, 'custom', customTarget)
const readLog = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => {
  const [name, kind, pid] = line.split(' ')
  return {name, kind, pid: Number(pid)}
})

const env = {...process.env}
for (const key of Object.keys(env)) if (/^(MERIDIAN_|CLAUDE|ANTHROPIC_|OPENAI_|OPENCODE_)/.test(key)) delete env[key]
Object.assign(env, {
  HOME: join(root, 'home'),
  PATH: `${join(root, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
  XDG_CONFIG_HOME: join(root, 'xdg', 'config'), XDG_DATA_HOME: join(root, 'xdg', 'data'),
  XDG_CACHE_HOME: join(root, 'xdg', 'cache'), XDG_STATE_HOME: join(root, 'xdg', 'state'),
  MERIDIAN_HOST: '127.0.0.1', MERIDIAN_PORT: '0',
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: join(root, 'project'), MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_DEFAULT_PROFILE: 'owned-exe',
  MERIDIAN_PROFILES: JSON.stringify([{id: 'owned-exe', claudeConfigDir: join(root, 'claude-profile')}]),
})

const server = spawn(process.execPath, [cli], {cwd: join(root, 'project'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
const serverPid = server.pid
const serverClosure = observeChildClosure(server)
let stdout = '', stderr = ''
const keepTail = (text, chunk) => (text + chunk).slice(-1024 * 1024)
server.stdout.on('data', chunk => { stdout = keepTail(stdout, chunk) })
server.stderr.on('data', chunk => { stderr = keepTail(stderr, chunk) })

// A process that has exited between listing and reading is not an error.
function readProc(path, read = readFileSync) {
  try { return read(path, 'utf8') }
  catch (error) { if (['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) return null; throw error }
}

// The SDK process gate starts /bin/sh as the server's direct child and execs
// the chosen executable in that PID, through any wrapper, so the last exe and
// argv seen for each child name the Claude Code that ran and what it was for.
const children = new Map()
function observe() {
  const tasks = readProc(`/proc/${serverPid}/task`, readdirSync) ?? []
  const pids = new Set(tasks.flatMap(tid => (readProc(`/proc/${serverPid}/task/${tid}/children`) ?? '').split(' ').filter(Boolean)))
  const now = Date.now()
  for (const pid of pids) {
    const stat = readProc(`/proc/${pid}/stat`)
    const exe = readProc(`/proc/${pid}/exe`, readlinkSync)
    const argv = (readProc(`/proc/${pid}/cmdline`) ?? '').split('\0')
    if (!stat || !exe) continue
    const key = `${pid}:${stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19]}`
    const child = children.get(key) ?? {pid: Number(pid), firstSeen: now}
    if (!SHELLS.has(basename(exe))) Object.assign(child, {exe, argv1: argv[1]})
    children.set(key, child)
  }
}
const observer = setInterval(observe, 20)
const kindOf = argv1 => argv1 === '--version' ? 'version' : argv1 === 'auth' ? 'auth' : 'session'

let base
const request = (path, init = {}) => fetch(base + path, {...init, signal: AbortSignal.timeout(300000)})
const health = async () => (await request('/health')).json()
async function settings(method = 'GET', body) {
  const response = await request('/settings/api/claude-executable', {
    method, ...(body ? {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)} : {}),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = {raw: text.slice(0, 200)} }
  return {status: response.status, body: parsed}
}
async function until(what, check, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    assert.equal(server.exitCode, null, `the server exited while waiting for ${what}`)
    assert(Date.now() < deadline, `timed out waiting for ${what}`)
    await sleep(100)
  }
}

const fixture = receipt => `For this JavaScript integration fixture, what exact text does console.log emit? const receipt = '${receipt}'; console.log(receipt). Reply with only the output line. Do not use tools.`
const longFixture = receipt => `For this JavaScript integration fixture, what exact text does this program print? for (let i = 1; i <= ${longLines}; i++) console.log('line ' + i); console.log('${receipt}'). Reply with only the output lines, in order. Do not use tools.`

// One real turn. `during` runs once the first text arrives, while the turn is
// still streaming; the turn's Claude Code processes are attributed afterwards.
async function turn({stream, prompt, receipt, maxTokens = 256, during}) {
  const logStart = readLog().length
  const startedAt = Date.now()
  const response = await request('/v1/messages', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'anthropic-version': '2023-06-01'},
    body: JSON.stringify({model, max_tokens: maxTokens, stream, messages: [{role: 'user', content: prompt}]}),
  })
  if (response.status !== 200) assert.fail(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
  let text = '', stopped = !stream, responseModel, duringDone
  if (stream) {
    const decoder = new TextDecoder(), reader = response.body.getReader()
    let buffered = ''
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      buffered += decoder.decode(value, {stream: true})
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines.filter(line => line.startsWith('data: '))) {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'message_start') responseModel = event.message?.model
        if (event.type === 'message_stop') stopped = true
        if (event.type === 'error') assert.fail(`stream error: ${JSON.stringify(event.error).slice(0, 300)}`)
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text
          duringDone ??= during?.()
        }
      }
    }
  } else {
    const body = await response.json()
    responseModel = body.model
    text = body.content.filter(block => block.type === 'text').map(block => block.text).join('')
  }
  const endedAt = Date.now()
  const duringResult = await duringDone
  await sleep(300)
  observe()
  const sessions = readLog().slice(logStart).filter(entry => entry.kind === 'session')
  const wrapped = new Map(sessions.map(entry => [entry.pid, entry.name]))
  const processes = [...children.values()].filter(child => child.firstSeen >= startedAt && child.firstSeen <= endedAt && child.exe && kindOf(child.argv1) === 'session')
  return {
    receiptDelivered: text.includes(receipt), stopped, responseModel, endedAt, durationMs: endedAt - startedAt, duringResult,
    started: {
      system: sessions.filter(entry => entry.name === 'system').length,
      custom: sessions.filter(entry => entry.name === 'custom').length,
      bundled: processes.filter(child => !wrapped.has(child.pid) && child.exe === bundled).length,
      other: processes.filter(child => !wrapped.has(child.pid) && child.exe !== bundled).length,
    },
    unattributed: processes.filter(child => !wrapped.has(child.pid) && child.exe !== bundled).map(child => child.exe),
  }
}
function expectRanOn(result, expected) {
  assert(result.receiptDelivered, 'the receipt did not come back')
  assert(result.stopped, 'the turn did not finish')
  const started = Object.entries(result.started).filter(([, count]) => count > 0).map(([name]) => name)
  assert.deepEqual(started, [expected], `expected only ${expected} to start Claude Code, saw ${JSON.stringify(result.started)}`)
  return {ranOn: expected, responseModel: result.responseModel, durationMs: result.durationMs, started: result.started}
}
async function expectActive(body, path, source, version) {
  assert.equal(realpathSync(body.active.path), realpathSync(path))
  assert.equal(body.active.source, source)
  assert.equal(body.active.version, version)
  const reported = (await health()).claudeExecutable
  assert.equal(reported?.source, source, `/health reports ${JSON.stringify(reported)}`)
  assert.equal(realpathSync(reported.path), realpathSync(path))
}

const steps = []
let current = 'startup', failure
const step = async (name, run) => { current = name; steps.push({step: name, ...await run()}) }
try {
  await step('startup', async () => {
    base = await until('the listening line', () => /Meridian running at (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1], 60000)
    await until('a logged-in /health', async () => {
      const report = await health().catch(() => null)
      return report?.status === 'healthy' && report.auth?.loggedIn === true
    }, 180000)
    return {healthy: true}
  })
  await step('starts-on-path', async () => {
    const reported = (await health()).claudeExecutable
    assert.deepEqual(reported, {path: shim, source: 'path-lookup'})
    return {source: reported.source}
  })
  await step('turn-on-path', async () => {
    const receipt = 'PATH-' + randomUUID()
    return expectRanOn(await turn({stream: false, prompt: fixture(receipt), receipt}), 'system')
  })
  await step('settings-state', async () => {
    const {status, body} = await settings()
    assert.equal(status, 200, `GET /settings/api/claude-executable answered ${status}`)
    assert.equal(body.mode, 'system')
    assert.deepEqual(body.modes, ['system', 'bundled', 'custom'])
    assert.equal(body.envOverride, null)
    assert.deepEqual(body.candidates.system, {path: shim, source: 'path-lookup', version: systemVersion})
    assert.equal(realpathSync(body.candidates.bundled.path), bundled)
    assert.equal(body.candidates.bundled.version, bundledVersion)
    await expectActive(body, shim, 'path-lookup', systemVersion)
    return {mode: body.mode, systemVersion, bundledVersion}
  })
  await step('refuses-unusable-path', async () => {
    const {status, body} = await settings('PUT', {mode: 'custom', path: join(root, 'missing', 'claude')})
    assert.equal(status, 400)
    assert.match(body.error, /does not exist/)
    assert.equal((await settings()).body.mode, 'system')
    return {status}
  })
  await step('switch-to-bundled', async () => {
    const {status, body} = await settings('PUT', {mode: 'bundled'})
    assert.equal(status, 200)
    assert.equal(body.mode, 'bundled')
    await expectActive(body, bundled, 'bundled', bundledVersion)
    return {status, active: body.active.source}
  })
  await step('turn-on-bundled', async () => {
    const receipt = 'BUNDLED-' + randomUUID()
    return expectRanOn(await turn({stream: true, prompt: fixture(receipt), receipt}), 'bundled')
  })
  await step('switch-to-custom', async () => {
    const {status, body} = await settings('PUT', {mode: 'custom', path: custom})
    assert.equal(status, 200)
    assert.equal(body.mode, 'custom')
    await expectActive(body, custom, 'custom', customVersion)
    return {status, active: body.active.source}
  })
  await step('turn-on-custom', async () => {
    const receipt = 'CUSTOM-' + randomUUID()
    return expectRanOn(await turn({stream: false, prompt: fixture(receipt), receipt}), 'custom')
  })
  await step('switch-during-turn', async () => {
    const receipt = 'INFLIGHT-' + randomUUID()
    let switchedAt
    const result = await turn({
      stream: true, prompt: longFixture(receipt), receipt, maxTokens: 8192,
      during: async () => {
        const {status, body} = await settings('PUT', {mode: 'system'})
        switchedAt = Date.now()
        return {status, mode: body.mode, active: body.active?.source}
      },
    })
    assert.deepEqual(result.duringResult, {status: 200, mode: 'system', active: 'path-lookup'})
    assert(switchedAt < result.endedAt, `the turn ended before the switch landed; raise E2E_LONG_LINES (now ${longLines})`)
    return {...expectRanOn(result, 'custom'), switchedTo: 'system', switchLandedMsBeforeTurnEnded: result.endedAt - switchedAt}
  })
  await step('next-turn-on-path', async () => {
    const receipt = 'NEXT-' + randomUUID()
    return expectRanOn(await turn({stream: false, prompt: fixture(receipt), receipt}), 'system')
  })
  await step('same-process', async () => {
    assert.equal(server.exitCode, null)
    assert.equal(server.pid, serverPid)
    return {restarted: false}
  })
} catch (error) {
  failure = {step: current, reason: String(error?.message ?? error).split('\n')[0].slice(0, 300)}
}

let adapters = []
if (base) {
  const recent = await request('/telemetry/requests?limit=50').then(response => response.json()).catch(() => [])
  adapters = [...new Set((Array.isArray(recent) ? recent : recent.requests ?? []).map(row => row.adapter).filter(Boolean))]
}
clearInterval(observer)
const closure = await stopAndJoinChild(server, serverClosure)
if (!closure.joined && !failure) failure = {step: 'cleanup', reason: 'server exit/close/captured-pipe custody is unconfirmed'}
// Every Claude Code process this run started works in the disposable project.
function ownedProcesses() {
  return readdirSync('/proc').filter(entry => /^\d+$/.test(entry))
    .filter(pid => readProc(`/proc/${pid}/cwd`, readlinkSync) === join(root, 'project'))
}
const cleanupDeadline = Date.now() + 15000
while (ownedProcesses().length && Date.now() < cleanupDeadline) await sleep(100)
const residual = ownedProcesses()
// Enumeration supplies a failure witness, never authority to signal a bare
// PID. The server's own process gates must join the SDK children it admitted.
if (!failure && residual.length) failure = {step: 'cleanup', reason: `${residual.length} Claude Code process(es) outlived the server`}
rmSync(credentialSnapshot, {force: true})

const clean = value => JSON.parse(JSON.stringify(value).split(root).join('<fixture>').split(repo).join('<repo>').split(homedir()).join('~'))
const summary = clean({
  result: failure ? 'FAIL' : 'PASS', ...(failure ? {failure} : {}),
  node: process.version, platform: process.platform, arch: process.arch, model, sdk: sdkVersion,
  executables: {
    bundled: {path: bundled, version: bundledVersion},
    system: {path: shim, runs: systemTarget, version: systemVersion},
    custom: {path: custom, runs: customTarget, version: customVersion},
  },
  adapters, steps, serverRestarted: false, residualProcesses: residual.length, closure,
  operatorProfileMutated: false, credentialSnapshotRemoved: !existsSync(credentialSnapshot),
})
writeFileSync(join(root, 'proof.json'), JSON.stringify(summary, null, 2), {mode: 0o600})
writeFileSync(join(root, 'server.stdout'), stdout, {mode: 0o600})
writeFileSync(join(root, 'server.stderr'), stderr, {mode: 0o600})
console.log(JSON.stringify(summary, null, 2))
process.exit(failure ? 1 : 0)
