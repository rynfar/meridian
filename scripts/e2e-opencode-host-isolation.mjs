#!/usr/bin/env node
// Actual OpenCode, matching Meridian plugin, SDK and native CLI. The default
// responder is loopback; --live requires an access-only grant and fresh usage
// guard. Host fixtures and client files are synthetic and separately owned.
import assert from 'node:assert/strict'
import cp from 'node:child_process'
import {createRequire, syncBuiltinESMExports} from 'node:module'
import {StringDecoder} from 'node:string_decoder'
import {createServer} from 'node:http'
import {once} from 'node:events'
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, realpathSync} from 'node:fs'
import {join, resolve} from 'node:path'
import {randomUUID, randomBytes} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import {resolveOpenCodeScrub, configureOpenCodeScrub, verifyOpenCodeScrub} from './lib-opencode-scrub-preflight.mjs'
import {observeChildClosure, stopAndJoinChild} from './lib/e2eProcessCustody.mjs'

assert(!process.versions.bun, 'Use Node so original child handles are observable')
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const client = process.env.E2E_OPENCODE_BIN, native = process.env.E2E_NATIVE_BIN
const version = process.env.E2E_OPENCODE_VERSION ?? '2.0.31'
assert(client?.startsWith('/') && native?.startsWith('/'))
assert(['2.0.21', '2.0.31'].includes(version))
const live = process.argv.includes('--live'), baseline = process.argv.includes('--expect-baseline')
const output = resolve(process.env.E2E_EVIDENCE_DIR ?? 'local-evidence/opencode-host-isolation')
const scrub = resolveOpenCodeScrub(process.env.E2E_PLUGIN_PATH, process.env.E2E_SCRUB_VERSION)
let profiles
if (live) {
  assert.equal(process.env.E2E_ALLOW_LIVE_MODEL, '1')
  const guardPath = process.env.E2E_USAGE_GUARD_FILE
  const guard = JSON.parse(readFileSync(guardPath, 'utf8'))
  assert(guard.canInfer && guard.extraUsageEnabled === false && guard.refreshes === 0)
  assert(Date.now() - statSync(guardPath).mtimeMs < 300000, 'Fresh included-capacity guard required')
  assert.equal(statSync(process.env.E2E_LIVE_PROFILE_FILE).mode & 0o077, 0)
  profiles = JSON.parse(readFileSync(process.env.E2E_LIVE_PROFILE_FILE, 'utf8'))
  assert(profiles.length === 1 && profiles[0].type === 'oauth-token' && profiles[0].oauthToken && !profiles[0].refreshToken)
}
const root = realpathSync(mkdtempSync('/tmp/meridian-host-isolation-'))
for (const directory of ['home', 'proxy', 'project', 'config', 'sessions', 'client', 'data', 'cache', 'state', 'native']) {
  mkdirSync(join(root, directory), {mode: 0o700})
}
mkdirSync(output, {recursive: true})
const work = join(root, 'project'), proxyWork = join(root, 'proxy')
const receipt = 'OWNED_FILE_' + randomUUID(), foreign = 'OWNED_PROXY_HOST_' + randomUUID()
const hookGuidance = 'OWNED_SESSIONSTART_' + randomUUID()
const primary = 'OWNED_CLIENT_SYSTEM_' + randomUUID(), model = 'claude-haiku-5-5'
writeFileSync(join(work, 'fixture.txt'), receipt)
writeFileSync(join(proxyWork, 'CLAUDE.md'), `Synthetic proxy host guidance: ${foreign}.\n`)
const hook = join(root, 'session-start.cjs')
writeFileSync(hook, 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:' + JSON.stringify(hookGuidance) + '}}));\n')
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_|CLAUDE_PROXY_|ANTHROPIC_|OPENCODE_)/.test(key)) delete process.env[key]
Object.assign(process.env, {
  HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'native'), PWD: proxyWork, INIT_CWD: proxyWork,
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'), MERIDIAN_WORKDIR: proxyWork,
  MERIDIAN_PASSTHROUGH: '1', MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_CREDENTIALS_READONLY: '1',
  MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_DEFER_TOOL_THRESHOLD: '0', MERIDIAN_HAIKU_MODEL: model,
  MERIDIAN_OPENCODE_ATTESTATION_KEY: randomBytes(32).toString('base64url'),
})
process.chdir(proxyWork)
writeFileSync(join(root, 'config', 'sdk-features.json'), JSON.stringify({opencode: {
  claudeMd: 'full', codeSystemPrompt: false, clientSystemPrompt: true, memory: false, dreaming: false, sharedMemory: false,
}}))
const report = {scope: live ? 'actual OpenCode/SDK/native/model' : 'actual OpenCode/SDK/native, scripted model responder',
  baseline, model, platform: process.platform, arch: process.arch, node: process.version, root,
  provider: [], native: [], actors: [], requests: [], foreignMcpRequests: 0, result: 'FAIL'}
const actors = [], originals = new Map()
let stopped = false, proxy, server
for (const name of ['spawn', 'execFile']) {
  const original = cp[name]; originals.set(name, original)
  cp[name] = function (...args) {
    const child = Reflect.apply(original, this, args), witness = observeChildClosure(child)
    actors.push({child, witness})
    if (child.stdout) {
      const emit = child.stdout.emit, decoder = new StringDecoder('utf8'); let pending = ''
      child.stdout.emit = function (event, ...values) {
        if (event === 'data') {
          pending += typeof values[0] === 'string' ? values[0] : decoder.write(values[0])
          if (pending.length > 2 * 1024 * 1024) { report.observationError = 'Native line exceeded bound'; stopped = true; pending = '' }
          let end
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1)
            let value; try { value = JSON.parse(line) } catch { continue }
            const message = value.type === 'assistant' ? value.message : value.type === 'stream_event' && value.event?.type === 'message_start' ? value.event.message : undefined
            if (message?.model) {
              report.native.push({session: value.session_id, id: message.id, model: message.model})
              if (message.model !== model) { stopped = true; report.modelMismatch = true }
            }
            if (value.type === 'rate_limit_event') {
              const info = value.rate_limit_info ?? value.rateLimitInfo
              report.native.push({type: value.type, isUsingOverage: info?.isUsingOverage, status: info?.status})
              if (info?.isUsingOverage || info?.status === 'rejected') { stopped = true; report.capacityRejected = true }
            }
          }
        }
        return emit.call(this, event, ...values)
      }
    }
    return child
  }
}
syncBuiltinESMExports()
const foreignServer = createServer(async (request, response) => {
  if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks)); report.foreignMcpRequests++
  if (body.id === undefined) { response.writeHead(202); response.end(); return }
  const result = body.method === 'initialize'
    ? {protocolVersion: body.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name: 'owned-foreign', version: '1'}}
    : body.method === 'tools/list'
      ? {tools: [{name: 'host_only', description: 'Synthetic proxy host tool; do not call.', inputSchema: {type: 'object', properties: {}}}]}
      : {content: [{type: 'text', text: 'Owned foreign fixture'}]}
  response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({jsonrpc: '2.0', id: body.id, result}))
})
await new Promise(ready => foreignServer.listen(0, '127.0.0.1', ready))
writeFileSync(join(proxyWork, '.mcp.json'), JSON.stringify({mcpServers: {owned_foreign: {type: 'http', url: `http://127.0.0.1:${foreignServer.address().port}/mcp`}}}))
for (const directory of [join(root, 'native'), ...(profiles ? [join(root, 'config', 'profiles', profiles[0].id)] : [])]) {
  mkdirSync(directory, {recursive: true})
  writeFileSync(join(directory, 'settings.json'), JSON.stringify({enableAllProjectMcpServers: true,
    hooks: {SessionStart: [{hooks: [{type: 'command', command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(hook)}]}]}}))
}
const controllers = new Set()
const upstream = createServer(async (request, response) => {
  const controller = new AbortController(); controllers.add(controller)
  response.once('close', () => { if (!response.writableFinished) controller.abort() })
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks), url = new URL(request.url, 'https://api.anthropic.com')
    let body; if (bytes.length) body = JSON.parse(bytes)
    const generation = request.method === 'POST' && url.pathname === '/v1/messages'
    let row
    if (generation) {
      const history = JSON.stringify(body.messages), system = JSON.stringify(body.system)
      row = {model: body.model, primary: system.includes(primary), foreignGuidance: history.includes(foreign) || system.includes(foreign),
        sessionStartGuidance: history.includes(hookGuidance) || system.includes(hookGuidance), toolCalls: [],
        foreignTools: (body.tools ?? []).filter(tool => tool.name?.includes('owned_foreign')).map(tool => tool.name),
        tools: (body.tools ?? []).map(tool => tool.name), receiptSeen: history.includes(receipt)}
      if (stopped || body.model !== model || report.provider.length >= 12) throw Error('Model/attempt boundary; no further inference permitted')
      report.provider.push(row)
    }
    if (!live) {
      if (!generation) { response.setHeader('content-type', 'application/json'); response.end('{}'); return }
      const read = (body.tools ?? []).find(tool => tool.name?.endsWith('__read'))
      const pathKey = ['path', 'filePath', 'file_path'].find(key => read?.input_schema?.properties?.[key])
      row.readPathProperty = pathKey
      assert(!row.primary || row.receiptSeen || pathKey, 'Actual client read path schema is unsupported')
      const content = row.primary && !row.receiptSeen
        ? [{type: 'tool_use', id: 'toolu_' + randomUUID(), name: read.name, input: {[pathKey]: join(work, 'fixture.txt')}}]
        : [{type: 'text', text: row.primary ? 'Owned receipt read.' : 'Fixture title'}]
      assert(!content.some(block => block.type === 'tool_use' && !block.name), 'Actual client read tool missing')
      const message = {id: 'msg_' + randomUUID(), type: 'message', role: 'assistant', model, content,
        stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: {input_tokens: 100, output_tokens: 10}}
      Object.assign(row, {status: 200, responseId: message.id, responseModel: model})
      row.toolCalls = content.filter(block => block.type === 'tool_use').map(block => block.name)
      if (!body.stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(message)); return }
      const events = [{type: 'message_start', message: {...message, content: [], stop_reason: null}},
        ...content.flatMap((block, index) => [{type: 'content_block_start', index, content_block: block.type === 'text' ? {type: 'text', text: ''} : {...block, input: {}}},
          {type: 'content_block_delta', index, delta: block.type === 'text' ? {type: 'text_delta', text: block.text} : {type: 'input_json_delta', partial_json: JSON.stringify(block.input)}},
          {type: 'content_block_stop', index}]),
        {type: 'message_delta', delta: {stop_reason: message.stop_reason, stop_sequence: null}, usage: {output_tokens: 10}}, {type: 'message_stop'}]
      response.setHeader('content-type', 'text/event-stream'); response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')); return
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) if (value && !['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(name)) headers.set(name, Array.isArray(value) ? value.join(',') : value)
    const result = await fetch(url, {method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : bytes,
      redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)])})
    if (row) row.status = result.status
    if (!result.ok) { stopped = true; report.providerRejected = result.status }
    const outgoing = {}; for (const [name, value] of result.headers) if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(name)) outgoing[name] = value
    response.writeHead(result.status, outgoing)
    if (!result.body) { response.end(); return }
    let pending = ''
    for await (const chunk of result.body) {
      if (generation) {
        pending += Buffer.from(chunk).toString().replaceAll('\r', ''); assert(pending.length < 2 * 1024 * 1024)
        let end; while ((end = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, end); pending = pending.slice(end + 2)
          for (const line of frame.split('\n')) if (line.startsWith('data: ')) {
            let event; try { event = JSON.parse(line.slice(6)) } catch { continue }
            if (event.type === 'message_start') { row.responseId = event.message?.id; row.responseModel = event.message?.model; assert.equal(row.responseModel, model) }
            if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') row.toolCalls.push(event.content_block.name)
            if (event.type === 'message_delta' && event.delta?.stop_reason === 'refusal') { report.refusal = true; stopped = true }
            if (event.type === 'error') { report.inBandError = event.error?.type; stopped = true }
          }
        }
      }
      response.write(Buffer.from(chunk))
    }
    response.end()
  } catch (error) {
    if (request.method === 'HEAD' && controller.signal.aborted) return
    stopped = true; report.upstreamFailure = error.name + ': ' + error.message
    if (!response.headersSent) response.writeHead(400); response.end()
    server?.kill('SIGTERM')
  } finally { controllers.delete(controller) }
})
await new Promise(ready => upstream.listen(0, '127.0.0.1', ready))
const trampoline = join(root, 'native-relay.cjs')
writeFileSync(trampoline, '#!/usr/bin/env node\nprocess.execve(' + JSON.stringify(native) + ',[' + JSON.stringify(native) + ',...process.argv.slice(2)],{...process.env,ANTHROPIC_BASE_URL:' + JSON.stringify(`http://127.0.0.1:${upstream.address().port}`) + '});\n', {mode: 0o700})
process.env.MERIDIAN_CLAUDE_PATH = trampoline
const clientEnv = {PATH: process.env.PATH, HOME: join(root, 'home'), PWD: work, INIT_CWD: work,
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_OPENCODE_ATTESTATION_KEY: process.env.MERIDIAN_OPENCODE_ATTESTATION_KEY,
  OPENCODE_CONFIG_DIR: join(root, 'client'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_SERVER_PASSWORD: randomUUID()}
for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) clientEnv[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
async function run(command, args) {
  const child = cp.spawn(command, args, {cwd: work, env: clientEnv, stdio: ['ignore', 'pipe', 'pipe']})
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes)
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000)
  const [code] = await once(child, 'close'); clearTimeout(timer); assert.equal(code, 0, stderr.slice(-400)); return stdout.trim()
}
try {
  report.client = await run(client, ['--version']); assert.equal(report.client, `opencode v${version}`)
  report.nativeVersion = await run(native, ['--version'])
  profiles ??= [{id: 'owned-isolation', type: 'api', apiKey: 'owned-loopback', baseUrl: `http://127.0.0.1:${upstream.address().port}`}]
  const {startProxyServer} = await import(pathToFileURL(join(repo, 'dist/server.js')))
  proxy = await startProxyServer({port: 0, host: '127.0.0.1', silent: true, profiles, defaultProfile: profiles[0].id, ...configureOpenCodeScrub(root, scrub)})
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const proxyUrl = `http://127.0.0.1:${proxy.server.address().port}`
  report.scrubPreflight = verifyOpenCodeScrub(await (await fetch(proxyUrl + '/plugins/list')).json(), scrub)
  proxy.server.prependListener('request', request => { if (new URL(request.url, 'http://localhost').pathname === '/v1/messages') report.requests.push({session: request.headers['x-opencode-session'], attested: Boolean(request.headers['x-meridian-opencode-turn'])}) })
  writeFileSync(join(root, 'client', 'opencode.json'), JSON.stringify({model: `anthropic/${model}`, share: 'disabled',
    providers: {anthropic: {settings: {apiKey: 'owned-loopback', baseURL: proxyUrl + '/v1'}}},
    agents: {build: {system: `${primary}. Follow the user's task using only the client's tools.`}}}))
  await run(process.execPath, [join(repo, 'dist/cli.js'), 'setup', '--v2', '--opencode-bin', client])
  const config = JSON.parse(readFileSync(join(root, 'client', 'opencode.json')))
  assert.deepEqual(config.plugins.map(path => realpathSync(path)), [realpathSync(join(repo, 'dist/meridian-v2'))])
  report.clientPlugin = realpathSync(join(repo, 'dist/meridian-v2'))
  server = cp.spawn(client, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {cwd: work, env: clientEnv, stdio: ['ignore', 'pipe', 'pipe']})
  server.stderr.resume()
  const address = await new Promise((ready, reject) => {
    let stdout = ''; const timer = setTimeout(() => reject(Error('OpenCode readiness timeout')), 30000)
    server.stdout.on('data', bytes => { stdout += bytes; const match = stdout.match(/server listening on (\S+)/); if (match) { clearTimeout(timer); ready(match[1]) } })
    server.once('close', () => { clearTimeout(timer); reject(Error('OpenCode exited before readiness')) })
  })
  const headers = {'content-type': 'application/json', authorization: 'Basic ' + Buffer.from('opencode:' + clientEnv.OPENCODE_SERVER_PASSWORD).toString('base64')}
  const where = '?directory=' + encodeURIComponent(work)
  async function api(method, path, body) {
    const response = await fetch(new URL(path, address), {method, headers, body: body && JSON.stringify(body), signal: AbortSignal.timeout(120000)})
    const text = await response.text(); assert(response.ok, `${method} ${path}: ${response.status}`); return text ? JSON.parse(text) : undefined
  }
  const session = (await api('POST', '/api/session', {location: {directory: work}, model: {providerID: 'anthropic', id: model}})).data
  await api('POST', `/api/session/${session.id}/prompt${where}`, {text: 'Inspect fixture.txt in the client project and report its contents using your available client tools. Do not call proxy-host tools.'})
  await api('POST', `/api/experimental/session/${session.id}/wait${where}`)
  assert(!stopped, 'Model/transport/capacity boundary failed; do not retry')
  const primaryRows = report.provider.filter(row => row.primary)
  assert(primaryRows.length >= 2 && primaryRows.some(row => row.receiptSeen), 'Actual client read/result round missing')
  assert(primaryRows.every(row => row.foreignGuidance === baseline), 'Proxy CLAUDE.md isolation differs from the expected source')
  assert(primaryRows.every(row => row.sessionStartGuidance === baseline), 'Proxy SessionStart isolation differs from the expected source')
  assert(primaryRows.every(row => Boolean(row.foreignTools.length) === baseline), 'Foreign project MCP catalog isolation differs from the expected source')
  const calls = primaryRows.flatMap(row => row.toolCalls)
  assert(calls.length > 0 && calls.every(name => name.startsWith('mcp__oc__')), 'Actual tool calls did not stay on the client catalog')
  assert(report.requests.some(row => row.session === session.id && row.attested), 'Matching plugin did not attest the actual primary turn')
  report.scrubFinal = verifyOpenCodeScrub(await (await fetch(proxyUrl + '/plugins/list')).json(), scrub, true)
  const require = createRequire(join(repo, 'package.json')), sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')))
  const mappings = JSON.parse(readFileSync(join(root, 'sessions', 'sessions.json'), 'utf8'))
  const dirs = [...new Set(Object.values(mappings).map(row => row.currentTranscript?.configDir).filter(Boolean))]
  assert.equal(dirs.length, 1); assert(resolve(dirs[0]).startsWith(root + '/'))
  const previous = process.env.CLAUDE_CONFIG_DIR; report.stored = []
  try {
    process.env.CLAUDE_CONFIG_DIR = dirs[0]
    for (const id of new Set(report.native.map(row => row.session).filter(Boolean))) {
      await sdk.importSessionToStore(id, {async append(_key, rows) {
        report.stored.push(...rows.filter(row => row.type === 'assistant').map(row => ({id: row.message?.id, model: row.message?.model})))
      }}, {includeSubagents: false})
    }
  } finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous }
  for (const row of report.provider) {
    assert.equal(row.status, 200); assert.equal(row.responseModel, model)
    assert(report.native.some(native => native.id === row.responseId && native.model === model))
    assert(report.stored.some(stored => stored.id === row.responseId && stored.model === model))
  }
  assert(!report.observationError && !report.modelMismatch && !report.refusal && !report.capacityRejected && !report.inBandError)
  report.providerNativeStoredCorrelated = true
  report.result = baseline ? 'EXPECTED_BASELINE_FAILURE' : 'PASS'
} catch (error) { report.failure = String(error) } finally {
  stopped = true; for (const controller of controllers) controller.abort()
  if (server) { const actor = actors.find(actor => actor.child === server); if (actor) await stopAndJoinChild(actor.child, actor.witness, {graceMs: 5000}) }
  try { await proxy?.close() } catch (error) { report.result = 'FAIL'; report.closeFailure = String(error) }
  for (const listener of [upstream, foreignServer]) { listener.closeAllConnections(); await new Promise(done => listener.close(done)) }
  for (const actor of actors) report.actors.push(await stopAndJoinChild(actor.child, actor.witness, {graceMs: 5000}))
  report.joined = report.actors.every(actor => actor.joined)
  if (!report.joined || report.failure) report.result = 'FAIL'
  for (const [name, original] of originals) cp[name] = original
  syncBuiltinESMExports()
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({result: report.result, failure: report.failure, joined: report.joined, evidence: output}))
  process.exitCode = report.result === 'FAIL' ? 1 : 0
}
