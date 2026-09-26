#!/usr/bin/env bun
// E67: actual OpenCode 2.0.16 + Meridian V2 plugin + real SDK/Opus.
// Inject one partial text response after a completed client tool call, then
// require OpenCode's retry of that exact history shape to resume the stored
// SDK session. Raw client output stays in a private temporary directory.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repo = realpathSync('.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-oc-checkpoint-fault-')))
const clientBin = process.env.E2E_OPENCODE_BIN
const scrub = process.env.E2E_PLUGIN_PATH
assert(clientBin, 'Set E2E_OPENCODE_BIN to the pinned OpenCode 2.0.16 executable')
assert(scrub, 'Set E2E_PLUGIN_PATH to an independently installed OpenCode scrub entrypoint')
const version = spawnSync(clientBin, ['--version'], { encoding: 'utf8' })
assert.equal(version.status, 0, 'OpenCode version command failed')
assert.equal(version.stdout.trim(), 'opencode v2.0.16')
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const config = join(root, 'config')
const project = join(root, 'project')
for (const dir of [config, project, join(root, 'plugins')]) mkdirSync(dir, { recursive: true })
process.env.MERIDIAN_CONFIG_DIR = join(root, 'meridian-config')
process.env.MERIDIAN_SESSION_DIR = join(root, 'meridian-sessions')
process.env.MERIDIAN_TELEMETRY_PERSIST = '0'
process.env.MERIDIAN_PASSTHROUGH = '1'
process.env.MERIDIAN_WORKDIR = project
process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY = randomBytes(32).toString('base64url')
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [{ path: scrub, enabled: true }] }))
const { startProxyServer } = await import(pathToFileURL(join(repo, 'dist/server.js')).href)
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, pluginConfigPath, pluginDir: join(root, 'plugins') })
const proxyUrl = `http://127.0.0.1:${proxy.server.address().port}`
const pluginState = await (await fetch(`${proxyUrl}/plugins/list`)).json()
assert(pluginState.plugins.some(plugin => plugin.name === 'opencode-scrub' && plugin.status === 'active'), 'Independent OpenCode scrub is inactive')
let fault = true
let faults = 0
const observed = []
const describe = body => (body.messages ?? []).map(m => ({ role: m.role, types: Array.isArray(m.content) ? m.content.map(b => b?.type ?? 'unknown') : [typeof m.content] }))
const sse = event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
const messageId = `msg_fault_${crypto.randomUUID().replaceAll('-', '')}`
const fixture = [
  { type: 'message_start', message: { id: messageId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The file contains' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'error', error: { type: 'api_error', message: 'upstream_idle: fixture cut after partial assistant text' } },
].map(sse).join('')
const relay = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const url = new URL(request.url)
  const primary = request.headers.get('x-opencode-agent-name') === 'build'
  let body
  if (request.method === 'POST' && url.pathname === '/v1/messages') {
    body = await request.json()
    const roles = describe(body)
    const hasResult = roles.some(m => m.types.includes('tool_result'))
    const row = { primary, roles, hasResult, faulted: false,
      attested: request.headers.has('x-meridian-opencode-turn'), requestId: `e67-${crypto.randomUUID()}` }
    observed.push(row)
    if (primary && hasResult && fault && faults === 0) {
      faults++
      row.faulted = true
      return new Response(fixture, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } })
    }
    const headers = new Headers(request.headers)
    headers.set('x-request-id', row.requestId)
    return fetch(`${proxyUrl}${url.pathname}${url.search}`, { method: request.method, headers, body: JSON.stringify(body), signal: request.signal })
  }
  return fetch(`${proxyUrl}${url.pathname}${url.search}`, request)
} })
const clientRoot = join(root, 'client')
for (const dir of [clientRoot, join(clientRoot, 'config'), join(clientRoot, 'data'), join(clientRoot, 'cache'), join(clientRoot, 'state')]) mkdirSync(dir, { recursive: true })
writeFileSync(join(config, 'opencode.json'), JSON.stringify({
  model: `anthropic/${model}`,
  share: 'disabled',
  providers: { anthropic: { settings: { apiKey: 'local-fixture', baseURL: `http://127.0.0.1:${relay.port}/v1` }, models: { [model]: { name: model, limit: { context: 200000, output: 1024 } } } } },
}))
const env = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: '1' }
for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(clientRoot, kind.toLowerCase())
for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete env[key]
env.MERIDIAN_OPENCODE_ATTESTATION_KEY = process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY
const setup = spawnSync('node', [join(repo, 'dist', 'cli.js'), 'setup', '--v2', '--opencode-bin', clientBin],
  { cwd: project, env, encoding: 'utf8', timeout: 30_000 })
assert.equal(setup.status, 0, `Meridian V2 setup failed: ${setup.stderr}`)
const configured = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'))
assert.deepEqual(configured.plugins.map(path => realpathSync(path)), [realpathSync(join(repo, 'dist', 'meridian-v2'))],
  'Meridian V2 client plugin was not installed exactly once')
async function run(name, args) {
  const child = spawn(clientBin, args, { cwd: project, env, stdio: ['ignore','pipe','pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timer = setTimeout(() => child.kill('SIGTERM'), 130000)
  const exit = await new Promise((resolve,reject) => { child.once('error',reject); child.once('exit',resolve) }).finally(() => clearTimeout(timer))
  writeFileSync(join(root, `${name}.stdout`), stdout)
  writeFileSync(join(root, `${name}.stderr`), stderr)
  const events = stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  return { exit, events, session: events.find(event => typeof event.sessionID === 'string')?.sessionID }
}
try {
  const first = await run('first', ['run','--standalone','--auto','--format','json','--model',`anthropic/${model}`,'Use the bash tool to run pwd, then say the working directory.'])
  const firstRunRequests = observed.length
  fault = false
  const continued = first.session ? await run('continued', ['run','--standalone','--auto','--session',first.session,'--format','json','--model',`anthropic/${model}`,'Your previous answer was cut off. Please answer with the working directory.']) : null
  const telemetry = await (await fetch(`${proxyUrl}/telemetry/requests?limit=40`)).json()
  const finalPlugins = await (await fetch(`${proxyUrl}/plugins/list`)).json()
  const scrubStats = finalPlugins.plugins.find(plugin => plugin.name === 'opencode-scrub')?.stats?.hooks?.onRequest
  const rows = Array.isArray(telemetry) ? telemetry : Object.values(telemetry).find(Array.isArray) ?? []
  const primary = observed.slice(0, firstRunRequests).filter(row => row.primary)
  const faultIndex = primary.findIndex(row => row.faulted)
  const retry = primary.slice(faultIndex + 1).find(row => row.hasResult && !row.faulted)
  const retryTelemetry = rows.find(row => row.requestId === retry?.requestId)
  const resultIndex = retry?.roles.findIndex(message => message.types.includes('tool_result')) ?? -1
  const retryHasPartial = resultIndex >= 0
    && retry.roles[resultIndex + 1]?.role === 'assistant'
    && retry.roles[resultIndex + 1]?.types.includes('text')
    && retry.roles[resultIndex + 2]?.role === 'user'
  const summary = {
    result: 'FAIL', artifact: root, platform: `${process.platform}/${process.arch}`,
    opencode: version.stdout.trim(), meridian: 'source build', model,
    scrub: pluginState.plugins.find(plugin => plugin.name === 'opencode-scrub')?.version,
    scrubInvocations: scrubStats?.invocations, scrubErrors: scrubStats?.errors,
    faults, firstExit: first.exit, firstSession: Boolean(first.session),
    firstToolCalls: first.events.filter(event => event.type === 'tool_use').length,
    firstPartialTextEvents: first.events.filter(event => event.type === 'text').length,
    faultTextSeen: first.events.some(event => event.type === 'text' && event.part?.text?.includes('The file contains')),
    faultErrorSeen: first.events.some(event => event.type === 'error'),
    firstAttested: primary[0]?.attested, retryAttested: retry?.attested,
    retryHasPartial, retryShape: retry?.roles, retryLineage: retryTelemetry?.lineageType,
    retryIsResume: retryTelemetry?.isResume,
    continuedExit: continued?.exit, continuedSameSession: continued?.session === first.session,
    continuedTextEvents: continued?.events.filter(event => event.type === 'text').length ?? 0,
  }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  assert(summary.firstToolCalls > 0, 'Actual OpenCode did not make a tool call')
  assert.equal(faults, 1, 'The fault must affect exactly one tool-result request')
  assert(summary.firstPartialTextEvents > 0 && summary.faultTextSeen && summary.faultErrorSeen,
    'OpenCode did not receive the partial assistant text and error')
  assert(summary.firstAttested, 'The Meridian V2 client plugin did not attest the primary turn')
  assert(retryHasPartial, 'OpenCode retry did not carry the reported result/assistant/user shape')
  assert((summary.scrubInvocations ?? 0) > 0 && summary.scrubErrors === 0, 'Independent OpenCode scrub did not run cleanly')
  assert.equal(retryTelemetry?.lineageType, 'continuation', 'Retry failed lineage verification')
  assert.equal(retryTelemetry?.isResume, true, 'Interrupted retry did not resume the stored SDK session')
  assert.equal(continued?.exit, 0, 'OpenCode follow-up did not complete')
  assert(summary.continuedSameSession && summary.continuedTextEvents > 0, 'Same-session follow-up did not answer')
  summary.result = 'PASS'
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
} finally {
  relay.stop(true)
  await proxy.close()
}
