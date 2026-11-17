// Actual installed Pi provider -> isolated Meridian CLI -> real SDK/native Haiku.
// No Pi session. Only task-owned servers are signaled; protected processes are read-only.
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
const credentialSource = required('E2E_CREDENTIALS_FILE')
const productionPid = Number(process.env.E2E_PROTECTED_PID)
const productionPort = Number(process.env.E2E_PROTECTED_PORT)
assert(Number.isSafeInteger(productionPid) && productionPid > 1, 'E2E_PROTECTED_PID')
assert(Number.isSafeInteger(productionPort) && productionPort > 0 && productionPort < 65536, 'E2E_PROTECTED_PORT')
assert((await readFile(required('E2E_ISOLATION_PROOF'), 'utf8')).includes(String(productionPid)), 'pre-start isolation witness must match protected PID')
const { stream } = await import(pathToFileURL(join(pi, 'dist/api/anthropic-messages.js')))
const { normalizeContext } = await import(pathToFileURL(join(pi, 'dist/utils/transcript.js')))
const { ANTHROPIC_MODELS } = await import(pathToFileURL(join(pi, 'dist/providers/anthropic.models.js')))
const model = Object.values(ANTHROPIC_MODELS).find(m => m.id === 'claude-haiku-5-5')
assert(model)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const versions = {
  node: process.version, platform: process.platform, productionPid, binary, pi,
  piVersion: JSON.parse(await readFile(join(pi, 'package.json'), 'utf8')).version,
  sdkVersion: JSON.parse(await readFile(join(candidate, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'), 'utf8')).version,
  nativeVersion: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(),
}
const report = { ...versions, cases: [] }
async function descendants(pid) {
  let children
  try { children = (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  return (await Promise.all(children.map(async child => [child, ...await descendants(child)]))).flat()
}
async function freePort() {
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = listener.address().port
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()))
  assert.notEqual(port, productionPort)
  return port
}
async function runCase(label, tree) {
  const root = join(scratch, label)
  await mkdir(root, { mode: 0o700 })
  for (const dir of ['home', 'auth', 'config', 'sessions', 'work', 'tmp', 'plugins']) await mkdir(join(root, dir), { mode: 0o700 })
  const credentials = JSON.parse(await readFile(credentialSource, 'utf8')).claudeAiOauth
  assert(credentials.accessToken && credentials.expiresAt > Date.now() + 300_000, 'fresh access-only grant required')
  await writeFile(join(root, 'auth/.credentials.json'), JSON.stringify({ claudeAiOauth: { ...credentials, refreshToken: '' } }), { mode: 0o600 })
  const port = await freePort(), url = `http://127.0.0.1:${port}`
  const row = { label, tree, port, requestedModel: model.id }
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
    MERIDIAN_PASSTHROUGH: '1', OPENCODE_CLAUDE_PROVIDER_DEBUG: '1',
  }
  for (const [key, value] of Object.entries(env)) {
    if (/DIR$|HOME$|TELEMETRY_DB$|PLUGIN_CONFIG$/.test(key)) assert(value.startsWith(root + '/'), key)
  }
  const child = spawn(process.execPath, [join(tree, 'dist/cli.js')], { cwd: join(root, 'work'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  row.serverPid = child.pid
  assert.notEqual(child.pid, productionPid)
  let logs = '', wire = ''
  child.stdout.on('data', b => { logs += b })
  child.stderr.on('data', b => { logs += b })
  const closed = once(child, 'close').then(([code, signal]) => ({ code, signal }))
  const observed = new Set()
  try {
    for (let i = 0; i < 200; i++) {
      assert.equal(child.exitCode, null, 'owned server alive')
      try { if ((await fetch(url + '/livez')).ok) break } catch { /* not ready yet */ }
      assert(i < 199, 'startup deadline')
      await sleep(50)
    }
    const requestId = `handoff-log-${label}`
    row.requestId = requestId
    const options = {
      apiKey: 'scratch-local-only', maxRetries: 0, maxTokens: 1024, signal: AbortSignal.timeout(120_000),
      headers: { 'x-meridian-agent': 'pi', 'x-session-affinity': requestId, 'x-request-id': requestId },
      fetch: async (input, init) => {
        assert.equal(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).origin, url)
        const request = JSON.parse(init.body)
        row.clientTools = request.tools.map(tool => ({ name: tool.name, defer_loading: tool.defer_loading }))
        assert.deepEqual(row.clientTools, [{ name: 'handoff_probe', defer_loading: undefined }], 'one declared client tool, no hidden deferred placeholder')
        const response = await fetch(input, init)
        row.httpStatus = response.status
        if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response
        const decoder = new TextDecoder()
        return new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
          wire += decoder.decode(chunk, { stream: true }); controller.enqueue(chunk)
        } })), { status: response.status, headers: response.headers })
      },
    }
    const prompt = 'Call the declared handoff_probe tool exactly once now with marker="handoff-log-fixture". Do not answer in text and do not call any other tool. The client will run it.'
    const tools = [{ name: 'handoff_probe', description: 'Return the requested fixture marker to the client. Call this now.', parameters: {
      type: 'object', properties: { marker: { type: 'string' } }, required: ['marker'], additionalProperties: false,
    } }]
    const events = stream({ ...model, baseUrl: url, compat: { ...model.compat, supportsMidConvoToolChanges: false, supportsMidConvoSystemMessages: false, supportsMessageThreads: false } }, normalizeContext({ tools, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }] }), options)
    for await (const event of events) {
      for (const pid of await descendants(child.pid)) observed.add(pid)
    }
    const result = await events.result()
    row.pi = { stopReason: result.stopReason, errorMessage: result.errorMessage, content: result.content }
    assert.equal(result.stopReason, 'toolUse')
    assert.equal(result.content.filter(block => block.type === 'toolCall').length, 1)
    assert.deepEqual(result.content.find(block => block.type === 'toolCall').arguments, { marker: 'handoff-log-fixture' })
    assert.equal(result.content.find(block => block.type === 'toolCall').name, 'handoff_probe')
    assert(!wire.includes('event: error'))
    assert(wire.includes('"stop_reason":"tool_use"'))
    assert(wire.includes('event: message_stop'))
    for (let i = 0; i < 200 && !logs.includes('"event":"upstream.failed"') && !logs.includes('"recovery":"tool_use"'); i++) await sleep(25)
    const logEvents = logs.split('\n').filter(line => line.startsWith('[opencode-claude-code-provider] '))
      .map(line => JSON.parse(line.slice('[opencode-claude-code-provider] '.length))).filter(event => event.requestId === requestId)
    row.outcomes = logEvents.filter(event => ['upstream.failed', 'proxy.anthropic.error', 'upstream.completed'].includes(event.event))
    if (label === 'baseline-live') {
      assert.equal(row.outcomes.filter(event => event.event === 'upstream.failed').length, 1)
      assert.equal(row.outcomes.filter(event => event.event === 'proxy.anthropic.error').length, 1)
      assert(row.outcomes.find(event => event.event === 'upstream.failed').error.includes('Reached maximum number of turns (1)'))
    } else {
      assert.equal(row.outcomes.length, 1)
      assert.equal(row.outcomes[0].event, 'upstream.completed')
      assert.equal(row.outcomes[0].recovery, 'tool_use')
      assert.equal(row.outcomes[0].sdkTermination, 'max_turns')
    }
    row.pass = true
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const exit = await Promise.race([closed, sleep(40_000).then(() => { throw new Error('owned server failed to join') })])
    row.exit = exit
    await writeFile(join(scratch, 'evidence', label + '.server.log'), logs)
    await writeFile(join(scratch, 'evidence', label + '.sse'), wire)
    await writeFile(join(scratch, 'evidence/report.json'), JSON.stringify(report, null, 2))
    assert.equal(exit.code, 0)
    for (const pid of observed) {
      try { await readFile(`/proc/${pid}/stat`); throw new Error(`owned descendant remains: ${pid}`) }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    row.residualDescendants = 0
    await rm(root, { recursive: true })
    await writeFile(join(scratch, 'evidence/report.json'), JSON.stringify(report, null, 2))
  }
  console.log(JSON.stringify(row))
}
await runCase('baseline-live', baseline)
await runCase('fixed-live', candidate)
console.log('PASS two live tool handoffs, baseline failure logs / fixed completion log; zero owned residuals')
