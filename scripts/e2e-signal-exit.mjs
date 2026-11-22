// Linux-only actual Pi provider + Meridian CLI + SDK + live Haiku signal/drain proof.
// Requires built E2E_BASELINE_ROOT and E2E_MERIDIAN_ROOT, E2E_PI_AI_ROOT,
// E2E_CLAUDE_BIN, E2E_CREDENTIALS_FILE (read-only source), E2E_SCRATCH_ROOT.
// Never starts a Pi session. Imports its actual provider and retry classifier.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.equal(process.platform, 'linux')
assert.equal(process.env.E2E_ALLOW_LIVE_MODEL, '1')
const required = name => { assert(process.env[name], name); return resolve(process.env[name]) }
const baseline = required('E2E_BASELINE_ROOT'), candidate = required('E2E_MERIDIAN_ROOT')
const scratch = required('E2E_SCRATCH_ROOT'), pi = required('E2E_PI_AI_ROOT')
const binary = await realpath(required('E2E_CLAUDE_BIN'))
const credentials = JSON.parse(await readFile(required('E2E_CREDENTIALS_FILE'), 'utf8')).claudeAiOauth
assert(credentials.accessToken && credentials.expiresAt > Date.now() + 300_000, 'fresh access-only grant required')
const { stream } = await import(pathToFileURL(join(pi, 'dist/api/anthropic-messages.js')))
const { normalizeContext } = await import(pathToFileURL(join(pi, 'dist/utils/transcript.js')))
const { isRetryableAssistantError } = await import(pathToFileURL(join(pi, 'dist/utils/retry.js')))
const { ANTHROPIC_MODELS } = await import(pathToFileURL(join(pi, 'dist/providers/anthropic.models.js')))
const model = Object.values(ANTHROPIC_MODELS).find(m => m.id === 'claude-haiku-5-5')
assert(model, 'actual Pi Haiku 5.5 model')
const retryable = errorMessage => isRetryableAssistantError({ stopReason: 'error', errorMessage })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const productionPid = Number(execFileSync('systemctl', ['--user', 'show', 'meridian.service', '-p', 'MainPID', '--value'], { encoding: 'utf8' }).trim())
assert(productionPid > 1)
const report = { node: process.version, platform: process.platform, productionPid, binary, cases: [] }
await mkdir(join(scratch, 'evidence'), { recursive: true })

async function descendants(pid) {
  let children
  try { children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return (await Promise.all(children.map(async child => [child, ...await descendants(child)]))).flat()
}
async function signalRequest(serverPid, row) {
  const owned = await descendants(serverPid)
  const matches = []
  for (const pid of owned) {
    try { if (await realpath(`/proc/${pid}/exe`) === binary) matches.push(pid) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  assert.equal(matches.length, 1, 'exactly one owned request CLI')
  assert.notEqual(matches[0], productionPid)
  assert((await descendants(serverPid)).includes(matches[0]))
  row.signalledChild = matches[0]
  row.childDescendants = await descendants(matches[0])
  process.kill(matches[0], 'SIGTERM')
}
async function freePort() {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  assert.notEqual(port, 3456)
  return port
}

async function runCase(label, tree, mode, graceMs) {
  const root = join(scratch, label)
  await mkdir(root, { mode: 0o700 }) // refuse reuse of a prior fixture
  for (const dir of ['home', 'auth', 'config', 'sessions', 'work', 'tmp', 'plugins']) await mkdir(join(root, dir), { mode: 0o700 })
  await writeFile(join(root, 'auth/.credentials.json'), JSON.stringify({ claudeAiOauth: {
    ...credentials, refreshToken: '',
  } }), { mode: 0o600 })
  const port = await freePort(), url = `http://127.0.0.1:${port}`
  const row = { label, port, mode, graceMs, serverPid: null }
  report.cases.push(row)
  const env = {
    PATH: '/usr/bin:/bin', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'),
    XDG_CONFIG_HOME: join(root, 'home/.config'), XDG_CACHE_HOME: join(root, 'home/.cache'),
    CLAUDE_CONFIG_DIR: join(root, 'auth'), MERIDIAN_CONFIG_DIR: join(root, 'config'),
    MERIDIAN_SESSION_DIR: join(root, 'sessions'), MERIDIAN_WORKDIR: join(root, 'work'),
    MERIDIAN_TELEMETRY_DB: join(root, 'config/telemetry.db'), MERIDIAN_TELEMETRY_PERSIST: '1',
    MERIDIAN_PLUGIN_DIR: join(root, 'plugins'), MERIDIAN_PLUGIN_CONFIG: join(root, 'config/plugins.json'),
    MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_BACKEND: 'claude',
    MERIDIAN_PROFILES: JSON.stringify([{ id: 'e2e', claudeConfigDir: join(root, 'auth') }]),
    MERIDIAN_DEFAULT_PROFILE: 'e2e', MERIDIAN_CLAUDE_PATH: binary, MERIDIAN_BOOKKEEPING: 'json',
    MERIDIAN_PORT: String(port), MERIDIAN_HOST: '127.0.0.1', MERIDIAN_NO_FILE_CHANGES: '1',
    MERIDIAN_SHUTDOWN_GRACE_MS: String(graceMs), MERIDIAN_PASSTHROUGH: '1',
  }
  // Assert all configured state roots resolve below this case, with no symlink inheritance.
  for (const [key, value] of Object.entries(env)) {
    if (/DIR$|HOME$|TELEMETRY_DB$|PLUGIN_CONFIG$/.test(key)) assert(value.startsWith(root + '/'), key)
  }
  const child = spawn(process.execPath, [join(tree, 'dist/cli.js')], { cwd: join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  row.serverPid = child.pid
  assert.notEqual(child.pid, productionPid)
  let logs = '', wire = '', status
  child.stdout.on('data', b => { logs += b })
  child.stderr.on('data', b => { logs += b })
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }))
  const start = Date.now()
  const observed = new Set()
  let stopped = false, serverSignalled = false, joined = false
  try {
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, 'scratch server alive')
      try { if ((await fetch(url + '/livez')).ok) break } catch { /* owned server not listening yet */ }
      assert(i < 199, 'scratch listener startup deadline')
      await sleep(50)
    }
    row.readyMs = Date.now() - start
    const options = {
      apiKey: 'scratch-local-only', maxRetries: 0, maxTokens: 4096, signal: AbortSignal.timeout(120_000),
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        status = response.status
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
        const decoder = new TextDecoder()
        return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          wire += decoder.decode(chunk, { stream: true }); controller.enqueue(chunk)
        } })), { status: response.status, headers: response.headers })
      },
    }
    const prompt = mode === 'drain'
      ? 'Write a numbered list of 70 short tips for naming variables. No tools. Start the list immediately.'
      : 'Write a numbered list of 1000 detailed facts about prime numbers. No tools. Start the list immediately and keep writing.'
    const requestAt = Date.now()
    const events = stream({ ...model, baseUrl: url }, normalizeContext({ messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }), options)
    for await (const event of events) {
      for (const pid of await descendants(child.pid)) observed.add(pid)
      if (event.type === 'text_delta' && !stopped) {
        row.firstTextMs = Date.now() - requestAt
        row.signalAtMs = Date.now() - requestAt
        stopped = true
        if (mode === 'crash') await signalRequest(child.pid, row)
        else {
          // Main only: no killpg, no signal to descendants (KillMode=mixed first phase).
          child.kill('SIGTERM')
          serverSignalled = true
          for (let i = 0; i < 100 && !logs.includes('shutting down gracefully'); i++) await sleep(10)
          assert(logs.includes('shutting down gracefully'), 'CLI received first SIGTERM')
          const denied = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id, messages: [{ role: 'user', content: 'No model call: must be refused during drain.' }], max_tokens: 1 }) })
          row.drainStatus = denied.status
          row.drainBody = await denied.text()
          assert.equal(denied.status, 503)
          row.drainPi = await stream({ ...model, baseUrl: url }, normalizeContext({ messages: [{ role: 'user', content: 'Must be refused before SDK.', timestamp: Date.now() }] }), { apiKey: 'scratch-local-only', maxRetries: 0 }).result()
          row.drainPi = { errorMessage: row.drainPi.errorMessage, stopReason: row.drainPi.stopReason }
          row.drainRetryable = retryable(row.drainPi.errorMessage)
          assert(row.drainRetryable)
        }
      }
    }
    const result = await events.result()
    row.httpStatus = status
    row.pi = { stopReason: result.stopReason, errorMessage: result.errorMessage }
    row.retryable = result.stopReason === 'error' ? retryable(result.errorMessage) : null
    row.finishedMs = Date.now() - requestAt
    row.messageStop = wire.includes('event: message_stop')
    row.sseError = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'error')?.error
    assert(stopped, 'first text observed before signal')
    if (mode === 'crash') {
      assert.equal(result.stopReason, 'error')
      assert.equal(row.retryable, label !== 'baseline-crash')
      assert(row.sseError)
    } else if (mode === 'drain') {
      assert.notEqual(result.stopReason, 'error')
      assert(row.messageStop)
      assert(row.finishedMs - row.signalAtMs < graceMs)
    } else {
      assert.equal(result.stopReason, 'error')
      assert.equal(row.retryable, true)
      assert.equal(row.sseError, undefined, 'grace expiry closes the socket, no SSE error')
    }
  } finally {
    if (!serverSignalled && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const exit = await Promise.race([closed, sleep(40_000).then(() => { throw new Error('scratch server failed to join') })])
    row.exit = exit; row.totalMs = Date.now() - start
    joined = true
    await writeFile(join(scratch, 'evidence', label + '.server.log'), logs)
    await writeFile(join(scratch, 'evidence/report-' + label + '.json'), JSON.stringify(row, null, 2))
    assert.equal(exit.code, 0)
    for (const pid of observed) {
      try { await readFile(`/proc/${pid}/stat`); throw new Error(`owned descendant still present: ${pid}`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    row.residualDescendants = 0
    await writeFile(join(scratch, 'evidence', label + '.server.log'), logs)
    // Only generated test answer/SSE, no prompt, credentials or production session data.
    await writeFile(join(scratch, 'evidence', label + '.sse'), wire)
    await writeFile(join(scratch, 'evidence/report.json'), JSON.stringify(report, null, 2))
    if (joined) await rm(root, { recursive: true })
  }
  console.log(JSON.stringify(row))
}
const supported = ['baseline-crash', 'fixed-crash', 'fixed-drain', 'fixed-grace']
const selected = (process.env.E2E_CASES || supported.join(',')).split(',')
assert(selected.length > 0 && selected.every(label => supported.includes(label)), 'known selected cases')
if (selected.includes('baseline-crash')) await runCase('baseline-crash', baseline, 'crash', 30_000)
if (selected.includes('fixed-crash')) await runCase('fixed-crash', candidate, 'crash', 30_000)
if (selected.includes('fixed-drain')) await runCase('fixed-drain', candidate, 'drain', 30_000)
if (selected.includes('fixed-grace')) await runCase('fixed-grace', candidate, 'grace', 250)
console.log('PASS selected cases: ' + selected.join(', ') + '; zero owned residuals')
