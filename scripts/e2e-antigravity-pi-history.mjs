// Opt-in live subscription gate. The imported history is a public fixture,
// not model-generated history or proof of the unspecified reporter ACP client.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const values = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
const target = call => call.input.path ?? call.input.file_path ?? call.input.filePath

/** Published Pi 1.1.0 docs/session-format.md: v3 linked AgentMessage entries. */
export function historyFixture(project, model, receipt) {
  const seedPath = join(project, 'already-completed.txt'), outputPath = join(project, 'latest-target.txt')
  const large = 'fixture payload\n'.repeat(6667), longText = 'prior assistant detail '.repeat(10000)
  const messages = [], files = new Map(), fixtureIds = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  const assistant = content => ({ role: 'assistant', content, api: 'anthropic-messages', provider: 'meridian-agy', model, usage, stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 1 })
  const completed = (id, path, content) => {
    fixtureIds.push(id); files.set(path, content)
    messages.push(assistant([{ type: 'toolCall', id, name: 'write', arguments: { content, path } }]))
    messages.push({ role: 'toolResult', toolCallId: id, toolName: 'write', content: [{ type: 'text', text: `Successfully wrote ${content.length} bytes to ${path}` }], isError: false, timestamp: 1 })
  }
  messages.push({ role: 'user', content: 'The following old fixture work has already completed. Never repeat it.', timestamp: 1 })
  for (let index = 0; index < 40; index++) completed(`fixture-old-${index}`, join(project, `old-${index}.txt`), `old receipt ${index}\n`)
  const current = `Newest request: the first write of the large fixture payload to ${seedPath} is already completed in the following history. Do not repeat it or change any old file. The remaining action is to use your write tool exactly once to write ${JSON.stringify(receipt + '\n')} to ${outputPath}, then use read on that file to verify its bytes. Do not use any other tools or write another target. Do not claim success without the correlated tool results.`
  messages.push({ role: 'user', content: current, timestamp: 1 })
  messages.push(assistant([{ type: 'text', text: longText }]))
  completed('fixture-current-large', seedPath, large)
  let parentId = null
  const entries = [{ type: 'session', version: 3, id: randomUUID(), timestamp: new Date(1).toISOString(), cwd: project }]
  for (const message of messages) {
    const id = entries.length.toString(16).padStart(8, '0')
    entries.push({ type: 'message', id, parentId, timestamp: new Date(1).toISOString(), message }); parentId = id
  }
  return { entries, files, fixtureIds, current, seedPath, outputPath, large, longText, expected: receipt + '\n' }
}

/** Verify public fixture import without replacing or repairing the client's wire history. */
export function assertImportedHistory(body, fixture) {
  const history = values(body.messages)
  const typed = body.messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string' ? message.content : values([message]).filter(block => block.type === 'text').map(block => block.text).join('\n')).filter(text => text.trim())
  assert.equal(typed.at(-1), fixture.current, 'Imported newest typed request was replaced or omitted')
  assert(body.messages.some(message => values([message]).some(block => block.type === 'text' && block.text === fixture.longText)), 'Long assistant history was not imported intact')
  const largeCall = history.find(block => block.type === 'tool_use' && block.id === 'fixture-current-large')
  assert(largeCall, 'Missing imported content-first write')
  assert.deepEqual(Object.keys(largeCall.input), ['content', 'path']); assert.equal(largeCall.input.content, fixture.large); assert.equal(target(largeCall), fixture.seedPath)
  for (const id of fixture.fixtureIds) {
    assert.equal(history.filter(block => block.type === 'tool_use' && block.id === id).length, 1, `Missing/duplicate imported call ${id}`)
    assert.equal(history.filter(block => block.type === 'tool_result' && block.tool_use_id === id && !block.is_error).length, 1, `Missing/duplicate imported result ${id}`)
  }
}

/** Advisory projection only; actual tool targets/results and file bytes stay exact.
 * @param {string} rendered @param {unknown[]} messages @param {string} seedPath
 */
export function inspectRenderedHistory(rendered, messages, seedPath) {
  const prefix = rendered.slice(0, rendered.indexOf('Client conversation:\n'))
  const suffix = '[… truncated]'
  const projectedTarget = seedPath.length <= 80 ? seedPath : seedPath.slice(0, 80 - suffix.length) + suffix
  const currentCallField = '"type":"tool_use","id":"fixture-current-large","name":"write","target":' + JSON.stringify(projectedTarget)
  return { prefixChars: prefix.length, currentTargetInRecap: prefix.includes(currentCallField), targetPreviewChars: projectedTarget.length, targetPreviewTruncated: projectedTarget !== seedPath, advisoryPreviewOnly: true, fullHistoryExact: rendered.endsWith('Client conversation:\n' + JSON.stringify(messages)) }
}

/** A timeout remains unknown even if the original promise subsequently resolves.
 * @param {() => unknown} action
 * @returns {Promise<{outcome:string,value:unknown,error:string|undefined}>}
 */
export async function boundedCompletion(action, timeoutMs = 10000) {
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve({ outcome: 'UNKNOWN_TIMEOUT', value: undefined, error: 'Completion deadline exceeded' }), timeoutMs) })
  try {
    return await Promise.race([timeout, Promise.resolve().then(action).then(value => ({ outcome: 'RESOLVED', value, error: undefined }), error => ({ outcome: 'REJECTED', value: undefined, error: String(error) }))])
  } finally { clearTimeout(timer) }
}

/** One physical writer, immutable queued snapshots, and a terminal drain.
 * A timed-out write remains unknown: subsequent writes never overlap it.
 * @param {(snapshot:object) => Promise<void>} write
 */
export function serializedSnapshots(write, timeoutMs = 10000) {
  let queue = Promise.resolve(), sealed = false, failure, terminal
  /** @type {{sealed:boolean,submitted:number,completed:number,rejectedAfterSeal:number,failure:string|undefined}} */
  const state = { sealed: false, submitted: 0, completed: 0, rejectedAfterSeal: 0, failure: undefined }
  const enqueue = snapshot => {
    const captured = structuredClone(snapshot)
    state.submitted++
    const result = queue.then(async () => {
      if (failure) return { outcome: 'NOT_WRITTEN_AFTER_FAILURE', error: failure }
      const completion = await boundedCompletion(() => write(captured), timeoutMs)
      if (completion.outcome === 'RESOLVED') state.completed++
      else { failure = `Artifact write ${completion.outcome}: ${completion.error}`; state.failure = failure }
      return completion
    })
    queue = result.then(() => undefined)
    return result
  }
  return {
    state,
    submit(snapshot) {
      if (sealed) { state.rejectedAfterSeal++; return Promise.resolve({ outcome: 'NOT_ADMITTED_AFTER_SEAL', error: 'Artifact writer sealed' }) }
      return enqueue(snapshot)
    },
    seal(snapshot) {
      if (terminal) return terminal
      sealed = true; state.sealed = true
      enqueue(snapshot)
      terminal = boundedCompletion(() => queue, timeoutMs).then(completion => {
        if (completion.outcome !== 'RESOLVED') { failure ??= `Artifact drain ${completion.outcome}: ${completion.error}`; state.failure = failure }
        return { ...completion, error: failure ?? completion.error }
      })
      return terminal
    },
  }
}

/** The main relay's single lifecycle owner. Close observations are memoized per
 * captured instance; retirement aborts forwarding and forbids new acquisitions.
 * Late acquisition is retained and closed, never published as a live replacement.
 * @template {object} T
 * @param {{start:()=>Promise<T>,close:(instance:T,label:string)=>Promise<unknown>,onClose?:(instance:T,label:string,completion:{outcome:string,value:unknown,error:string|undefined})=>Promise<void>,operationMs?:number,closeMs?:number,drainMs?:number}} options
 */
export function liveLifecycle({ start, close, onClose = async () => {}, operationMs = 130000, closeMs = 10000, drainMs = 10000 }) {
  const controller = new AbortController(), pending = new Set(), observations = new Set(), instances = new Set()
  /** @type {Map<T,Promise<{outcome:string,value:unknown,error:string|undefined}>>} */
  const closes = new Map()
  /** @type {{retired:boolean,retirementReason:string|undefined,firstFailure:{kind:string,error:string}|undefined,failures:Array<{kind:string,error:string}>,operations:Array<{label:string,outcome:string,error:string|undefined}>,closes:Array<{label:string,outcome:string,error:string|undefined,receiptCallbackOutcome:string}>,drain:{outcome:string,error:string|undefined}|undefined}} */
  const state = { retired: false, retirementReason: undefined, firstFailure: undefined, failures: [], operations: [], closes: [], drain: undefined }
  /** @type {Promise<{outcome:string,value:unknown,error:string|undefined}>|undefined} */
  let drain
  const retire = reason => {
    if (state.retired) return
    state.retired = true; state.retirementReason = reason; controller.abort(new Error(reason))
  }
  const fail = (kind, error) => {
    const cause = { kind, error: String(error) }
    state.firstFailure ??= cause; state.failures.push(cause); retire(cause.error)
  }
  const active = () => { if (state.retired) throw new Error(`Lifecycle retired: ${state.retirementReason}`) }
  /** @template R @param {Promise<R>} promise @param {Set<Promise<unknown>>} owned */
  const retain = (promise, owned = pending) => {
    owned.add(promise)
    promise.then(() => owned.delete(promise), () => owned.delete(promise))
    return promise
  }
  const run = (label, action) => {
    if (state.retired) return Promise.reject(new Error(`Lifecycle retired: ${state.retirementReason}`))
    const observation = { label, outcome: 'PENDING', error: undefined }
    state.operations.push(observation)
    // Check admission again in the same microtask which starts the operation.
    const raw = retain(Promise.resolve().then(() => { active(); return action(controller.signal) }))
    return retain(boundedCompletion(() => raw, operationMs).then(completion => {
      Object.assign(observation, { outcome: completion.outcome, error: completion.error })
      if (completion.outcome !== 'RESOLVED') { fail(label, completion.error); throw new Error(completion.error) }
    }), observations)
  }
  /** @param {T} instance @param {string} label */
  const closeInstance = (instance, label) => {
    const existing = closes.get(instance)
    if (existing) return existing
    const observation = { label, outcome: 'PENDING', error: undefined, receiptCallbackOutcome: 'PENDING' }
    state.closes.push(observation)
    const raw = retain(Promise.resolve().then(() => close(instance, label)))
    const completion = retain(boundedCompletion(() => raw, closeMs).then(async result => {
      // Exactly one bounded result, even if raw close settles after the deadline.
      Object.assign(observation, { outcome: result.outcome, error: result.error })
      if (result.outcome !== 'RESOLVED') fail('proxy-close', result.error)
      try { await onClose(instance, label, result); observation.receiptCallbackOutcome = 'COMPLETED' }
      catch (error) { observation.receiptCallbackOutcome = 'REJECTED'; fail('proxy-close-qualification', error); throw error }
      return Object.freeze(result)
    }), observations)
    closes.set(instance, completion)
    return completion
  }
  return {
    state, signal: controller.signal, active, retire, fail, run, close: closeInstance,
    /** @template R @param {(signal:AbortSignal)=>R} action */
    forward(action) { active(); return action(controller.signal) },
    async start() {
      active()
      /** @type {T|undefined} */
      let acquired
      await run('proxy-start', async () => {
        const instance = await start()
        acquired = instance; instances.add(instance)
        if (state.retired) {
          await closeInstance(instance, 'late-start-after-retirement')
          throw new Error('Acquired proxy after retirement; retained and closed, not forwarded')
        }
      })
      active(); assert(acquired); return acquired
    },
    drain() {
      if (drain) return drain
      retire('Final cleanup')
      // Starts already in flight remain in pending until late-instance close has
      // been observed. An unknown drain never certifies those operations joined.
      drain = boundedCompletion(async () => {
        for (const instance of instances) closeInstance(instance, 'final').catch(error => fail('proxy-close-callback', error))
        while (pending.size || observations.size) await Promise.allSettled([...pending, ...observations])
        await Promise.allSettled([...closes.values()])
      }, drainMs).then(result => {
        state.drain = { outcome: result.outcome, error: result.error }
        if (result.outcome !== 'RESOLVED') fail('lifecycle-drain', result.error)
        return result
      })
      return drain
    },
  }
}

/** Used by the real relay and injected tests. Retain the upstream cause before
 * destroying downstream; finish/close and retirement remain separately tracked.
 * @param {import('node:stream').Readable} readable
 * @param {import('node:stream').Writable} response
 * @param {{signal:AbortSignal,active:()=>void,fail:(kind:string,error:unknown)=>void}} lifecycle
 * @param {(stage:string)=>Promise<unknown>} checkpoint
 */
export function forwardResponse(readable, response, lifecycle, checkpoint) {
  lifecycle.active()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true; lifecycle.signal.removeEventListener('abort', abort)
      if (error) reject(error); else resolve(undefined)
    }
    const failed = (kind, error) => {
      // Preserve the original rejection as well as the durable first cause.
      finish(error)
      lifecycle.fail(kind, error)
      // checkpoint queues a captured snapshot synchronously before its first await.
      checkpoint(kind + '-retained').catch(checkpointError => lifecycle.fail('stream-checkpoint', checkpointError))
      readable.destroy(); response.destroy(error)
    }
    const abort = () => {
      const error = new Error(`Forwarding retired: ${String(lifecycle.signal.reason)}`)
      readable.destroy(); response.destroy(); finish(error)
    }
    readable.once('error', error => failed('response-stream', error))
    response.once('error', error => failed('downstream-response', error))
    response.once('finish', () => finish())
    response.once('close', () => { if (!settled) failed('downstream-close', new Error('Response closed before finish')) })
    lifecycle.signal.addEventListener('abort', abort, { once: true })
    if (lifecycle.signal.aborted) abort(); else readable.pipe(response)
  })
}

/** One owned Pi role. Missing close is a finite failure, never a native join. */
export function observeClient(child, { deadlineMs = 240000, captureBytes = 4 * 1024 * 1024, joinGraceMs = 2000, killGraceMs = 1000, signalGroup = (pid, signal) => { process.kill(-pid, signal) } } = {}) {
  /** @type {{stdout:string, stderr:string, failure:string|undefined, exitEvent:boolean, exitCode:number|null, exitSignal:string|null, closeEvent:boolean, lateCloseEvent:boolean, joinExpired:boolean, localPipeCloseRequested:boolean, stdoutEnd:boolean, stderrEnd:boolean, stdoutClose:boolean, stderrClose:boolean, signals:Array<{signal:string,sent:boolean,code?:string}>}} */
  const state = { stdout: '', stderr: '', failure: undefined, exitEvent: false, exitCode: null, exitSignal: null, closeEvent: false, lateCloseEvent: false, joinExpired: false, localPipeCloseRequested: false, stdoutEnd: false, stderrEnd: false, stdoutClose: false, stderrClose: false, signals: [] }
  let stopping = false, settled = false, killTimer, closeTimer, resolveJoin
  /** @type {Promise<{code:number|null,signal:string|null,closeEvent:boolean,outcome:string}>} */
  const join = new Promise(resolve => { resolveJoin = resolve })
  const finish = result => {
    if (settled) return
    settled = true; clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer)
    resolveJoin(result)
  }
  const armCloseDeadline = () => {
    if (settled || closeTimer) return
    closeTimer = setTimeout(() => {
      state.joinExpired = true; state.failure ??= 'Client close join deadline exceeded'
      finish({ code: child.exitCode, signal: child.signalCode, closeEvent: false, outcome: 'UNKNOWN_CLOSE_TIMEOUT' })
      // Release only our local read ends. Their close events cannot prove native cleanup.
      for (const name of ['stdout', 'stderr']) if (typeof child[name].destroy === 'function') {
        state.localPipeCloseRequested = true; child[name].destroy()
      }
    }, joinGraceMs)
  }
  const terminate = signal => {
    if (!child.pid || settled || state.closeEvent || child.exitCode !== null || child.signalCode !== null) return
    try { signalGroup(child.pid, signal); state.signals.push({ signal, sent: true }) }
    catch (error) { state.signals.push({ signal, sent: false, code: error.code }); if (error.code !== 'ESRCH') state.failure ??= `Signal failed: ${error.code}` }
  }
  const stop = reason => {
    state.failure ??= reason
    if (stopping || settled || state.closeEvent) return
    stopping = true; terminate('SIGTERM'); killTimer = setTimeout(() => terminate('SIGKILL'), killGraceMs); armCloseDeadline()
  }
  const timer = setTimeout(() => stop('Client deadline exceeded'), deadlineMs)
  const capture = (chunk, name) => {
    if (Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr) + chunk.length > captureBytes) { stop('Client capture cap exceeded'); return }
    state[name] += chunk.toString()
  }
  for (const name of ['stdout', 'stderr']) {
    child[name].on('data', chunk => capture(chunk, name))
    child[name].once('end', () => { state[name + 'End'] = true })
    child[name].once('close', () => { state[name + 'Close'] = true })
    child[name].on('error', error => stop(`Client ${name} read failed: ${error.code ?? error.name}`))
  }
  child.once('error', error => stop(`Client process error: ${error.code ?? error.name}`))
  child.once('exit', (code, signal) => { state.exitEvent = true; state.exitCode = code; state.exitSignal = signal; armCloseDeadline() })
  child.once('close', (code, signal) => {
    state.closeEvent = true; state.lateCloseEvent = settled
    finish({ code, signal, closeEvent: true, outcome: 'CLOSE_OBSERVED' })
  })
  return { state, stop, join }
}

function groupAbsent(pid) {
  try { process.kill(-pid, 0); return 'PRESENT_OR_ZOMBIE_UNQUALIFIED' }
  catch (error) { return error.code === 'ESRCH' ? 'ESRCH_NO_GROUP' : `UNKNOWN_${error.code}` }
}
function directChildren() {
  const sample = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024 })
  assert.equal(sample.status, 0, 'Numeric process census failed')
  return sample.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)).filter(row => row[1] === process.pid && row[0] !== sample.pid)
}

export async function main() {
  assert.equal(process.platform, 'darwin', 'This supported live gate is Darwin-only')
  assert.equal(globalThis.Bun?.version, '1.3.11', 'Run the source-selecting escrow with pinned Bun 1.3.11')
  const packageRoot = resolve(process.env.E2E_MERIDIAN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..'))
  const pi = process.env.E2E_PI_BIN, node = process.env.E2E_NODE_BIN, executable = process.env.MERIDIAN_AGY_PATH
  assert(pi && isAbsolute(pi) && node && isAbsolute(node) && executable && isAbsolute(executable), 'Provide exact installed Pi CLI, supported Node and official agy paths')
  const model = 'gemini-3.8-flash-low'
  const root = await mkdtemp(join(tmpdir(), 'meridian-agy-pi-history-'))
  const project = join(root, 'project'), config = join(root, 'pi-config'), session = join(root, 'fixture-session.jsonl')
  for (const path of [project, config, join(root, 'home'), join(root, 'tmp')]) await mkdir(path, { mode: 0o700 })
  console.log(`Artifacts: ${root}`)
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
  const version = (binary, childEnv, prefix = []) => {
    const result = spawnSync(binary, [...prefix, '--version'], { env: childEnv, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 })
    assert.equal(result.status, 0, 'Version command did not complete cleanly')
    return (result.stdout || result.stderr).trim()
  }
  const report = { packageRoot, model, platform: process.platform, bun: globalThis.Bun.version, nodeCompatibility: process.version, clientNode: version(node, env), client: version(node, env, [pi]), cli: version(executable, process.env), scope: 'built source checkout / actual Pi imported-public-history / official agy; reporter ACP client and OS unknown', passed: [], joins: [] }
  const nodeParts = /^v(\d+)\.(\d+)\./.exec(report.clientNode)
  assert(nodeParts && (Number(nodeParts[1]) > 22 || Number(nodeParts[1]) === 22 && Number(nodeParts[2]) >= 19), 'Pi 1.1.0 requires Node >=22.19.0')
  assert.equal(report.client, '1.1.0', 'Use independently installed pinned current Pi 1.1.0')
  assert(/\b1\.2\.7\b/.test(report.cli), 'Use independently verified official agy 1.2.7, accepted by both frozen runtimes')
  report.serverSha256 = sha(await readFile(join(packageRoot, 'dist/server.js')))
  report.protocolSha256 = sha(await readFile(join(packageRoot, 'src/proxy/backends/antigravityProtocol.ts')))
  report.harnessSha256 = sha(await readFile(fileURLToPath(import.meta.url)))
  report.piCliSha256 = sha(await readFile(pi))
  const { startProxyServer } = await import(pathToFileURL(join(packageRoot, 'dist/server.js')).href)
  const { parseAgRequest, renderAgPrompt } = await import(pathToFileURL(join(packageRoot, 'src/proxy/backends/antigravityProtocol.ts')).href)
  const fixture = historyFixture(project, model, `LATEST_${randomUUID()}`)
  for (const [path, content] of fixture.files) await writeFile(path, content, { mode: 0o600 })
  await writeFile(session, fixture.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 })
  report.fixtureSha256 = sha(await readFile(session))
  await writeFile(join(root, 'fixture-before.jsonl'), await readFile(session), { mode: 0o600 })
  const observed = [], baselineChildren = new Set(directChildren().map(row => row[0]))
  let relay, child, role, restarted = false, stdout = '', stderr = '', primaryError, current
  const snapshots = serializedSnapshots(async snapshot => {
    await writeFile(join(root, 'requests.json'), JSON.stringify(snapshot.requests, null, 2), { mode: 0o600 })
    await writeFile(join(root, 'pi.stdout'), snapshot.stdout, { mode: 0o600 })
    await writeFile(join(root, 'pi.stderr'), snapshot.stderr, { mode: 0o600 })
    await writeFile(join(root, 'report.json'), JSON.stringify(snapshot.report, null, 2), { mode: 0o600 })
  })
  const capture = stage => {
    report.stage = stage; report.lifecycle = lifecycle.state; report.artifactWriter = snapshots.state
    if (role) {
      const { stdout: capturedOut, stderr: capturedErr, ...observation } = role.state
      stdout = capturedOut; stderr = capturedErr; report.clientObservation = observation
    }
    return { report, requests: observed, stdout, stderr }
  }
  const checkpoint = async stage => {
    const result = await snapshots.submit(capture(stage))
    if (result.error && result.outcome !== 'NOT_ADMITTED_AFTER_SEAL') {
      report.artifactError ??= result.error
      lifecycle.fail('artifact-write', result.error)
      console.error(JSON.stringify({ primaryError: report.error, artifactError: report.artifactError, stage }))
    }
  }
  const closeObservations = new Map()
  const lifecycle = liveLifecycle({
    start: () => startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true, turnTimeoutMs: 60000, pendingToolTimeoutMs: 30000 } }),
    close: async (instance, label) => {
      let owned = [], censusError
      try { owned = directChildren().filter(row => !baselineChildren.has(row[0]) && row[0] !== child?.pid) }
      catch (error) { censusError = String(error) }
      const observation = { label, publicCloseResolved: false, publicCloseOutcome: 'PENDING', publicCloseError: undefined, listenerStopped: false, qualified: !censusError && owned.every(row => row[0] === row[2]), censusError, groups: [], scope: 'sampled direct owned native children/groups; not a universal descendant census' }
      closeObservations.set(instance, { owned, observation }); report.joins.push(observation)
      await checkpoint(label + '-before-public-close')
      return instance.close()
    },
    onClose: async (instance, label, completion) => {
      const { owned, observation } = closeObservations.get(instance)
      Object.assign(observation, { publicCloseOutcome: completion.outcome, publicCloseError: completion.error, listenerStopped: !instance.server.listening })
      if (completion.outcome !== 'RESOLVED') { await checkpoint(label + '-public-close-unqualified'); return }
      const groups = owned.map(row => ({ pid: row[0], pgid: row[2], after: row[0] === row[2] ? groupAbsent(row[2]) : 'UNQUALIFIED_GROUP' }))
      Object.assign(observation, { publicCloseResolved: true, groups })
      await checkpoint(label + '-public-close-observed')
      assert(observation.qualified && !instance.server.listening && groups.every(row => row.after === 'ESRCH_NO_GROUP'), 'Old proxy/native group did not join')
      if (label === 'before-result-tail-replay') assert(groups.length > 0, 'No owned native process observed before replacement')
    },
  })
  const start = async () => {
    const instance = await lifecycle.start()
    if (!instance.server.listening) {
      const ready = await boundedCompletion(() => once(instance.server, 'listening', { signal: lifecycle.signal }))
      if (ready.outcome !== 'RESOLVED') { lifecycle.fail('proxy-listening', ready.error); throw new Error(ready.error) }
    }
    lifecycle.active(); return instance
  }
  const urlFor = instance => {
    const address = instance.server.address(); assert(address && typeof address !== 'string')
    return `http://127.0.0.1:${address.port}`
  }
  try {
    current = await start()
    relay = createServer((req, res) => {
      lifecycle.run('relay-request', async signal => {
        let bytes = 0; const chunks = []
        for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 2 * 1024 * 1024, 'Request capture cap'); chunks.push(chunk) }
        const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw)
        assert(observed.length < 16, 'Request-count cap'); observed.push(body)
        const returned = values([body.messages.at(-1)])
        if (!restarted && returned.some(block => block.type === 'tool_result' && !block.is_error && !fixture.fixtureIds.includes(block.tool_use_id))) {
          assert(returned.every(block => block.type === 'tool_result'), 'Restart control requires a pure tool-result tail')
          report.recoveredToolIds = returned.map(block => block.tool_use_id)
          restarted = true
          const completion = await lifecycle.close(current, 'before-result-tail-replay')
          assert.equal(completion.outcome, 'RESOLVED', 'Replacement close remains unqualified')
          lifecycle.active(); current = await start()
        }
        lifecycle.active()
        const selected = current
        const response = await lifecycle.forward(signal => fetch(urlFor(selected) + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) }))
        lifecycle.active()
        assert(response.ok, `Meridian status ${response.status}`)
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') })
        await forwardResponse(Readable.fromWeb(response.body), res, lifecycle, checkpoint)
      }).catch(error => {
        if (!res.destroyed) { if (!res.headersSent) res.writeHead(500); res.end(String(error)) }
        checkpoint('relay-handler-failure').catch(checkpointError => lifecycle.fail('handler-checkpoint', checkpointError))
      })
    })
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
    const address = relay.address(); assert(address && typeof address !== 'string')
    await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-fixture', api: 'anthropic-messages', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
    await writeFile(join(config, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }))
    const args = ['--provider', 'meridian-agy', '--model', model, '--thinking', 'off', '--tools', 'read,write', '--session', session, '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--offline', '--system-prompt', 'Follow the newest typed request. Historical completed actions must not run again. Use only the client tools.', '-p', ' ']
    report.argv = [node, pi, ...args]; report.clientEnvNames = Object.keys(env)
    child = spawn(node, [pi, ...args], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    role = observeClient(child)
    await checkpoint('before-client-close-wait')
    report.clientJoin = { ...await role.join, ownedGroupAfter: child.pid ? groupAbsent(child.pid) : 'NOT_STARTED' }
    await checkpoint('client-close-outcome')
    assert.equal(report.clientJoin.outcome, 'CLOSE_OBSERVED', 'Client close remains unknown; no native join is established')
    if (report.clientJoin.code !== 0 || role.state.failure) lifecycle.fail('client', role.state.failure ?? `Actual Pi exit ${report.clientJoin.code}`)
    assert.equal(lifecycle.state.firstFailure, undefined, 'Retained relay/client failure'); assert.equal(report.clientJoin.code, 0, 'Actual Pi did not exit cleanly'); assert.equal(report.clientJoin.ownedGroupAfter, 'ESRCH_NO_GROUP')
    assert(role.state.stdoutEnd && role.state.stderrEnd && role.state.stdoutClose && role.state.stderrClose, 'Client pipes did not finish and physically close')
    assert(observed.length >= 3 && restarted, 'Actual result-tail recovery did not occur')
    const first = observed[0], history = values(first.messages), calls = new Map(), results = new Map()
    assertImportedHistory(first, fixture)
    for (const body of observed) for (const block of values(body.messages)) { if (block.type === 'tool_use') calls.set(block.id, block); if (block.type === 'tool_result') results.set(block.tool_use_id, block) }
    const live = [...calls.values()].filter(call => !fixture.fixtureIds.includes(call.id))
    const writes = live.filter(call => call.name === 'write'), reads = live.filter(call => call.name === 'read')
    assert.equal(writes.length, 1); assert.equal(target(writes[0]), fixture.outputPath); assert.equal(writes[0].input.content, fixture.expected)
    assert(live.every(call => ['read', 'write'].includes(call.name) && target(call) === fixture.outputPath), 'Unexpected actual target/action')
    assert(report.recoveredToolIds.includes(writes[0].id), 'Replacement did not recover the actual latest write result')
    assert(reads.some(call => target(call) === fixture.outputPath), 'Actual client must verify the latest target with read')
    for (const call of live) assert(results.has(call.id) && !results.get(call.id).is_error, `Missing/unsuccessful actual result ${call.id}`)
    assert([...reads].some(call => JSON.stringify(results.get(call.id).content).includes(writes[0].input.content.trim())), 'Correlated read result lacks actual receipt')
    assert.equal(await readFile(fixture.outputPath, 'utf8'), writes[0].input.content)
    for (const [path, content] of fixture.files) assert.equal(await readFile(path, 'utf8'), content, 'Completed historical file changed')
    report.passed.push('actual Pi imports full public history and exact content-first write/result IDs', 'newest exact write/read target and bytes with correlated actual tool results', 'joined backend replacement before pure result-tail replay; no repeated completed write')
    const rendered = renderAgPrompt(parseAgRequest(first))
    report.renderer = inspectRenderedHistory(rendered, parseAgRequest(first).messages, fixture.seedPath)
    assert(report.renderer.prefixChars < 16000 && report.renderer.currentTargetInRecap && report.renderer.fullHistoryExact, 'Actual translated prompt recap/full-history structural regression')
    report.passed.push('actual translated-body deterministic recap bound and intact full history (separate from model behavior)')
    assert.equal(sha(await readFile(join(packageRoot, 'dist/server.js'))), report.serverSha256, 'Selected server bytes changed')
    assert.equal(sha(await readFile(join(packageRoot, 'src/proxy/backends/antigravityProtocol.ts'))), report.protocolSha256, 'Selected pure protocol bytes changed')
    assert.equal(sha(await readFile(pi)), report.piCliSha256, 'Selected Pi CLI bytes changed')
  } catch (error) {
    lifecycle.fail('main', error)
    primaryError = error; report.error = String(error)
  } finally {
    // Retire before any await: already-started handlers cannot acquire/forward.
    lifecycle.retire('Final cleanup')
    await checkpoint('before-final-cleanup')
    if (relay) relay.closeAllConnections()
    if (role) {
      if (!role.state.closeEvent) role.stop('Final cleanup after primary failure')
      await checkpoint('before-final-client-close-wait')
      report.clientJoin ??= { ...await role.join, ownedGroupAfter: child.pid ? groupAbsent(child.pid) : 'NOT_STARTED' }
      if (report.clientJoin.code !== 0 || role.state.failure) lifecycle.fail('client-cleanup', role.state.failure ?? `Actual Pi exit ${report.clientJoin.code}`)
    }
    await checkpoint('before-lifecycle-drain')
    await lifecycle.drain()
    if (relay) {
      await checkpoint('before-relay-close-wait')
      report.relayClose = await boundedCompletion(() => new Promise(resolve => relay.close(resolve)))
      if (report.relayClose.outcome !== 'RESOLVED') {
        report.relayCloseError = `Relay close ${report.relayClose.outcome}: ${report.relayClose.error}`
        lifecycle.fail('relay-close', report.relayCloseError)
      }
    }
    report.runTermination = primaryError || lifecycle.state.firstFailure || report.artifactError ? 'NONZERO_AFTER_RETAINED_FAILURE; native custody may remain unqualified' : 'CHECKS_COMPLETE_ARTIFACT_DRAIN_PENDING'
    report.artifactDrain = await snapshots.seal(capture('final-outcomes'))
    report.artifactError ??= report.artifactDrain.error
    if (report.artifactError) console.error(JSON.stringify({ firstFailure: lifecycle.state.firstFailure, artifactError: report.artifactError }))
  }
  if (primaryError) throw primaryError
  assert.equal(lifecycle.state.firstFailure, undefined, 'Retained lifecycle failure; see report')
  assert.equal(report.relayCloseError, undefined, 'Relay close failed')
  assert.equal(report.artifactError, undefined, 'Artifact retention failed')
  // The written snapshot cannot certify its own physical completion. The outer
  // owned command must retain this post-drain result and its actual exit/joins.
  report.runTermination = 'QUALIFIED_CHECKS_COMPLETE'
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) { console.error(String(error)); process.exit(1) } // Retained unknown joins fail; process exit is not native cleanup proof.
}
