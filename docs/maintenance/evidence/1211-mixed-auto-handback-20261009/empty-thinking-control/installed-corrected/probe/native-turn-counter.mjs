#!/usr/bin/env bun
// Pinned SDK/native counter discovery, never actual-model/client acceptance.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { createOwnedClientProcess } from './e2eOwnedClient.mjs'
import { createPublicSdkGenerationWitness } from './e2ePublicSdkDiagnostics.mjs'
import { backgroundReadNativeResult } from './e2eBackgroundRead.mjs'

const arg = name => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3)
const source = arg('source-root'), output = arg('evidence-dir'), cli = arg('claude-executable')
const optionsRoot = arg('options-root') ?? source
const expectedCli = arg('expected-cli-version') ?? '2.1.284'
assert(source && output && cli, 'explicit source/evidence/native inputs required')
const requireSource = createRequire(join(source, 'package.json'))
const sdkEntry = requireSource.resolve('@anthropic-ai/claude-agent-sdk')
const { query, createSdkMcpServer, tool } = await import(pathToFileURL(sdkEntry).href)
const { z } = await import(pathToFileURL(requireSource.resolve('zod')).href)
const { buildQueryOptions } = await import(pathToFileURL(join(optionsRoot, 'src/proxy/query.ts')).href)
const root = await mkdtemp(join(tmpdir(), 'meridian-counter-'))
const inherited = { ...process.env }
const allowedEnvironment = { PATH: inherited.PATH, HOME: root, TMPDIR: root, XDG_CACHE_HOME: join(root, '.cache'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' }
const report = { kind: 'credential-free-pinned-runtime-discovery', actualModelAcceptance: false, actualClientAcceptance: false, platform: `${process.platform}/${process.arch}`, bun: Bun.version, startedAt: new Date().toISOString(), cases: [], outcome: 'INCOMPLETE' }
await mkdir(output, { recursive: true, mode: 0o700 })
await writeFile(join(output, 'RESERVED'), '', { flag: 'wx', mode: 0o600 })
const owners = [], states = []
let admission = true, active, server, failure, otherRequests = 0
const now = () => Math.round(performance.now() * 1000) / 1000
const cases = [
  { name: 'normal-final-text', cap: 4, tools: 1, deny: true, handoff: true, stream: true, scriptedTextAt: 4 },
  { name: 'thinking-only-end-turn-retry', cap: 4, tools: 1, deny: true, handoff: true, stream: true, scriptedTextAt: 4, thinkingAt: 4 },
]

async function bounded(promise, ms, label) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms) })]) }
  finally { clearTimeout(timer) }
}
function ownedSpawn(options) {
  assert(admission && !options.signal.aborted, 'native admission closed')
  const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const owner = createOwnedClientProcess(child)
  const abort = () => owner.signal('SIGTERM')
  const row = { owner, stderrBytes: 0, exitCode: null, signal: null }
  owners.push(row)
  child.stderr.on('data', bytes => { row.stderrBytes += bytes.length })
  child.once('exit', (code, signal) => { row.exitCode = code; row.signal = signal })
  options.signal.addEventListener('abort', abort, { once: true })
  owner.joined.then(() => options.signal.removeEventListener('abort', abort))
  if (options.signal.aborted) abort()
  return child
}
function close(state) {
  try { state.sdk?.close() }
  catch (error) { state.closeError ??= error?.name ?? 'UnknownThrownValue' }
}
function respond(body, row) {
  const call = row.requests.length
  const count = call < row.scriptedTextAt ? row.tools : 0
  const content = call === row.thinkingAt ? [{ type: 'thinking', thinking: 'fixture internal thought', signature: 'fixture-signature' }] : count ? Array.from({ length: count }, (_, i) => ({ type: 'tool_use', id: `tool_${randomUUID()}`, name: 'mcp__oc__fixture', input: { ordinal: i + 1 } })) : [{ type: 'text', text: 'fixture complete' }]
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason: count ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: count || 1 } }
  row.responseIds.add(message.id)
  row.requests.at(-1).scriptedToolCalls = count; row.requests.at(-1).scriptedStopReason = message.stop_reason; row.requests.at(-1).thinkingOnly = call === row.thinkingAt
  if (!body.stream) return Response.json(message)
  const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } }]
  content.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : block.type === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { ...block, input: {} } })
    events.push({ type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : block.type === 'thinking' ? { type: 'thinking_delta', thinking: block.thinking } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    if (block.type === 'thinking') events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } })
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: message.usage.output_tokens } }, { type: 'message_stop' })
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}
try {
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, allowedEnvironment)
  report.cliSha256 = createHash('sha256').update(await readFile(cli)).digest('hex')
  const version = ownedSpawn({ command: cli, args: ['--version'], cwd: root, env: { ...process.env }, signal: new AbortController().signal })
  let versionText = ''
  version.stdout.on('data', chunk => { if (versionText.length < 1024) versionText += chunk.toString() })
  await bounded(owners.at(-1).owner.joined, 10000, 'native version deadline')
  assert.equal(owners.at(-1).exitCode, 0, 'native version failed')
  report.cliVersion = versionText.match(/\d+\.\d+\.\d+/)?.[0]
  assert.equal(report.cliVersion, expectedCli, 'pinned CLI version mismatch')
  report.sdkEntrySha256 = createHash('sha256').update(await readFile(sdkEntry)).digest('hex')
  // Read public package metadata only, never native session/config files.
  report.sdkVersion = JSON.parse(await readFile(join(sdkEntry, '../package.json'), 'utf8')).version
  assert.equal(report.sdkVersion, '0.2.141', 'pinned SDK version mismatch')
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    if (path !== '/v1/messages') { otherRequests++; return Response.json({}) }
    assert(admission && active && !active.settled, 'model request outside active owned case')
    assert(active.requests.length < 8, 'scripted API request bound')
    const text = await bounded(request.text(), 5000, 'scripted request body deadline')
    assert(Buffer.byteLength(text) <= 2 * 1024 * 1024, 'scripted API body bound')
    const body = JSON.parse(text)
    assert(JSON.stringify(body.messages).includes(active.marker), 'unowned model request')
    assert.deepEqual(body.tools.map(value => value.name), ['mcp__oc__fixture'], 'native catalog mismatch')
    const results = (body.messages ?? []).flatMap(value => Array.isArray(value.content) ? value.content : []).filter(value => value.type === 'tool_result')
    active.requests.push({ ordinal: active.requests.length + 1, atMs: now(), stream: body.stream === true, toolResults: results.length, errorToolResults: results.filter(value => value.is_error === true).length })
    return respond(body, active)
  }, error(error) { failure ??= error; return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'scripted control failed' } }, { status: 400 }) } })
  for (const testCase of cases) {
    const state = { ...testCase, marker: randomUUID(), requests: [], responseIds: new Set(), observedIds: new Set(), witness: createPublicSdkGenerationWitness({ now }), hooks: 0, handlerCalls: 0, result: null, iteratorError: null, closeError: null, settled: false, abortController: new AbortController(), sdk: null, done: Promise.resolve() }
    states.push(state); active = state
    const passthroughMcp = { serverName: 'oc', toolNames: ['mcp__oc__fixture'], hasDeferredTools: false,
      createServer: () => createSdkMcpServer({ name: 'oc', version: '1.0.0', tools: [tool('fixture', 'An in-memory fixture receipt', { ordinal: z.number().int() }, async () => { state.handlerCalls++; return { content: [{ type: 'text', text: 'fixture receipt' }] } })] }) }
    const config = buildQueryOptions({ prompt: `${state.marker}: fixture request`, model: 'claude-sonnet-5-5', workingDirectory: root, systemContext: '', claudeExecutable: cli,
      passthrough: true, stream: true, sdkAgents: {}, passthroughMcp, hasDeferredTools: false, isUndo: false, blockedTools: [], incompatibleTools: [], mcpServerName: 'oc', allowedMcpTools: [],
      settingSources: [], codeSystemPrompt: false, memory: false, dreaming: false,
      cleanEnv: { ...allowedEnvironment, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`, ANTHROPIC_API_KEY: 'fixture-noncredential', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_OAUTH_TOKEN: '' },
    }, state.abortController)
    config.options.maxTurns = testCase.cap
    config.options.includePartialMessages = testCase.stream
    config.options.spawnClaudeCodeProcess = ownedSpawn
    config.options.hooks = { PreToolUse: [{ hooks: [async input => {
      assert.equal(input.tool_name, 'mcp__oc__fixture', 'unexpected fixture tool')
      state.hooks++; state.witness.observeHook(input.tool_use_id, state.handoff && state.requests.length === 1 ? 'forwarded' : state.deny ? 'dropped' : 'forwarded')
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: state.deny ? 'deny' : 'allow', ...(state.deny ? { permissionDecisionReason: 'fixture denial' } : {}) } }
    }] }] }
    // This varies SDK partial events; the actual API transport is recorded.
    state.stream = testCase.stream
    state.ownerStart = owners.length
    state.sdk = query(config)
    state.done = (async () => {
      try {
        for await (const event of state.sdk) {
          state.witness.observe(event); state.assistantError ||= event.type === 'assistant' && Boolean(event.error); if (event.type === 'tombstone') state.tombstones = (state.tombstones ?? 0) + 1
          const id = event.type === 'assistant' ? event.message?.id : event.type === 'stream_event' && event.event?.type === 'message_start' ? event.event.message?.id : null
          if (id) state.observedIds.add(id)
          if (event.type === 'system' && event.subtype === 'init') state.mcpConnected = event.mcp_servers?.find(value => value.name === 'oc')?.status === 'connected'
          if (event.type === 'result') {
            assert.equal(state.result, null, 'multiple native result events')
            state.privateResultErrors = Array.isArray(event.errors) && event.errors.every(value => typeof value === 'string') ? event.errors : null
            state.result = { subtype: event.subtype, isError: event.is_error, numTurns: event.num_turns, terminalReason: event.terminal_reason ?? 'absent', atMs: now() }
          }
        }
      } catch (error) {
        state.iteratorError = error?.name ?? 'UnknownThrownValue'
        state.exactProcessExitOneError = error instanceof Error && error.message === 'Claude Code process exited with code 1'
        // SDK 0.2.141 replaces a process-exit exception with the immediately
        // preceding native result's error text. Compare privately and retain
        // only the exact binding; never print the native text.
        state.exactPriorResultError = error instanceof Error && state.privateResultErrors !== null && error.message === `Claude Code returned an error result: ${state.privateResultErrors.join('; ')}`
      }
      finally { close(state); state.settled = true; state.settledAtMs = now() }
    })()
    await bounded(state.done, 25000, `case deadline: ${state.name}`)
    const owned = owners.slice(state.ownerStart)
    assert.equal(owned.length, 1, 'one native owner required per query')
    await bounded(owned[0].owner.joined, 3000, 'case native/stdio physical join')
    const row = { name: state.name, cap: state.cap, firstResponseTools: state.tools, permission: state.deny ? 'deny' : 'allow', repeatedTools: state.repeat === true, firstGenerationHandoff: state.handoff === true,
      apiRequests: state.requests, modelApiRounds: state.requests.length, thinkingOnlyResponseOrdinal: state.thinkingAt ?? null, assistantError: state.assistantError === true, tombstones: state.tombstones ?? 0, publicGenerationIdsExactlyMatchScriptedResponses: state.responseIds.size === state.observedIds.size && [...state.responseIds].every(id => state.observedIds.has(id)), generations: state.witness.summary(), hooks: state.hooks, handlerCalls: state.handlerCalls,
      mcpConnected: state.mcpConnected === true, sdkPartialEventsRequested: state.stream, result: state.result, iteratorError: state.iteratorError, exactProcessExitOneError: state.exactProcessExitOneError === true, exactPriorResultError: state.exactPriorResultError === true, nativeResultErrorCount: state.privateResultErrors?.length ?? null, closeError: state.closeError, iteratorSettled: state.settled,
      nativeProcess: { ...owned[0].owner.snapshot(), exitCode: owned[0].exitCode, signal: owned[0].signal } }
    report.cases.push(row)
    assert.equal(row.mcpConnected, true, 'native MCP not connected')
    if (row.result?.subtype === 'error_max_turns') {
      assert.equal(row.result.isError, true, 'max-turn error flag invalid')
      assert.equal(row.result.terminalReason, 'max_turns', 'max-turn terminal reason invalid')
      assert.equal(row.exactProcessExitOneError || row.exactPriorResultError, true, 'post-result iterator failure is unrelated to result/exit')
      assert.equal(row.nativeProcess.exitCode, 1, 'max-turn native exit did not match SDK exception')
    } else {
      assert.equal(row.iteratorError, null, 'native iterator failed')
      assert.equal(row.result?.subtype, 'success', 'noncanonical native result')
      assert.equal(row.result.isError, false, 'success error flag invalid')
      assert.equal(row.nativeProcess.exitCode, 0, 'successful native process failed')
    }
    assert.equal(row.nativeProcess.signal, null, 'native query was signaled')
    assert.equal(row.closeError, null, 'native close failed')
    assert(row.result && row.publicGenerationIdsExactlyMatchScriptedResponses, 'native/API generation identity mismatch')
    assert.equal(row.modelApiRounds, state.thinkingAt ? 5 : 4, 'unexpected normal/thinking-only API round count')
    assert.equal(row.generations.distinctGenerations, row.modelApiRounds, 'public API generation count differs')
    assert.equal(row.assistantError, false, 'unexpected assistant error')
    assert.equal(row.hooks, 3, 'original three tool generations missing')
    assert.equal(row.result.numTurns, row.modelApiRounds, 'unexpected terminal turn count')
    const nativeReceipt = { maxTurns: row.cap, nativeTurns: row.result.numTurns, resultSubtype: row.result.subtype, resultIsError: row.result.isError, resultFlagValid: true, sdkToolHookCustody: true, generations: row.generations }
    row.existingGenerationBoundAccepted = backgroundReadNativeResult(nativeReceipt, { sdkVersion: report.sdkVersion, nativeVersion: report.cliVersion })
    assert.equal(row.existingGenerationBoundAccepted, !state.thinkingAt, 'existing generation bound accepted overflow or refused ordinary success')
    const stops = row.generations.generations.map(value => value.stopReasons)
    assert.deepEqual(stops, state.stream ? (state.thinkingAt ? [['tool_use'], ['tool_use'], ['tool_use'], ['end_turn'], ['end_turn']] : [['tool_use'], ['tool_use'], ['tool_use'], ['end_turn']]) : Array.from({ length: row.modelApiRounds }, () => []), 'public stop witnesses differ from scripted API stops or known no-partial absence')
    assert.equal(row.generations.uncorrelatedStopEvents, 0, 'orphan native stop witness')
    assert.equal(row.generations.overlappingStreamStarts, 0, 'overlapping native stream starts')
    console.log(JSON.stringify({ name: row.name, rounds: row.modelApiRounds, generations: row.generations.distinctGenerations, stops, result: row.result, existingGenerationBoundAccepted: row.existingGenerationBoundAccepted }))
    if (failure) throw failure
  }
  report.outcome = 'DISCOVERY_COMPLETED'
} catch (error) { failure ??= error; report.outcome = 'FAILED'; report.errorClass = error?.name ?? 'UnknownThrownValue' }
finally {
  admission = false
  for (const state of states) { state.abortController.abort(); close(state) }
  let childrenJoined = false, iteratorsJoined = false, listenerClosed = !server
  try { await bounded(Promise.all(owners.map(row => row.owner.joined)), 1000, 'initial close join'); childrenJoined = true }
  catch (error) {
    for (const row of owners) row.owner.signal('SIGTERM')
    try { await bounded(Promise.all(owners.map(row => row.owner.joined)), 2000, 'term close join'); childrenJoined = true }
    catch (error) {
      for (const row of owners) row.owner.signal('SIGKILL')
      try { await bounded(Promise.all(owners.map(row => row.owner.joined)), 3000, 'kill close join'); childrenJoined = true }
      catch (error) { report.childJoinError = error.name }
    }
  }
  try { await bounded(Promise.all(states.map(row => row.done)), 3000, 'iterator join'); iteratorsJoined = true }
  catch (error) { report.iteratorJoinError = error.name }
  if (server) {
    const port = server.port
    try {
      await bounded(Promise.resolve(server.stop(true)), 3000, 'listener stop')
      try { await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) }) }
      catch (error) { listenerClosed = ['ConnectionRefused', 'ECONNREFUSED'].includes(error.code ?? error.cause?.code) }
    } catch (error) { report.listenerCloseError = error.name }
  }
  report.otherApiRequests = otherRequests
  report.cleanup = { admissionClosed: !admission, childrenJoined, iteratorsJoined, listenerClosed, children: owners.map(row => ({ ...row.owner.snapshot(), exitCode: row.exitCode, signal: row.signal, stderrBytes: row.stderrBytes })), privateRuntimeRemoved: false }
  if (childrenJoined && iteratorsJoined && listenerClosed) { await rm(root, { recursive: true }); report.cleanup.privateRuntimeRemoved = true }
  else { report.retainedRuntime = root; failure ??= new Error('cleanup unknown'); report.outcome = 'FAILED' }
  for (const key of Object.keys(process.env)) delete process.env[key]
  Object.assign(process.env, inherited)
  report.environmentRestored = true
  report.completedAt = new Date().toISOString()
  report.exitCode = failure ? 1 : 0
  await writeFile(join(output, 'COUNTER_DISCOVERY.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.length, cleanup: report.cleanup, errorClass: report.errorClass }))
  process.exitCode = report.exitCode
}
