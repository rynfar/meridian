// Actual OpenCode MCP discovery/execution through the official signed-in agy CLI.
// Credentials remain with agy. Each run owns its client config, catalog and files.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'

const { startProxyServer } = await import(pathToFileURL(resolve(process.env.E2E_SERVER_MODULE || 'dist/server.js')).href)
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-catalog-'))
console.log('Artifacts: ' + root)
const model = 'gemini-3.8-flash-high'
const executable = process.env.MERIDIAN_AGY_PATH || 'agy'
const client = process.env.E2E_OPENCODE_BIN || 'opencode'
const count = Number(process.env.E2E_CATALOG_SIZE || 129)
const expectRejection = process.env.E2E_EXPECT_TOOL_LIMIT === '1'
assert([129, 256].includes(count))
function version(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 20000 })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
assert.equal(version(executable), '1.5.13')
assert.equal(version(client), '1.18.30')
const receipt = 'MCP-CATALOG-' + randomUUID()
const config = join(root, 'config'), project = join(root, 'project'), calls = join(root, 'calls.jsonl'), lifecycle = join(root, 'mcp-lifecycle.jsonl')
await mkdir(config); await mkdir(project)
await writeFile(join(project, 'receipt.txt'), receipt, { mode: 0o600 })
const roster = join(root, 'roster.cjs')
await writeFile(roster, `const fs=require('node:fs'),readline=require('node:readline');
const first=Number(process.argv[2]),last=Number(process.argv[3]);
const record=phase=>fs.appendFileSync(${JSON.stringify(lifecycle)},JSON.stringify({phase,pid:process.pid,first,last})+'\\n',{mode:0o600});
record('started');process.on('exit',()=>record('exited'));
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 let result;
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'owned-catalog',version:'1'}};
 else if(m.method==='tools/list')result={tools:Array.from({length:last-first+1},(_,i)=>({name:'probe_'+(first+i),description:'Return the exact output of the owned coding integration fixture '+(first+i),inputSchema:{type:'object',properties:{},additionalProperties:false}}))};
 else if(m.method==='tools/call'){
  const target=m.params.name==='probe_${count}';
  fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({name:m.params.name,target})+'\\n',{mode:0o600});
  result={content:[{type:'text',text:target?fs.readFileSync(${JSON.stringify(join(project, 'receipt.txt'))},'utf8'):'Not the requested fixture'}],isError:!target};
 }else if(m.method==='ping')result={};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Unsupported method'}})+'\\n');return}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});
`, { mode: 0o600 })
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(OPENCODE_|MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env['XDG_' + kind + '_HOME'] = join(root, kind.toLowerCase())
env.HOME = join(root, 'home'); env.OPENCODE_CONFIG_DIR = config; env.OPENCODE_DISABLE_AUTOUPDATE = '1'
await mkdir(env.HOME)
const requests = [], errors = []
let proxy, relay, child, clientClosed, stdout = '', stderr = '', launchError
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, host: '127.0.0.1', silent: true,
    antigravity: { executable, allowToolBridge: true, reuseConversations: false } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const upstream = 'http://127.0.0.1:' + proxy.server.address().port
  const discovery = await (await fetch(upstream + '/v1/models')).json()
  assert(discovery.data.some(item => item.id === model), 'Requested native model is unavailable')
  relay = createServer(async (req, res) => {
    const abort = new AbortController()
    res.once('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8'), body = raw ? JSON.parse(raw) : undefined
      if (body?.messages) requests.push(body)
      const response = await fetch(upstream + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw || undefined, signal: abort.signal })
      if (!response.ok) errors.push({ status: response.status, toolLimit: (await response.clone().text()).includes('<=128') })
      res.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end()
    } catch (error) { if (!res.headersSent) res.writeHead(502); res.end(String(error)) }
  })
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening')
  await writeFile(join(config, 'opencode.json'), JSON.stringify({ model: 'meridian-agy/' + model,
    small_model: 'meridian-agy/' + model, enabled_providers: ['meridian-agy'], share: 'disabled', permission: 'allow',
    mcp: { catalog_a: { type: 'local', command: [process.execPath, roster, '1', '128'], enabled: true },
      catalog_z: { type: 'local', command: [process.execPath, roster, '129', String(count)], enabled: true } },
    provider: { 'meridian-agy': { npm: '@ai-sdk/anthropic', options: { baseURL: 'http://127.0.0.1:' + relay.address().port + '/v1', apiKey: 'owned-loopback' },
      models: { [model]: { name: model, limit: { context: 128000, output: 2048 }, temperature: false, reasoning: false, tool_call: true, modalities: { input: ['text'], output: ['text'] } } } } } }), { mode: 0o600 })
  child = spawn(client, ['run', '--format', 'json', '--title', 'owned-tool-catalog', '--model', 'meridian-agy/' + model,
    `Check the exact output of coding integration fixture ${count} by calling catalog_z_probe_${count} once with {}. Reply with its exact output only. Do not use any other tools or guess the output.`],
  { cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  clientClosed = new Promise(resolve => child.once('close', resolve))
  child.once('error', error => { launchError = error })
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  const deadline = Date.now() + 240000
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    if (launchError) throw launchError
    assert(stdout.length + stderr.length < 4 * 1024 * 1024, 'Client output exceeded fixture bound')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.notEqual(child.exitCode, null, 'Actual client did not complete')
  await clientClosed
  assert(requests.length > 0)
  const initial = requests.find(request => request.tools?.length), names = initial?.tools.map(tool => tool.name)
  assert(names, 'Actual client never sent its tool catalog')
  assert.equal(initial.model, model)
  const target = names.find(name => name.endsWith('catalog_z_probe_' + count))
  assert(target, 'Actual MCP target is missing from the client catalog')
  assert(names.indexOf(target) >= 128, 'Target did not exercise the formerly excluded catalog tail')
  assert.equal(names.filter(name => /catalog_[az]_probe_\d+$/.test(name)).length, count)
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  const delivered = events.filter(event => event.type === 'text').map(event => event.part?.text || '').join('').includes(receipt)
  let invocations = []
  try { invocations = (await readFile(calls, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (expectRejection) {
    assert.equal(child.exitCode, 1); assert(!delivered); assert.equal(invocations.length, 0)
    assert(errors.some(error => error.status === 400 && error.toolLimit), 'Baseline failed for a different reason')
  } else {
    assert.equal(child.exitCode, 0); assert(delivered, 'Actual client did not return the tool-only receipt')
    assert.equal(errors.length, 0)
    assert.deepEqual(invocations, [{ name: 'probe_' + count, target: true }])
    assert(requests.slice(1).some(request => request.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result' && JSON.stringify(block.content).includes(receipt)))), 'Actual client tool result did not return through Meridian')
  }
  const negativeControls = []
  if (!expectRejection) {
    for (const [label, tools, message] of [
      ['invalid-name', [...initial.tools, { name: 'invalid.name', input_schema: {} }], 'Invalid string'],
      ['duplicate-name', [...initial.tools, initial.tools[0]], 'Duplicate tool names'],
      ['malformed-schema', [...initial.tools, { name: 'invalid_schema', input_schema: { type: 'not-a-json-schema-type' } }], 'Invalid or unsupported JSON Schema'],
    ]) {
      const response = await fetch(upstream + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...initial, tools, stream: false }) })
      assert.equal(response.status, 400, label)
      assert((await response.text()).includes(message), label + ' failed for a different reason')
      negativeControls.push(label)
    }
  }
  const mcpEvents = (await readFile(lifecycle, 'utf8')).trim().split('\n').map(JSON.parse)
  const mcpPids = mcpEvents.filter(event => event.phase === 'started').map(event => event.pid)
  assert.equal(mcpPids.length, 2)
  const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error } }
  const mcpDeadline = Date.now() + 5000
  while (mcpPids.some(alive) && Date.now() < mcpDeadline) await new Promise(resolve => setTimeout(resolve, 50))
  assert(!mcpPids.some(alive), 'A recorded client MCP process survived frontend exit')
  const state = await (await fetch(upstream + '/health')).json()
  assert.equal(state.processes, 0); assert.equal(state.preparing, 0)
  await proxy.close()
  assert.equal(proxy.server.listening, false)
  const report = { result: 'PASS', catalogSize: count, actualToolCount: names.length, targetIndex: names.indexOf(target), model,
    client: version(client), cli: version(executable), platform: process.platform, arch: process.arch, node: process.version,
    expectRejection, frontendExit: child.exitCode, delivered, targetInvocations: invocations.length, clientRequests: requests.length,
    returnedClientToolResult: !expectRejection, negativeControls, clientMcpServersExited: true, joinedBackendCleanup: true }
  await writeFile(join(root, 'proof.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report))
} finally {
  await writeFile(join(root, 'client.stdout'), stdout, { mode: 0o600 }); await writeFile(join(root, 'client.stderr'), stderr, { mode: 0o600 })
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests), { mode: 0o600 })
  if (child && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error }
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error } }, 1000)
    await clientClosed; clearTimeout(timer)
  }
  if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)) }
  if (proxy) await proxy.close()
}
