import { spyOn } from 'bun:test'
import { createOwnedCheckpointWitness } from './e2eOwnedCheckpoint.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const source = arg('source-root'), output = arg('evidence-dir'), cli = arg('claude-executable'), installed = arg('target-kind') === 'installed'
assert(source && output && cli)
const root = await mkdtemp(join(tmpdir(), 'meridian-integrated-control-'))
await mkdir(output, { recursive: true }); await writeFile(join(output, 'RESERVED'), '', { flag: 'wx' })
const report = { kind: 'native-stop-provider-eof-causal-control', actualModelAcceptance: false, actualClientAcceptance: false, platform: `${process.platform}/${process.arch}`, bun: Bun.version, cases: [], outcome: 'INCOMPLETE', realCredentialReads: 0 }
const inherited = { ...process.env }, initialCwd = process.cwd(), originalDebug = console.debug
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, { PATH: inherited.PATH, HOME: root, TMPDIR: root, XDG_CACHE_HOME: join(root, '.cache'), CLAUDE_CONFIG_DIR: join(root, 'claude-config'), MERIDIAN_CONFIG_DIR: join(root, 'meridian-config'), MERIDIAN_SESSION_DIR: join(root, 'store'), MERIDIAN_CLAUDE_PATH: cli, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_SESSION_GC_INTERVAL_MS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', OPENCODE_CLAUDE_PROVIDER_DEBUG: '1' })
process.chdir(root)
let sdkSpy; const checkpointWitnesses = [], queryDiagnostics = [], providerBodies = [], bodyJoins = [];
const began = performance.now(), elapsed = () => Math.round((performance.now() - began) * 1000) / 1000;
const sanitize = value => value.replaceAll(root, '<owned-runtime>').replaceAll(source, '<qualified-target>').replaceAll(cli, '<qualified-native>').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<owned-id>').slice(0, 4096);
const errorFacts = value => typeof value === 'string' ? { characters: value.length, sha256: createHash('sha256').update(value).digest('hex'), ownedFixturePublicText: sanitize(value) } : undefined;
let admission = true, active, provider, proxy, failure, store, getSessionMessages, requests = [], qualified = [], ownedControls = [], inflight = []
console.debug = (...args) => {
  if (typeof args[0] !== 'string' || !args[0].startsWith('[opencode-claude-code-provider] ')) return
  const event = JSON.parse(args[0].slice('[opencode-claude-code-provider] '.length))
  if (event.event === 'passthrough.checkpoint_interrupt_qualified') qualified.push({ mode: event.mode, acknowledged: event.acknowledged, qualified: event.qualified, generations: event.generations, tools: event.tools })
}
async function bounded(promise, ms, reason) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function nativeCensus() {
  const rows = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid || name === '1') continue
    let comm
    try { comm = (await readFile(`/proc/${name}/comm`, 'utf8')).trim() }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error }
    if (['node', 'bun', 'claude', 'claude.exe'].includes(comm)) rows.push({ pid: Number(name), comm })
  }
  return rows
}
function respond(body, state) {
  const content = state.phase === 'tool' ? Array.from({ length: state.tools }, (_, ordinal) => ({ type: 'tool_use', id: `tool_${randomUUID()}`, name: state.nativeToolName, input: { ordinal: ordinal + 1 } })) : [{ type: 'text', text: 'fixture continuation complete' }]
  if (state.phase === 'tool') state.scriptedTools = content
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: state.phase === 'tool' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: Math.max(1, content.length), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  assert.equal(body.stream, true, 'native API transport unexpectedly changed')
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } }]
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { ...block, input: {} } })
    events.push({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }, { type: 'message_stop' })
  const bytes = new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
  const bodyFact = { case: state.name, phase: state.phase, configuredEOFDelayMs: state.phase === 'tool' ? state.eofDelayMs : 0, messageStopWrittenMs: elapsed(), bodyClosedMs: null, bodyCancelledMs: null }
  providerBodies.push(bodyFact)
  let settled = false, timer, controller, join
  bodyJoins.push(new Promise(resolve => { join = resolve }))
  const close = () => { if (settled) return; settled = true; clearTimeout(timer); controller.close(); bodyFact.bodyClosedMs = elapsed(); join() }
  const stream = new ReadableStream({
    start(value) { controller = value; value.enqueue(bytes); if (bodyFact.configuredEOFDelayMs === 0) close(); else timer = setTimeout(close, bodyFact.configuredEOFDelayMs) },
    cancel() { if (settled) return; settled = true; clearTimeout(timer); bodyFact.bodyCancelledMs = elapsed(); join() },
  })
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
}
function decode(text, stream) {
  if (!stream) return JSON.parse(text)
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  assert(!events.some(event => event.type === 'error'), 'proxy streamed an error')
  const content = [], fragments = new Map()
  for (const event of events) {
    if (event.type === 'content_block_start') { content[event.index] = event.content_block; fragments.set(event.index, '') }
    if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') fragments.set(event.index, fragments.get(event.index) + event.delta.partial_json)
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') content[event.index].text += event.delta.text
    if (event.type === 'content_block_stop' && content[event.index]?.type === 'tool_use') content[event.index].input = JSON.parse(fragments.get(event.index))
  }
  return { content: content.filter(Boolean), stop_reason: events.filter(event => event.type === 'message_delta').at(-1)?.delta?.stop_reason }
}
async function request(state, messages) {
  const promise = (async () => {
    const response = await proxy.app.fetch(new Request('http://localhost/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-noncredential', 'user-agent': 'opencode/1.0.0', 'x-opencode-agent': 'build', 'x-opencode-agent-mode': 'primary', 'x-opencode-session': state.clientSession },
      body: JSON.stringify({ model: 'claude-sonnet-5-5', stream: state.stream, max_tokens: 1024, messages, tools: [{ name: 'read', description: 'Read a fixture record', input_schema: { type: 'object', properties: { ordinal: { type: 'integer' } }, required: ['ordinal'] } }] }),
    }))
    const text = await response.text(); assert.equal(response.status, 200, 'proxy HTTP request failed')
    return decode(text, state.stream)
  })()
  inflight.push(promise); return await bounded(promise, 35000, 'integrated HTTP request deadline')
}
try {
  const requireSource = createRequire(join(source, 'package.json'))
  report.sdkVersion = requireSource('@anthropic-ai/claude-agent-sdk/package.json').version
  report.nativeVersion = requireSource('@anthropic-ai/claude-code/package.json').version
  assert.equal(report.sdkVersion, '0.2.141'); assert.equal(report.nativeVersion, arg('expected-cli-version'))
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64')
  const version = spawnSync(cli, ['--version'], { encoding: 'utf8', timeout: 5000 }); assert.equal(version.status, 0); assert(version.stdout.startsWith(report.nativeVersion + ' '))
  const core = join(source, 'dist/claude-proxy-core.js'), sdkEntry = requireSource.resolve('@anthropic-ai/claude-agent-sdk')
  report.identity = { targetKind: installed ? 'installed' : 'source', runtimeBuildHead: '6d773781ac03359df22f1226807becd95b28005b', currentCodeHead: 'cfacfd36a90eef12b9412ad5cd807d9e5de5d3fe', coreSha256: createHash('sha256').update(readFileSync(core)).digest('hex'), sdkEntrySha256: createHash('sha256').update(readFileSync(sdkEntry)).digest('hex'), nativeSha256: createHash('sha256').update(readFileSync(cli)).digest('hex'), actualNativeVersionMatched: true }
  assert.equal(report.identity.coreSha256, '7c5efc44d215cf411b4b60dd90349b9b0feeb783303e1847003b4f78107522a7')
  assert.equal(report.identity.sdkEntrySha256, '48bde6aeabf7e71ad5528bf52c8feb1642c21f505ea2495c70f39db7df226d97')
  const sdk = await import(pathToFileURL(requireSource.resolve('@anthropic-ai/claude-agent-sdk')).href)
  getSessionMessages = sdk.getSessionMessages
  const originalQuery = sdk.query
  sdkSpy = spyOn(sdk, 'query').mockImplementation(input => {
    assert(queryDiagnostics.length < 24, 'bounded native Query admission exceeded')
    const diagnostic = { case: active?.name, phase: active?.phase, maxTurns: input.options.maxTurns, resumed: typeof input.options.resume === 'string', fork: input.options.forkSession === true, admittedMs: elapsed() }; queryDiagnostics.push(diagnostic)
    const witness = createOwnedCheckpointWitness({ maxTurns: input.options.maxTurns, signal: input.options.abortController?.signal, forwardedReason: 'This tool call has been forwarded to the client for execution. The result will be delivered in a future turn. Do not retry, do not call additional tools, and do not generate further text — end your turn now.' })
    checkpointWitnesses.push(witness)
    const hooks = input.options.hooks.PreToolUse.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(hook => async (event, toolId, options) => {
      witness.hookStarted(event, toolId)
      let output
      try { output = await hook(event, toolId, options) } catch (error) { witness.hookSettled(toolId, undefined, true); throw error }
      witness.hookSettled(toolId, output); return output
    }) }))
    const query = originalQuery({ ...input, options: { ...input.options, hooks: { ...input.options.hooks, PreToolUse: hooks } } })
    return new Proxy(query, { get(target, key) {
      if (key === 'interrupt') return async (...args) => { diagnostic.interruptRequestedMs = elapsed(); witness.interruptRequested(); try { const value = await query.interrupt(...args); diagnostic.interruptAcknowledgedMs = elapsed(); witness.interruptSettled(true); return value } catch (error) { witness.interruptSettled(false); diagnostic.interruptError = errorFacts(error.message); throw error } }
      if (key === 'close') return (...args) => { witness.close(); try { return query.close(...args) } catch (error) { witness.close(true); throw error } }
      if (key === Symbol.asyncIterator) return async function* () {
        try { for await (const event of query) {
          if (event.type === 'result') diagnostic.terminal = { subtype: event.subtype, isError: event.is_error, nativeTurns: event.num_turns, publicReasonCode: typeof event.terminal_reason === 'string' && /^[a-z_]{1,64}$/.test(event.terminal_reason) ? event.terminal_reason : 'absent-or-non-code', errors: Array.isArray(event.errors) ? event.errors.filter(value => typeof value === 'string').slice(0, 8).map(errorFacts) : [], observedMs: elapsed() }
          witness.observe(event); yield event
        } } catch (error) { diagnostic.iteratorError = errorFacts(error.message); witness.iteratorError(error); throw error }
        finally { diagnostic.iteratorSettledMs = elapsed(); witness.iteratorSettled() }
      }
      const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
    } })
  })
  if (installed) store = { readSessionStoreSnapshot: () => Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(root, 'store/sessions.json'), 'utf8'))).filter(([key, value]) => !key.startsWith('\u0000') && typeof value?.claudeSessionId === 'string')) }
  else { store = await import(pathToFileURL(join(source, 'src/proxy/sessionStore.ts')).href); store.setSessionStoreDir(join(root, 'store')) }
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    assert(admission && active, 'provider request outside owned admission')
    const path = new URL(request.url).pathname
    if (path !== '/v1/messages') return Response.json({})
    const body = await request.json(), state = active
    assert(JSON.stringify(body.messages).includes(state.marker), 'provider request not owned by current case')
    assert.equal(state.phaseRequests++, 0, 'extra native API round before complete handoff/continuation')
    const tools = body.tools.filter(tool => tool.name.endsWith('__read'))
    assert.equal(tools.length, 1, 'native fixture tool catalog changed'); state.nativeToolName = tools[0].name
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result')
    if (state.phase === 'continue') assert(state.scriptedTools.every((tool, index) => results.filter(result => result.tool_use_id === tool.id && result.is_error !== true && result.content === `fixture-result-${index}`).length === 1), 'native continuation lacks exact real client results')
    requests.push({ case: state.name, phase: state.phase, toolResults: results.length, errorResults: results.filter(result => result.is_error).length })
    return respond(body, state)
  }, error(error) { failure ??= error; return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'scripted provider control failed' } }, { status: 400 }) } })
  const { createProxyServer } = await import(pathToFileURL(installed ? requireSource.resolve('@rynfar/meridian') : join(source, 'src/proxy/server.ts')).href)
  proxy = createProxyServer({ port: 0, host: '127.0.0.1', silent: true, profiles: [{ id: 'fixture', type: 'api', apiKey: 'fixture-noncredential', baseUrl: `http://127.0.0.1:${provider.port}` }], defaultProfile: 'fixture', pluginDir: join(root, 'empty-plugins'), pluginConfigPath: join(root, 'empty-plugins.json') })
  for (const eofDelayMs of [0, 150, 750]) for (const stream of [false, true]) for (const tools of [1, 3]) {
    active = { name: `eof-${eofDelayMs}-tools-${tools}-stream-${stream}`, eofDelayMs, tools, stream, clientSession: randomUUID(), marker: randomUUID(), phase: 'tool', phaseRequests: 0 }
    const state = active, startQualified = qualified.length
    const messages = [{ role: 'user', content: `${state.marker}: read the fixture records` }]
    const first = await request(state, messages)
    assert.equal(first.stop_reason, 'tool_use'); assert.equal(first.content.length, tools)
    assert(first.content.every((tool, index) => tool.type === 'tool_use' && tool.id === state.scriptedTools[index].id && tool.name === 'read' && tool.input.ordinal === index + 1), 'forwarded tool identity/input mismatch')
    assert.equal(qualified.length, startQualified + 1, 'owned interruption not qualified through production orchestration')
    assert.deepEqual(qualified.at(-1), { mode: stream ? 'stream' : 'non_stream', acknowledged: true, qualified: true, generations: 1, tools })
    const entries = Object.values(store.readSessionStoreSnapshot()).filter(entry => entry.passthroughToolCallIds?.length === tools && state.scriptedTools.every(tool => entry.passthroughToolCallIds.includes(tool.id)))
    assert.equal(entries.length, 1, 'checkpoint mapping missing or ambiguous')
    const saved = entries[0], before = await getSessionMessages(saved.claudeSessionId, { dir: root, limit: 100 })
    assert(before.some(message => message.uuid === saved.passthroughToolCallAssistantUuid), 'published assistant UUID absent from supported SDK history')
    state.phase = 'continue'; state.phaseRequests = 0
    const nextMessages = [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: state.scriptedTools.map((tool, index) => ({ type: 'tool_result', tool_use_id: tool.id, content: `fixture-result-${index}` })) }]
    const final = await request(state, nextMessages)
    assert.equal(final.stop_reason, 'end_turn'); assert(final.content.some(block => block.type === 'text' && block.text === 'fixture continuation complete'), 'decoded continuation text missing')
    const current = Object.values(store.readSessionStoreSnapshot()).filter(entry => entry.previousClaudeSessionId === saved.claudeSessionId)
    assert.equal(current.length, 1, 'distinct durable continuation mapping missing')
    assert.notEqual(current[0].claudeSessionId, saved.claudeSessionId)
    const history = await getSessionMessages(current[0].claudeSessionId, { dir: root, limit: 100 })
    const blocks = history.flatMap(message => Array.isArray(message.message?.content) ? message.message.content : [])
    assert(state.scriptedTools.every((tool, index) => blocks.filter(block => block.type === 'tool_result' && block.tool_use_id === tool.id && block.content === `fixture-result-${index}` && block.is_error !== true).length === 1), 'durable fork lacks exact results')
    assert.equal(blocks.filter(block => block.type === 'tool_result' && block.is_error).length, 0, 'denial tail retained in client continuation')
    assert.equal(JSON.stringify(await getSessionMessages(saved.claudeSessionId, { dir: root, limit: 100 })), JSON.stringify(before), 'original public source history changed')
    const census = await nativeCensus(); assert.equal(census.length, 0, 'native actor remains after HTTP terminal')
    report.cases.push({ name: state.name, eofDelayMs, stream, tools, httpRequests: 2, nativeApiRounds: 2, interrupt: qualified.at(-1), publishedCheckpointUuidPresent: true, distinctDurableFork: true, realResultsExactlyOnce: true, noDenialTail: true, originalPublicHistoryUnchanged: true, nativeActorCensusEmpty: true })
    if (failure) throw failure
  }
  const summaries = checkpointWitnesses.map(witness => witness.summary()); report.independentCheckpointObservers = summaries
  assert.equal(summaries.length, 24, 'unexpected admitted SDK query count')
  assert.equal(summaries.filter(row => row.requested).length, 12, 'unexpected public interrupt count')
  assert(summaries.filter(row => row.requested).every(row => row.qualified), 'independent observer rejected actual stop')
  report.outcome = 'PASS'
} catch (error) { failure ??= error; report.outcome = 'FAIL'; report.errorClass = error?.name ?? 'UnknownThrownValue'; report.failure = error.message }
finally {
  admission = false
  proxy?.beginDrain?.(); proxy?.forceAbortInFlight?.()
  let requestsSettled = false, backendClosed = !proxy, listenerClosed = !provider
  try { await bounded(Promise.allSettled(inflight), 10000, 'original HTTP request join'); requestsSettled = true } catch (error) { report.requestJoinError = error.name }
  try { await bounded(proxy?.closeBackend?.(), 10000, 'backend join'); backendClosed = true } catch (error) { report.backendJoinError = error.name }
  if (provider) { const port = provider.port; await provider.stop(true); try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }) } catch (error) { listenerClosed = ['ConnectionRefused','ECONNREFUSED'].includes(error.code ?? error.cause?.code) } }
  let providerBodiesJoined = false
  try { await bounded(Promise.all(bodyJoins), 2000, 'owned provider body join'); providerBodiesJoined = true }
  catch (error) { report.providerBodyJoinError = errorFacts(error.message); failure ??= error }
  const census = await nativeCensus()
  report.cleanup = { admissionClosed: true, providerBodiesJoined, requestsSettled, backendClosed, listenerClosed, nativeActorCensusEmpty: census.length === 0, residualNativeActors: census, privateRuntimeRemoved: false }
  if (providerBodiesJoined && requestsSettled && backendClosed && listenerClosed && census.length === 0) { await rm(root, { recursive: true }); report.cleanup.privateRuntimeRemoved = true }
  else { report.outcome = 'FAIL'; failure ??= new Error('native/runtime custody incomplete') }
  report.independentCheckpointObservers = checkpointWitnesses.map(witness => witness.summary()); sdkSpy?.mockRestore();
  report.requests = requests; report.qualifiedInterruptions = qualified; report.queryDiagnostics = queryDiagnostics; report.providerBodies = providerBodies; report.liveFailureCauseEstablished = false; report.priorLiveFailurePreserved = true; report.completedAt = new Date().toISOString()
  console.debug = originalDebug; process.chdir(initialCwd); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, inherited)
  await writeFile(join(output, 'INTEGRATED_HTTP.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.length, failure: report.failure, cleanup: report.cleanup })); process.exitCode = failure ? 1 : 0
}
