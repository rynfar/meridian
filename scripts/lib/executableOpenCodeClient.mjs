// Actual OpenCode V1 arm of the executable-selection gate. Uses the tested
// built CLI's setup and a recording relay; never manufactures client headers.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {Readable, Transform} from 'node:stream'
import {StringDecoder} from 'node:string_decoder'
import {fileURLToPath} from 'node:url'
import {observeChildClosure, stopAndJoinChild} from './e2eProcessCustody.mjs'

export async function createExecutableOpenCodeClient({repo, root, proxyURL, env, model}) {
  const executable = process.env.E2E_OPENCODE_BIN
  const expectedVersion = process.env.E2E_OPENCODE_VERSION
  assert(executable && expectedVersion, 'Pin E2E_OPENCODE_BIN and E2E_OPENCODE_VERSION')
  const config = join(root, 'opencode')
  mkdirSync(config, {mode: 0o700})
  const plugin = realpathSync(join(repo, 'dist', 'meridian'))
  const clientEnv = {...env, OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: '1'}
  // Authentication belongs to Meridian's private profile, not the client.
  delete clientEnv.MERIDIAN_PROFILES
  delete clientEnv.MERIDIAN_DEFAULT_PROFILE
  const closures = [], requests = [], pending = new Set(), controllers = new Set()
  let session, current, firstFailure, host, hostWitness, hostURL, hostOutput = '', hostErrors = ''
  const pluginPath = path => realpathSync(path.startsWith('file:') ? fileURLToPath(path) : path)
  async function invoke(command, args, label, timeoutMs = 180000) {
    const child = spawn(command, args, {cwd: join(root, 'project'), env: clientEnv, stdio: ['ignore', 'pipe', 'pipe']})
    const witness = observeChildClosure(child)
    let stdout = '', stderr = '', overflow = false, timer
    const capture = target => chunk => {
      if (target === 'stdout') stdout += chunk; else stderr += chunk
      if (stdout.length + stderr.length > 8 * 1024 * 1024) {
        overflow = true
        stdout = stdout.slice(-4 * 1024 * 1024); stderr = stderr.slice(-4 * 1024 * 1024)
        if (!witness.state.exitSeen && !witness.state.closeSeen) child.kill('SIGTERM')
      }
    }
    child.stdout.on('data', capture('stdout')); child.stderr.on('data', capture('stderr'))
    try {
      await Promise.race([witness.joined, new Promise(resolve => { timer = setTimeout(resolve, timeoutMs) })])
    } finally { clearTimeout(timer) }
    const closure = await stopAndJoinChild(child, witness, {graceMs: 2000, forceMs: 3000})
    closures.push({label, ...closure})
    for (const [suffix, contents] of [['stdout', stdout], ['stderr', stderr]]) {
      writeFileSync(join(root, `${label}.${suffix}`), contents, {mode: 0o600})
    }
    assert(closure.joined && closure.exitCode === 0 && closure.exitSignal === null && !overflow,
      `${label} did not exit successfully with all captured pipes joined`)
    return {stdout, stderr}
  }
  async function handle(request, response) {
    const controller = new AbortController()
    controllers.add(controller)
    const abort = () => { if (!response.writableFinished) controller.abort() }
    response.once('close', abort)
    const timeout = setTimeout(() => controller.abort(), 300000)
    try {
      const chunks = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length; assert(size <= 4 * 1024 * 1024, 'client request exceeds gate bound'); chunks.push(chunk)
      }
      const body = chunks.length ? Buffer.concat(chunks) : undefined
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined && !['host', 'connection', 'content-length'].includes(name)) headers.set(name, String(value))
      }
      let row
      if (request.url === '/v1/messages' && body) {
        const parsed = JSON.parse(body)
        row = {route: request.url, model: parsed.model, streaming: parsed.stream === true,
          session: headers.get('x-opencode-session'), agent: headers.get('x-opencode-agent-name'),
          mode: headers.get('x-opencode-agent-mode'), requestIdentity: headers.has('x-opencode-request'),
          attested: headers.has('x-meridian-opencode-turn'),
          hasCurrentReceipt: current ? JSON.stringify(parsed.messages).includes(current.receipt) : false}
        requests.push(row)
      }
      const upstream = await fetch(proxyURL + request.url, {method: request.method, headers,
        ...(body ? {body} : {}), signal: controller.signal})
      if (row) row.status = upstream.status
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      if (!upstream.body) { response.end(); return }
      let buffered = ''
      const decoder = new StringDecoder('utf8')
      const inspect = new Transform({transform(chunk, _encoding, done) {
        buffered += decoder.write(chunk)
        const lines = buffered.split('\n'); buffered = lines.pop()
        if (buffered.length > 65536) { done(new Error('SSE line exceeds gate bound')); return }
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let event
          try { event = JSON.parse(line.slice(6)) } catch (error) { done(error); return }
          if (row && event.type === 'message_start') row.responseModel = event.message?.model
          if (row?.hasCurrentReceipt && row.mode === 'primary' && current?.during && !current.duringStarted && event.delta?.type === 'text_delta') {
            current.duringStarted = true
            current.duringDone = Promise.resolve().then(current.during)
            current.duringDone.catch(error => { firstFailure ??= error })
          }
        }
        done(null, chunk)
      }})
      await new Promise((resolve, reject) => {
        const stream = Readable.fromWeb(upstream.body)
        stream.on('error', reject); inspect.on('error', reject); response.on('error', reject)
        response.once('close', () => { if (!response.writableFinished) reject(new Error('Client response closed before completion')) })
        response.once('finish', resolve)
        stream.pipe(inspect).pipe(response)
      })
    } catch (error) {
      firstFailure ??= error
      if (!response.headersSent) response.writeHead(502)
      response.end('Executable client gate relay failed')
    } finally {
      clearTimeout(timeout); response.removeListener('close', abort); controllers.delete(controller)
    }
  }
  const relay = createServer((request, response) => {
    const running = handle(request, response).finally(() => pending.delete(running))
    pending.add(running)
  })
  await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(0, '127.0.0.1', resolve) })
  const baseURL = `http://127.0.0.1:${relay.address().port}/v1`
  const close = async () => {
    let hostClosure
    if (host) {
      hostClosure = await stopAndJoinChild(host, hostWitness, {graceMs: 5000, forceMs: 3000})
      writeFileSync(join(root, 'opencode-server.stdout'), hostOutput, {mode: 0o600})
      writeFileSync(join(root, 'opencode-server.stderr'), hostErrors, {mode: 0o600})
    }
    for (const controller of controllers) controller.abort()
    relay.closeAllConnections()
    await new Promise(resolve => relay.close(resolve))
    let timer
    try {
      await Promise.race([Promise.allSettled([...pending]), new Promise(resolve => { timer = setTimeout(resolve, 5000) })])
    } finally { clearTimeout(timer) }
    return {closed: !relay.listening && pending.size === 0 && (!hostClosure || hostClosure.joined),
      ...(hostClosure ? {hostClosure} : {}), handlersJoined: pending.size === 0, closures,
      requests: requests.map(({session: id, ...row}) => ({...row, sessionCaptured: Boolean(id)}))}
  }
  try {
    writeFileSync(join(config, 'opencode.json'), JSON.stringify({
      model: `anthropic/${model}`, small_model: `anthropic/${model}`, share: 'disabled', permission: 'deny',
      provider: {anthropic: {options: {apiKey: 'local-executable-fixture', baseURL},
        models: {[model]: {name: model, limit: {context: 200000, output: 8192},
          modalities: {input: ['text'], output: ['text']}, reasoning: false, tool_call: true}}}},
    }, null, 2), {mode: 0o600})
    const version = await invoke(executable, ['--version'], 'opencode-version', 30000)
    assert.equal(version.stdout.trim(), expectedVersion)
    await invoke(process.execPath, [join(repo, 'dist', 'cli.js'), 'setup', '--v1'], 'opencode-setup', 30000)
    const configured = JSON.parse(readFileSync(join(config, 'opencode.json'), 'utf8'))
    assert.deepEqual(configured.plugin.map(pluginPath), [plugin])
    assert.equal(configured.provider.anthropic.options.baseURL, baseURL)
    // OpenCode itself resolves effective config before any model call.
    const preflight = await invoke(executable, ['debug', 'config', '--print-logs', '--log-level', 'DEBUG'], 'opencode-preflight', 60000)
    const effective = JSON.parse(preflight.stdout)
    assert.deepEqual(effective.plugin.map(pluginPath), [plugin])
    assert.equal(effective.provider.anthropic.options.baseURL, baseURL)
    host = spawn(executable, ['serve', '--hostname', '127.0.0.1', '--port', '0', '--print-logs', '--log-level', 'DEBUG'],
      {cwd: join(root, 'project'), env: clientEnv, stdio: ['ignore', 'pipe', 'pipe']})
    hostWitness = observeChildClosure(host)
    host.stdout.on('data', chunk => { hostOutput = (hostOutput + chunk).slice(-1024 * 1024) })
    host.stderr.on('data', chunk => { hostErrors = (hostErrors + chunk).slice(-1024 * 1024) })
    const deadline = Date.now() + 60000
    while (!(hostURL = /opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(hostOutput)?.[1])) {
      assert(!hostWitness.state.exitSeen && Date.now() < deadline, 'OpenCode server did not become ready')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const created = await fetch(hostURL + '/session', {method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({title: 'executable-selector-proof'}), signal: AbortSignal.timeout(30000)})
    assert.equal(created.status, 200)
    session = (await created.json()).id
    assert(session, 'OpenCode did not create its own session')
    assert(hostErrors.split('\n').some(line => line.includes('loading plugin') && line.includes(plugin)),
      'Actual OpenCode did not record loading the expected Meridian plugin')
    const identity = {version: expectedVersion, plugin: '<repo>/dist/meridian',
      pluginSha256: createHash('sha256').update(readFileSync(join(plugin, 'index.js'))).digest('hex'),
      setupExit: 0, effectiveEntries: 1, loadedBeforeInference: true, providerTargetsRelay: true}
    let turnIndex = 0
    return {identity, close, async turn({prompt, receipt, during}) {
      assert(!firstFailure, 'An earlier relay operation failed')
      current = {receipt, during, duringStarted: false}
      const start = requests.length
      const flags = ['--attach', hostURL, '--session', session]
      const result = await invoke(executable, ['run', '--format', 'json', '--print-logs', '--log-level', 'DEBUG',
        ...flags, '--model', `anthropic/${model}`, prompt], `opencode-turn-${++turnIndex}`)
      const events = result.stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
      assert(!events.some(event => event.type === 'error'), 'OpenCode emitted an error event')
      const sessionID = events.find(event => typeof event.sessionID === 'string')?.sessionID
      assert(sessionID, 'OpenCode did not return its session identity')
      if (session) assert.equal(sessionID, session); else session = sessionID
      const primary = requests.slice(start).filter(row => row.hasCurrentReceipt && row.agent === 'build' && row.mode === 'primary')
      assert(primary.length > 0 && primary.every(row => row.session === session && row.requestIdentity && row.attested && row.status === 200),
        'Expected successful signed primary requests from the actual Meridian client plugin')
      const duringResult = await current.duringDone
      if (firstFailure) throw firstFailure
      assert(primary.every(row => typeof row.responseModel === 'string'), 'No actual model identity reached the client')
      const text = events.filter(event => event.type === 'text').map(event => event.part?.text ?? '').join('')
      current = undefined
      return {receiptDelivered: text.includes(receipt), stopped: events.some(event => event.type === 'step_finish'),
        responseModel: primary.at(-1).responseModel, duringResult, actualClient: true, sameSession: true, primaryRequests: primary.length}
    }}
  } catch (error) {
    await close()
    throw error
  }
}
