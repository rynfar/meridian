#!/usr/bin/env bun
// E71: identical native auto-mode flow and assertions on baseline and fix.
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
import { AsyncLocalStorage } from 'node:async_hooks'

// Observe the existing private logger context rather than adding a product
// field or inferring ownership from query timing. Imported controls exercise
// this exact factory against both the source and certified compiled server.
export function createRequestModelWitness(requests) {
  const prototype = AsyncLocalStorage.prototype
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'run')
  assert(typeof descriptor?.value === 'function', 'Logger context run descriptor unavailable')
  const original = descriptor.value, shadow = new AsyncLocalStorage(), owners = new Set()
  let loggerStore, restored = false, missingContext = false, duplicateContext = false, otherLoggerStore = false
  const wrapper = function (store, callback, ...parameters) {
    const shaped = store && typeof store === 'object' && store.endpoint === '/v1/messages' && typeof store.requestId === 'string'
    if (this === shadow) return Reflect.apply(original, this, [store, callback, ...parameters])
    if (loggerStore && this !== loggerStore) {
      if (shaped && requests.has(store.requestId)) otherLoggerStore = true
      return Reflect.apply(original, this, [store, callback, ...parameters])
    }
    if (!shaped && this !== loggerStore) return Reflect.apply(original, this, [store, callback, ...parameters])
    // Any nested run on the pinned logger must replace the private witness;
    // malformed/unknown contexts cannot borrow an outer owned request.
    const metadata = shaped ? requests.get(store.requestId) : undefined
    if (metadata && !loggerStore) loggerStore = this
    if (metadata && this !== loggerStore) otherLoggerStore = true
    const witness = metadata && this === loggerStore ? { requestId: store.requestId, metadata } : undefined
    return Reflect.apply(original, shadow, [witness, () => Reflect.apply(original, this, [store, callback, ...parameters])])
  }
  Object.defineProperty(prototype, 'run', { ...descriptor, value: wrapper })
  return {
    capture() {
      const context = shadow.getStore()
      if (!context || requests.get(context.requestId) !== context.metadata || otherLoggerStore) { missingContext = true; assert(false, 'SDK query lacks an exact owned logger request context') }
      if (owners.has(context.requestId)) { duplicateContext = true; assert(false, 'SDK retry is outside the one-query-per-wire benchmark') }
      owners.add(context.requestId)
      return context.metadata
    },
    summary() { return { capturedRequests: owners.size, missingContext, duplicateContext, otherLoggerStore } },
    isRestored() { return restored },
    restore() {
      if (restored) return
      const current = Object.getOwnPropertyDescriptor(prototype, 'run')
      const intact = current && Reflect.ownKeys(current).length === Reflect.ownKeys(descriptor).length && Object.entries(descriptor).every(([key, value]) => current[key] === (key === 'value' ? wrapper : value))
      // Joined work permits restoring our original descriptor even if a
      // restorable drift is a verification failure. Never leave it installed
      // merely because the pre-restore comparison failed.
      Object.defineProperty(prototype, 'run', descriptor)
      const after = Object.getOwnPropertyDescriptor(prototype, 'run')
      assert(after && Reflect.ownKeys(after).length === Reflect.ownKeys(descriptor).length && Object.entries(descriptor).every(([key, value]) => after[key] === value), 'Logger context descriptor restoration incomplete')
      shadow.disable(); restored = true
      assert(intact, 'Logger context descriptor changed before restoration')
    },
  }
}

// Own one actual detached client handle. Birth identity is immutable; exit
// retires signaling before stdio joins. A signal call never establishes a join.
export function createOwnedClientProcess(child, sendSignal = process.kill.bind(process)) {
  const facts = { spawned: false, spawnError: false, exit: false, close: false,
    stdoutEnd: !child.stdout, stdoutClose: !child.stdout,
    stderrEnd: !child.stderr, stderrClose: !child.stderr,
    signalAttempts: 0, signalFailures: 0, signals: [] }
  let birthPid, resolveJoin
  const joined = new Promise(resolve => { resolveJoin = resolve })
  const isJoined = () => (facts.exit || facts.spawnError && !facts.spawned) && facts.close
    && facts.stdoutEnd && facts.stdoutClose && facts.stderrEnd && facts.stderrClose
  const check = () => { if (isJoined()) resolveJoin() }
  child.once('spawn', () => { birthPid = child.pid; facts.spawned = true })
  child.once('error', () => { facts.spawnError = true; check() })
  child.once('exit', () => { facts.exit = true; check() })
  child.once('close', () => { facts.close = true; check() })
  for (const name of ['stdout', 'stderr']) if (child[name]) {
    child[name].once('end', () => { facts[`${name}End`] = true; check() })
    child[name].once('close', () => { facts[`${name}Close`] = true; check() })
  }
  return {
    joined, isJoined,
    signal(signal) {
      if (!facts.spawned || facts.exit || facts.close) return 'RETIRED_OR_NOT_STARTED'
      const observation = { signal, result: 'FAILED' }
      // A missing/invalid birth PID confers no group authority.
      if (!Number.isSafeInteger(birthPid) || birthPid <= 1) observation.code = 'INVALID_BIRTH_PID'
      else {
        try { sendSignal(-birthPid, signal); observation.result = 'SENT' }
        catch (error) {
          observation.code = /^[A-Z0-9_]{1,48}$/.test(error?.code) ? error.code : 'UNKNOWN_SIGNAL_ERROR'
          if (error?.code === 'ESRCH') observation.result = 'NOT_FOUND'
        }
      }
      facts.signalAttempts++
      if (observation.result === 'FAILED') facts.signalFailures++
      if (facts.signals.length < 16) facts.signals.push(observation)
      return observation.result
    },
    snapshot() {
      return { ...facts, signals: facts.signals.map(value => ({ ...value })), join: isJoined() ? 'JOINED' : 'UNKNOWN' }
    },
  }
}

// Importing the factories performs no environment, config, auth, SDK or I/O work.
if (import.meta.main) {

const switches = new Set(['expect-unfixed', 'rehearsal', 'fail-after-copy', 'synthetic'])
const names = new Set(['target-root', 'entry', 'source-head', 'client', 'client-version', 'native-cli', 'native-cli-version', 'sdk-version', 'model', 'served-model', 'classifier-model', 'classifier-served-model', 'grant-file', 'proof-dir', 'max-queries', 'max-cost-usd', 'timeout-ms'])
const args = {}
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '')
  assert(process.argv[i].startsWith('--') && (switches.has(key) || names.has(key)) && !(key in args), 'Unknown or repeated harness option')
  args[key] = switches.has(key) ? true : process.argv[++i]
}
for (const key of names) if (key !== 'source-head') assert(typeof args[key] === 'string' && args[key].length > 0, `Missing --${key}`)
const synthetic = args.synthetic === true, rehearsal = args.rehearsal === true
assert(synthetic || (process.platform === 'linux' && process.arch === 'x64'), 'Native E71 acceptance requires Linux x64')
assert(/^claude-sonnet-[0-9][a-z0-9.-]*$/.test(args.model) && /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(args['served-model']), 'Explicit implicated requested and served Sonnet IDs required')
assert(/^claude-sonnet-[0-9][a-z0-9.-]*$/.test(args['classifier-served-model']) && [args.model, 'claude-sonnet-5'].includes(args['classifier-model']), 'Pin one audited classifier arm: Sonnet5 default or the requested main fallback, and its explicit served model')
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
const proofDescriptor = openSync(join(output, 'claude-auto-mode-results.json'), 'wx', 0o600)
try { verifyProofDescriptor(proofDescriptor) }
catch (error) { closeSync(proofDescriptor); throw error }
const proof = { kind: synthetic ? 'synthetic-harness-control' : rehearsal ? 'zero-query-rehearsal' : 'native-affected-flow', expected: args['expect-unfixed'] ? 'unfixed' : 'fixed', platform: `${process.platform}/${process.arch}`, runtime: { bun: Bun.version, node: process.version }, requestedModel: args.model, requiredServedModel: args['served-model'], requestedClassifierModel: args['classifier-model'], requiredServedClassifierModel: args['classifier-served-model'], classifierSelectorGate: 'Actual client feature config, policy, entitlement and probe/demotion selection remain native gates; this run accepts only its single explicit classifier arm. Internal SDK retries producing multiple queries for one wire request fail this owned benchmark; existing query/cost/deadline limits remain enforced.', limits: { queries: maximum, sdkEstimatedCostUsd: costLimit, perQueryBudgetUsd: costLimit / maximum, totalMilliseconds: timeout }, queries: [], turns: [], checks: {}, result: 'INCOMPLETE', acceptance: false }
const saved = { log: console.log, error: console.error, warn: console.warn, debug: console.debug }
const publicLog = saved.log.bind(console), records = [], traceIds = new Map(), requestModels = new Map()
let turn = 0, suppressed = 0
for (const key of Object.keys(saved)) console[key] = (...values) => {
  suppressed++
  const line = values.map(String).join(' ')
  if (!line.includes('adapter=claude-code') || !line.includes('msgCount=')) return
  const request = traceIds.get(/\[PROXY\] ([a-z0-9-]+) /.exec(line)?.[1])
  if (!request) return
  const word = name => new RegExp(`(?:^| )${name}=([a-z0-9:.-]+)(?: |$)`).exec(line)?.[1]
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
const sdkTools = new Map(), sdkToolOwners = new Map(), httpTools = new Map(), pendingHttp = new Set()
const relayHandlers = new Set()
let scratch, proxy, relay, observer, source, runtimeGrant, deadline, census, failure, startup, modelWitness
let startupSettled = false
let relayAdmissionClosed = false
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
const objectInput = value => value && typeof value === 'object' && !Array.isArray(value)
function nativeSystemEnvelope(text) {
  if (!text.trimStart().startsWith('You are a security monitor for autonomous AI coding agents.')) return false
  let opened = false
  for (const line of text.split('\n')) {
    if (line === '<cc_automode_permissions>') opened = true
    if (opened && line === '</cc_automode_permissions>') return true
  }
  return false
}
function inputIdentity(value) {
  if (Array.isArray(value)) return value.map(inputIdentity)
  if (objectInput(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, inputIdentity(value[key])]))
  return value
}
function httpToolTerminal(status, contentType, text) {
  if (status !== 200) return
  const complete = []
  if (contentType.includes('text/event-stream')) {
    const blocks = new Map(); let started = false, terminal = false, stopped = false
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
      }
      if (event.type === 'content_block_stop') {
        const block = blocks.get(event.index)
        if (terminal || !block || block.closed) return
        block.closed = true
      }
      if (event.type === 'message_delta') {
        if (terminal) return
        if (event.delta?.stop_reason != null) {
          if (event.delta.stop_reason !== 'tool_use' || !blocks.size || [...blocks.values()].some(block => !block.closed)) return
          terminal = true
        }
      }
      if (event.type === 'message_stop') {
        if (!terminal || !blocks.size || [...blocks.values()].some(block => !block.closed)) return
        stopped = true
      }
    }
    if (!started || !terminal || !stopped) return
    for (const block of blocks.values()) if (block.type === 'tool_use') complete.push({ id: block.id, input: block.json ? JSON.parse(block.json) : block.input })
  } else {
    const body = JSON.parse(text)
    if (body.type !== 'message' || body.stop_reason !== 'tool_use' || !Array.isArray(body.content)) return
    complete.push(...body.content.filter(block => block.type === 'tool_use'))
  }
  if (!complete.length || complete.some(block => typeof block.id !== 'string' || !block.id.length || !objectInput(block.input))) return
  for (const block of complete) {
    if (httpTools.has(block.id)) proof.httpToolIdReused = true
    httpTools.set(block.id, JSON.stringify(inputIdentity(block.input)))
  }
}
try {
  deadline = setTimeout(() => stop.abort(new Error('E71 total deadline exceeded')), timeout)
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
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-e71-')))
  const account = join(scratch, 'runtime-account'), config = join(scratch, 'proxy-config'), clientConfig = join(scratch, 'client-config'), project = join(scratch, 'client-project'), outside = join(scratch, 'outside-project'), work = join(scratch, 'proxy-work')
  for (const directory of [account, config, clientConfig, project, outside, work, join(scratch, 'store'), join(scratch, 'proxy-home'), join(scratch, 'client-home'), join(scratch, 'unlinked-default'), join(scratch, 'plugins')]) mkdirSync(directory, { mode: 0o700 })
  // Do not give a native runtime refresh authority or the immutable source file.
  const { refreshToken: _removedRefresh, ...readOnlyGrant } = grant
  writeFileSync(join(account, '.credentials.json'), JSON.stringify({ claudeAiOauth: readOnlyGrant }), { mode: 0o400, flag: 'wx' })
  runtimeGrant = snapshot(join(account, '.credentials.json'), true)
  proof.privateSnapshotCreated = true
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ routing: 'active', updateCheck: false }), { mode: 0o600 })
  writeFileSync(join(config, 'profiles.json'), '[]', { mode: 0o600 })
  writeFileSync(join(scratch, 'plugins.json'), '{"plugins":[]}', { mode: 0o600 })
  writeFileSync(join(project, 'README.md'), 'Owned synthetic E71 project.\n', { mode: 0o600 })
  if (args['fail-after-copy']) throw new Error('Injected post-copy failure')
  for (const key of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC|MERIDIAN|CLAUDE_PROXY|OPENAI|AWS_|GOOGLE_|VERTEX_|BEDROCK_|NODE_OPTIONS|BUN_OPTIONS|OPENCODE_)/.test(key)) delete process.env[key]
  Object.assign(process.env, { HOME: join(scratch, 'proxy-home'), CLAUDE_CONFIG_DIR: join(scratch, 'unlinked-default'), MERIDIAN_CONFIG_DIR: config, MERIDIAN_SESSION_DIR: join(scratch, 'store'), MERIDIAN_WORKDIR: work, MERIDIAN_CLAUDE_PATH: native, MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_ROUTING: 'active', MERIDIAN_PASSTHROUGH: '1', MERIDIAN_MAX_CONCURRENT: '4', MERIDIAN_SHUTDOWN_GRACE_MS: '2000' })
  proof.sdkCapacity = 4
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) { const directory = join(scratch, `proxy-xdg-${kind.toLowerCase()}`); mkdirSync(directory, { mode: 0o700 }); process.env[`XDG_${kind}_HOME`] = directory }
  const clientEnv = { ...process.env }
  for (const key of Object.keys(clientEnv)) if (/^(CLAUDE|ANTHROPIC|MERIDIAN|CLAUDE_PROXY|OPENAI)/.test(key)) delete clientEnv[key]
  Object.assign(clientEnv, { HOME: join(scratch, 'client-home'), CLAUDE_CONFIG_DIR: clientConfig, ANTHROPIC_AUTH_TOKEN: 'meridian-e71-local-dummy', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) { const directory = join(scratch, `client-xdg-${kind.toLowerCase()}`); mkdirSync(directory, { mode: 0o700 }); clientEnv[`XDG_${kind}_HOME`] = directory }
  for (const [file, expected, env] of [[client, args['client-version'], clientEnv], [native, args['native-cli-version'], process.env]]) {
    const result = await childRun(file, ['--version'], env, work, 10000)
    assert(result.status === 0 && result.out.trim() === `${expected} (Claude Code)`, 'Explicit client/native version mismatch')
  }
  proof.identity.clientVersion = args['client-version']; proof.identity.nativeCliVersion = args['native-cli-version']
  if (!synthetic && !rehearsal) {
    const ready = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: `Bearer ${grant.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(10000)]) })
    proof.readinessStatus = ready.status; await ready.body?.cancel(); assert(ready.ok, 'Owned grant readiness failed; no generation started')
  }
  const sdk = await import(pathToFileURL(sdkPath).href), original = sdk.query
  modelWitness = createRequestModelWitness(requestModels)
  observer = spyOn(sdk, 'query').mockImplementation(input => {
    assert(!rehearsal, 'Rehearsal fenced SDK generation')
    assert(!stop.signal.aborted && proof.queries.length < maximum, 'Generation count/deadline bound reached')
    assert(input.options.env?.CLAUDE_CONFIG_DIR === account && input.options.pathToClaudeCodeExecutable === native, 'SDK escaped explicit account/executable')
    assert(!input.options.env?.ANTHROPIC_API_KEY && !input.options.env?.ANTHROPIC_BASE_URL && !input.options.env?.CLAUDE_CODE_OAUTH_TOKEN, 'SDK inherited another authentication/provider override')
    const owned = modelWitness.capture()
    const row = { turn: owned.turn, request: owned.request, role: owned.role, wireRequested: owned.requestedModel, requested: /^[a-z0-9[\].-]+$/.test(input.options.model) ? input.options.model : 'invalid-requested-model', versionPin: input.options.env?.ANTHROPIC_DEFAULT_SONNET_MODEL === undefined ? undefined : /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(input.options.env.ANTHROPIC_DEFAULT_SONNET_MODEL) ? input.options.env.ANTHROPIC_DEFAULT_SONNET_MODEL : 'invalid-version-pin', resumed: typeof input.options.resume === 'string', maxTurns: input.options.maxTurns, nativeModels: [], completed: false, assistantError: false, resultFlagValid: false, resultIsError: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: null }
    const tools = new Map(); sdkTools.set(row, tools)
    proof.queries.push(row)
    const query = original({ ...input, options: { ...input.options, maxBudgetUsd: costLimit / maximum } }); active.add(query)
    const abort = () => { input.options.abortController?.abort(new Error('E71 execution bound')); query.close() }
    stop.signal.addEventListener('abort', abort, { once: true })
    return new Proxy(query, { get(targetQuery, key) {
      if (key === Symbol.asyncIterator) return async function* () {
        try {
          for await (const event of query) {
            const model = event.type === 'assistant' ? event.message?.model : event.type === 'stream_event' && event.event?.type === 'message_start' ? event.event.message?.model : undefined
            if (typeof model === 'string' && !row.nativeModels.includes(model)) row.nativeModels.push(/^claude-[a-z0-9.-]+$/.test(model) ? model : 'invalid-native-model')
            if (event.type === 'assistant') {
              row.assistantError ||= Boolean(event.error)
              const usage = event.message?.usage
              if (usage) { row.inputTokens = Math.max(row.inputTokens, (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)); row.outputTokens = Math.max(row.outputTokens, usage.output_tokens ?? 0) }
              for (const block of event.message?.content ?? []) if (block.type === 'tool_use' && typeof block.id === 'string' && objectInput(block.input)) {
                if (sdkToolOwners.has(block.id) && sdkToolOwners.get(block.id) !== row) proof.sdkToolIdReused = true
                sdkToolOwners.set(block.id, row)
                tools.set(block.id, JSON.stringify(inputIdentity(block.input)))
              }
            }
            if (event.type === 'result') {
              row.completed = true; row.resultSubtype = ['success', 'error_max_turns'].includes(event.subtype) ? event.subtype : 'other'
              row.resultFlagValid = typeof event.is_error === 'boolean'
              row.resultIsError = row.resultFlagValid ? event.is_error : null; row.nativeTurns = event.num_turns
              row.terminalReason = event.terminal_reason === undefined ? 'absent' : event.terminal_reason === 'max_turns' ? 'max_turns' : 'other'
              row.estimatedCostUsd = Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : null
            }
            yield event
          }
        } finally { row.iteratorSettled = true; stop.signal.removeEventListener('abort', abort); active.delete(query) }
      }
      const value = Reflect.get(targetQuery, key, targetQuery); return typeof value === 'function' ? value.bind(targetQuery) : value
    } })
  })
  census = setInterval(() => { try { ownedProcesses() } catch { proof.processCensusFailed = true; stop.abort(new Error('Owned process census failed')) } }, 100)
  const { startProxyServer } = await import(pathToFileURL(entry).href)
  startup = startProxyServer({ port: 0, host: '127.0.0.1', silent: false, profiles: [{ id: 'e71-owned', type: 'claude-max', claudeConfigDir: account }], defaultProfile: 'e71-owned', pluginDir: join(scratch, 'plugins'), pluginConfigPath: join(scratch, 'plugins.json') }).then(value => { proxy = value; return value }).finally(() => { startupSettled = true })
  proxy = await duringRun(startup, 15000, 'Proxy startup deadline exceeded')
  if (!proxy.server.listening) await duringRun(once(proxy.server, 'listening'), 5000, 'Proxy listen deadline exceeded')
  const address = proxy.server.address(); assert(address && typeof address === 'object', 'Proxy did not bind loopback')
  if (rehearsal) { assert(proof.queries.length === 0, 'Rehearsal queried SDK'); proof.result = 'REHEARSAL' }
  else {
    const wire = []
    const session = randomUUID(), words = ['ONE', 'TWO', 'THREE', 'FOUR']
    relay = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 255, fetch(request) {
      if (relayAdmissionClosed) return new Response('Owned relay admission closed', { status: 503 })
      const operation = (async () => {
      const url = new URL(request.url), text = ['GET', 'HEAD'].includes(request.method) ? undefined : await requestBody(request, 2 * 1024 * 1024)
      const headers = new Headers(request.headers)
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
      assert(wire.length < maximum, 'Client request count bound reached')
      const requestId = `e71-${randomUUID()}`, requestNumber = wire.length + 1
      headers.set('x-request-id', requestId); traceIds.set(requestId, requestNumber)
      const body = JSON.parse(text), rawClass = request.headers.get('x-claude-code-request-class') ?? 'none'
      let identity = body.metadata?.user_id
      if (typeof identity === 'string') { try { identity = JSON.parse(identity) } catch { identity = undefined } }
      const sessionKeyMatched = identity?.session_id === session
      const system = typeof body.system === 'string' ? [body.system] : Array.isArray(body.system) ? body.system.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text) : []
      const systemEnvelope = system.some(nativeSystemEnvelope)
      const stopsValid = body.stop_sequences === undefined || (Array.isArray(body.stop_sequences) && body.stop_sequences.length === 1 && body.stop_sequences.every(value => value === '</block>' || value === '</severity>'))
      const classifier = sessionKeyMatched && systemEnvelope && (body.stream === undefined || body.stream === false) && (body.tools === undefined || (Array.isArray(body.tools) && !body.tools.length)) && stopsValid
      const role = classifier || rawClass === 'auxiliary' ? 'classifier' : 'main'
      const row = { request: requestNumber, turn, role, requestedModel: /^claude-sonnet-[0-9][a-z0-9.-]*$/.test(body.model) ? body.model : 'invalid-wire-model', requestedModelMatched: body.model === (role === 'classifier' ? args['classifier-model'] : args.model), requestClass: ['none', 'main', 'auxiliary', 'compaction', 'subagent', 'workflow'].includes(rawClass) ? rawClass : 'other', systemEnvelope, sessionKeyMatched, streamDeclared: body.stream === undefined ? 'omitted' : typeof body.stream === 'boolean' ? body.stream : 'invalid', stopsDeclared: body.stop_sequences !== undefined, classifier, tools: Array.isArray(body.tools) ? body.tools.length : 0 }
      requestModels.set(requestId, row); wire.push(row)
      }
      const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, { method: request.method, headers, body: text, signal: AbortSignal.any([request.signal, stop.signal]), decompress: false })
      if (request.method === 'POST' && url.pathname === '/v1/messages') {
        // Snapshot metadata before Bun hands the original response to its
        // server; that transfer can consume its response headers.
        const status = response.status, contentType = response.headers.get('content-type') ?? ''
        const receipt = requestBody(response.clone(), 2 * 1024 * 1024).then(body => httpToolTerminal(status, contentType, body)).catch(error => { proof.httpReceiptFailure = true; proof.httpReceiptFailureType = ['SyntaxError', 'TypeError', 'AssertionError', 'Error'].includes(error?.name) ? error.name : 'other' })
        pendingHttp.add(receipt); receipt.finally(() => pendingHttp.delete(receipt))
      }
      return response
      })()
      relayHandlers.add(operation)
      return operation.finally(() => relayHandlers.delete(operation))
    } })
    for (turn = 1; turn <= 4; turn++) {
      const word = words[turn - 1], prompt = turn === 3 ? `Reply with exactly the word ${word}.` : `Run the shell command \`date > ${outside}/stamp${turn}.txt\`, then reply with exactly the word ${word}.`
      const command = [turn === 1 ? '--session-id' : '--resume', session, '-p', prompt, '--model', args.model, '--permission-mode', 'auto']
      const result = await childRun(client, command, { ...clientEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${relay.port}`, ...(turn === 4 ? { CLAUDE_CODE_GATEWAY_HINT_HEADERS: '1' } : {}) }, project, Math.min(timeout, 300000))
      const stamp = join(outside, `stamp${turn}.txt`)
      proof.turns.push({ number: turn, status: result.status, answered: new RegExp(`\\b${word}\\b`).test(result.out), outsideWrite: turn === 3 || (existsSync(stamp) && statSync(stamp).isFile() && statSync(stamp).size > 0 && statSync(stamp).size < 256), refused: /API Error: [45][0-9][0-9]/.test(`${result.out}\n${result.err}`) })
      assert(!stop.signal.aborted, 'Execution deadline/output bound reached')
    }
    await duringRun(Promise.all([...pendingHttp]), 30000, 'HTTP terminal receipts failed to settle')
    proof.completedHttpToolTerminals = httpTools.size
    for (const row of proof.queries) {
      const tools = sdkTools.get(row)
      row.canonicalHttpToolTerminal = tools.size > 0 && [...tools].every(([id, input]) => httpTools.get(id) === input) && [...tools.values()].some(input => input.includes(`${outside}/stamp${row.turn}.txt`))
      row.acceptedCanonicalResult = row.resultFlagValid && ((row.resultSubtype === 'success' && row.resultIsError === false) || (row.resultSubtype === 'error_max_turns' && row.resultIsError === true && row.maxTurns === 1 && row.nativeTurns === 1 && ['absent', 'max_turns'].includes(row.terminalReason) && row.canonicalHttpToolTerminal))
    }
    proof.wire = wire; proof.lineage = records
    const classifiers = wire.filter(row => row.classifier || row.requestClass === 'auxiliary'), shape = classifiers.filter(row => row.turn < 4), labelled = wire.filter(row => row.turn === 4 && row.requestClass === 'auxiliary'), mains = records.filter(row => row.tools > 0 && !row.auxiliary)
    const decision = row => records.filter(record => record.request === row.request)
    const isolated = row => decision(row).length === 1 && decision(row)[0].auxiliary === true && decision(row)[0].lineage === 'diverged'
    proof.checks = {
      invocationsSucceeded: proof.turns.every(row => row.status === 0), turnsAnswered: proof.turns.every(row => row.answered), outsideToolWrites: proof.turns.every(row => row.outsideWrite), noRefusal: proof.turns.every(row => !row.refused), classifierOccurred: shape.length > 0 && labelled.length > 0 && classifiers.every(row => row.sessionKeyMatched),
      shapeHeadersAbsent: wire.filter(row => row.turn < 4).every(row => row.requestClass === 'none'), headerPathPresent: wire.some(row => row.turn === 4) && wire.filter(row => row.turn === 4).every(row => row.requestClass !== 'none'),
      wireRequestedModel: wire.length > 0 && wire.every(row => row.requestedModelMatched), requestDecisionsComplete: wire.length > 0 && wire.every(row => decision(row).length === 1),
      shapeIsolation: shape.length > 0 && shape.every(isolated), headerIsolation: labelled.length > 0 && labelled.every(isolated),
      nonAuxiliaryPreserved: wire.filter(row => !row.classifier && row.requestClass !== 'auxiliary').every(row => decision(row).length === 1 && !decision(row)[0].auxiliary),
      auxiliaryZeroLeaseWait: classifiers.every(row => decision(row).length === 1 && decision(row)[0].sessionWaitMs === 0),
      mainResume: mains.length > 1 && mains.slice(1).every(row => row.lineage === 'continuation'), noCollision: !records.some(row => ['unrelated-history', 'concurrent-race'].includes(row.divergence)),
      requestModelOwnership: proof.queries.length === wire.length && wire.length > 0 && wire.every(row => proof.queries.filter(query => query.request === row.request && query.role === row.role && query.wireRequested === row.requestedModel).length === 1) && Object.entries(modelWitness.summary()).every(([key, value]) => key === 'capturedRequests' ? value === wire.length : value === false),
      nativeReceipts: !proof.httpReceiptFailure && !proof.sdkToolIdReused && !proof.httpToolIdReused && proof.queries.length > 0 && proof.queries.every(row => (row.requested === row.wireRequested || (row.requested === 'sonnet' && row.versionPin === row.wireRequested)) && row.completed && row.iteratorSettled && row.acceptedCanonicalResult && !row.assistantError && row.inputTokens > 0 && row.outputTokens > 0 && row.nativeModels.length > 0 && row.nativeModels.every(model => model === (row.role === 'classifier' ? args['classifier-served-model'] : args['served-model'])) && row.estimatedCostUsd !== null && row.estimatedCostUsd >= 0), costBound: proof.queries.reduce((sum, row) => sum + (row.estimatedCostUsd ?? Infinity), 0) <= costLimit,
    }
    const defects = new Set(['shapeIsolation', 'headerIsolation', 'mainResume', 'noCollision'])
    for (const [name, actual] of Object.entries(proof.checks)) {
      if (args['expect-unfixed'] && name === 'auxiliaryZeroLeaseWait') continue // Measured baseline wait; fixed MUST be zero.
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
  let proxyJoined = !proxy
  clearTimeout(deadline); clearInterval(census); stop.abort(new Error('E71 cleanup'))
  for (const query of active) { try { query.close() } catch { cleanup.push('SDK query close') } }
  for (const child of children) { try { signalGroup(child, 'SIGKILL') } catch { cleanup.push('client signal') } }
  try {
    await bounded(Promise.all(clientOwners.map(owner => owner.joined)), 5000, 'Owned client physical join deadline exceeded')
    for (const child of children) if (childOwners.get(child)?.isJoined()) children.delete(child)
  } catch { cleanup.push('client physical join') }
  proof.clientProcesses = clientOwners.map(owner => owner.snapshot())
  if (proof.clientProcesses.some(owner => owner.signalFailures > 0)) cleanup.push('client signal')
  relayAdmissionClosed = true
  try { relay?.stop(true) } catch { cleanup.push('relay close') }
  try { if (startup && !startupSettled) await bounded(startup, 3000, 'Proxy startup did not join') } catch { cleanup.push('proxy startup join') }
  try { if (proxy) { await bounded(proxy.close(), 10000, 'Proxy cleanup deadline exceeded'); proxyJoined = true } } catch { cleanup.push('proxy close/join') }
  // Close admission before taking the sets. A handler may still create its
  // cloned receipt while settling, so handlers join before receipt snapshots.
  proof.relayOperationsJoined = false; proof.httpReceiptsJoined = false
  proof.httpCleanupJoinMilliseconds = 3000
  try {
    await bounded(Promise.allSettled([...relayHandlers]), 3000, 'Relay handler cleanup join deadline exceeded')
    proof.relayOperationsJoined = relayHandlers.size === 0
    assert(proof.relayOperationsJoined, 'Relay handlers remained after cleanup join')
  } catch { cleanup.push('relay handler join') }
  try {
    await bounded(Promise.allSettled([...pendingHttp]), 3000, 'HTTP receipt cleanup join deadline exceeded')
    proof.httpReceiptsJoined = proof.relayOperationsJoined && pendingHttp.size === 0
    assert(proof.httpReceiptsJoined, 'HTTP receipts remained after cleanup join')
  } catch { cleanup.push('HTTP receipt join') }
  proof.pendingRelayHandlers = relayHandlers.size; proof.pendingHttpReceipts = pendingHttp.size
  try {
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const [pid, row] of ownedProcesses()) { if (ownedProcesses().get(pid)?.start !== row.start) continue; try { process.kill(pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error } }
      for (let i = 0; i < 20 && ownedProcesses().size; i++) await Bun.sleep(50)
      if (!ownedProcesses().size) break
    }
    proof.ownedResidualProcesses = ownedProcesses().size
    if (proof.ownedResidualProcesses || children.size || active.size) cleanup.push('unjoined owned work')
  } catch { cleanup.push('owned process join') }
  try { observer?.mockRestore() } catch { cleanup.push('SDK observer restore') }
  try {
    if (modelWitness) {
      proof.requestModelWitness = modelWitness.summary()
      const joined = proxyJoined && (!startup || startupSettled) && !active.size && !children.size && proof.ownedResidualProcesses === 0 && proof.relayOperationsJoined && proof.httpReceiptsJoined && !relayHandlers.size && !pendingHttp.size
      if (joined) { try { modelWitness.restore() } finally { proof.loggerContextDescriptorRestored = modelWitness.isRestored() } }
      else { proof.loggerContextDescriptorRestored = false; cleanup.push('logger context retained after unjoined work') }
    }
  } catch { cleanup.push('logger context restore') }
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
}
