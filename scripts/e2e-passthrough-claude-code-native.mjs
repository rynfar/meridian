#!/usr/bin/env bun
// Bound and observe the maintained E55 gate without replacing its client flow
// or assertions. Explicit source/installed targets and access-only input.
import * as cp from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, lstatSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spyOn } from 'bun:test'
import { observeChildClosure, stopAndJoinChild } from './lib/e2eProcessCustody.mjs'

export function isE55CanonicalCompletion(row) {
  return row.completed === true && row.flagValid === true && row.terminalTargetMatched === true && row.inputTokens > 0 && row.outputTokens > 0
    && row.models.length > 0 && row.models.every(model => model === row.requiredModel)
    && Number.isSafeInteger(row.nativeTurns) && row.nativeTurns >= 1 && row.assistantResponses > 0
    && Number.isFinite(row.cost) && row.cost >= 0
    && (row.subtype === 'success' && row.isError === false
      // num_turns is the SDK's result counter, not a guaranteed copy of the
      // option budget. E55's actual capped frames report2 at maxTurns1.
      // Require one actual model response independently of that counter.
      || row.subtype === 'error_max_turns' && row.isError === true && row.maxTurns === 1 && row.assistantResponses === 1 && row.toolCalls > 0)
}

if (import.meta.main) {
if (process.argv.slice(2).some(arg => arg !== '--prepare-only') || process.argv.slice(2).length > 1) throw new Error('Only --prepare-only is supported')
const prepare = process.argv.includes('--prepare-only')
const fields = ['ENTRY', 'SDK_ENTRY', 'NATIVE_BIN', 'CLIENT_BIN', 'CLIENT_VERSION', 'NATIVE_VERSION', 'OUTPUT_DIR', 'TOKEN_FILE', 'GRANT_EXPIRES_AT']
const input = Object.fromEntries(fields.map(key => [key, process.env['E55_' + key]]))
for (const key of fields.filter(key => !['TOKEN_FILE', 'GRANT_EXPIRES_AT'].includes(key))) {
  if (key.endsWith('VERSION')) continue
  if (!input[key] || !isAbsolute(input[key])) throw new Error('Explicit absolute E55 input required: ' + key)
}
if (input.CLIENT_VERSION !== '2.1.287' || !['2.1.284', '2.1.295'].includes(input.NATIVE_VERSION)) throw new Error('Unsupported E55 client/backend version')
const requiredModel = 'claude-sonnet-5-5', maximum = 16, duration = 480000
const output = input.OUTPUT_DIR
mkdirSync(output, { recursive: true, mode: 0o700 })
if (lstatSync(output).isSymbolicLink() || (lstatSync(output).mode & 0o077) !== 0 || lstatSync(output).uid !== process.getuid() || realpathSync(output) !== output) throw new Error('Private real E55 output required')
const reportFile = join(output, 'REPORT.json')
writeFileSync(reportFile, '', { flag: 'wx', mode: 0o600 })
const report = { kind: 'E55_ORIGINAL_CLAUDE_CLIENT_GATE', platform: process.platform, architecture: process.arch,
  requiredModel, sdkVersion: null, queries: [], checks: {}, children: [], inputs: {},
  actualClientInvocations: 0, originalGateSettled: false, originalGateExit: null, firstFailure: null,
  scope: 'Original E55 three real client invocations and all assertions; not an actual LiteLLM gateway or historical reporter tuple.' }
const saved = Object.fromEntries(['log', 'error', 'warn', 'debug', 'info'].map(key => [key, console[key]]))
const spies = [], actors = [], actorIndex = new WeakMap(), controls = new Map(), iteratorJoins = [], sockets = new Set(), socketJoins = []
let retired = false, proxy, proxyClosed = false, closeOperation, startup, timer, token
const fail = code => { report.firstFailure ??= code }
const need = (condition, code) => { if (!condition) throw new Error(code) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const within = path => { const rel = relative(output, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) }
async function bounded(promise, ms, code) {
  let deadline
  try { return await Promise.race([promise, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(code)), ms) })]) }
  finally { clearTimeout(deadline) }
}
function attach(child, kind) {
  if (actorIndex.has(child)) return actorIndex.get(child)
  const actor = { child, witness: observeChildClosure(child), facts: { kind, originalPid: child.pid ?? null,
    stdinClosed: child.stdin === null, nativeInit: [], nativeTerminal: [] } }
  actorIndex.set(child, actor); actors.push(actor)
  child.stdin?.once('close', () => { actor.facts.stdinClosed = true })
  child.once('error', () => fail('observed-child-error'))
  for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.on('error', () => fail('observed-pipe-error'))
  for (const stream of [child.stdout, child.stderr]) {
    let bytes = 0
    stream?.on('data', chunk => {
      bytes += chunk.length
      if (bytes > 2000000) { retired = true; fail('child-stream-byte-bound'); if (!actor.witness.state.exitSeen && !actor.witness.state.closeSeen) child.kill('SIGTERM') }
    })
  }
  if (kind === 'sdk-gate') {
    let pending = ''
    child.stdout?.on('data', bytes => {
      pending += bytes.toString('utf8')
      if (pending.length > 2000000) { fail('sdk-observer-byte-bound'); pending = ''; return }
      for (;;) {
        const end = pending.indexOf('\n'); if (end < 0) break
        const line = pending.slice(0, end); pending = pending.slice(end + 1)
        let event
        try { event = JSON.parse(line) } catch { continue }
        if (event.type === 'system' && event.subtype === 'init') actor.facts.nativeInit.push({ model: event.model === requiredModel ? event.model : 'unexpected-model', version: event.claude_code_version })
        if (event.type === 'result') actor.facts.nativeTerminal.push({ subtype: event.subtype, flagValid: typeof event.is_error === 'boolean', isError: typeof event.is_error === 'boolean' ? event.is_error : null })
      }
    })
  }
  return actor
}
class OriginalGateExit extends Error { constructor(code) { super('original-gate-terminal'); this.code = code } }
try {
  need(process.platform === 'linux' && process.arch === 'x64', 'linux-x64-native-required')
  for (const key of ['ENTRY', 'SDK_ENTRY', 'NATIVE_BIN', 'CLIENT_BIN']) {
    const path = input[key], stat = lstatSync(path)
    need(stat.isFile() && !stat.isSymbolicLink(), 'regular-pinned-input-required')
    report.inputs[key] = { path, sha256: hash(readFileSync(path)) }
  }
  for (const [key, version] of [['CLIENT_BIN', input.CLIENT_VERSION], ['NATIVE_BIN', input.NATIVE_VERSION]]) {
    const result = cp.spawnSync(input[key], ['--version'], { encoding: 'utf8', timeout: 10000 })
    need(result.status === 0 && result.stdout.trim() === version + ' (Claude Code)', 'pinned-executable-version-mismatch')
  }
  const sdk = await import(pathToFileURL(input.SDK_ENTRY).href)
  report.sdkVersion = JSON.parse(readFileSync(join(dirname(input.SDK_ENTRY), 'package.json'), 'utf8')).version
  need(report.sdkVersion === '0.2.141', 'sdk-version-mismatch')
  if (prepare) { report.disposition = 'PASS_E55_PREREQUISITES_ONLY' }
  else {
    need(input.TOKEN_FILE && isAbsolute(input.TOKEN_FILE), 'explicit-private-grant-required')
    need(Number.isFinite(Number(input.GRANT_EXPIRES_AT)) && Number(input.GRANT_EXPIRES_AT) > Date.now() + duration + 60000, 'full-run-grant-expiry-required')
    const stat = lstatSync(input.TOKEN_FILE), parent = lstatSync(dirname(input.TOKEN_FILE))
    need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o400
      && parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, 'owned-access-only-grant-required')
    token = readFileSync(input.TOKEN_FILE, 'utf8').trim(); need(/^sk-ant-oat01-[A-Za-z0-9_-]+$/.test(token), 'supported-access-only-grant-required')
    for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|MERIDIAN|OPENAI|OPENCLAW|OPENCODE|NODE_OPTIONS)/.test(key)) delete process.env[key]
    for (const name of ['tmp', 'config', 'sessions', 'plugins', 'work']) mkdirSync(join(output, name), { mode: 0o700 })
    Object.assign(process.env, { TMPDIR: join(output, 'tmp'), CLAUDE_CONFIG_DIR: join(output, 'config'), MERIDIAN_CONFIG_DIR: join(output, 'config'),
      MERIDIAN_SESSION_DIR: join(output, 'sessions'), MERIDIAN_WORKDIR: join(output, 'work'), MERIDIAN_CLAUDE_PATH: input.NATIVE_BIN,
      MERIDIAN_SONNET_MODEL: requiredModel, MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_NO_UPDATE_CHECK: '1',
      PROBE_PORT: '0', PROBE_MODEL: requiredModel })
    for (const key of Object.keys(saved)) console[key] = (...values) => {
      const text = values.map(String).join(' '), match = /^\s+(PASS|FAIL)\s{2}([^—\n]+)/.exec(text)
      if (match) report.checks[match[2].trim()] = match[1] === 'PASS'
    }
    for (const name of ['spawn', 'execFile']) {
      const original = cp[name]
      spies.push(spyOn(cp, name).mockImplementation((...args) => {
        need(!retired, 'child-admission-retired')
        const native = name === 'spawn' && args[0] === '/bin/sh' && args[1]?.[2] === 'meridian-sdk-gate'
        const client = args[0] === input.CLIENT_BIN
        if (client) {
          need(++report.actualClientInvocations <= 3, 'client-invocation-bound')
          need(!args[2]?.env?.CLAUDE_CODE_OAUTH_TOKEN && !args[2]?.env?.ANTHROPIC_API_KEY
            && args[2]?.env?.ANTHROPIC_AUTH_TOKEN === 'meridian-e2e-dummy'
            && args[2]?.env?.ANTHROPIC_BASE_URL === 'http://127.0.0.1:' + proxy.server.address().port, 'client-auth-or-route-escaped')
        }
        const child = Reflect.apply(original, cp, args); attach(child, native ? 'sdk-gate' : client ? 'client' : name); return child
      }))
    }
    const originalQuery = sdk.query
    spies.push(spyOn(sdk, 'query').mockImplementation(params => {
      need(!retired && report.queries.length < maximum, 'sdk-admission-bound-or-retired')
      const opts = params.options
      need(opts.env?.CLAUDE_CODE_OAUTH_TOKEN === token && within(opts.env.CLAUDE_CONFIG_DIR) && within(opts.cwd), 'sdk-grant-or-state-escaped')
      need(!opts.env.ANTHROPIC_API_KEY && !opts.env.ANTHROPIC_AUTH_TOKEN && !opts.env.ANTHROPIC_BASE_URL, 'sdk-unexpected-provider-credential-or-route')
      need(opts.model === requiredModel || opts.model === 'sonnet' && opts.env.ANTHROPIC_DEFAULT_SONNET_MODEL === requiredModel, 'sdk-model-pin-mismatch')
      const row = { requiredModel, models: [], inputTokens: 0, outputTokens: 0, toolCalls: 0, maxTurns: opts.maxTurns,
        completed: false, flagValid: false, isError: null, subtype: null, cost: null, iteratorSettled: false, closeCalled: false, originalPid: null, terminalTargetMatched: false, assistantResponses: 0 }
      const assistantIds = new Set()
      need(typeof opts.sessionId === 'string', 'preallocated-sdk-target-required')
      report.queries.push(row)
      let joined; iteratorJoins.push(new Promise(resolve => { joined = resolve }))
      const originalFactory = opts.spawnClaudeCodeProcess; need(typeof originalFactory === 'function', 'product-public-process-gate-required')
      const query = originalQuery({ ...params, options: { ...opts, maxBudgetUsd: .5, spawnClaudeCodeProcess(spawnOptions) {
        need(realpathSync(spawnOptions.command) === realpathSync(input.NATIVE_BIN), 'sdk-executable-escaped')
        const child = originalFactory(spawnOptions); row.originalPid = child.pid; need(actorIndex.get(child)?.facts.kind === 'sdk-gate', 'original-sdk-gate-handle-missing'); return child
      } } }); controls.set(query, row)
      return new Proxy(query, { get(target, key) {
        if (key === 'close') return (...args) => { row.closeCalled = true; return Reflect.apply(target.close, target, args) }
        if (key === Symbol.asyncIterator) return async function* () {
          try { for await (const event of query) {
            if (event.type === 'assistant') {
              need(typeof event.message?.id === 'string' && event.message.id.length > 0, 'original-assistant-response-identity-missing')
              assistantIds.add(event.message.id); row.assistantResponses = assistantIds.size
              if (typeof event.message?.model === 'string') row.models.push(event.message.model === requiredModel ? requiredModel : 'unexpected-model')
              const usage = event.message?.usage ?? {}
              row.inputTokens = Math.max(row.inputTokens, (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)); row.outputTokens = Math.max(row.outputTokens, usage.output_tokens ?? 0)
              row.toolCalls += (event.message?.content ?? []).filter(block => block.type === 'tool_use').length
            }
            if (event.type === 'result') {
              need(!row.completed, 'sdk-result-repeated'); row.completed = true; row.flagValid = typeof event.is_error === 'boolean'; row.isError = row.flagValid ? event.is_error : null
              row.nativeTurns = event.num_turns; row.terminalTargetMatched = event.session_id === opts.sessionId
              row.subtype = ['success', 'error_max_turns'].includes(event.subtype) ? event.subtype : 'unexpected-result'; row.cost = Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null
              need(row.cost !== null && row.cost >= 0 && row.cost <= .5 && report.queries.reduce((sum, q) => sum + (q.cost ?? 0), 0) <= 8, 'sdk-estimated-cost-bound')
            }
            yield event
          } } finally { row.iteratorSettled = true; joined() }
        }
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    }))
    const product = await import(pathToFileURL(input.ENTRY).href)
    globalThis[Symbol.for('meridian.e55.native-fixture')] = { client: input.CLIENT_BIN, async startProxyServer(config) {
      need(!retired, 'proxy-acquisition-retired')
      startup = product.startProxyServer({ ...config, backend: 'claude', profiles: [{ id: 'e55-owned', type: 'oauth-token', oauthToken: token }],
        defaultProfile: 'e55-owned', pluginDir: join(output, 'plugins'), installProcessErrorHandlers: false })
      proxy = await startup; proxy.server.once('close', () => { proxyClosed = true })
      proxy.server.on('connection', socket => { sockets.add(socket); socketJoins.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve() }))) })
      return { ...proxy, close(...args) { closeOperation ??= Reflect.apply(proxy.close, proxy, args); return closeOperation } }
    } }
    spies.push(spyOn(process, 'exit').mockImplementation(code => { throw new OriginalGateExit(code ?? 0) }))
    timer = setTimeout(() => {
      retired = true; fail('whole-run-deadline')
      for (const [query, row] of controls) { try { query.close(); row.closeCalled = true } catch { fail('deadline-sdk-close-failed') } }
    }, duration)
    try { await bounded(import('./e2e-passthrough-claude-code-session.mjs'), duration, 'original-gate-deadline') }
    catch (error) { if (error instanceof OriginalGateExit) report.originalGateExit = error.code; else throw error }
    report.originalGateSettled = true
    need(report.originalGateExit === 0 && Object.keys(report.checks).length === 11 && Object.values(report.checks).every(Boolean), 'original-e55-assertions-failed-or-missing')
    need(report.actualClientInvocations === 3 && report.queries.length > 0 && report.queries.every(isE55CanonicalCompletion), 'native-query-model-usage-terminal-missing')
  }
} catch (error) { fail(/^[a-z0-9-]+$/.test(error.message ?? '') ? error.message : 'e55-execution-failed') }
finally {
  retired = true; clearTimeout(timer)
  if (startup && !proxy) { try { proxy = await bounded(startup, 15000, 'proxy-acquisition-join-deadline') } catch { fail('proxy-acquisition-unjoined') } }
  for (const [query, row] of controls) { try { query.close(); row.closeCalled = true } catch { fail('sdk-close-failed') } }
  try { await bounded(Promise.all(iteratorJoins), 15000, 'sdk-iterator-join-deadline') } catch { fail('sdk-iterator-unjoined') }
  if (proxy) { try { closeOperation ??= proxy.close(); await bounded(closeOperation, 15000, 'proxy-close-deadline') } catch { fail('proxy-close-failed') } }
  for (const socket of sockets) socket.destroy()
  try { await bounded(Promise.all(socketJoins), 3000, 'socket-join-deadline') } catch { fail('socket-unjoined') }
  for (const actor of actors) {
    const closure = await stopAndJoinChild(actor.child, actor.witness, { graceMs: 3000, forceMs: 3000 })
    report.children.push({ ...actor.facts, closure })
    if (!closure.joined || !actor.facts.stdinClosed || closure.signalFailure) fail('original-child-custody-incomplete')
  }
  report.http = { proxyCloseSeen: proxyClosed, listening: proxy?.server.listening ?? false, remainingSockets: sockets.size }
  if (!prepare && (!proxyClosed || report.http.listening || sockets.size || report.queries.some(row => !row.iteratorSettled))) fail('native-actor-join-incomplete')
  if (!prepare) {
    for (const row of report.queries) {
      const actor = report.children.find(child => child.originalPid === row.originalPid && child.kind === 'sdk-gate')
      if (!row.closeCalled || !actor || actor.nativeInit.length !== 1 || actor.nativeInit[0].model !== requiredModel || actor.nativeInit[0].version !== input.NATIVE_VERSION
        || actor.nativeTerminal.length !== 1 || !actor.nativeTerminal[0].flagValid || actor.nativeTerminal[0].subtype !== row.subtype || actor.nativeTerminal[0].isError !== row.isError
        || actor.closure.exitCode !== (row.subtype === 'success' ? 0 : 1)) fail('original-native-init-terminal-exit-mismatch')
    }
  }
  for (const [key, identity] of Object.entries(report.inputs)) {
    try { need(hash(readFileSync(input[key])) === identity.sha256, 'input-bytes-changed') } catch { fail('input-identity-not-retained') }
  }
  delete globalThis[Symbol.for('meridian.e55.native-fixture')]
  for (const spy of spies.reverse()) spy.mockRestore()
  for (const [key, value] of Object.entries(saved)) console[key] = value
  report.disposition = report.firstFailure ? 'FAILED_E55_NATIVE_GATE' : prepare ? 'PASS_E55_PREREQUISITES_ONLY' : 'PASS_E55_NATIVE_GATE'
  writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ disposition: report.disposition, firstFailure: report.firstFailure, queries: report.queries.length }))
  process.exitCode = report.firstFailure ? 1 : 0
}
}
