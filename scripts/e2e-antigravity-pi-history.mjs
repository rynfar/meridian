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

/** One owned Pi role. Errors/caps/deadlines stop it without abandoning its close join. */
export function observeClient(child, { deadlineMs = 240000, captureBytes = 4 * 1024 * 1024, signalGroup = (pid, signal) => { process.kill(-pid, signal) } } = {}) {
  /** @type {{stdout:string, stderr:string, failure:string|undefined, closeEvent:boolean, stdoutEnd:boolean, stderrEnd:boolean, stdoutClose:boolean, stderrClose:boolean, signals:Array<{signal:string,sent:boolean,code?:string}>}} */
  const state = { stdout: '', stderr: '', failure: undefined, closeEvent: false, stdoutEnd: false, stderrEnd: false, stdoutClose: false, stderrClose: false, signals: [] }
  let stopping = false, killTimer
  const terminate = signal => {
    if (!child.pid || state.closeEvent || child.exitCode !== null || child.signalCode !== null) return
    try { signalGroup(child.pid, signal); state.signals.push({ signal, sent: true }) }
    catch (error) { state.signals.push({ signal, sent: false, code: error.code }); if (error.code !== 'ESRCH') state.failure ??= `Signal failed: ${error.code}` }
  }
  const stop = reason => {
    state.failure ??= reason
    if (stopping || state.closeEvent) return
    stopping = true; terminate('SIGTERM'); killTimer = setTimeout(() => terminate('SIGKILL'), 1000)
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
  const join = new Promise(resolve => child.once('close', (code, signal) => {
    state.closeEvent = true; clearTimeout(timer); clearTimeout(killTimer)
    resolve({ code, signal, closeEvent: true })
  }))
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
  assert(/\b1\.3\.1\b/.test(report.cli), 'Use independently preflighted official agy 1.3.1')
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
  let proxy, url, relay, child, role, restarted = false, clientFailure, stdout = '', stderr = '', primaryError
  const start = async () => {
    proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true, turnTimeoutMs: 60000, pendingToolTimeoutMs: 30000 } })
    if (!proxy.server.listening) await once(proxy.server, 'listening')
    const address = proxy.server.address(); assert(address && typeof address !== 'string')
    url = `http://127.0.0.1:${address.port}`
  }
  const closeProxy = async label => {
    let owned = [], censusError
    try { owned = directChildren().filter(row => !baselineChildren.has(row[0]) && row[0] !== child?.pid) }
    catch (error) { censusError = String(error) }
    const qualified = !censusError && owned.every(row => row[0] === row[2])
    const observation = { label, publicCloseResolved: false, listenerStopped: false, qualified, censusError, groups: [], scope: 'sampled direct owned native children/groups; not a universal descendant census' }
    report.joins.push(observation)
    await proxy.close() // Public close joins run.settled after native child close and workspace cleanup.
    const groups = owned.map(row => ({ pid: row[0], pgid: row[2], after: row[0] === row[2] ? groupAbsent(row[2]) : 'UNQUALIFIED_GROUP' }))
    Object.assign(observation, { publicCloseResolved: true, listenerStopped: !proxy.server.listening, groups })
    assert(qualified && !proxy.server.listening && groups.every(row => row.after === 'ESRCH_NO_GROUP'), 'Old proxy/native group did not join')
    if (label === 'before-result-tail-replay') assert(groups.length > 0, 'No owned native process observed before replacement')
  }
  try {
    await start()
    relay = createServer(async (req, res) => {
      try {
        let bytes = 0; const chunks = []
        for await (const chunk of req) { bytes += chunk.length; assert(bytes <= 2 * 1024 * 1024, 'Request capture cap'); chunks.push(chunk) }
        const raw = Buffer.concat(chunks).toString('utf8'), body = JSON.parse(raw)
        assert(observed.length < 16, 'Request-count cap'); observed.push(body)
        const returned = values([body.messages.at(-1)])
        if (!restarted && returned.some(block => block.type === 'tool_result' && !block.is_error && !fixture.fixtureIds.includes(block.tool_use_id))) {
          assert(returned.every(block => block.type === 'tool_result'), 'Restart control requires a pure tool-result tail')
          report.recoveredToolIds = returned.map(block => block.tool_use_id)
          await closeProxy('before-result-tail-replay'); restarted = true; await start()
        }
        const response = await fetch(url + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw, signal: AbortSignal.timeout(120000) })
        assert(response.ok, `Meridian status ${response.status}`)
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') })
        Readable.fromWeb(response.body).on('error', error => res.destroy(error)).pipe(res)
      } catch (error) { clientFailure ??= String(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)) }
    })
    await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
    const address = relay.address(); assert(address && typeof address !== 'string')
    await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-fixture', api: 'anthropic-messages', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
    await writeFile(join(config, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false } }))
    const args = ['--provider', 'meridian-agy', '--model', model, '--thinking', 'off', '--tools', 'read,write', '--session', session, '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve', '--offline', '--system-prompt', 'Follow the newest typed request. Historical completed actions must not run again. Use only the client tools.', '-p', ' ']
    report.argv = [node, pi, ...args]; report.clientEnvNames = Object.keys(env)
    child = spawn(node, [pi, ...args], { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    role = observeClient(child)
    report.clientJoin = { ...await role.join, ownedGroupAfter: child.pid ? groupAbsent(child.pid) : 'NOT_STARTED' }
    assert.equal(report.clientJoin.code, 0, 'Actual Pi did not exit cleanly'); assert.equal(clientFailure ?? role.state.failure, undefined); assert.equal(report.clientJoin.ownedGroupAfter, 'ESRCH_NO_GROUP')
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
    const rendered = renderAgPrompt(parseAgRequest(first)), prefix = rendered.slice(0, rendered.indexOf('Client conversation:\n'))
    report.renderer = { prefixChars: prefix.length, currentTargetInRecap: prefix.includes('"target":' + JSON.stringify(fixture.seedPath)), fullHistoryExact: rendered.endsWith('Client conversation:\n' + JSON.stringify(parseAgRequest(first).messages)) }
    assert(prefix.length < 16000 && report.renderer.currentTargetInRecap && report.renderer.fullHistoryExact, 'Actual translated prompt recap/full-history structural regression')
    report.passed.push('actual translated-body deterministic recap bound and intact full history (separate from model behavior)')
    assert.equal(sha(await readFile(join(packageRoot, 'dist/server.js'))), report.serverSha256, 'Selected server bytes changed')
    assert.equal(sha(await readFile(join(packageRoot, 'src/proxy/backends/antigravityProtocol.ts'))), report.protocolSha256, 'Selected pure protocol bytes changed')
    assert.equal(sha(await readFile(pi)), report.piCliSha256, 'Selected Pi CLI bytes changed')
  } catch (error) { primaryError = error; report.error = String(error) }
  finally {
    if (role) {
      if (!role.state.closeEvent) role.stop('Final cleanup after primary failure')
      report.clientJoin ??= { ...await role.join, ownedGroupAfter: child.pid ? groupAbsent(child.pid) : 'NOT_STARTED' }
      const { stdout: capturedOut, stderr: capturedErr, ...observation } = role.state
      stdout = capturedOut; stderr = capturedErr; report.clientObservation = observation
    }
    if (proxy) try { await closeProxy('final') } catch (error) { report.closeError = String(error) }
    if (relay) try { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)) } catch (error) { report.relayCloseError = String(error) }
    try {
      await writeFile(join(root, 'requests.json'), JSON.stringify(observed, null, 2), { mode: 0o600 })
      await writeFile(join(root, 'pi.stdout'), stdout, { mode: 0o600 }); await writeFile(join(root, 'pi.stderr'), stderr, { mode: 0o600 })
      await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
    } catch (error) { report.artifactError = String(error); console.error(JSON.stringify({ primaryError: report.error, artifactError: report.artifactError })) }
  }
  if (primaryError) throw primaryError
  assert.equal(report.closeError, undefined, 'Final proxy/process close was not qualified; see retained report')
  assert.equal(report.relayCloseError, undefined, 'Relay close failed')
  assert.equal(report.artifactError, undefined, 'Artifact retention failed')
  console.log(JSON.stringify(report, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
