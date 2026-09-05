#!/usr/bin/env bun
// Actual pinned OpenCode host against a local API, with isolated client state.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const client = process.env.E2E_OPENCODE_BIN
assert(client, 'Set E2E_OPENCODE_BIN to the pinned OpenCode binary')
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const live = process.argv.includes('--live')
const source = process.argv.includes('--source')
const v1 = process.argv.includes('--v1')
const extended = process.argv.includes('--extended')
assert(!extended || (live && !v1), '--extended requires --live and a V2 host')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-v2-package-')))
const config = join(root, 'config', 'opencode')
mkdirSync(config, { recursive: true })
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_') || key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete env[key]
for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
Object.assign(env, { OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: '1', MERIDIAN_CONFIG_DIR: join(root, 'meridian') })
const serverPassword = 'local-e2e-fixture-password'
env.OPENCODE_SERVER_PASSWORD = serverPassword
env.OPENCODE_PASSWORD = serverPassword
const serverAuthorization = `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`
const receipt = `BETA_RECEIPT_${crypto.randomUUID()}`
const forkMarker = `FORK_ONLY_${crypto.randomUUID()}`
const undoMarker = `UNDO_ONLY_${crypto.randomUUID()}`
const fixturePath = join(root, 'fixture.txt')
writeFileSync(fixturePath, receipt)
let proxy
let proxyUrl
const proxyOutputs = []
async function startMeridian() {
  let ready
  let rejectReady
  const readiness = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject })
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'e2e-opencode-proxy-host.mjs')], {
    cwd: root, env: { ...process.env, E2E_PROXY_MODULE: pathToFileURL(join(repo, 'dist/server.js')).href },
    stdout: 'pipe', stderr: 'pipe', ipc(message) { if (message.port) ready(message.port) },
  })
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  child.exited.then(code => rejectReady(new Error(`Proxy exited before readiness: ${code}`)))
  const timer = setTimeout(() => rejectReady(new Error('Proxy did not become ready')), 30_000)
  proxy = { close: async () => {
    child.kill()
    const killTimer = setTimeout(() => child.kill('SIGKILL'), 20_000)
    try { await child.exited; proxyOutputs.push(await output) } finally { clearTimeout(killTimer) }
  } }
  try { proxyUrl = `http://127.0.0.1:${await readiness}` } finally { clearTimeout(timer) }
}
if (live) {
  for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
  Object.assign(process.env, { MERIDIAN_CONFIG_DIR: env.MERIDIAN_CONFIG_DIR, MERIDIAN_SESSION_DIR: join(root, 'sessions'),
    MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_TELEMETRY_PERSIST: '0' })
  await startMeridian()
}
const requests = []
let primaryRequests = 0
let deliveredResultSeen = false
const endpoint = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  const body = await request.json()
  const headers = Object.fromEntries([...request.headers].filter(([key]) => (key.startsWith('x-') && key !== 'x-api-key') || key === 'user-agent'))
  const row = { requestId: crypto.randomUUID(), path: new URL(request.url).pathname, model: body.model, headers, hasForkMarker: JSON.stringify(body.messages).includes(forkMarker),
    hasUndoMarker: JSON.stringify(body.messages).includes(undoMarker), startedAt: Date.now() }
  requests.push(row)
  if (live) {
    const forwardedHeaders = new Headers(request.headers)
    forwardedHeaders.set('x-request-id', row.requestId)
    const response = await fetch(`${proxyUrl}${new URL(request.url).pathname}`, { method: 'POST', headers: forwardedHeaders, body: JSON.stringify(body), signal: request.signal })
    return new Response(response.body.pipeThrough(new TransformStream({ flush() { row.completedAt = Date.now() } })), { status: response.status, headers: response.headers })
  }
  const primary = headers['x-opencode-agent-name'] === 'build'
  if (primary) primaryRequests++
  const read = primary && primaryRequests === 1 ? body.tools?.find(tool => tool.name === 'read') : undefined
  if (primary && primaryRequests > 1 && body.messages.some(message => Array.isArray(message.content) && message.content.some(block =>
    block.type === 'tool_result' && block.tool_use_id === 'toolu_beta_read' && JSON.stringify(block.content).includes(receipt)))) deliveredResultSeen = true
  const text = receipt
  const pathKey = read?.input_schema?.properties?.path ? 'path' : 'filePath'
  if (read) assert(read.input_schema.properties[pathKey], 'Read tool has no supported file path property')
  const toolInput = { [pathKey]: fixturePath }
  const events = [
    { type: 'message_start', message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', content: [], model: body.model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: read ? { type: 'tool_use', id: 'toolu_beta_read', name: read.name, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: read ? { type: 'input_json_delta', partial_json: JSON.stringify(toolInput) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: read ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
} })
async function run(args) {
  const child = Bun.spawn(args, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), 180_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    console.log(JSON.stringify({ root, args, exitCode, stdout, stderr }))
    assert.equal(exitCode, 0)
    return stdout
  } finally { clearTimeout(timer) }
}
let server
let serverUrl
let serverOutput
async function startClientServer() {
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const port = reservation.port
  await reservation.stop(true)
  serverUrl = `http://127.0.0.1:${port}`
  server = Bun.spawn([client, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  serverOutput = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()])
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`${serverUrl}/api/session?directory=${encodeURIComponent(root)}`, { headers: { authorization: serverAuthorization } })
      if (response.ok) return
    } catch (error) { if (server.exitCode !== null) throw error }
    await Bun.sleep(100)
  }
  throw new Error('OpenCode API did not start')
}
async function api(path, method = 'GET', payload) {
  const response = await fetch(`${serverUrl}${path}`, { method, headers: { 'content-type': 'application/json', authorization: serverAuthorization },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(180_000) })
  const text = await response.text()
  assert(response.ok, `${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : undefined
}
const resumeEvidence = []
async function latestPrimaryTelemetry(session) {
  const requestId = requests.findLast(row => row.headers['x-opencode-session'] === session)?.requestId
  const rows = await (await fetch(`${proxyUrl}/telemetry/requests?limit=500`)).json()
  const row = rows.find(candidate => candidate.requestId === requestId)
  assert(row, 'No telemetry for the completed primary request')
  return row
}
function verifyResume(prior, current, label) {
  assert.equal(current.isResume, true, `${label} did not resume`)
  assert.equal(current.lineageType, 'continuation', `${label} replayed the conversation`)
  assert.notEqual(current.sdkSessionId, prior.sdkSessionId, `${label} did not publish a distinct fork`)
  const cached = (prior.cacheReadInputTokens ?? 0) + (prior.cacheCreationInputTokens ?? 0)
  assert(cached > 0 && current.cacheReadInputTokens >= cached * 0.95, `${label} lost the cached prefix: ${current.cacheReadInputTokens}/${cached}`)
  resumeEvidence.push({ label, prior: prior.sdkSessionId, current: current.sdkSessionId, cached, cacheRead: current.cacheReadInputTokens })
}
try {
  const version = (await run([client, '--version'])).trim()
  assert(v1 ? version === '1.18.11' : ['opencode2 v0.0.0-beta-18314', 'opencode2 v0.0.0-beta-18866'].includes(version))
  await run([source ? process.execPath : 'node', join(repo, source ? 'bin/cli.ts' : 'dist/cli.js'), 'setup', v1 ? '--v1' : '--v2', '--opencode-bin', client])
  const path = join(config, 'opencode.json')
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (v1) data.permission = { external_directory: { [`${root}/*`]: 'allow' } }
  else data.permissions = [{ action: 'external_directory', resource: `${root}/*`, effect: 'allow' }]
  const provider = { settings: { apiKey: 'local-fixture-key', baseURL: `http://127.0.0.1:${endpoint.port}/v1` },
    headers: { 'x-opencode-session': 'spoofed', 'x-session-affinity': 'spoofed', 'x-meridian-source': 'spoofed', 'x-opencode-agent-mode': 'subagent' } }
  if (v1) data.provider = { anthropic: { options: provider.settings } }
  else data.providers = { anthropic: provider }
  writeFileSync(path, JSON.stringify(data, null, 2))
  if (extended) await startClientServer()
  const base = [client, 'run', ...(extended ? ['--server', serverUrl] : v1 ? [] : ['--standalone']), '--format', 'json', '--model', 'anthropic/claude-haiku-4-5-20251001']
  const initial = await run([...base, `Read ${fixturePath} using the read tool. Return only its receipt text. Do not inspect other files or run commands.`])
  const parse = text => text.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  const first = parse(initial)
  assert(!first.some(event => event.type === 'error'), initial)
  assert(first.some(event => event.part?.type === 'tool' && event.part.state?.status === 'completed' && JSON.stringify(event.part.state.output).includes(receipt)),
    'Actual client did not complete a tool returning the fixture receipt')
  assert(first.some(event => event.type === 'text' && event.part?.text.includes(receipt)), initial)
  const session = first.find(event => event.sessionID)?.sessionID
  assert(session)
  let priorTelemetry = live ? await latestPrimaryTelemetry(session) : undefined
  const continued = await run([...base, '--session', session, '--agent', 'build', 'Return the receipt you just read, without calling tools.'])
  assert(parse(continued).some(event => event.type === 'text' && event.part?.text.includes(receipt)), continued)
  if (live) {
    const current = await latestPrimaryTelemetry(session)
    verifyResume(priorTelemetry, current, 'ordinary continuation')
    priorTelemetry = current
  }
  if (extended) {
    await proxy.close()
    await startMeridian()
    const restarted = parse(await run([...base, '--session', session, '--agent', 'build', 'Return the receipt again from context, without calling tools.']))
    assert(restarted.some(event => event.type === 'text' && event.part?.text.includes(receipt)), 'Restart lost the receipt')
    verifyResume(priorTelemetry, await latestPrimaryTelemetry(session), 'process restart')
  }
  if (!v1) await run([...base, '--session', session, '--agent', 'summary', 'Summarize the fixture receipt in one sentence.'])
  const fork = parse(await run([...base, '--session', session, '--agent', 'build', '--fork', `This fork has tracking token ${forkMarker}. Return the same receipt, without tools.`]))
  assert(fork.some(event => event.type === 'text' && event.part?.text.includes(receipt)))
  const forkSession = fork.find(event => event.sessionID)?.sessionID
  assert(forkSession && forkSession !== session)
  assert(requests.some(row => row.headers['x-opencode-agent-name'] === 'build' && row.headers['x-opencode-session'] === forkSession && row.hasForkMarker))
  const original = parse(await run([...base, '--session', session, '--agent', 'build', 'Return the original receipt, without calling tools.']))
  assert(original.some(event => event.type === 'text' && event.part?.text.includes(receipt)))
  assert.equal(requests.findLast(row => row.headers['x-opencode-session'] === session)?.hasForkMarker, false)
  if (extended) {
    const undoPath = join(root, 'undo.txt')
    writeFileSync(undoPath, undoMarker)
    const disposable = parse(await run([...base, '--session', session, '--agent', 'build', `Read ${undoPath} with read and return its exact text only.`]))
    assert(disposable.some(event => event.type === 'text' && event.part?.text.includes(undoMarker)))
    const context = await api(`/api/session/${session}/context`)
    const removed = context.data.find(message => message.type === 'user' && message.text.includes(undoPath))
    assert(removed, 'Missing disposable user message in supported context API')
    await api(`/api/session/${session}/revert/stage`, 'POST', { messageID: removed.id, files: false })
    await api(`/api/session/${session}/revert/commit`, 'POST')
    assert(!JSON.stringify(await api(`/api/session/${session}/context`)).includes(undoMarker), 'Undo retained removed result')
    const undone = parse(await run([...base, '--session', session, '--agent', 'build', 'Return the original fixture receipt from context without tools.']))
    assert(undone.some(event => event.type === 'text' && event.part?.text.includes(receipt)))
    assert.equal(requests.findLast(row => row.headers['x-opencode-session'] === session)?.hasUndoMarker, false)
    const childStart = requests.length
    const children = parse(await run([...base, '--session', session, '--agent', 'build',
      'Launch two general subagents concurrently with the task tool. Ask the first to reply CHILD_ALPHA_ONLY and the second CHILD_BRAVO_ONLY, without tools. Wait for both and report both exact tokens. Do not read files or use shell commands.']))
    assert(children.some(event => event.type === 'text' && event.part?.text.includes('CHILD_ALPHA_ONLY') && event.part.text.includes('CHILD_BRAVO_ONLY')))
    const childRequests = requests.slice(childStart).filter(row => row.headers['x-opencode-agent-name'] === 'general')
    assert(new Set(childRequests.map(row => row.headers['x-opencode-session'])).size >= 2, 'No distinct general child sessions')
    assert(childRequests.every(row => row.headers['x-opencode-agent-mode'] === 'subagent'))
    assert(childRequests.some((a, index) => childRequests.some((b, other) => index !== other && a.startedAt < b.completedAt && b.startedAt < a.completedAt)), 'Child requests did not overlap')
    await run([...base, '--session', session, '--agent', 'build', 'Our next task needs the original fixture receipt exactly. State it now and preserve it for the next turn. Do not call tools.'])
    await api(`/api/session/${session}/compact`, 'POST', {})
    await api(`/api/session/${session}/wait`, 'POST')
    const compacted = await api(`/api/session/${session}/context`)
    assert(compacted.data.some(message => message.type === 'compaction' && message.summary), 'No durable compaction summary')
    const afterCompact = parse(await run([...base, '--session', session, '--agent', 'build', 'Return the original receipt exactly from context, without tools.']))
    assert(afterCompact.some(event => event.type === 'text' && event.part?.text.includes(receipt)))
    const compactionRequests = requests.filter(row => row.headers['x-opencode-agent-name'] === 'compaction')
    assert(compactionRequests.length)
    assert(compactionRequests.every(row => row.headers['x-opencode-session'] === session && row.headers['x-meridian-source'] === 'subagent-compaction'))
  }
  assert(requests.length > 0, 'No API request reached fixture')
  assert(requests.some(row => row.headers['x-opencode-agent-mode'] === 'primary'), 'Primary plugin hook did not run')
  for (const name of v1 ? [] : ['title', 'summary']) {
    const rows = requests.filter(row => row.headers['x-opencode-agent-name'] === name)
    assert(rows.length, `No ${name} request observed`)
    for (const { headers } of rows) {
      assert.equal(headers['x-meridian-source'], `subagent-${name}`)
      assert.equal(headers['x-opencode-agent-mode'], 'subagent')
      for (const header of ['x-opencode-session', 'x-session-affinity', 'x-session-id', 'x-parent-session-id', 'x-meridian-opencode-turn']) assert(!headers[header], `${name} retained ${header}`)
    }
  }
  for (const { headers } of requests.filter(row => row.headers['x-opencode-agent-name'] === 'build')) {
    assert.equal(headers['x-opencode-agent-mode'], 'primary')
    assert(headers['x-opencode-session'] && headers['x-opencode-session'] !== 'spoofed')
    assert(!headers['x-meridian-source'])
  }
  if (!live) assert(deliveredResultSeen, 'Actual file result did not return to the API')
  assert.equal((await run([client, '--version'])).trim(), version)
  console.log(JSON.stringify({ result: 'PASS', version, source, live, extended, root, session, requests, resumeEvidence }))
} finally {
  console.log(JSON.stringify({ requestTrace: requests }))
  if (server) { server.kill(); await server.exited; console.log(JSON.stringify({ serverOutput: await serverOutput })) }
  await endpoint.stop(true)
  await proxy?.close()
  if (live) console.log(JSON.stringify({ proxyOutputs }))
}
