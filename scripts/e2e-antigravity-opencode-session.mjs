// Actual OpenCode session controls against subscription-backed Antigravity.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { verifyImageClients } from './lib-antigravity-image-checks.mjs'
import { startProxyServer } from '../dist/server.js'

const root = await mkdtemp(join(tmpdir(), 'meridian-agy-opencode-session-'))
console.log(`Artifacts: ${root}`)
const modelID = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const binary = process.env.E2E_OPENCODE_BIN || 'opencode'
const capabilities = process.env.E2E_SESSION_CAPABILITIES === '1'
const model = { providerID: 'meridian-agy', modelID }
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(OPENCODE_|MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
env.HOME = join(root, 'home'); env.OPENCODE_CONFIG_DIR = join(root, 'config')
env.OPENCODE_DISABLE_AUTOUPDATE = '1'; env.OPENCODE_SERVER_PASSWORD = randomUUID()
await mkdir(env.HOME); await mkdir(env.OPENCODE_CONFIG_DIR)
const cliVersion = () => spawnSync(process.env.MERIDIAN_AGY_PATH || 'agy', ['--version'], { encoding: 'utf8' }).stdout.trim()
const report = { cli: cliVersion(), node: process.version, modelID, client: spawnSync(binary, ['--version'], { encoding: 'utf8' }).stdout.trim(), platform: process.platform, passed: [] }
let proxy, child, stdout = '', stderr = '', exited = false
const apiLog = []
try {
  let executable = process.env.MERIDIAN_AGY_PATH
  if (process.env.E2E_AGY_TRACE === '1') {
    executable = join(root, 'trace-agy.cjs')
    await writeFile(executable, `#!/usr/bin/env node
const {spawn}=require('node:child_process');const fs=require('node:fs');
const args=process.argv.slice(2);const trace=args.includes('--input-format');
const child=spawn(${JSON.stringify(process.env.MERIDIAN_AGY_PATH || 'agy')},args,{stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stderr.pipe(process.stderr);
child.stdin.on('error',e=>process.stderr.write(String(e)));
child.stdout.on('data',d=>{if(trace)fs.appendFileSync(${JSON.stringify(root)}+'/agy-'+process.pid+'.ndjson',d);process.stdout.write(d)});
if(trace)process.stdin.on('data',d=>fs.appendFileSync(${JSON.stringify(root)}+'/prompt-'+process.pid+'.json',d));
child.on('error',e=>{process.stderr.write(String(e));process.exitCode=1});child.on('close',code=>process.exit(code??1));
`)
    await chmod(executable, 0o700)
  }
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { allowToolBridge: true, executable } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const address = proxy.server.address(); assert(address && typeof address !== 'string')
  const proxyUrl = `http://127.0.0.1:${address.port}`
  await writeFile(join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), JSON.stringify({ model: `meridian-agy/${modelID}`, small_model: `meridian-agy/${modelID}`, enabled_providers: ['meridian-agy'], share: 'disabled', permission: capabilities ? { '*': 'deny', read: 'allow', StructuredOutput: 'allow' } : 'deny', provider: { 'meridian-agy': { npm: '@ai-sdk/anthropic', options: { baseURL: proxyUrl + '/v1', apiKey: 'local-fixture' }, models: { [modelID]: { name: modelID, limit: { context: 128000, output: 4096 }, temperature: false, reasoning: false, tool_call: true, modalities: { input: capabilities ? ['text', 'image'] : ['text'], output: ['text'] } } } } } }))
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk }); child.stderr.on('data', chunk => { stderr += chunk })
  child.once('close', () => { exited = true })
  let childError
  child.once('error', error => { childError = error })
  const readyBy = Date.now() + 30000
  while (!/http:\/\/127\.0\.0\.1:\d+/.test(stdout)) { assert(!childError && !exited && Date.now() < readyBy, String(childError || stderr)); await new Promise(resolve => setTimeout(resolve, 50)) }
  const base = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout)[0]
  async function api(path, body) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', authorization: `Basic ${Buffer.from(`opencode:${env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
    const text = await response.text()
    apiLog.push({ path, body, status: response.status, response: text })
    assert(response.ok, `${path}: ${response.status}: ${text}`)
    return text ? JSON.parse(text) : undefined
  }
  if (capabilities) await verifyImageClients({ root, api, model, proxyUrl, report })
  else {
  const session = await api('/session', { title: 'Antigravity session acceptance' })
  const path = `/session/${session.id}`
  async function prompt(text) {
    const result = await api(path + '/message', { model, parts: [{ type: 'text', text }] })
    assert(!result.info?.error, JSON.stringify(result))
    return result.parts.filter(part => part.type === 'text').map(part => part.text).join('\n')
  }
  const receipt = `RETAIN_${randomUUID()}`, removed = `REMOVE_${randomUUID()}`
  assert((await prompt(`Remember the receipt ${receipt}. Reply with it exactly. Do not use tools.`)).includes(receipt))
  assert((await prompt(`Temporary detour: reply exactly ${removed}. Do not use tools.`)).includes(removed))
  const messages = await api(path + '/message')
  const target = messages.find(message => message.info.role === 'user' && message.parts.some(part => part.text?.includes(removed)))
  assert(target)
  await api(path + '/revert', { messageID: target.info.id })
  const undone = await prompt('What was the RETAIN_ receipt? Return it only, without tools.')
  assert(undone.includes(receipt) && !undone.includes(removed), undone)
  report.passed.push('actual OpenCode undo and continuation preserve earlier context')
  console.log('PASS OpenCode undo')
  await api(path + '/summarize', model)
  const summarized = await api(path + '/message')
  assert(summarized.some(message => message.info.summary === true), 'No actual compaction summary was saved')
  assert((await prompt('Repeat the exact RETAIN_ receipt from our context. No tools.')).includes(receipt))
  report.passed.push('actual OpenCode compaction and continued recall')
  console.log('PASS OpenCode compaction')
  await api(path + '/prompt_async', { model, parts: [{ type: 'text', text: 'Write a 10000-word explanation of graph algorithms with worked examples. Do not use tools.' }] })
  const health = async () => (await fetch(proxyUrl + '/health')).json()
  const startedBy = Date.now() + 30000
  while ((await health()).processes === 0) { assert(Date.now() < startedBy, 'Request did not become active'); await new Promise(resolve => setTimeout(resolve, 50)) }
  await api(path + '/abort', {})
  const stoppedBy = Date.now() + 10000
  while ((await health()).processes) { assert(Date.now() < stoppedBy, 'OpenCode abort leaked a process'); await new Promise(resolve => setTimeout(resolve, 50)) }
  assert((await prompt('Reply exactly OPENCODE_RECOVERED. No tools.')).includes('OPENCODE_RECOVERED'))
  report.passed.push('actual OpenCode cancellation releases process and next prompt succeeds')
  }
  assert.equal(cliVersion(), report.cli, "CLI version changed during verification")
  console.log(JSON.stringify(report, null, 2))
} catch (error) { report.error = String(error); throw error }
finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'api.json'), JSON.stringify(apiLog, null, 2))
  await writeFile(join(root, 'opencode.stdout'), stdout); await writeFile(join(root, 'opencode.stderr'), stderr)
  if (child && !exited) {
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 1000)
    await once(child, 'close').finally(() => clearTimeout(timer))
  }
  await proxy?.close()
}
