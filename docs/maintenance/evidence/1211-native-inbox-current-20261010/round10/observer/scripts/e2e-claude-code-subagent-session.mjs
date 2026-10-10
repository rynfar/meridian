#!/usr/bin/env bun
// E72: bounded native Agent subagents and resumed parent on baseline/fix.
// Explicit inputs only. Never discovers auth or prints client/provider prose.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { constants as fsConstants, lstatSync, statSync, fstatSync, openSync, closeSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { spyOn } from 'bun:test'
import { PASSTHROUGH_DENY_REASON } from '../src/proxy/passthroughDenial.ts'
import { createQueryMcpReadinessWitness } from './lib/e2eMcpReadiness.mjs'
import { createOwnedClientProcess } from './lib/e2eOwnedClient.mjs'
import { createPublicSdkGenerationWitness, publicToolCapabilities } from './lib/e2ePublicSdkDiagnostics.mjs'
import { backgroundLaunchOutput, backgroundReadCompletion, backgroundReadNativeResult } from './lib/e2eBackgroundRead.mjs'
import { createOwnedCheckpointWitness, ownedCheckpointNativeResult } from './lib/e2eOwnedCheckpoint.mjs'
import { createRequestModelWitness } from './e2e-claude-code-auto-mode.mjs'
import { mixedAutoRequest, mixedAutoCommands, createOwnedRelayWork, publicToolReceiptMatch, publicHandbackReceiptFacts, publicHandbackEncodingFacts, publicNativeHandbackFrameFacts } from './lib/e2eMixedAuto.mjs'

const switches = new Set(['expect-unfixed', 'rehearsal', 'fail-after-copy', 'synthetic', 'require-mcp-readiness'])
const names = new Set(['checkpoint-protocol', 'scenario', 'classifier-model', 'classifier-served-model', 'target-root', 'entry', 'source-head', 'client', 'client-version', 'native-cli', 'native-cli-version', 'sdk-version', 'model', 'served-model', 'grant-file', 'proof-dir', 'max-queries', 'max-cost-usd', 'timeout-ms'])
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '')
  assert(process.argv[i].startsWith('--') && (switches.has(key) || names.has(key)) && !(key in args), 'Unknown or repeated harness option')
  args[key] = switches.has(key) ? true : process.argv[++i]
}
for (const key of names) if (!['checkpoint-protocol', 'source-head', 'scenario', 'classifier-model', 'classifier-served-model'].includes(key)) assert(typeof args[key] === 'string' && args[key].length > 0, `Missing --${key}`)
const ownedCheckpoint = args['checkpoint-protocol'] === 'owned-interrupt-v1'
assert(args['checkpoint-protocol'] === undefined || ownedCheckpoint, 'Invalid checkpoint protocol')
if (ownedCheckpoint) assert(args['sdk-version'] === '0.2.141' && ['2.1.284', '2.1.295', '2.1.296'].includes(args['native-cli-version']), 'Owned interrupt requires an independently qualified SDK/native tuple')
const scenario = args.scenario ?? 'foreground'
assert(['foreground', 'background', 'background-read-v2', 'mixed-auto-v1', 'mixed-auto-handback-v2', 'mixed-auto-handback-v3'].includes(scenario), 'Invalid E72 scenario')
const framedHandback = scenario === 'mixed-auto-handback-v3'
if (framedHandback) assert(args['client-version'] === '2.1.287', 'Native handback frame requires the independently observed client pin')
const mixedHandback = scenario === 'mixed-auto-handback-v2' || framedHandback
const mixedAuto = scenario === 'mixed-auto-v1' || mixedHandback
const readBackground = scenario === 'background-read-v2'
const background = ['background', 'background-read-v2'].includes(scenario)
if (readBackground || mixedAuto) assert(args['sdk-version'] === '0.2.141' && (ownedCheckpoint ? ['2.1.284', '2.1.295', '2.1.296'] : ['2.1.284', '2.1.295']).includes(args['native-cli-version']) && args.model === 'claude-sonnet-5-5' && args['served-model'] === args.model, 'Versioned scenario requires counter-qualified SDK/native/model tuple')
if (mixedAuto) assert([args.model, 'claude-sonnet-5'].includes(args['classifier-model']) && /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(args['classifier-served-model']), 'Mixed scenario requires one explicit requested/served classifier model arm')
else assert(args['classifier-model'] === undefined && args['classifier-served-model'] === undefined, 'Classifier models belong only to the mixed scenario')
const synthetic = args.synthetic === true, rehearsal = args.rehearsal === true
assert(synthetic || (process.platform === 'linux' && process.arch === 'x64'), 'Native E72 acceptance requires Linux x64')
assert(args['client-version'] === '2.1.287', 'E72 requires the implicated Claude Code client 2.1.287')
assert(/^claude-sonnet-[0-9][a-z0-9.-]*$/.test(args.model) && /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(args['served-model']), 'Explicit implicated requested and served Sonnet IDs required')
const maximum = Number(args['max-queries']), costLimit = Number(args['max-cost-usd']), timeout = Number(args['timeout-ms'])
assert(Number.isInteger(maximum) && maximum >= 1 && maximum <= 40 && costLimit > 0 && costLimit <= 50 && timeout >= 100 && timeout <= 1200000, 'Invalid query/cost/time limits')
const output = resolve(args['proof-dir'])
mkdirSync(output, { recursive: true, mode: 0o700 })
assert((statSync(output).mode & 0o077) === 0 && !lstatSync(output).isSymbolicLink(), 'Proof directory must be private and real')
function verifyProofDescriptor(fd) {
  const row = fstatSync(fd)
  assert(row.isFile() && row.uid === process.getuid() && row.nlink === 1 && (row.mode & 0o777) === 0o600, 'Proof descriptor must be private, owned and single-link')
}
// Reserve before imports, version probes or reading any grant. Existing
// output (including a link) is never opened for writing or removed.
const proofDescriptor = openSync(join(output, 'claude-subagent-results.json'), 'wx', 0o600)
try { verifyProofDescriptor(proofDescriptor) }
catch (error) { closeSync(proofDescriptor); throw error }
const proof = { kind: synthetic ? 'synthetic-harness-control' : rehearsal ? 'zero-query-rehearsal' : 'native-affected-flow', expected: args['expect-unfixed'] ? 'unfixed' : 'fixed', platform: `${process.platform}/${process.arch}`, runtime: { bun: Bun.version, node: process.version }, scenario, requestedModel: args.model, requiredServedModel: args['served-model'], limits: { queries: maximum, sdkEstimatedCostUsd: costLimit, perQueryBudgetUsd: costLimit / maximum, totalMilliseconds: timeout, wireRequests: maximum, requestBytes: 2 * 1024 * 1024, clientStreamBytes: 2 * 1024 * 1024, clientInvocations: 2, ownedProcesses: 96 }, queries: [], turns: [], checks: {}, result: 'INCOMPLETE', acceptance: false }
proof.checkpointProtocol = ownedCheckpoint ? 'owned-interrupt-v1' : 'legacy'
if (mixedAuto) { proof.requestedClassifierModel = args['classifier-model']; proof.requiredServedClassifierModel = args['classifier-served-model']; proof.classifierModelScope = 'One explicitly pinned native classifier arm only; demotion/fallback and another served model cannot qualify this run.' }
const saved = { log: console.log, error: console.error, warn: console.warn, debug: console.debug }
const publicLog = saved.log.bind(console), records = [], traceIds = new Map(), decisionSessions = new Map()
const startedAt = performance.now(), elapsed = () => Math.round((performance.now() - startedAt) * 1000) / 1000
let turn = 0, suppressed = 0
for (const key of Object.keys(saved)) console[key] = (...values) => {
  suppressed++
  const line = values.map(String).join(' ')
  if (!line.includes('adapter=claude-code') || !line.includes('msgCount=')) return
  const request = traceIds.get(/\[PROXY\] ([a-z0-9-]+) /.exec(line)?.[1])
  if (!request) return
  const word = name => new RegExp(`(?:^| )${name}=([a-z0-9:.-]+)(?: |$)`).exec(line)?.[1]
  decisionSessions.set(request, word('session'))
  records.push({ turn, request, lineage: word('lineage'), divergence: word('diverged'), tools: Number(word('tools')), messages: Number(word('msgCount')), sessionWaitMs: Number(word('sessionWait')?.replace(/ms$/, '')), auxiliary: word('diverged') === 'independent-request:auxiliary-request' })
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fileIdentity = row => [row.dev, row.ino, row.uid, row.gid, row.mode, row.nlink, row.size, row.mtimeMs, row.ctimeMs]
function snapshot(file, ownedGrant = false) {
  const link = lstatSync(file)
  assert(link.isFile() && !link.isSymbolicLink(), 'Identity input must be a regular non-symlink file')
  const verifyGrant = row => {
    if (!ownedGrant) return
    assert((row.mode & 0o777) === 0o400 && row.nlink === 1 && row.uid === process.getuid(), 'Owned grant must be private, read-only, single-link and runtime-owned before reading content')
  }
  verifyGrant(link)
  assert(Number.isInteger(fsConstants.O_NOFOLLOW) && Number.isInteger(fsConstants.O_NONBLOCK), 'No-follow nonblocking input reads unavailable')
  const descriptor = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
  try {
    const row = fstatSync(descriptor), identity = fileIdentity(row)
    assert(row.isFile() && JSON.stringify(identity) === JSON.stringify(fileIdentity(link)), 'Identity input changed before descriptor read')
    verifyGrant(row)
    const bytes = readFileSync(descriptor), after = lstatSync(file)
    assert(after.isFile() && !after.isSymbolicLink() && JSON.stringify(fileIdentity(fstatSync(descriptor))) === JSON.stringify(identity) && JSON.stringify(fileIdentity(after)) === JSON.stringify(identity), 'Identity input changed during descriptor read')
    return { file, bytes, identity, hash: hash(bytes), ownedGrant }
  } finally { closeSync(descriptor) }
}
function unchanged(before) {
  const after = snapshot(before.file, before.ownedGrant)
  return after.hash === before.hash && JSON.stringify(after.identity) === JSON.stringify(before.identity)
}
function sdkPackage(entry) {
  let directory = dirname(entry)
  for (;;) {
    const file = join(directory, 'package.json')
    if (existsSync(file)) { const value = JSON.parse(readFileSync(file, 'utf8')); if (value.name === '@anthropic-ai/claude-agent-sdk') return { value, file } }
    const parent = dirname(directory); assert(parent !== directory, 'Target SDK package identity unavailable'); directory = parent
  }
}
async function bounded(operation, milliseconds, label) {
  let timer
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), milliseconds) })]) }
  finally { clearTimeout(timer) }
}
async function requestBody(request, maximumBytes) {
  const reader = request.body?.getReader(), decoder = new TextDecoder()
  if (!reader) return ''
  let bytes = 0, text = ''
  try {
    for (;;) {
      const chunk = await bounded(reader.read(), Math.min(timeout, 30000), 'Client body deadline reached')
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      assert(bytes <= maximumBytes, 'Client request byte bound reached')
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally { await reader.cancel(); reader.releaseLock() }
}
const seen = new Map(), children = new Set(), active = new Set(), stop = new AbortController()
const childOwners = new WeakMap(), clientOwners = []
const sdkTools = new Map(), sdkToolOwners = new Map(), sdkHookReceipts = new Map(), httpTools = new Map(), pendingHttp = new Set(), sdkTexts = new Map(), httpTexts = new Map(), sdkSessionIds = new Map()
const checkpointWitnesses = new Map()
const requestModels = new Map(), relayWork = createOwnedRelayWork()
const sessionOrdinal = value => { if (typeof value !== 'string' || !value.length) return undefined; if (!sdkSessionIds.has(value)) sdkSessionIds.set(value, sdkSessionIds.size + 1); return sdkSessionIds.get(value) }
let scratch, proxy, relay, observer, source, runtimeGrant, deadline, census, failure, startup, modelWitness
let startupSettled = false, proxyJoined = false
let inputs = []
async function duringRun(operation, milliseconds, label) {
  assert(!stop.signal.aborted, 'Total execution deadline reached')
  let abort
  const halted = new Promise((_, reject) => { abort = () => reject(new Error('Total execution deadline reached')); stop.signal.addEventListener('abort', abort, { once: true }) })
  try { return await bounded(Promise.race([operation, halted]), milliseconds, label) }
  finally { stop.signal.removeEventListener('abort', abort) }
}
// Linux incarnation/cwd/ancestry census: no command/env/private SDK reads.
function ownedProcesses() {
  if (!scratch) return new Map()
  const all = new Map()
  if (process.platform !== 'linux') {
    // Synthetic POSIX controls use parent/incarnation metadata only. The
    // native acceptance lane remains Linux and uses the stricter /proc census.
    const result = spawnSync('ps', ['-eo', 'pid=,ppid=,lstart='], { encoding: 'utf8', timeout: 2000 })
    assert(result.status === 0, 'Owned synthetic process census failed')
    for (const line of result.stdout.split('\n')) {
      const row = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)
      if (!row || Number(row[1]) === process.pid || Number(row[1]) === result.pid) continue
      const pid = Number(row[1]), parent = Number(row[2]), start = row[3]
      all.set(pid, { parent, start, owned: parent === process.pid || seen.get(pid) === start })
    }
  }
  else {
  for (const pid of readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
    if (Number(pid) === process.pid) continue
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'), fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' '), cwd = realpathSync(`/proc/${pid}/cwd`), start = fields[19]
      all.set(Number(pid), { parent: Number(fields[1]), start, owned: cwd === scratch || cwd.startsWith(`${scratch}/`) || seen.get(Number(pid)) === start })
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw new Error('Owned process census failed') }
  }
  }
  let changed
  do { changed = false; for (const row of all.values()) if (!row.owned && all.get(row.parent)?.owned) { row.owned = true; changed = true } } while (changed)
  const owned = new Map([...all].filter(([, row]) => row.owned))
  for (const [pid, row] of owned) seen.set(pid, row.start)
  for (const [pid, start] of seen) if (all.get(pid)?.start !== start) seen.delete(pid)
  return owned
}
function signalGroup(child, signal) {
  const owner = childOwners.get(child)
  assert(owner, 'Client signaling requires an observed owned handle')
  return owner.signal(signal)
}
async function childRun(executable, command, env, cwd, milliseconds) {
  assert(!stop.signal.aborted, 'Owned client refused after execution deadline')
  const child = spawn(executable, command, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const owner = createOwnedClientProcess(child)
  childOwners.set(child, owner); clientOwners.push(owner)
  children.add(child)
  const onAbort = () => signalGroup(child, 'SIGTERM')
  stop.signal.addEventListener('abort', onAbort, { once: true })
  child.once('spawn', () => { if (stop.signal.aborted) onAbort() })
  const exit = new Promise((resolveExit, reject) => { child.once('error', () => reject(new Error('Owned client spawn failed'))); child.once('close', code => resolveExit(code)) })
  const text = { out: '', err: '' }
  for (const [key, stream] of [['out', child.stdout], ['err', child.stderr]]) stream.on('data', bytes => {
    text[key] += bytes.toString()
    if (Buffer.byteLength(text[key]) > 2 * 1024 * 1024) { signalGroup(child, 'SIGTERM'); stop.abort(new Error('Client output bound exceeded')) }
  })
  let operationFailed = false
  try { return { status: await duringRun(exit, milliseconds, 'Owned client deadline exceeded'), ...text } }
  catch (error) { operationFailed = true; throw error }
  finally {
    try {
      signalGroup(child, 'SIGTERM')
      try { await bounded(owner.joined, 1000, 'Owned client join deadline exceeded') }
      catch { signalGroup(child, 'SIGKILL'); await bounded(owner.joined, 5000, 'Owned client failed to join') }
    } catch (error) {
      // Failed cleanup cannot replace the original deadline/spawn failure.
      // Outer physical-join and signal receipts keep cleanup failure visible.
      if (!operationFailed) throw error
    } finally {
      stop.signal.removeEventListener('abort', onAbort)
      if (owner.isJoined()) children.delete(child)
    }
  }
}
const sdkClientToolName = name => (mixedHandback && name === 'mcp__oc__SubagentHandback' ? 'SubagentHandback' : /^mcp__oc__(Agent|Bash|TaskOutput|Read)$/.exec(name)?.[1]) ?? name
const objectInput = value => value && typeof value === 'object' && !Array.isArray(value)
function inputIdentity(value) {
  if (Array.isArray(value)) return value.map(inputIdentity)
  if (objectInput(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, inputIdentity(value[key])]))
  return value
}
function httpToolTerminal(status, contentType, text, request) {
  if (status !== 200) return
  const complete = []
  if (contentType.includes('text/event-stream')) {
    const blocks = new Map(); let started = false, terminal = false, stopped = false, terminalReason
    for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
      const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
      if (!data) continue
      const event = JSON.parse(data)
      if (event.type === 'ping') continue
      if (event.type === 'error' || stopped) return
      if (event.type === 'message_start') {
        if (started || blocks.size) return
        started = true; continue
      }
      if (!started) return
      if (event.type === 'content_block_start') {
        if (terminal || !Number.isInteger(event.index) || event.index < 0 || blocks.has(event.index) || typeof event.content_block?.type !== 'string') return
        blocks.set(event.index, { ...event.content_block, json: '', closed: false })
      }
      if (event.type === 'content_block_delta') {
        const block = blocks.get(event.index)
        if (terminal || !block || block.closed) return
        if (event.delta?.type === 'input_json_delta') {
          if (block.type !== 'tool_use' || typeof event.delta.partial_json !== 'string') return
          block.json += event.delta.partial_json
        }
        if (event.delta?.type === 'text_delta') {
          if (block.type !== 'text' || typeof event.delta.text !== 'string') return
          block.text = (block.text ?? '') + event.delta.text
        }
      }
      if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index)
        if (terminal || !block || block.closed) return
        block.closed = true
      }
      if (event.type === 'message_delta') {
        if (terminal) return
        if (event.delta?.stop_reason != null) {
          if (!['tool_use', 'end_turn'].includes(event.delta.stop_reason) || !blocks.size || [...blocks.values()].some(block => !block.closed)) return
          terminal = true; terminalReason = event.delta.stop_reason
        }
      }
      if (event.type === 'message_stop') {
        if (!terminal || !blocks.size || [...blocks.values()].some(block => !block.closed)) return
        stopped = true
      }
    }
    if (!started || !terminal || !stopped) return
    if (terminalReason === 'end_turn') { const value = [...blocks.values()].filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(''); if (value.length) httpTexts.set(request, value); return }
    for (const block of blocks.values()) if (block.type === 'tool_use') complete.push({ id: block.id, name: block.name, input: block.json ? JSON.parse(block.json) : block.input })
  } else {
    const body = JSON.parse(text)
    if (body.type !== 'message' || !['tool_use', 'end_turn'].includes(body.stop_reason) || !Array.isArray(body.content)) return
    if (body.stop_reason === 'end_turn') { const value = body.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join(''); if (value.length) httpTexts.set(request, value); return }
    complete.push(...body.content.filter(block => block.type === 'tool_use'))
  }
  if (!complete.length || complete.some(block => typeof block.id !== 'string' || !block.id.length || typeof block.name !== 'string' || !objectInput(block.input))) return
  for (const block of complete) {
    if (httpTools.has(block.id)) proof.httpToolIdReused = true
    httpTools.set(block.id, { request, name: block.name, input: JSON.stringify(inputIdentity(block.input)), privateInput: block.input })
  }
}
try {
  deadline = setTimeout(() => stop.abort(new Error('E72 total deadline exceeded')), timeout)
  const target = realpathSync(args['target-root']), entry = realpathSync(resolve(target, args.entry)), targetPackage = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
  assert(entry.startsWith(`${target}/`), 'Proxy entry must belong to selected target')
  assert(synthetic ? targetPackage.name === 'meridian-harness-synthetic-fixture' : targetPackage.name === '@rynfar/meridian', 'Selected proxy package identity mismatch')
  const sdkPath = realpathSync(createRequire(entry).resolve('@anthropic-ai/claude-agent-sdk')), installed = sdkPackage(sdkPath)
  assert(installed.value.version === args['sdk-version'], 'Target SDK version mismatch')
  assert(!synthetic || installed.value.meridianHarnessSynthetic === true, 'Synthetic mode cannot invoke native SDK')
  if (args['source-head']) {
    assert(/^[a-f0-9]{40}$/.test(args['source-head']), 'Pin a full source SHA')
    const head = spawnSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 })
    assert(head.status === 0 && head.stdout.trim() === args['source-head'], 'Selected source head mismatch')
    const clean = spawnSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 })
    assert(clean.status === 0 && !clean.stdout.trim(), 'Selected source checkout must be clean')
  }
  const client = realpathSync(args.client), native = realpathSync(args['native-cli'])
  inputs = [snapshot(entry), snapshot(sdkPath), snapshot(installed.file), snapshot(client), snapshot(native), snapshot(join(target, 'package.json'))]
  if (ownedCheckpoint) { const helper = snapshot(new URL('./lib/e2eOwnedCheckpoint.mjs', import.meta.url)); inputs.push(helper); proof.checkpointObserverSha256 = helper.hash }
  if (args['source-head'] && entry.startsWith(`${target}/dist/`)) {
    const manifestInput = snapshot(join(target, 'dist/build-provenance.json')), manifest = JSON.parse(manifestInput.bytes.toString('utf8'))
    assert(manifest.build?.sha === args['source-head'] && manifest.build.dirty === false && manifest.build.certification === 'verified', 'Compiled target does not certify selected clean source head')
    for (const [name, expected] of Object.entries(manifest.artifacts ?? {})) {
      assert(/^(?!.*(?:^|\/)\.\.(?:\/|$))(?!\/)[A-Za-z0-9_./@-]+$/.test(name), 'Invalid compiled artifact path')
      const artifact = snapshot(join(target, 'dist', name)); assert(artifact.hash === expected, 'Compiled artifact identity mismatch'); inputs.push(artifact)
    }
    assert(manifest.artifacts?.[entry.slice(`${target}/dist/`.length)] === inputs[0].hash, 'Selected entry missing from compiled certification')
    inputs.push(manifestInput)
  }
  proof.identity = { targetKind: args['source-head'] ? 'source' : 'installed-package', sourceHead: args['source-head'], packageVersion: targetPackage.version, proxyEntrySha256: inputs[0].hash, sdkVersion: installed.value.version, sdkEntrySha256: inputs[1].hash, clientSha256: inputs[3].hash, nativeCliSha256: inputs[4].hash }
  source = snapshot(args['grant-file'], true)
  assert((source.identity[4] & 0o777) === 0o400 && source.identity[5] === 1, 'Owned grant must be a single-link private read-only file (0400)')
  assert(source.identity[2] === process.getuid(), 'Owned grant must belong to this runtime user')
  const credential = JSON.parse(source.bytes.toString('utf8')), grant = credential.claudeAiOauth
  assert(typeof grant?.accessToken === 'string' && grant.accessToken.length > 0 && grant.expiresAt > Date.now() + timeout + 60000 && Array.isArray(grant.scopes), 'Owned grant absent/malformed/insufficient full-run expiry; no query started')
  assert(!synthetic || grant.accessToken.startsWith('synthetic-'), 'Synthetic control requires a non-auth synthetic grant')
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-e72-')))
  const account = join(scratch, 'runtime-account'), config = join(scratch, 'proxy-config'), clientConfig = join(scratch, 'client-config'), project = join(scratch, 'client-project'), work = join(scratch, 'proxy-work'), outside = join(scratch, 'outside-project')
  for (const directory of [account, config, clientConfig, project, work, ...(mixedAuto ? [outside] : []), join(scratch, 'store'), join(scratch, 'proxy-home'), join(scratch, 'client-home'), join(scratch, 'unlinked-default'), join(scratch, 'plugins')]) mkdirSync(directory, { mode: 0o700 })
  const mixedCommands = mixedAuto ? mixedAutoCommands(outside) : undefined
  // Do not give a native runtime refresh authority or the immutable source file.
  const { refreshToken: _removedRefresh, ...readOnlyGrant } = grant
  writeFileSync(join(account, '.credentials.json'), JSON.stringify({ claudeAiOauth: readOnlyGrant }), { mode: 0o400, flag: 'wx' })
  runtimeGrant = snapshot(join(account, '.credentials.json'), true)
  proof.privateSnapshotCreated = true
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ routing: 'active', updateCheck: false }), { mode: 0o600 })
  writeFileSync(join(config, 'profiles.json'), '[]', { mode: 0o600 })
  writeFileSync(join(scratch, 'plugins.json'), '{"plugins":[]}', { mode: 0o600 })
  writeFileSync(join(project, 'README.md'), 'Owned synthetic E72 project.\n', { mode: 0o600 })
  if (args['fail-after-copy']) throw new Error('Injected post-copy failure')
  for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|MERIDIAN|CLAUDE_PROXY|OPENAI|AWS_|GOOGLE_|VERTEX_|BEDROCK_|NODE_OPTIONS|BUN_OPTIONS|OPENCODE_)/.test(key)) delete process.env[key]
  Object.assign(process.env, { HOME: join(scratch, 'proxy-home'), CLAUDE_CONFIG_DIR: join(scratch, 'unlinked-default'), MERIDIAN_CONFIG_DIR: config, MERIDIAN_SESSION_DIR: join(scratch, 'store'), MERIDIAN_WORKDIR: work, MERIDIAN_CLAUDE_PATH: native, MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_ROUTING: 'active', MERIDIAN_PASSTHROUGH: '1', MERIDIAN_MAX_CONCURRENT: '4', MERIDIAN_SHUTDOWN_GRACE_MS: '2000' })
  proof.sdkCapacity = 4
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) { const directory = join(scratch, `proxy-xdg-${kind.toLowerCase()}`); mkdirSync(directory, { mode: 0o700 }); process.env[`XDG_${kind}_HOME`] = directory }
  const clientEnv = { ...process.env }
  for (const key of Object.keys(clientEnv)) if (/^(CLAUDE|ANTHROPIC|MERIDIAN|CLAUDE_PROXY|OPENAI)/.test(key)) delete clientEnv[key]
  Object.assign(clientEnv, { HOME: join(scratch, 'client-home'), CLAUDE_CONFIG_DIR: clientConfig, ANTHROPIC_AUTH_TOKEN: 'meridian-e72-local-dummy', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) { const directory = join(scratch, `client-xdg-${kind.toLowerCase()}`); mkdirSync(directory, { mode: 0o700 }); clientEnv[`XDG_${kind}_HOME`] = directory }
  for (const [file, expected, env] of [[client, args['client-version'], clientEnv], [native, args['native-cli-version'], process.env]]) {
    const result = await childRun(file, ['--version'], env, work, 10000)
    assert(result.status === 0 && result.out.trim() === `${expected} (Claude Code)`, 'Explicit client/native version mismatch')
  }
  proof.identity.clientVersion = args['client-version']; proof.identity.nativeCliVersion = args['native-cli-version']
  proof.remainingNativeGates = ['background/main overlap', 'mixed auto-mode classifiers and subagents', 'explicit root and scoped cancellation', 'declared nested ancestry cancellation', 'incidental parent HTTP abort independence', 'E41 all four modes']
  if (!synthetic && !rehearsal) {
    const ready = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: `Bearer ${grant.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]) })
    proof.readinessStatus = ready.status; await ready.body?.cancel(); assert(ready.ok, 'Owned grant readiness failed; no generation started')
  }
  const sdk = await import(pathToFileURL(sdkPath).href), original = sdk.query
  if (mixedAuto) modelWitness = createRequestModelWitness(requestModels)
  observer = spyOn(sdk, 'query').mockImplementation(input => {
    assert(!rehearsal, 'Rehearsal fenced SDK generation')
    assert(!stop.signal.aborted && proof.queries.length < maximum, 'Generation count/deadline bound reached')
    assert(input.options.env?.CLAUDE_CONFIG_DIR === account && input.options.pathToClaudeCodeExecutable === native, 'SDK escaped explicit account/executable')
    assert(!input.options.env?.ANTHROPIC_API_KEY && !input.options.env?.ANTHROPIC_BASE_URL && !input.options.env?.CLAUDE_CODE_OAUTH_TOKEN, 'SDK inherited another authentication/provider override')
    const owned = mixedAuto ? modelWitness.capture() : undefined
    const row = { turn: owned?.turn ?? turn, ...(mixedAuto ? { request: owned.request, role: owned.role, wireRequested: owned.requestedModel } : {}), requested: /^[a-z0-9[\].-]+$/.test(input.options.model) ? input.options.model : 'invalid-requested-model', versionPin: input.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL === undefined ? undefined : /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(input.options.env.ANTHROPIC_DEFAULT_SONNET_MODEL) ? input.options.env.ANTHROPIC_DEFAULT_SONNET_MODEL : 'invalid-version-pin', resumed: typeof input.options.resume === 'string', resumedSession: sessionOrdinal(input.options.resume), forked: input.options.forkSession === true, requestedSession: sessionOrdinal(input.options.sessionId), maxTurns: input.options.maxTurns, nativeModels: [], completed: false, assistantError: false, resultFlagValid: false, resultIsError: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null }
    row.createdMs = elapsed(); row.allowedToolCapabilities = publicToolCapabilities(input.options.allowedTools)
    row.nativeInitToolCapabilities = []
    const generations = createPublicSdkGenerationWitness({ now: elapsed })
    const checkpoint = ownedCheckpoint ? createOwnedCheckpointWitness({ maxTurns: input.options.maxTurns, signal: input.options.abortController?.signal, forwardedReason: PASSTHROUGH_DENY_REASON }) : undefined
    if (checkpoint) checkpointWitnesses.set(row, checkpoint)
    const tools = new Map(), hookReceipts = new Map(); sdkTools.set(row, tools); sdkHookReceipts.set(row, hookReceipts)
    const mcpWitness = args['require-mcp-readiness'] ? createQueryMcpReadinessWitness(input.options) : undefined
    proof.queries.push(row)
    const dropReason = 'This tool call has already been handled by the client-facing turn — do not repeat it. Do not call additional tools and do not generate further text — end your turn now.'
    const preToolHooks = input.options.hooks?.PreToolUse
    assert(Array.isArray(preToolHooks) && preToolHooks.length > 0, 'SDK tool forwarding hook witness unavailable')
    let hookOrder = 0
    const observedHooks = preToolHooks.map(matcher => ({ ...matcher, hooks: matcher.hooks.map(hook => async (event, toolUseId, options) => {
      checkpoint?.hookStarted(event, toolUseId)
      let result
      try { result = await hook(event, toolUseId, options) }
      catch (error) { checkpoint?.hookSettled(toolUseId, undefined, true); throw error }
      checkpoint?.hookSettled(toolUseId, result)
      if (typeof event.tool_use_id !== 'string' || event.tool_use_id !== toolUseId || !objectInput(event.tool_input)) { row.invalidToolHookWitness = true; return result }
      if (hookReceipts.has(toolUseId)) row.duplicateToolHookWitness = true
      hookReceipts.set(toolUseId, {
        name: sdkClientToolName(event.tool_name), input: JSON.stringify(inputIdentity(event.tool_input)), order: ++hookOrder,
        fate: result?.decision === 'block' && result.reason === PASSTHROUGH_DENY_REASON ? 'forwarded'
          : result?.decision === 'block' && result.reason === dropReason ? 'dropped' : 'unknown',
      })
      generations.observeHook(toolUseId, hookReceipts.get(toolUseId).fate)
      return result
    }) }))
    const query = original({ ...input, options: { ...input.options, hooks: { ...input.options.hooks, PreToolUse: observedHooks }, maxBudgetUsd: costLimit / maximum } }); active.add(query)
    const closeObserved = (...values) => {
      row.closeCalls = (row.closeCalls ?? 0) + 1; row.firstCloseCalledMs ??= elapsed()
      checkpoint?.close()
      try { return query.close(...values) } catch (error) { checkpoint?.close(true); row.closeThrew = true; throw error }
    }
    const interruptObserved = async (...values) => {
      checkpoint.interruptRequested()
      try { const result = await query.interrupt(...values); checkpoint.interruptSettled(true); return result }
      catch (error) { checkpoint.interruptSettled(false); throw error }
    }
    const abort = () => {
      try { input.options.abortController?.abort(new Error('E72 execution bound')) } catch { proof.sdkAbortSignalFailed = true }
      try { closeObserved() } catch { proof.sdkAbortCloseFailed = true }
    }
    stop.signal.addEventListener('abort', abort, { once: true })
    return new Proxy(query, { get(targetQuery, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        try {
          for await (const event of query) {
            mcpWitness?.observe(event)
            generations.observe(event)
            checkpoint?.observe(event)
            if (event.type === 'system' && event.subtype === 'init') {
              if (row.nativeInitToolCapabilities.length < 16) row.nativeInitToolCapabilities.push(publicToolCapabilities(event.tools))
              else row.nativeInitCapabilitiesOverflow = true
            }
            const eventSession = sessionOrdinal(event.session_id)
            if (eventSession !== undefined) { if (row.session !== undefined && row.session !== eventSession) row.sessionChanged = true; row.session = eventSession }
            const model = event.type === 'assistant' ? event.message?.model : event.type === 'stream_event' && event.event?.type === 'message_start' ? event.event.message?.model : undefined
            if (typeof model === 'string' && !row.nativeModels.includes(model)) row.nativeModels.push(/^claude-[a-z0-9.-]+$/.test(model) ? model : 'invalid-native-model')
            if (event.type === 'assistant') {
              row.assistantError ||= Boolean(event.error)
              const text = (event.message?.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
              if (text.length) { const collected = (sdkTexts.get(row) ?? '') + text; assert(Buffer.byteLength(collected) <= 2 * 1024 * 1024, 'SDK text receipt byte bound reached'); sdkTexts.set(row, collected) }
              const usage = event.message?.usage
              if (usage) { row.inputTokens = Math.max(row.inputTokens, (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)); row.outputTokens = Math.max(row.outputTokens, usage.output_tokens ?? 0) }
              for (const block of event.message?.content ?? []) if (block.type === 'tool_use' && typeof block.id === 'string' && objectInput(block.input)) {
                if (sdkToolOwners.has(block.id) && sdkToolOwners.get(block.id) !== row) proof.sdkToolIdReused = true
                sdkToolOwners.set(block.id, row)
                tools.set(block.id, { name: sdkClientToolName(block.name), rawName: block.name, input: JSON.stringify(inputIdentity(block.input)) })
              }
            }
            if (event.type === 'result') {
              row.resultEventMs = elapsed()
              row.completed = true; row.resultSubtype = ['success', 'error_max_turns', 'error_during_execution'].includes(event.subtype) ? event.subtype : 'other'
              row.resultFlagValid = typeof event.is_error === 'boolean'
              row.resultIsError = row.resultFlagValid ? event.is_error : null; row.nativeTurns = event.num_turns
              row.terminalReason = event.terminal_reason === undefined ? 'absent' : ['max_turns', 'aborted_tools'].includes(event.terminal_reason) ? event.terminal_reason : 'other'
              row.estimatedCostUsd = Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null
            }
            yield event
          }
        } catch (error) { checkpoint?.iteratorError(error); throw error }
        finally { checkpoint?.iteratorSettled(); if (mcpWitness) row.mcpReadiness = mcpWitness.summary(); row.generations = generations.summary(); row.iteratorSettledMs = elapsed(); row.iteratorSettled = true; stop.signal.removeEventListener('abort', abort); active.delete(query) }
      }
      if (key === 'close') return closeObserved
      if (key === 'interrupt' && checkpoint && typeof targetQuery.interrupt === 'function') return interruptObserved
      const value = Reflect.get(targetQuery, key, targetQuery); return typeof value === 'function' ? value.bind(targetQuery) : value
    } })
  })
  census = setInterval(() => { try { const count = ownedProcesses().size; proof.peakOwnedProcesses = Math.max(proof.peakOwnedProcesses ?? 0, count); if (count > proof.limits.ownedProcesses) { proof.processBoundExceeded = true; stop.abort(new Error('Owned process count bound reached')) } } catch { proof.processCensusFailed = true; stop.abort(new Error('Owned process census failed')) } }, 100)
  const { startProxyServer } = await import(pathToFileURL(entry).href)
  startup = startProxyServer({ port: 0, host: '127.0.0.1', silent: false, profiles: [{ id: 'e72-owned', type: 'claude-max', claudeConfigDir: account }], defaultProfile: 'e72-owned', pluginDir: join(scratch, 'plugins'), pluginConfigPath: join(scratch, 'plugins.json') }).then(value => { proxy = value; return value }).finally(() => { startupSettled = true })
  proxy = await duringRun(startup, 15000, 'Proxy startup deadline exceeded')
  if (!proxy.server.listening) await duringRun(once(proxy.server, 'listening'), 5000, 'Proxy listen deadline exceeded')
  const address = proxy.server.address(); assert(address && typeof address === 'object', 'Proxy did not bind loopback')
  if (rehearsal) { assert(proof.queries.length === 0, 'Rehearsal queried SDK'); proof.result = 'REHEARSAL' }
  else {
    const wire = [], agentIds = new Map(), toolResults = new Map(), callerMessages = new Map()
    const session = randomUUID()
    let activeAgents = 0, activeMain = 0, peakAgents = 0, peakParentChild = 0, wireEvents = 0
    const actorOf = header => {
      if (header === null) return 0
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(header)) return -1
      if (!agentIds.has(header)) agentIds.set(header, agentIds.size + 1)
      return agentIds.get(header)
    }
    const resultText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : ''
    relay = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, fetch: relayWork.wrap(async request => {
      const url = new URL(request.url), text = ['GET', 'HEAD'].includes(request.method) ? undefined : await requestBody(request, 2 * 1024 * 1024)
      const headers = new Headers(request.headers)
      let row, receiptOwnsActive = false
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        assert(wire.length < maximum, 'Client request count bound reached')
        const requestId = `e72-${randomUUID()}`, requestNumber = wire.length + 1
        headers.set('x-request-id', requestId); traceIds.set(requestId, requestNumber)
        const body = JSON.parse(text), actor = actorOf(request.headers.get('x-claude-code-agent-id'))
        let identity = body.metadata?.user_id
        if (typeof identity === 'string') { try { identity = JSON.parse(identity) } catch { identity = undefined } }
        row = { request: requestNumber, turn, actor, requestedModelMatched: body.model === args.model, sessionKeyMatched: identity?.session_id === session, tools: Array.isArray(body.tools) ? body.tools.length : 0 }
        if (mixedAuto) {
          Object.assign(row, mixedAutoRequest(body, request.headers.get('x-claude-code-request-class') ?? 'none', row.sessionKeyMatched))
          row.requestedModel = /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(body.model) ? body.model : 'invalid-wire-model'
          row.requestedModelMatched = body.model === (row.role === 'classifier' ? args['classifier-model'] : args.model)
          requestModels.set(requestId, row)
        }
        if (mixedHandback) row.handbackDeclared = Array.isArray(body.tools) && body.tools.some(tool => tool?.name === 'SubagentHandback' && tool.input_schema?.properties?.message?.type === 'string' && Array.isArray(tool.input_schema?.required) && tool.input_schema.required.includes('message'))
        row.requestStartedMs = elapsed(); row.clientToolCapabilities = publicToolCapabilities(Array.isArray(body.tools) ? body.tools.map(tool => tool?.name) : undefined)
        if (background) row.startEvent = ++wireEvents
        wire.push(row)
        if (mixedHandback && row.role === 'working' && actor === 0) callerMessages.set(requestNumber, Array.isArray(body.messages) ? body.messages : [])
        for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          const receipt = { request: requestNumber, actor, ...(background ? { event: row.startEvent } : {}), text: resultText(block.content), ...(mixedHandback ? { privateContent: block.content } : {}), successful: block.is_error === undefined || block.is_error === false }
          const earlier = toolResults.get(block.tool_use_id)
          if (earlier && (earlier.actor !== receipt.actor || earlier.text !== receipt.text || earlier.successful !== receipt.successful)) proof.toolResultChanged = true
          if (!earlier) toolResults.set(block.tool_use_id, receipt)
        }
        if (row.role !== 'classifier' && actor > 0) { activeAgents++; peakAgents = Math.max(peakAgents, activeAgents) }
        else if (row.role !== 'classifier' && actor === 0) activeMain++
        if (activeMain > 0 && activeAgents > 0) peakParentChild = Math.max(peakParentChild, activeMain + activeAgents)
      }
      try {
        const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, { method: request.method, headers, body: text, signal: AbortSignal.any([request.signal, stop.signal]), decompress: false })
        if (row) {
          // Bun may consume headers when returning the original response.
          const status = response.status, contentType = response.headers.get('content-type') ?? ''
          row.status = status
          row.responseHeadersMs = elapsed()
          const receipt = requestBody(response.clone(), 2 * 1024 * 1024).then(body => { row.responseBodyTerminalMs = elapsed(); if (background) row.terminalEvent = ++wireEvents; httpToolTerminal(status, contentType, body, row.request) }).catch(error => { proof.httpReceiptFailure = true; proof.httpReceiptFailureType = ['SyntaxError', 'TypeError', 'AssertionError', 'Error'].includes(error?.name) ? error.name : 'other' })
          receiptOwnsActive = true
          pendingHttp.add(receipt); receipt.finally(() => { pendingHttp.delete(receipt); if (row.role !== 'classifier' && row.actor > 0) activeAgents--; else if (row.role !== 'classifier' && row.actor === 0) activeMain-- })
        }
        return response
      } finally { if (row && !receiptOwnsActive) { if (row.role !== 'classifier' && row.actor > 0) activeAgents--; else if (row.role !== 'classifier' && row.actor === 0) activeMain-- } }
    }) })
    for (turn = 1; turn <= 2; turn++) {
      const firstAlpha = mixedAuto ? mixedCommands.firstAlpha : background ? 'sleep 2 && echo alpha-1' : 'echo alpha-1'
      const firstBeta = mixedAuto ? mixedCommands.firstBeta : background ? 'sleep 2 && echo beta-1' : 'echo beta-1'
      const prompt = turn === 1 ? [
        'Use the Agent tool to launch exactly two general-purpose subagents in parallel, in one message,',
        background ? 'both in the background (run_in_background true).' : 'both in the foreground (run_in_background false).',
        `Subagent ALPHA must run the exact shell command \`${firstAlpha}\`, then in a separate Bash call run`,
        `\`${mixedAuto ? mixedCommands.secondAlpha : 'echo alpha-2'}\`, then report both outputs.`,
        `Subagent BETA must do the same with \`${firstBeta}\` and \`${mixedAuto ? mixedCommands.secondBeta : 'echo beta-2'}\`.`,
        ...(mixedHandback ? [
          `After both Bash calls, ALPHA must call SubagentHandback exactly once with message equal to the JSON string ${JSON.stringify('alpha-1\nalpha-2')}.`,
          `BETA must likewise call SubagentHandback exactly once with message equal to ${JSON.stringify('beta-1\nbeta-2')}.`,
          'Each handback must be that child\'s final call. Do not use SendMessage or any other tools in this bounded task.',
        ] : []),
        ...(background ? [
          'Immediately after launching them, run exactly one Bash command `echo parent-overlap` in the parent while they work.',
          ...(readBackground ? [
            'Wait for both background completion notifications. After each child is complete, use exactly one Read call on that launched child\'s advertised output_file path to collect its complete final report, reading from the beginning.',
            'Do not poll partial files and do not use TaskOutput, TaskStop, SendMessage or other tools in this bounded task.',
          ] : [
            'Then use exactly one TaskOutput call per launched agent ID, with block true and timeout 30000, to collect both completed reports.',
            'Do not use Read, TaskStop, SendMessage or other tools in this bounded task.',
          ]),
        ] : []),
        'When both have reported, reply with exactly the word DONE.',
      ].join(' ') : mixedAuto ? `Run exactly one Bash command \`${mixedCommands.parent}\`, then reply with exactly the word AGAIN.` : 'Reply with exactly the word AGAIN.'
      const command = [turn === 1 ? '--session-id' : '--resume', session, '-p', prompt, '--model', args.model, '--permission-mode', mixedAuto ? 'auto' : 'default', '--allowedTools', ...(mixedAuto ? ['Agent'] : ['Bash(echo:*)', 'Agent', ...(background ? ['Bash(sleep:*)', readBackground ? 'Read' : 'TaskOutput'] : [])])]
      const result = await childRun(client, command, { ...clientEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${relay.port}` }, project, Math.min(timeout, 300000))
      proof.turns.push({ number: turn, status: result.status, answered: new RegExp(`\\b${turn === 1 ? 'DONE' : 'AGAIN'}\\b`).test(result.out), refused: /API Error: [45][0-9][0-9]/.test(`${result.out}\n${result.err}`) })
      assert(!stop.signal.aborted, 'Execution deadline/output bound reached')
    }
    await duringRun(Promise.all([...pendingHttp]), 30000, 'HTTP terminal receipts failed to settle')
    proof.completedHttpToolTerminals = httpTools.size
    for (const row of proof.queries) {
      const observed = sdkTools.get(row), claims = sdkHookReceipts.get(row), tools = new Map(), dropped = []
      let hooksExact = !row.invalidToolHookWitness && !row.duplicateToolHookWitness && claims.size === observed.size
      for (const [id, tool] of observed) {
        const claim = claims.get(id)
        hooksExact &&= claim?.name === tool.name && claim?.input === tool.input && ['forwarded', 'dropped'].includes(claim?.fate)
        if (claim?.fate === 'forwarded') tools.set(id, tool)
        if (claim?.fate === 'dropped') dropped.push({ id, order: claim.order })
      }
      const lastForwardedOrder = Math.max(0, ...[...tools.keys()].map(id => claims.get(id).order))
      row.sdkToolHookCustody = hooksExact && dropped.every(({ id, order }) => tools.size > 0 && order > lastForwardedOrder && !httpTools.has(id) && !toolResults.has(id))
      row.sdkObservedToolCount = observed.size
      row.explicitlyDroppedSdkToolCount = dropped.length
      row.canonicalHttpToolTerminal = tools.size > 0 && [...tools].every(([id, tool]) => httpTools.get(id)?.input === tool.input && httpTools.get(id)?.name === tool.name)
      const requests = new Set([...tools.keys()].map(id => httpTools.get(id)?.request))
      row.toolRequest = tools.size > 0 && requests.size === 1 && !requests.has(undefined) ? [...requests][0] : undefined
      row.toolCount = tools.size
      if (ownedCheckpoint) row.ownedCheckpoint = checkpointWitnesses.get(row).summary()
      row.acceptedCanonicalResult = row.resultFlagValid && ((row.resultSubtype === 'success' && row.resultIsError === false) || (row.resultSubtype === 'error_max_turns' && row.resultIsError === true && row.maxTurns === 1 && row.nativeTurns === 1 && ['absent', 'max_turns'].includes(row.terminalReason) && row.canonicalHttpToolTerminal))
      if (readBackground || mixedAuto) {
        row.originalCanonicalResult = row.acceptedCanonicalResult
        row.acceptedCanonicalResult = backgroundReadNativeResult(row, { sdkVersion: args['sdk-version'], nativeVersion: args['native-cli-version'] })
      }
      if (ownedCheckpoint) {
        row.legacyCanonicalResult = row.acceptedCanonicalResult
        row.acceptedCanonicalResult = ownedCheckpointNativeResult(row, { sdkVersion: args['sdk-version'], nativeVersion: args['native-cli-version'] })
      }
    }
    proof.wire = wire; proof.lineage = records; proof.peakParallelAgentRequests = peakAgents; if (background) proof.peakParentChildRequests = peakParentChild
    const decision = row => records.filter(record => record.request === row.request)
    const working = wire.filter(row => row.role !== 'classifier'), classifiers = wire.filter(row => row.role === 'classifier')
    const mains = working.filter(row => row.actor === 0), agents = new Map()
    for (const row of working.filter(row => row.actor > 0)) agents.set(row.actor, [...(agents.get(row.actor) ?? []), row])
    const resumed = rows => rows.length >= 2 && rows.slice(1).every(row => decision(row).length === 1 && decision(row)[0].lineage === 'continuation')
    const privateReceipts = [...httpTools].map(([id, tool]) => {
      const request = wire.find(row => row.request === tool.request), sdkRows = proof.queries.filter(row => sdkTools.get(row).has(id)), result = toolResults.get(id)
      return { id, tool, actor: request?.actor, row: sdkRows.length === 1 ? sdkRows[0] : undefined, result, paired: sdkRows.length === 1 && sdkTools.get(sdkRows[0]).get(id)?.input === tool.input && sdkTools.get(sdkRows[0]).get(id)?.name === tool.name, resultMatched: !!result && result.actor === request?.actor && result.request > tool.request && result.successful }
    })
    const launches = privateReceipts.filter(receipt => receipt.tool.name === 'Agent')
    const commands = mixedAuto ? [mixedCommands.firstAlpha, mixedCommands.secondAlpha, mixedCommands.firstBeta, mixedCommands.secondBeta] : [background ? 'sleep 2 && echo alpha-1' : 'echo alpha-1', 'echo alpha-2', background ? 'sleep 2 && echo beta-1' : 'echo beta-1', 'echo beta-2']
    const bash = commands.map(command => privateReceipts.filter(receipt => receipt.tool.name === 'Bash' && receipt.tool.privateInput.command === command))
    const foregroundLaunchReceipts = launches.length === 2 && ['alpha', 'beta'].every(label => launches.filter(receipt => receipt.actor === 0 && receipt.paired && receipt.resultMatched && receipt.tool.privateInput.subagent_type === 'general-purpose' && receipt.tool.privateInput.run_in_background !== true && typeof receipt.tool.privateInput.prompt === 'string' && receipt.tool.privateInput.prompt.includes(`${label}-1`) && receipt.tool.privateInput.prompt.includes(`${label}-2`) && receipt.result.text.includes(`${label}-1`) && receipt.result.text.includes(`${label}-2`)).length === 1)
    const bashReceipts = bash.every((rows, index) => rows.length === 1 && rows[0].actor > 0 && rows[0].paired && rows[0].resultMatched && rows[0].result.text.includes(['alpha-1', 'alpha-2', 'beta-1', 'beta-2'][index])) && bash[0][0]?.actor === bash[1][0]?.actor && bash[2][0]?.actor === bash[3][0]?.actor && bash[0][0]?.actor !== bash[2][0]?.actor
    const mixedParent = mixedAuto ? privateReceipts.filter(receipt => receipt.tool.name === 'Bash' && receipt.tool.privateInput.command === mixedCommands.parent) : []
    const mixedParentWorked = mixedAuto && mixedParent.length === 1 && mixedParent[0].actor === 0 && mixedParent[0].paired && mixedParent[0].resultMatched && mixedParent[0].result.text.includes('parent-2') && wire.find(row => row.request === mixedParent[0].tool.request)?.turn === 2
    const handbacks = mixedHandback ? privateReceipts.filter(receipt => receipt.tool.name === 'SubagentHandback') : []
    const handbackLinks = []
    const handbackMatches = mixedHandback ? ['alpha', 'beta'].map((label, index) => {
      const actor = bash[index * 2][0]?.actor
      const calls = handbacks.filter(receipt => receipt.actor === actor)
      const parents = launches.filter(receipt => typeof receipt.tool.privateInput.prompt === 'string' && receipt.tool.privateInput.prompt.includes(`${label}-1`) && receipt.tool.privateInput.prompt.includes(`${label}-2`))
      const receipt = calls[0], parent = parents[0], last = working.filter(row => row.actor === actor).at(-1)
      const message = `${label}-1\n${label}-2`
      const frame = publicNativeHandbackFrameFacts({ parentResultContent: parent?.result?.privateContent, expectedMessage: message, expectedActorId: [...agentIds].find(([, number]) => number === actor)?.[0], clientVersion: args['client-version'] })
      const diagnostic = publicHandbackReceiptFacts({ input: receipt?.tool.privateInput, parentPrompt: parent?.tool.privateInput.prompt,
        parentResultContent: parent?.result?.privateContent, expectedMessage: message,
        expectedActorId: [...agentIds].find(([, ordinal]) => ordinal === actor)?.[0],
        callerMessages: callerMessages.get(parent?.result?.request) ?? [] })
      handbackLinks.push({ expectedChild: index + 1, actor, call: receipt ? privateReceipts.indexOf(receipt) + 1 : null,
        parentLaunch: parent ? privateReceipts.indexOf(parent) + 1 : null, parentResultRequest: parent?.result?.request,
        finalChildRequest: last?.request, exactMessageInParentResult: parent?.resultMatched === true && parent.result.text.includes(message), diagnostic, frame,
        encoding: publicHandbackEncodingFacts({ input: receipt?.tool.privateInput, parentResultContent: parent?.result?.privateContent, expectedMessage: message }) })
      return actor > 0 && calls.length === 1 && parents.length === 1 && receipt.paired && !receipt.result &&
        Object.keys(receipt.tool.privateInput).length === 1 && receipt.tool.privateInput.message === message &&
        parent.paired && parent.resultMatched && (framedHandback ? frame.reportMatched : parent.result.text.includes(message)) && parent.result.request > receipt.tool.request &&
        last?.turn === 1 && last.request === receipt.tool.request && last.handbackDeclared === true
    }) : []
    const distinctHandbackParents = mixedHandback && new Set(handbackLinks.map(row => row.parentLaunch)).size === 2 && handbackLinks.every(row => row.parentLaunch !== null)
    const nativeHandbacks = mixedHandback && handbacks.length === 2 && new Set(handbacks.map(receipt => receipt.actor)).size === 2 && distinctHandbackParents && handbackMatches.every(Boolean)
    // Background launch handles stay private and must identify the actual wire
    // child. A foreground result or a generated completion word cannot qualify.
    const backgroundLaunches = ['alpha', 'beta'].map((label, index) => {
      const matches = launches.filter(receipt => receipt.actor === 0 && receipt.paired && receipt.resultMatched && receipt.tool.privateInput.subagent_type === 'general-purpose' && receipt.tool.privateInput.run_in_background === true && typeof receipt.tool.privateInput.prompt === 'string' && receipt.tool.privateInput.prompt.includes(`${label}-1`) && receipt.tool.privateInput.prompt.includes(`${label}-2`))
      if (matches.length !== 1) return undefined
      const ids = [...matches[0].result.text.matchAll(/\bagentId:\s*([A-Za-z0-9_-]{1,128})\b/g)]
      if (ids.length !== 1 || agentIds.get(ids[0][1]) !== bash[index * 2][0]?.actor) return undefined
      const output = readBackground ? backgroundLaunchOutput(matches[0].result.text) : undefined
      if (readBackground && (!output || output.id !== ids[0][1])) return undefined
      return { id: ids[0][1], actor: agentIds.get(ids[0][1]), launch: matches[0], label, ...(output ? { path: output.path } : {}) }
    })
    const taskOutputs = privateReceipts.filter(receipt => receipt.tool.name === 'TaskOutput')
    const boundedTaskWait = receipt => receipt.tool.privateInput.block === true && Number.isFinite(receipt.tool.privateInput.timeout) && receipt.tool.privateInput.timeout > 0 && receipt.tool.privateInput.timeout <= 30000
    const taskHandleMatches = (receipt, child) => child && receipt.tool.privateInput.task_id === child.id
    // A query receives launch results before generating its TaskOutput calls.
    // That same incoming request is a valid boundary; a prior query is not.
    const taskAfterLaunch = (receipt, child) => child && receipt.tool.request >= child.launch.result.request
    const childCompleted = (receipt, child) => child && receipt.result && wire.filter(row => row.actor === child.actor).every(row => Number.isInteger(row.terminalEvent) && row.terminalEvent < receipt.result.event)
    const completedBackground = backgroundLaunches.every(child => child && taskOutputs.filter(receipt => receipt.actor === 0 && receipt.paired && receipt.resultMatched && taskHandleMatches(receipt, child) && boundedTaskWait(receipt) && taskAfterLaunch(receipt, child) && childCompleted(receipt, child) && receipt.result.text.includes(`${child.label}-1`) && receipt.result.text.includes(`${child.label}-2`)).length === 1)
    const parentWork = privateReceipts.filter(receipt => receipt.tool.name === 'Bash' && receipt.tool.privateInput.command === 'echo parent-overlap')
    const parentWorked = parentWork.length === 1 && parentWork[0].actor === 0 && parentWork[0].paired && parentWork[0].resultMatched && parentWork[0].result.text.includes('parent-overlap')
    const reads = privateReceipts.filter(receipt => receipt.tool.name === 'Read')
    const readFacts = readBackground ? backgroundLaunches.map((child, index) => {
      const childRequests = child ? wire.filter(row => row.actor === child.actor) : []
      const finalRequest = childRequests.at(-1)
      const candidates = reads.filter(receipt => child && receipt.tool.privateInput.file_path === child.path)
      return candidates.length === 1 ? backgroundReadCompletion({ receipt: { ...candidates[0], startEvent: wire.find(row => row.request === candidates[0].tool.request)?.startEvent }, launch: child, childRequests,
        finalReport: finalRequest ? httpTexts.get(finalRequest.request) : undefined, executionIds: [bash[index * 2][0]?.id, bash[index * 2 + 1][0]?.id] }) : { accepted: false, ownedPath: false, afterLaunch: false, childCompleteBeforeRead: false, matchedReport: false, format: 'unknown' }
    }) : []
    const readLaunchesUnique = readBackground && backgroundLaunches.every(Boolean) && new Set(backgroundLaunches.map(child => child.id)).size === 2 && new Set(backgroundLaunches.map(child => child.path)).size === 2
    const backgroundLaunchReceipts = launches.length === 2 && backgroundLaunches.every(Boolean) && parentWorked && (readBackground ? readLaunchesUnique && taskOutputs.length === 0 && reads.length === 2 && readFacts.every(row => row.accepted) : taskOutputs.length === 2 && completedBackground)
    if (background) proof.backgroundReceiptFacts = {
      launches: launches.length, ownedLaunchHandles: backgroundLaunches.filter(Boolean).length,
      taskOutputs: taskOutputs.length,
      matchedTaskHandles: taskOutputs.filter(receipt => backgroundLaunches.some(child => taskHandleMatches(receipt, child))).length,
      boundedTaskWaits: taskOutputs.filter(boundedTaskWait).length,
      tasksAfterLaunch: taskOutputs.filter(receipt => backgroundLaunches.some(child => taskHandleMatches(receipt, child) && taskAfterLaunch(receipt, child))).length,
      childBodiesCompleteBeforeTaskResults: taskOutputs.filter(receipt => backgroundLaunches.some(child => taskHandleMatches(receipt, child) && childCompleted(receipt, child))).length,
      parentWorked, childBashReceipts: bashReceipts, forwardedReceipts: privateReceipts.length,
    }
    if (readBackground) proof.backgroundReadFacts = { ownedLaunchPaths: backgroundLaunches.filter(child => child?.path).length, uniqueLaunchPathsAndHandles: readLaunchesUnique, reads: reads.length,
      ownedReads: readFacts.filter(row => row.ownedPath).length, readsAfterLaunch: readFacts.filter(row => row.afterLaunch).length, childCompleteBeforeRead: readFacts.filter(row => row.childCompleteBeforeRead).length,
      matchedFinalReports: readFacts.filter(row => row.matchedReport).length, completedReads: readFacts.filter(row => row.accepted).length, formats: readFacts.map(row => row.format) }
    const privatePrefix = ordinal => [...sdkSessionIds].find(([, value]) => value === ordinal)?.[0].slice(0, 8)
    const prefixes = [...sdkSessionIds.keys()].map(id => id.slice(0, 8))
    proof.sessionPrefixAmbiguous = new Set(prefixes).size !== prefixes.length
    const finalTexts = proof.queries.filter(row => row.toolCount === 0).map(row => sdkTexts.get(row))
    proof.textReceiptAmbiguous = new Set(finalTexts).size !== finalTexts.length
    const queryRequests = new Map(), usedRequests = new Set()
    for (const row of proof.queries) {
      const prefix = row.resumed ? privatePrefix(row.resumedSession) : 'new'
      const candidates = wire.filter(request => !usedRequests.has(request.request) && request.turn === row.turn && decision(request).length === 1 &&
        (mixedAuto ? request.request === row.request && request.role === row.role && request.requestedModel === row.wireRequested : decisionSessions.get(request.request) === prefix) &&
        (row.toolCount > 0 ? row.toolRequest === request.request : sdkTexts.get(row)?.length > 0 && sdkTexts.get(row) === httpTexts.get(request.request)))
      if (candidates.length === 1) { queryRequests.set(row, candidates[0]); usedRequests.add(candidates[0].request) }
    }
    const actorQueries = new Map()
    for (const [row, request] of queryRequests) if (request.role !== 'classifier') actorQueries.set(request.actor, [...(actorQueries.get(request.actor) ?? []), row])
    const allQueriesCorrelated = (mixedAuto || !proof.sessionPrefixAmbiguous && !proof.textReceiptAmbiguous) && queryRequests.size === proof.queries.length && usedRequests.size === wire.length
    const actorSessionSets = [...actorQueries.values()].map(rows => new Set(rows.map(row => row.session)))
    const distinctSessionMappings = allQueriesCorrelated && actorQueries.size === 3 && actorSessionSets.every(values => !values.has(undefined)) && actorSessionSets.every((values, index) => actorSessionSets.slice(index + 1).every(other => [...values].every(value => !other.has(value)))) && [...actorQueries].every(([actor, queries]) => {
      const rows = [...queries].sort((left, right) => queryRequests.get(left).request - queryRequests.get(right).request)
      return rows.length === working.filter(request => request.actor === actor).length && (
        !rows[0].resumed || background && actor > 0 && rows[0].forked && rows[0].session !== rows[0].resumedSession &&
        (actorQueries.get(0) ?? []).some(parent => parent.session === rows[0].resumedSession && queryRequests.get(parent).request < queryRequests.get(rows[0]).request)
      ) && rows.slice(1).every((row, index) => row.resumed && row.resumedSession === rows[index].session)
    })
    proof.queryReceipts = proof.queries.map((row, index) => ({ number: index + 1, request: queryRequests.get(row)?.request, actor: queryRequests.get(row)?.actor, ...(mixedAuto ? { role: row.role } : {}), kind: row.toolCount > 0 ? 'tools' : 'text', paired: queryRequests.has(row) }))
    // Same-actor public lifecycle overlap locates a wait without claiming that
    // iterator completion is the physical native exit or the lease-release instant.
    proof.queryLifecycle = [...queryRequests].map(([row, request]) => {
      const previous = [...queryRequests].filter(([, prior]) => prior.role !== 'classifier' && request.role !== 'classifier' && prior.actor === request.actor && prior.request < request.request).sort((left, right) => right[1].request - left[1].request)[0]
      return { query: proof.queries.indexOf(row) + 1, request: request.request, actor: request.actor, priorRequest: previous?.[1].request ?? null,
        ...(mixedAuto ? { role: request.role } : {}),
        priorHttpBodyCompleteBeforeRequest: previous ? Number.isFinite(previous[1].responseBodyTerminalMs) && previous[1].responseBodyTerminalMs <= request.requestStartedMs : null,
        priorResultOverlapMs: previous && Number.isFinite(previous[0].resultEventMs) ? Math.max(0, previous[0].resultEventMs - request.requestStartedMs) : null,
        priorIteratorOverlapMs: previous && Number.isFinite(previous[0].iteratorSettledMs) ? Math.max(0, previous[0].iteratorSettledMs - request.requestStartedMs) : null }
    })
    // Only ordinal aliases and deterministic facts leave memory; no real
    // agent/session/tool IDs, prompts, tool arguments or generated prose.
    proof.toolReceipts = privateReceipts.map((receipt, index) => ({ number: index + 1, actor: receipt.actor, query: receipt.row ? proof.queries.indexOf(receipt.row) + 1 : null, name: ['Agent', 'Bash', 'TaskOutput', 'Read', ...(mixedHandback ? ['SubagentHandback'] : [])].includes(receipt.tool.name) ? receipt.tool.name : 'other', paired: receipt.paired, resultRequest: receipt.result?.request, resultMatched: receipt.resultMatched }))
    if (mixedAuto) proof.toolReceiptDiagnostics = privateReceipts.map((receipt, index) => {
      const sdkTool = receipt.row && sdkTools.get(receipt.row).get(receipt.id)
      const hook = receipt.row && sdkHookReceipts.get(receipt.row).get(receipt.id)
      return { number: index + 1, ...publicToolReceiptMatch({ wireName: receipt.tool.name, sdkRawName: sdkTool?.rawName, observerSdkName: sdkTool?.name,
        wireInput: receipt.tool.input, sdkInput: sdkTool?.input, hookFate: hook?.fate, hookInput: hook?.input,
        sdkIdOwners: proof.queries.filter(row => sdkTools.get(row).has(receipt.id)).length }) }
    })
    if (mixedHandback) proof.handbackFacts = { protocol: framedHandback ? 'native-client-frame-v1' : 'raw-substring-v2', calls: handbacks.length, actors: handbacks.map(receipt => receipt.actor).sort((a, b) => a - b),
      distinctParentLaunches: distinctHandbackParents, exactChildReportsDeliveredToMatchingParent: handbackMatches, childFinalCalls: handbacks.length === 2 && handbacks.every(receipt => working.filter(row => row.actor === receipt.actor).at(-1)?.request === receipt.tool.request), reports: handbackLinks }
    proof.checks = {
      invocationsSucceeded: proof.turns.length === 2 && proof.turns.every(row => row.status === 0), turnsAnswered: proof.turns.every(row => row.answered), noRefusal: proof.turns.every(row => !row.refused) && wire.every(row => row.status === 200),
      requestedModelIdentity: wire.length > 0 && wire.every(row => row.requestedModelMatched), rootedWireIdentity: wire.length > 0 && wire.every(row => row.sessionKeyMatched && row.actor >= 0), requestDecisionsComplete: wire.length > 0 && wire.every(row => decision(row).length === 1) && records.length === wire.length,
      twoMultiturnAgents: agents.size === 2 && [...agents.values()].every(rows => rows.length >= 3 && rows.every(row => row.turn === 1)), [background ? 'backgroundParallelism' : 'foregroundParallelism']: peakAgents >= 2,
      actualAgentAndBashReceipts: !proof.toolResultChanged && (background ? backgroundLaunchReceipts : foregroundLaunchReceipts) && bashReceipts && (!mixedAuto || mixedParentWorked) && (!mixedHandback || nativeHandbacks) && privateReceipts.length === (background || mixedHandback ? 9 : mixedAuto ? 7 : 6),
      sdkToolHookCustody: proof.queries.every(row => row.sdkToolHookCustody),
      allQueriesCorrelated, distinctSessionMappings, subagentResume: agents.size === 2 && [...agents.values()].every(resumed), mainResume: mains.length >= 3 && mains.some(row => row.turn === 2) && resumed(mains),
      noCollision: !records.some(row => ['unrelated-history', 'concurrent-race'].includes(row.divergence)), boundedLeaseWait: records.length === wire.length && records.every(row => Number.isFinite(row.sessionWaitMs) && row.sessionWaitMs >= 0 && row.sessionWaitMs <= 1000),
      nativeReceipts: !proof.httpReceiptFailure && !proof.sdkToolIdReused && !proof.httpToolIdReused && proof.queries.length === wire.length && proof.queries.every(row => (row.requested === (mixedAuto ? row.wireRequested : args.model) || (row.requested === 'sonnet' && row.versionPin === (mixedAuto ? row.wireRequested : args.model))) && row.completed && row.iteratorSettled && row.sdkToolHookCustody && row.acceptedCanonicalResult && !row.assistantError && !row.sessionChanged && row.session !== undefined && (row.requestedSession !== undefined ? row.requestedSession === row.session : !row.resumed || row.forked || row.resumedSession === row.session) && (row.toolCount === 0 || (row.canonicalHttpToolTerminal && row.toolRequest !== undefined)) && row.inputTokens > 0 && row.outputTokens > 0 && row.nativeModels.length > 0 && row.nativeModels.every(model => model === (mixedAuto && row.role === 'classifier' ? args['classifier-served-model'] : args['served-model'])) && row.estimatedCostUsd !== null && row.estimatedCostUsd >= 0), costBound: proof.queries.reduce((sum, row) => sum + (row.estimatedCostUsd ?? Infinity), 0) <= costLimit,
    }
    if (mixedAuto) {
      const childWorking = working.filter(row => row.actor > 0)
      const childStart = Math.min(...childWorking.map(row => row.requestStartedMs)), childEnd = Math.max(...childWorking.map(row => row.responseBodyTerminalMs))
      const classifierQueries = proof.queries.filter(row => row.role === 'classifier'), workingSessions = new Set(proof.queries.filter(row => row.role === 'working').map(row => row.session))
      proof.requestModelWitness = modelWitness.summary()
      proof.mixedAutoFacts = { classifiers: classifiers.length, classifierActors: [...new Set(classifiers.map(row => row.actor))].sort((a, b) => a - b), workingRequests: working.length,
        turnOneClassifiers: classifiers.filter(row => row.turn === 1).length, turnTwoClassifiers: classifiers.filter(row => row.turn === 2).length,
        duringChildWorkflow: classifiers.filter(row => row.turn === 1 && row.requestStartedMs >= childStart && row.requestStartedMs <= childEnd).length,
        completedOutsideWrites: mixedCommands.stamps.filter(file => { try { const row = lstatSync(file); return row.isFile() && !row.isSymbolicLink() && row.uid === process.getuid() && row.nlink === 1 && row.size > 0 && row.size < 256 } catch { return false } }).length }
      Object.assign(proof.checks, {
        genuineClassifiers: classifiers.length > 0 && classifiers.every(row => row.classifier && row.systemEnvelope),
        mixedClassifierCoverage: proof.mixedAutoFacts.duringChildWorkflow > 0 && proof.mixedAutoFacts.turnTwoClassifiers > 0,
        classifierIsolation: classifiers.length > 0 && classifiers.every(row => decision(row).length === 1 && decision(row)[0].auxiliary) && working.every(row => decision(row).length === 1 && !decision(row)[0].auxiliary),
        classifierNoWorkingLeaseWait: classifiers.length > 0 && classifiers.every(row => decision(row).length === 1 && decision(row)[0].sessionWaitMs === 0),
        independentClassifierSessions: allQueriesCorrelated && classifierQueries.length === classifiers.length && classifierQueries.every(row => !row.resumed && !row.forked && row.session !== undefined && !workingSessions.has(row.session)) && new Set(classifierQueries.map(row => row.session)).size === classifierQueries.length,
        exactRequestModelOwnership: proof.requestModelWitness.capturedRequests === wire.length && !proof.requestModelWitness.missingContext && !proof.requestModelWitness.duplicateContext && !proof.requestModelWitness.otherLoggerStore,
        outsideWritesAndParentReceipt: proof.mixedAutoFacts.completedOutsideWrites === 5 && mixedParentWorked,
      })
      if (mixedHandback) proof.checks.nativeHandbackReports = nativeHandbacks
    }
    if (background) proof.checks.backgroundParentChildOverlap = peakParentChild >= 2
    if (readBackground) proof.checks.backgroundReadCapabilities = wire.every(row => row.clientToolCapabilities.catalogValid && row.clientToolCapabilities.read && !row.clientToolCapabilities.taskOutput) && proof.queries.every(row => !row.nativeInitCapabilitiesOverflow && row.nativeInitToolCapabilities.length > 0 && row.nativeInitToolCapabilities.every(catalog => catalog.catalogValid && catalog.clientMcpRead && !catalog.clientMcpTaskOutput && !catalog.taskOutput))
    const defects = new Set(['distinctSessionMappings', 'subagentResume', 'mainResume', 'noCollision'])
    if (mixedAuto) defects.add('classifierIsolation')
    if (args['require-mcp-readiness']) proof.checks.nativeMcpReadiness = proof.queries.some(row => row.mcpReadiness?.declaredServers.length > 0) && proof.queries.every(row => row.mcpReadiness?.ready === true)
    for (const [name, actual] of Object.entries(proof.checks)) {
      if (args['expect-unfixed'] && name === 'boundedLeaseWait') continue // Measure the baseline wait; fix remains bounded.
      assert(actual === !(args['expect-unfixed'] && defects.has(name)), `Affected-flow assertion failed: ${name}`)
    }
    proof.result = args['expect-unfixed'] ? 'EXPECTED_BASELINE_FAILURE' : 'PASS'
  }
  proof.targetIdentityUnchanged = inputs.every(unchanged)
  if (args['source-head']) {
    const head = spawnSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }), clean = spawnSync('git', ['-C', target, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 })
    proof.targetIdentityUnchanged &&= head.status === 0 && head.stdout.trim() === args['source-head'] && clean.status === 0 && !clean.stdout.trim()
  }
  assert(proof.targetIdentityUnchanged, 'Target client/SDK/proxy identity changed')
} catch (error) {
  failure = error; proof.result = 'FAIL'
  proof.failureType = /^[A-Za-z]+$/.test(error?.name) ? error.name : 'Error'
  proof.failureCode = /^[A-Z0-9_]+$/.test(error?.code) ? error.code : undefined
  proof.failure = error?.name === 'AssertionError' ? String(error.message).split('\n')[0].replace(/\b[A-Za-z]:\\\S+|\/\S+/g, '[redacted-path]') : 'Harness operation failed (details suppressed)'
} finally {
  const cleanup = []
  clearTimeout(deadline); clearInterval(census); stop.abort(new Error('E72 cleanup'))
  if (proof.sdkAbortSignalFailed || proof.sdkAbortCloseFailed) cleanup.push('SDK abort failure')
  for (const query of active) { try { query.close() } catch { cleanup.push('SDK query close') } }
  for (const child of children) { try { signalGroup(child, 'SIGKILL') } catch { cleanup.push('client signal') } }
  try {
    await bounded(Promise.all(clientOwners.map(owner => owner.joined)), 5000, 'Owned client physical join deadline exceeded')
    for (const child of children) if (childOwners.get(child)?.isJoined()) children.delete(child)
  } catch { cleanup.push('client physical join') }
  proof.clientProcesses = clientOwners.map(owner => owner.snapshot())
  if (proof.clientProcesses.some(owner => owner.signalFailures > 0)) cleanup.push('client signal')
  try { relay?.stop(true) } catch { cleanup.push('relay close') }
  try { await bounded(relayWork.join(), 3000, 'Relay operation cleanup did not join'); proof.relayOperationsJoined = relayWork.pendingCount() === 0; if (!proof.relayOperationsJoined) cleanup.push('relay operation join') } catch { cleanup.push('relay operation join') }
  try { await bounded(Promise.all([...pendingHttp]), 3000, 'HTTP receipt cleanup did not join'); if (pendingHttp.size) cleanup.push('HTTP receipt join') } catch { cleanup.push('HTTP receipt join') }
  try { if (startup && !startupSettled) await bounded(startup, 3000, 'Proxy startup did not join') } catch { cleanup.push('proxy startup join') }
  try { if (proxy) await bounded(proxy.close(), 10000, 'Proxy cleanup deadline exceeded'); proxyJoined = !startup || startupSettled } catch { cleanup.push('proxy close/join') }
  try {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const [pid, row] of ownedProcesses()) { if (ownedProcesses().get(pid)?.start !== row.start) continue; try { process.kill(pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
      for (let i = 0; i < 20 && ownedProcesses().size; i++) await Bun.sleep(50)
      if (!ownedProcesses().size) break
    }
    proof.ownedResidualProcesses = ownedProcesses().size
    if (proof.ownedResidualProcesses || children.size || active.size) cleanup.push('unjoined owned work')
  } catch { cleanup.push('owned process join') }
  if (modelWitness) {
    proof.requestModelWitness = modelWitness.summary()
    try {
      assert(proxyJoined && (!startup || startupSettled) && active.size === 0 && children.size === 0 && proof.ownedResidualProcesses === 0 && relayWork.pendingCount() === 0 && pendingHttp.size === 0 && !proof.processCensusFailed, 'Logger context restoration requires all owned work to join')
      modelWitness.restore()
    } catch { cleanup.push('logger context restoration') }
    proof.loggerContextDescriptorRestored = modelWitness.isRestored()
  }
  try { observer?.mockRestore() } catch { cleanup.push('SDK observer restore') }
  try { proof.targetIdentityUnchanged = inputs.length > 0 && inputs.every(unchanged); if (inputs.length && !proof.targetIdentityUnchanged) cleanup.push('target identity invariance') } catch { cleanup.push('target identity invariance') }
  try { proof.ownerGrantUnchanged = source ? unchanged(source) : null; if (source && !proof.ownerGrantUnchanged) cleanup.push('owner grant invariance') } catch { cleanup.push('owner grant invariance') }
  try { proof.runtimeGrantUnchanged = runtimeGrant ? unchanged(runtimeGrant) : null; if (runtimeGrant && !proof.runtimeGrantUnchanged) cleanup.push('runtime grant invariance') } catch { cleanup.push('runtime grant invariance') }
  try {
    // Failed join/census never confers permission to remove a live child's
    // account/workdir. Retain its private fixture and keep acceptance closed.
    if (scratch && cleanup.length === 0 && !proof.processCensusFailed) rmSync(scratch, { recursive: true, force: true })
    proof.privateRuntimeRemoved = !scratch || !existsSync(scratch)
    proof.privateRuntimeRetained = !proof.privateRuntimeRemoved
    if (!proof.privateRuntimeRemoved) cleanup.push('private runtime retained after cleanup failure')
  } catch { cleanup.push('private runtime removal') }
  proof.cleanupFailures = cleanup; proof.suppressedLogLines = suppressed
  if (cleanup.length) proof.result = 'FAIL'
  proof.acceptance = !synthetic && !rehearsal && !args['expect-unfixed'] && proof.result === 'PASS'
  for (const key of Object.keys(saved)) console[key] = saved[key]
  try { verifyProofDescriptor(proofDescriptor); writeFileSync(proofDescriptor, JSON.stringify(proof, null, 2)) }
  finally { closeSync(proofDescriptor) }
  publicLog(JSON.stringify({ kind: proof.kind, result: proof.result, acceptance: proof.acceptance, sdkQueries: proof.queries.length, ownerGrantUnchanged: proof.ownerGrantUnchanged, privateRuntimeRemoved: proof.privateRuntimeRemoved, cleanupFailures: cleanup.length }))
}
process.exit(failure || proof.cleanupFailures.length ? 1 : 0)
