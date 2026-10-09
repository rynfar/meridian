/**
 * Credentialless preparation for #769, using an independently installed client.
 * This loopback SSE fixture proves client/tool protocol wiring only. It does not
 * establish Agent SDK, real-model, platform or classifier acceptance.
 *
 * E2E_OPENCLAW_BIN=/absolute/openclaw.mjs E2E_OUTPUT_DIR=/new/owned/directory \
 *   node scripts/e2e-openclaw-client-protocol.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { observeChildClosure, stopAndJoinChild } from './lib/e2eProcessCustody.mjs'

const bin = process.env.E2E_OPENCLAW_BIN
const output = process.env.E2E_OUTPUT_DIR
if (!bin || !output || !isAbsolute(bin) || !isAbsolute(output)) {
  throw new Error('Set absolute E2E_OPENCLAW_BIN and a new E2E_OUTPUT_DIR')
}
mkdirSync(output, { mode: 0o700 }) // Refuse to reuse prior evidence or session state.
for (const name of ['home', 'state', 'workspace', 'tmp', 'xdg-config', 'xdg-cache', 'xdg-data']) {
  mkdirSync(join(output, name), { mode: 0o700 })
}
const fixture = join(output, 'workspace', 'fixture.txt')
const marker = 'OWNED_OPENCLAW_TOOL_RESULT_' + randomUUID()
writeFileSync(fixture, marker + '\n', { mode: 0o600 })
const report = {
  kind: 'CREDENTIALLESS_REAL_CLIENT_LOOPBACK_PROTOCOL_ONLY',
  providerModelCalls: 0, platform: process.platform, architecture: process.arch,
  node: process.version, clientEntrypointSHA256: hash(readFileSync(bin)),
  firstFailure: null, commands: [], requests: [], assertions: {},
  qualification: 'Original CLI and captured-pipe joins; owned server/socket joins. No global descendant census, native SDK, real model or classifier acceptance.',
}
function hash(value) { return createHash('sha256').update(value).digest('hex') }
function fail(reason) { retired = true; report.firstFailure ??= String(reason) }
function save() { writeFileSync(join(output, 'REPORT.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }) }
function bounded(promise, ms) {
  let timer
  return Promise.race([promise, new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })])
    .finally(() => clearTimeout(timer))
}
const sockets = new Set()
const socketClosures = []
const handlers = new Set()
let retired = false
let requestCount = 0
async function handleRequest(request, response) {
  request.on('error', error => fail(error.message))
  response.on('error', error => fail(error.message))
  try {
    if (retired || request.method !== 'POST' || request.url !== '/v1/messages') {
      response.writeHead(404).end()
      return
    }
    const chunks = []
    let bytes = 0
    for await (const chunk of request) {
      bytes += chunk.length
      if (bytes > 2_000_000) throw new Error('Owned fixture request exceeded bound')
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const index = requestCount++
    if (index > 2) throw new Error('Unexpected client retry exceeded fixture admission')
    const messages = body.messages ?? []
    const tools = (body.tools ?? []).map(tool => tool.name)
    const result = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_result' && block.tool_use_id === 'ownedread')
    const call = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .find(block => block.type === 'tool_use' && block.id === 'ownedread' && block.name === 'read' && block.input?.path === fixture)
    report.requests.push({ index, model: body.model, stream: body.stream, tools,
      messageRoles: messages.map(message => message.role),
      blockTypes: messages.flatMap(message => Array.isArray(message.content) ? message.content.map(block => block.type) : ['text']),
      toolResultMatched: Boolean(call && result && !result.is_error && JSON.stringify(result.content).includes(marker)),
      bodySHA256: hash(Buffer.concat(chunks)),
    })
    if (body.model !== 'opus[1m]' || body.stream !== true) throw new Error('Client model/stream contract differs')
    if (index === 0 && !tools.includes('read')) throw new Error('Actual client did not declare read')
    if (index === 1 && !report.requests.at(-1).toolResultMatched) throw new Error('Actual client tool result missing or failed')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const emit = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
    emit('message_start', { message: { id: 'owned-message-' + index, type: 'message', role: 'assistant', model: body.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } })
    if (index === 0) {
      emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'ownedread', name: 'read', input: {} } })
      emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path: fixture }) } })
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'OWNED_PROTOCOL_COMPLETE' } })
    }
    emit('content_block_stop', { index: 0 })
    emit('message_delta', { delta: { stop_reason: index === 0 ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
    emit('message_stop', {})
    response.end()
  } catch (error) {
    retired = true
    fail(error.message)
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: { type: 'api_error', message: 'Owned protocol fixture failed' } }))
  } finally { save() }
}
const server = createServer((request, response) => {
  const handler = handleRequest(request, response)
  handlers.add(handler)
  handler.then(() => handlers.delete(handler), error => { handlers.delete(handler); retired = true; fail(error.message) })
})
server.on('connection', socket => {
  sockets.add(socket)
  socketClosures.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
})
server.on('error', error => fail(error.message))
server.requestTimeout = 15_000
server.headersTimeout = 10_000
const env = {
  PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: join(output, 'home'), TMPDIR: join(output, 'tmp'),
  OPENCLAW_HOME: join(output, 'home'), OPENCLAW_STATE_DIR: join(output, 'state'),
  OPENCLAW_CONFIG_PATH: join(output, 'openclaw.json'), NODE_DISABLE_COMPILE_CACHE: '1',
  XDG_CONFIG_HOME: join(output, 'xdg-config'), XDG_CACHE_HOME: join(output, 'xdg-cache'), XDG_DATA_HOME: join(output, 'xdg-data'),
}
async function command(name, args, ms = 90_000) {
  const stdout = [], stderr = []
  const child = spawn(process.execPath, [bin, ...args], { cwd: join(output, 'workspace'), env, stdio: ['ignore', 'pipe', 'pipe'] })
  const witness = observeChildClosure(child)
  child.once('error', error => fail(error.message))
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.stdout.on('error', error => fail(error.message))
  child.stderr.on('error', error => fail(error.message))
  await bounded(witness.joined.then(() => true), ms)
  // Retire immediately at a failed close or deadline, before artifact writes.
  if (!witness.state.joined || witness.state.exitCode !== 0) {
    retired = true
    fail(!witness.state.joined ? name + ': deadline before process/pipe closure' : name + ': exit ' + witness.state.exitCode)
  }
  const closure = await stopAndJoinChild(child, witness, { graceMs: 3000, forceMs: 3000 })
  if (!closure.joined) fail(name + ': original process/pipe witnesses incomplete')
  const out = Buffer.concat(stdout), err = Buffer.concat(stderr)
  writeFileSync(join(output, name + '.stdout.log'), out, { mode: 0o600 })
  writeFileSync(join(output, name + '.stderr.log'), err, { mode: 0o600 })
  report.commands.push({ name, args, originalPid: child.pid ?? null, closure, stdoutSHA256: hash(out), stderrSHA256: hash(err) })
  save()
  if (report.firstFailure) throw new Error(report.firstFailure)
  return out.toString('utf8')
}
try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const config = {
    models: { mode: 'replace', providers: { meridian: { baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'owned-protocol-fixture-only',
      api: 'anthropic-messages', models: [{ id: 'opus[1m]', name: 'Owned fixture; no provider', reasoning: false,
        input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 }] } } },
    agents: { defaults: { workspace: join(output, 'workspace'), model: { primary: 'meridian/opus[1m]' }, memorySearch: { enabled: false }, thinkingDefault: 'off' } },
    tools: { allow: ['read'] }, plugins: { enabled: false }, gateway: { mode: 'local' },
  }
  writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  const version = await command('version', ['--version'])
  if (!version.includes('2026.6.11')) throw new Error('Expected reported OpenClaw 2026.6.11')
  report.clientVersion = version.trim()
  await command('config-validate', ['config', 'validate'])
  const result = await command('agent', ['agent', '--local', '--json', '--model', 'meridian/opus[1m]', '--session-id', randomUUID(),
    '--message', 'Read the owned fixture file using read, then report completion.', '--thinking', 'off', '--timeout', '60'])
  report.assertions = { exactlyTwoRequests: requestCount === 2, readResultReturned: report.requests[1]?.toolResultMatched === true,
    finalClientOutput: JSON.parse(result).payloads?.some(payload => payload.text === 'OWNED_PROTOCOL_COMPLETE') === true }
  if (!Object.values(report.assertions).every(Boolean)) throw new Error('Client protocol assertions failed')
} catch (error) { retired = true; fail(error.message) }
finally {
  retired = true
  const closed = new Promise(resolve => server.close(error => { if (error) fail(error.message); resolve(!error) }))
  server.closeIdleConnections()
  if (!await bounded(closed, 3000)) {
    fail('Owned listener/socket closure exceeded deadline')
    for (const socket of sockets) socket.destroy()
    await bounded(closed, 3000)
  }
  const socketJoins = await bounded(Promise.all(socketClosures).then(() => true), 3000)
  const handlerJoins = await bounded(Promise.allSettled([...handlers]).then(() => true), 3000)
  report.serverJoined = !server.listening && sockets.size === 0 && socketJoins && handlerJoins
  if (!report.serverJoined) fail('Owned listener/socket close witnesses incomplete')
  report.disposition = report.firstFailure ? 'FAILED_PROTOCOL_PREPARATION' : 'PASS_PROTOCOL_ONLY_NATIVE_ACCEPTANCE_HELD'
  save()
  console.log(JSON.stringify({ disposition: report.disposition, firstFailure: report.firstFailure, assertions: report.assertions, serverJoined: report.serverJoined }))
  if (report.firstFailure) process.exitCode = 1
  // A missing inherited-pipe or handler witness must not leave this harness
  // waiting forever after its durable failed receipt. This exit is a failure
  // bound, never evidence that the unjoined actor has been terminated.
  if (!report.serverJoined || report.commands.some(command => !command.closure.joined)) process.exit(1)
}
