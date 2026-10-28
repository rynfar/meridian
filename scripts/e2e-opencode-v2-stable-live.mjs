#!/usr/bin/env bun
// Pinned stable OpenCode (including Desktop's bundled CLI) -> Meridian V2 plugin.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { observeChildClosure, stopAndJoinChild } from './lib/e2eProcessCustody.mjs'
import { clientAnswer, requireAnswer, requireLiveAdmission, requireSuccessfulTurn, correlatedModels, streamResponse, sseErrorObserver } from './lib-opencode-v2-evidence.mjs'
import { verifyPriorityAttestation } from '../src/proxy/priorityAttestation.ts'

const expectedClientVersion = process.env.E2E_OPENCODE_VERSION ?? '2.0.16'
assert(['2.0.16','2.0.21','2.0.31','2.2.0'].includes(expectedClientVersion), 'Pin a qualified stable host')
const client = process.env.E2E_OPENCODE_BIN
assert(client, 'Set E2E_OPENCODE_BIN to the exact stable OpenCode executable')
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
if (process.env.E2E_EXPECT_MERIDIAN_VERSION) assert.equal(version, process.env.E2E_EXPECT_MERIDIAN_VERSION)
const model = process.env.E2E_MODEL ?? 'claude-haiku-4-5'
const fixture = process.argv.includes('--fixture')
const live = process.argv.includes('--live')
assert(fixture !== live, 'Select --fixture (no credentials) or --live explicitly')
if (live) {
  assert.equal(process.env.E2E_ALLOW_LIVE_MODEL, '1', 'Live generation requires explicit admission')
  assert(process.env.E2E_PROXY_URL, 'Live mode requires an already-running, operator-authorized proxy; never spawn with ambient credentials')
  assert(process.env.E2E_ATTESTATION_KEY, 'Use the external proxy attestation key without printing it')
}
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-opencode-v2-stable-')))
const project = join(root, 'project')
const config = join(root, 'opencode')
const meridianConfig = join(root, 'meridian')
const clientHome = join(root, 'client-home')
for (const path of [project, config, meridianConfig, clientHome]) mkdirSync(path)
// The server scrub a Claude subscription needs for OpenCode traffic; without
// it Claude can refuse the client as third-party ("extra usage").
if (process.env.E2E_PLUGIN_PATH) {
  writeFileSync(join(meridianConfig, 'plugins.json'),
    JSON.stringify({ plugins: [{ path: resolve(process.env.E2E_PLUGIN_PATH), enabled: true }] }))
}
// The source the installed plugin is expected to send for attached compaction;
// override only to observe an older plugin build as a control.
const compactionSource = process.env.E2E_COMPACTION_SOURCE ?? 'fork-compaction'
const marker = process.env.E2E_MARKER ?? `OC2_STABLE_${randomUUID()}`
assert(/^OC2_STABLE_[a-f0-9-]{36}$/.test(marker), 'Use a fixture marker, not customer text')
const variantMarker = `VARIANT_${randomUUID()}`
const fileReceipt = `FILE_RECEIPT_${randomUUID()}`
const forkMarker = `FORK_ONLY_${randomUUID()}`
const generateMarker = `GENERATE_${randomUUID()}`
writeFileSync(join(project, 'fixture.txt'), fileReceipt)
const attestationKey = process.env.E2E_ATTESTATION_KEY ?? randomBytes(32).toString('base64url')
const observed = []
const discovery = []
let summary
let compactionModels = []
let relay
let fixtureServer
let admissionFailure
let livePreflight
let proxyURL = process.env.E2E_PROXY_URL
const joins = []
const pendingForwards = new Set()
const forwardControllers = new Set()
async function json(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) })
  assert(response.ok, `Readiness/API HTTP ${response.status}`)
  return response.json()
}
function output(stream) {
  let text = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => { text += chunk })
  return () => text
}
try {
  if (fixture) {
    assert(!proxyURL, '--fixture cannot forward to a real proxy')
    fixtureServer = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
      if (new URL(request.url).pathname === '/v1/models') {
        return Response.json({ data: [{ id: model, display_name: 'Discovered fixture model', context_window: 234_567,
          capabilities: { effort: { xhigh: { supported: true } } } }] })
      }
      if (request.method === 'GET') return Response.json([])
      const body = await request.json()
      const messages = JSON.stringify(body.messages)
      const needsRead = request.headers.get('x-opencode-agent-mode') === 'primary'
        && !messages.includes('"tool_result"') && messages.includes('Use the read tool')
      const read = needsRead
        ? body.tools?.find(tool => tool.name === 'read') : undefined
      if (needsRead) assert(read, 'Client did not advertise read')
      const pathKey = read?.input_schema?.properties?.path ? 'path' : 'filePath'
      const text = request.headers.get('x-meridian-source') === 'fork-compaction'
        ? `## Objective\n- Recall the fixture.\n\n## Requirements\n- Preserve its value.\n\n## Decisions\n- (none)\n\n## Work State\n### Completed\n- Read the marker.\n### Active\n- (none)\n### Blocked\n- (none)\n\n## Next Move\n1. Return the marker.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- ${marker}`
        : messages.includes(fileReceipt) ? fileReceipt
        : messages.includes(variantMarker) ? variantMarker
        : messages.includes(forkMarker) ? forkMarker
        : messages.includes(generateMarker) ? generateMarker : marker
      const events = [
        { type: 'message_start', message: { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content: [],
          model: body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: read
          ? { type: 'tool_use', id: 'toolu_fixture_read', name: read.name, input: {} } : { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: read
          ? { type: 'input_json_delta', partial_json: JSON.stringify({ [pathKey]: join(project, 'fixture.txt') }) }
          : { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: read ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } })
    proxyURL = `http://127.0.0.1:${fixtureServer.port}`
  }
  const target = new URL(proxyURL)
  assert(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Use an operator-owned loopback proxy')
  if (live) {
    const [health, profiles, quota, plugins] = await Promise.all([
      json(`${proxyURL}/health`), json(`${proxyURL}/profiles/list`), json(`${proxyURL}/v1/usage/quota/all`), json(`${proxyURL}/plugins/list`),
    ])
    const usage = quota.profiles.find(profile => profile.id === profiles.activeProfile)
    requireLiveAdmission(profiles, usage, Date.now())
    const scrub = plugins.plugins.find(plugin => plugin.name === 'opencode-scrub')
    assert(scrub?.status === 'active' && scrub.version === process.env.E2E_SCRUB_VERSION, 'Pin the actual loaded server scrub version')
    assert.equal(scrub.stats.hooks.onRequest.errors, 0)
    livePreflight = { proxyVersion: health.version, nativeExecutable: health.claudeExecutable,
      checkedAt: Date.now(), fetchedAt: usage.fetchedAt, extraUsageEnabled: false, windows: usage.windows,
      scrub: { path: scrub.path, version: scrub.version, invocations: scrub.stats.hooks.onRequest.invocations } }
    writeFileSync(join(root, 'live-preflight.json'), JSON.stringify(livePreflight, null, 2))
  }
  relay = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url)
    if (admissionFailure && request.method === 'POST') return new Response('Qualification stopped after provider failure', { status: 409 })
    if (request.method === 'GET' && url.pathname.endsWith('/models')) discovery.push(url.pathname)
    const body = request.method === 'GET' ? undefined : await request.arrayBuffer()
    let row
    if (url.pathname === '/v1/messages' && body) {
      let parsed
      try { parsed = JSON.parse(new TextDecoder().decode(body)) } catch { parsed = undefined }
      const messages = JSON.stringify(parsed?.messages ?? [])
      row = {
        requestId: randomUUID(),
        path: url.pathname,
        model: parsed?.model,
        effort: parsed?.effort ?? parsed?.output_config?.effort,
        systemBlockLengths: Array.isArray(parsed?.system) ? parsed.system.map(block => block.text?.length ?? 0) : [],
        session: request.headers.get('x-opencode-session'),
        agent: request.headers.get('x-opencode-agent-name'),
        mode: request.headers.get('x-opencode-agent-mode'),
        source: request.headers.get('x-meridian-source'),
        attested: (() => {
          const token = verifyPriorityAttestation(request.headers.get('x-meridian-opencode-turn') ?? undefined,
            Buffer.from(attestationKey, 'base64url'))
          return token?.generation === 'oc2v2016' && token.sessionId === request.headers.get('x-opencode-session')
            && token.agentId === request.headers.get('x-opencode-agent-name')
            && Math.abs(Date.now() / 1000 - token.issuedAt) < 300
        })(),
        hasMarker: messages.includes(marker),
        hasVariantMarker: messages.includes(variantMarker),
        hasFileReceipt: messages.includes(fileReceipt),
        hasForkMarker: messages.includes(forkMarker),
        hasGenerateMarker: messages.includes(generateMarker),
        hasToolUse: messages.includes('"tool_use"'),
        hasToolResult: messages.includes('"tool_result"'),
      }
      observed.push(row)
    }
    const controller = new AbortController()
    const headers = new Headers(request.headers)
    if (row) headers.set('x-request-id', row.requestId)
    const signal = AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(120_000)])
    forwardControllers.add(controller)
    try {
      const upstream = await fetch(`${proxyURL}${url.pathname}${url.search}`, {
        method: request.method, headers, signal,
        ...(body === undefined ? {} : { body }),
      })
      if (row) row.status = upstream.status
      if (row && upstream.status !== 200) admissionFailure = `Upstream HTTP ${upstream.status}`
      const observe = row ? sseErrorObserver(type => { row.streamError = type; admissionFailure = `Upstream SSE ${type}` }) : undefined
      const forwarded = streamResponse(upstream, controller, { signal, onChunk: observe })
      pendingForwards.add(forwarded.done)
      void forwarded.done.then(() => { pendingForwards.delete(forwarded.done); forwardControllers.delete(controller) })
      return forwarded.response
    } catch (error) {
      forwardControllers.delete(controller)
      if (row) row.transportError = error.name
      return new Response('Test relay transport failed', { status: 502 })
    }
  } })
  const relayURL = `http://127.0.0.1:${relay.port}`
  const plugin = join(repo, 'dist', 'meridian-v2')
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: `anthropic/${model}`,
    providers: { anthropic: { settings: { apiKey: 'local-e2e', baseURL: `${relayURL}/v1` },
      models: { [model]: { limit: { output: 4096 } } } } },
  }, null, 2))
  const clientEnv = { ...process.env }
  for (const key of Object.keys(clientEnv)) {
    if (key.startsWith('OPENCODE_') || key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_') || key.startsWith('ANTHROPIC_')) delete clientEnv[key]
  }
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) clientEnv[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
  Object.assign(clientEnv, {
    OPENCODE_CONFIG_DIR: config,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_PASSWORD: 'local-e2e',
    MERIDIAN_CONFIG_DIR: meridianConfig,
    MERIDIAN_OPENCODE_ATTESTATION_KEY: attestationKey,
    PWD: project,
    INIT_CWD: project,
    HOME: clientHome,
  })
  const versionRun = Bun.spawnSync([client, '--version'], { env: clientEnv })
  assert.equal(versionRun.exitCode, 0)
  assert.equal(new TextDecoder().decode(versionRun.stdout).trim(), `opencode v${expectedClientVersion}`)
  const setup = Bun.spawnSync(['node', join(repo, 'dist', 'cli.js'), 'setup', '--v2', '--opencode-bin', client],
    { cwd: project, env: clientEnv })
  assert.equal(setup.exitCode, 0, `Meridian setup rejected ${expectedClientVersion}: ${new TextDecoder().decode(setup.stderr)}`)
  const configured = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'))
  assert.deepEqual(configured.plugins.map(path => realpathSync(path)), [realpathSync(plugin)],
    'Setup did not install the packaged V2 plugin exactly once')
  writeFileSync(join(root, 'setup.json'), JSON.stringify({ client: expectedClientVersion, plugin,
    configuration: configured, setupExit: setup.exitCode }, null, 2))
  async function runClient(label, flags, prompt) {
    const run = spawn(client, ['run', '--server', base, '--auto', '--format', 'json', ...flags, prompt], {
      cwd: project, env: clientEnv, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const witness = observeChildClosure(run)
    const stdoutText = output(run.stdout)
    const stderrText = output(run.stderr)
    let timeout
    const closed = await Promise.race([witness.joined.then(() => true),
      new Promise(resolve => { timeout = setTimeout(() => resolve(false), 180_000) })]).finally(() => clearTimeout(timeout))
    const joined = await stopAndJoinChild(run, witness, { graceMs: 3000, forceMs: 3000 })
    joins.push({ label, ...joined })
    const stdout = stdoutText(), stderr = stderrText(), code = joined.exitCode
    writeFileSync(join(root, `${label}.stdout`), stdout)
    writeFileSync(join(root, `${label}.stderr`), stderr)
    writeFileSync(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
    assert(closed && joined.joined, `${label}: client process/pipes did not join`)
    assert.equal(code, 0, `${label}: OpenCode exit ${code}; see ${root}/${label}.stderr`)
    clientAnswer(stdout)
    assert(!admissionFailure, admissionFailure)
    const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    const sessionID = events.find(event => event.sessionID)?.sessionID
    const context = await json(`${base}/api/session/${sessionID}/context`, { headers })
    requireSuccessfulTurn(context.data)
    return stdout
  }
  const reservation = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('reserved') })
  const apiPort = reservation.port
  await reservation.stop(true)
  const server = spawn(client, ['serve', '--hostname', '127.0.0.1', '--port', String(apiPort)], {
    cwd: project, env: clientEnv, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const serverWitness = observeChildClosure(server)
  const serverStdout = output(server.stdout), serverStderr = output(server.stderr)
  const authorization = `Basic ${Buffer.from('opencode:local-e2e').toString('base64')}`
  const base = `http://127.0.0.1:${apiPort}`
  const headers = { authorization, 'content-type': 'application/json' }
  try {
    let ready = false
    for (let attempt = 0; attempt < 150; attempt++) {
      try {
        const response = await fetch(`${base}/api/info`, { headers, signal: AbortSignal.timeout(1000) })
        if (response.ok) { ready = true; break }
      } catch (error) { if (server.exitCode !== null) throw error }
      await Bun.sleep(100)
    }
    assert(ready, `OpenCode ${expectedClientVersion} API server did not load the persisted session`)
    const directoryQuery = `?directory=${encodeURIComponent(project)}`
    let plugins
    let loaded
    for (let attempt = 0; attempt < 100; attempt++) {
      plugins = await json(`${base}/api/plugin${directoryQuery}`, { headers })
      loaded = plugins.data.filter(entry => entry.id === 'meridian')
      if (loaded.length > 0) break
      await Bun.sleep(100)
    }
    assert.equal(loaded.length, 1, `Exactly one Meridian plugin must load: ${JSON.stringify({ location: plugins.location,
      local: plugins.data.filter(entry => entry.source.type !== 'builtin') })}`)
    assert.equal(loaded[0].state.status, 'active', 'Meridian plugin failed to activate')
    assert.equal(realpathSync(loaded[0].source.path), realpathSync(plugin), 'Generating host loaded the wrong plugin package')
    const advertised = await json(`${proxyURL}/v1/models`)
    const expectedModel = advertised.data.find(entry => entry.id === model)
    assert(expectedModel, 'Meridian did not advertise the test model')
    let adopted
    for (let attempt = 0; attempt < 100; attempt++) {
      const catalog = await json(`${base}/api/model${directoryQuery}`, { headers })
      adopted = catalog.data.find(entry => entry.providerID === 'anthropic' && entry.id === model)
      if (adopted?.limit.context === expectedModel.context_window) break
      await Bun.sleep(100)
    }
    assert.equal(adopted?.limit.context, expectedModel.context_window, 'Client did not adopt Meridian context discovery')
    assert(discovery.length > 0 && discovery.every(path => path === '/v1/models'), 'Plugin discovery did not use /v1/models')
    writeFileSync(join(root, 'plugin-witness.json'), JSON.stringify({ plugin: loaded[0],
      adopted: { id: adopted.id, context: adopted.limit.context }, discovery }, null, 2))
    const first = await runClient('first', ['--model', `anthropic/${model}`],
      `Reply with exactly ${marker}. Do not call any tools.`)
    assert(first.includes('"type":"text"'), `No model response text; see ${root}/first.stdout`)
    requireAnswer(first, marker)
    const primary = observed.find(row => row.hasMarker && row.session && row.agent === 'build' && row.mode === 'primary')
    assert(primary?.attested, `No attested primary request: ${JSON.stringify(observed)}`)
    assert(observed.some(row => row.hasMarker && row.agent === 'title' && row.mode === 'subagent' && !row.session),
      `Title job was not detached: ${JSON.stringify(observed)}`)

    const beforeResume = observed.length
    const resumed = await runClient('resumed', ['--session', primary.session, '--model', `anthropic/${model}`],
      'Repeat the exact OC2_STABLE marker from the previous user message. Do not call tools.')
    assert(resumed.includes('"type":"text"'), `No resumed model response text; see ${root}/resumed.stdout`)
    requireAnswer(resumed, marker)
    assert(observed.slice(beforeResume).some(row => row.session === primary.session && row.agent === 'build' && row.attested && row.hasMarker),
      'Resumed primary request lost the prior user marker or signed turn identity')

    const variant = await runClient('variant', ['--model', `anthropic/${model}#xhigh`],
      `Reply with exactly ${variantMarker}. Do not call any tools.`)
    requireAnswer(variant, variantMarker)
    assert(observed.some(row => row.hasVariantMarker && row.effort === 'xhigh' && row.agent === 'build' && row.attested),
      `Discovered xhigh effort did not reach Meridian with the fixture input: ${JSON.stringify(observed)}`)

    const beforeTool = observed.length
    const tool = await runClient('tool', ['--model', `anthropic/${model}`],
      'Use the read tool to open fixture.txt in the current directory. Return only its exact contents.')
    assert(observed.slice(beforeTool).some(row => row.hasFileReceipt && row.hasToolResult && row.agent === 'build'),
      `The real read tool result did not reach the model: ${JSON.stringify(observed.slice(beforeTool))}`)
    requireAnswer(tool, fileReceipt)

    const beforeFork = observed.length
    const forkAnswer = await runClient('fork', ['--session', primary.session, '--fork', '--model', `anthropic/${model}`],
      `In this fork, reply with exactly ${forkMarker}. Do not use tools.`)
    requireAnswer(forkAnswer, forkMarker)
    const fork = observed.slice(beforeFork).find(row => row.hasForkMarker && row.agent === 'build' && row.session)
    assert(fork && fork.session !== primary.session, `Fork reused the source session: ${JSON.stringify(observed.slice(beforeFork))}`)
    assert.equal(fork.attested, false, 'A fork must not receive a root human-turn attestation')
    const beforeOriginal = observed.length
    const original = await runClient('original', ['--session', primary.session, '--model', `anthropic/${model}`],
      'Return the original OC2_STABLE marker. Do not use tools.')
    requireAnswer(original, marker)
    assert(observed.slice(beforeOriginal).some(row => row.session === primary.session && row.agent === 'build' && !row.hasForkMarker),
      `Original session contains the fork-only marker: ${JSON.stringify(observed.slice(beforeOriginal))}`)

    const beforeGenerate = observed.length
    const generated = await fetch(`${base}/api/session/${primary.session}/generate`, {
      method: 'POST', headers, body: JSON.stringify({ prompt: `Reply with exactly ${generateMarker}.` }),
      signal: AbortSignal.timeout(120_000),
    })
    const generatedBody = await generated.text()
    assert(generated.ok, `Session generate failed: ${generated.status} ${generatedBody.slice(0, 300)}`)
    assert.equal(typeof JSON.parse(generatedBody).data?.text, 'string')
    assert.equal(JSON.parse(generatedBody).data.text.trim(), generateMarker)
    assert(observed.slice(beforeGenerate).some(row => row.hasGenerateMarker && row.agent === 'generate'
      && row.mode === 'subagent' && row.source === 'subagent-generate' && !row.session && !row.attested),
    `Transient generate was not detached: ${JSON.stringify(observed.slice(beforeGenerate))}`)

    const beforeCompaction = observed.length
    const compact = await fetch(`${base}/api/session/${primary.session}/compact`, {
      method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(120_000),
    })
    const compactBody = await compact.text()
    assert(compact.ok, `Session compaction admission failed: ${compact.status} ${compactBody.slice(0, 300)}`)
    const settled = await fetch(`${base}/api/experimental/session/${primary.session}/wait`, {
      method: 'POST', headers, signal: AbortSignal.timeout(120_000),
    })
    assert(settled.ok, `Session compaction did not settle: ${settled.status}`)
    const context = await json(`${base}/api/session/${primary.session}/context`, { headers })
    writeFileSync(join(root, 'compaction-state.json'), JSON.stringify(context, null, 2))
    assert(context.data.some(message => message.type === 'compaction' && message.status === 'completed' && message.summary
      && JSON.stringify(message.summary).includes(marker)), 'No completed compaction summary preserved the fixture')
    assert(observed.slice(beforeCompaction).some(row => row.session === primary.session
      && row.source === compactionSource && row.mode === 'primary' && !row.attested),
    `Compaction changed the root identity or source: ${JSON.stringify(observed.slice(beforeCompaction))}`)
    const telemetry = await json(`${proxyURL}/telemetry/requests?limit=500`)
    compactionModels = correlatedModels(observed.slice(beforeCompaction).map(row => row.requestId), telemetry)
  } finally {
    const joined = await stopAndJoinChild(server, serverWitness, { graceMs: 3000, forceMs: 3000 })
    joins.push({ label: 'server', ...joined })
    writeFileSync(join(root, 'server.stdout'), serverStdout())
    writeFileSync(join(root, 'server.stderr'), serverStderr())
    assert(joined.joined, 'Client server process/pipes did not join')
  }
  writeFileSync(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
  summary = { result: 'PASS', fixture, root, client: expectedClientVersion, meridian: version, model, plugin, discovery, joins,
    requests: observed.length, primary: observed.filter(row => row.agent === 'build'),
    auxiliary: observed.filter(row => row.agent === 'generate' || row.source === compactionSource) }
} finally {
  for (const controller of forwardControllers) controller.abort()
  await relay?.stop(true)
  await fixtureServer?.stop(true)
  await Promise.allSettled([...pendingForwards])
  writeFileSync(join(root, 'process-joins.json'), JSON.stringify(joins, null, 2))
  if (livePreflight) {
    try {
      const plugins = await json(`${proxyURL}/plugins/list`)
      const scrub = plugins.plugins.find(plugin => plugin.name === 'opencode-scrub')
      assert(scrub?.status === 'active' && scrub.path === livePreflight.scrub.path && scrub.version === livePreflight.scrub.version,
        'The admitted scrub changed during the run')
      assert.equal(scrub.stats.hooks.onRequest.errors, 0)
      const processed = scrub.stats.hooks.onRequest.invocations - livePreflight.scrub.invocations
      assert(processed >= observed.filter(row => row.status && row.status < 400).length, 'Scrub hook did not process the completed test requests')
      livePreflight.scrubFinal = { processed, errors: 0, status: 'active', path: scrub.path, version: scrub.version }
    } catch (error) {
      livePreflight.scrubFinal = { failure: error.message }
    }
    writeFileSync(join(root, 'live-preflight.json'), JSON.stringify(livePreflight, null, 2))
    if (summary) assert(!livePreflight.scrubFinal.failure, livePreflight.scrubFinal.failure)
  }
}
if (summary) {
  const expected = process.env.E2E_EXPECT_COMPACTION_MODEL
  if (expected) assert(compactionModels.length > 0 && compactionModels.every(routed => routed === expected),
    `Compaction was routed to ${JSON.stringify(compactionModels)}, expected ${expected}`)
  const report = { ...summary, compactionModels }
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
