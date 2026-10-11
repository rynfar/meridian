import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const source = arg('source-root'), output = arg('evidence-dir'), cli = arg('claude-executable')
assert(source && output && cli)
const root = await mkdtemp(join(tmpdir(), 'meridian-integrated-control-'))
await mkdir(output, { recursive: true }); await writeFile(join(output, 'RESERVED'), '', { flag: 'wx' })
const report = { kind: 'independently-installed-meridian-http-real-sdk-native-scripted-provider', actualModelAcceptance: false, actualClientAcceptance: false, platform: `${process.platform}/${process.arch}`, bun: Bun.version, cases: [], outcome: 'INCOMPLETE', realCredentialReads: 0 }
const inherited = { ...process.env }, initialCwd = process.cwd(), originalDebug = console.debug
for (const key of Object.keys(process.env)) delete process.env[key]
Object.assign(process.env, { PATH: inherited.PATH, HOME: root, TMPDIR: root, XDG_CACHE_HOME: join(root, '.cache'), CLAUDE_CONFIG_DIR: join(root, 'claude-config'), MERIDIAN_CONFIG_DIR: join(root, 'meridian-config'), MERIDIAN_SESSION_DIR: join(root, 'store'), MERIDIAN_CLAUDE_PATH: cli, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_SESSION_GC_INTERVAL_MS: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', OPENCODE_CLAUDE_PROVIDER_DEBUG: '1' })
process.chdir(root)
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
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
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
  getSessionMessages = (await import(pathToFileURL(requireSource.resolve('@anthropic-ai/claude-agent-sdk')).href)).getSessionMessages
  // Only Meridian's own published mapping metadata; native transcript contents
  // remain accessible solely through supported SDK getSessionMessages.
  store = { readSessionStoreSnapshot: () => Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(root, 'store/sessions.json'), 'utf8'))).filter(([key, value]) => !key.startsWith('\u0000') && typeof value?.claudeSessionId === 'string')) }
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
  const { createProxyServer } = await import(pathToFileURL(requireSource.resolve('@rynfar/meridian')).href)
  proxy = createProxyServer({ port: 0, host: '127.0.0.1', silent: true, profiles: [{ id: 'fixture', type: 'api', apiKey: 'fixture-noncredential', baseUrl: `http://127.0.0.1:${provider.port}` }], defaultProfile: 'fixture', pluginDir: join(root, 'empty-plugins'), pluginConfigPath: join(root, 'empty-plugins.json') })
  for (const stream of [false, true]) for (const tools of [1, 3]) {
    active = { name: `tools-${tools}-stream-${stream}`, tools, stream, clientSession: randomUUID(), marker: randomUUID(), phase: 'tool', phaseRequests: 0 }
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
    report.cases.push({ name: state.name, stream, tools, httpRequests: 2, nativeApiRounds: 2, interrupt: qualified.at(-1), publishedCheckpointUuidPresent: true, distinctDurableFork: true, realResultsExactlyOnce: true, noDenialTail: true, originalPublicHistoryUnchanged: true, nativeActorCensusEmpty: true })
    if (failure) throw failure
  }
  report.outcome = 'PASS'
} catch (error) { failure ??= error; report.outcome = 'FAIL'; report.errorClass = error?.name ?? 'UnknownThrownValue'; report.failure = error.message }
finally {
  admission = false
  proxy?.beginDrain?.(); proxy?.forceAbortInFlight?.()
  let requestsSettled = false, backendClosed = !proxy, listenerClosed = !provider
  try { await bounded(Promise.allSettled(inflight), 10000, 'original HTTP request join'); requestsSettled = true } catch (error) { report.requestJoinError = error.name }
  try { await bounded(proxy?.closeBackend?.(), 10000, 'backend join'); backendClosed = true } catch (error) { report.backendJoinError = error.name }
  if (provider) { const port = provider.port; await provider.stop(true); try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }) } catch (error) { listenerClosed = ['ConnectionRefused','ECONNREFUSED'].includes(error.code ?? error.cause?.code) } }
  const census = await nativeCensus()
  report.cleanup = { admissionClosed: true, requestsSettled, backendClosed, listenerClosed, nativeActorCensusEmpty: census.length === 0, residualNativeActors: census, privateRuntimeRemoved: false }
  if (requestsSettled && backendClosed && listenerClosed && census.length === 0) { await rm(root, { recursive: true }); report.cleanup.privateRuntimeRemoved = true }
  else { report.outcome = 'FAIL'; failure ??= new Error('native/runtime custody incomplete') }
  report.requests = requests; report.qualifiedInterruptions = qualified; report.completedAt = new Date().toISOString()
  console.debug = originalDebug; process.chdir(initialCwd); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, inherited)
  await writeFile(join(output, 'INTEGRATED_HTTP.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.length, failure: report.failure, cleanup: report.cleanup })); process.exitCode = failure ? 1 : 0
}
