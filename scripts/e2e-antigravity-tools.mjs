// Real coding-tool acceptance gate. Uses subscription quota through official agy.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { once } from 'node:events'
import { startProxyServer } from '../dist/server.js'

const root = await mkdtemp(join(tmpdir(), 'meridian-agy-tools-'))
const project = join(root, 'client'), config = join(root, 'pi-config')
await mkdir(project); await mkdir(config)
console.log(`Artifacts: ${root}`)
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const executable = process.env.MERIDIAN_AGY_PATH || 'agy'
const version = binary => {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return (result.stdout || result.stderr).trim()
}
const pi = process.env.E2E_PI_BIN || 'pi'
const report = { model, cli: version(executable), pi: version(pi), platform: process.platform, node: process.version, passed: [] }
let proxy, relay
const observed = []
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const address = proxy.server.address()
  assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  relay = createServer(async (req, res) => {
    const abort = new AbortController()
    res.once('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      observed.push(JSON.parse(raw))
      const response = await fetch(url + req.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw, signal: abort.signal })
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') })
      Readable.fromWeb(response.body).on('error', error => res.destroy(error)).pipe(res)
    } catch (error) {
      if (!res.headersSent) res.writeHead(500)
      res.end(String(error))
    }
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const relayAddress = relay.address()
  assert(relayAddress && typeof relayAddress !== 'string')
  await writeFile(join(config, 'models.json'), JSON.stringify({ providers: { 'meridian-agy': { baseUrl: `http://127.0.0.1:${relayAddress.port}`, apiKey: 'local-fixture', api: 'anthropic-messages', models: [{ id: model, name: model, reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }))
  const receipt = `工具_🧪_${randomUUID()}`
  const sourcePath = join(project, 'café-🧪.cjs'), missingPath = join(project, 'missing.cjs'), outputPath = join(project, 'résultat-你好.txt')
  const source = `const count = 2;\nconsole.log(${JSON.stringify(receipt)} + ':' + (count * 7));\n`
  await writeFile(sourcePath, source)
  const prompt = `Complete this coding task using only your client's read, edit, bash and write tools. First try reading ${missingPath}. That file deliberately does not exist: recover from the read error by reading ${sourcePath}. Edit that actual file with your edit tool, changing only "const count = 2;" to "const count = 3;". Use bash to execute the edited file with node. Write the exact stdout, including its trailing newline, to ${outputPath} with your write tool. Finally report the program output. Do not create the missing file, guess the receipt, or use built-in Antigravity tools.`
  const env = { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
  const args = ['--provider', 'meridian-agy', '--model', model, '--thinking', 'off', '--tools', 'read,edit,bash,write', '--no-session', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--system-prompt', 'Complete the coding task using the client tools. Treat expected tool errors as recoverable. Preserve Unicode and exact file content.', '-p', prompt]
  const child = spawn(pi, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const terminate = signal => {
    if (!child.pid) return
    try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
  }
  let killTimer
  const timer = setTimeout(() => { terminate('SIGTERM'); killTimer = setTimeout(() => terminate('SIGKILL'), 1000) }, 240000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }).finally(() => { clearTimeout(timer); clearTimeout(killTimer) })
  await writeFile(join(root, 'pi.stdout'), stdout); await writeFile(join(root, 'pi.stderr'), stderr)
  assert.equal(code, 0, stderr)
  assert.equal(await readFile(sourcePath, 'utf8'), source.replace('const count = 2;', 'const count = 3;'))
  assert.equal(await readFile(outputPath, 'utf8'), `${receipt}:21\n`)
  assert(stdout.includes(`${receipt}:21`), stdout + stderr)
  const calls = new Map(), results = new Map()
  for (const body of observed) for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.set(block.id, block)
      if (block.type === 'tool_result') results.set(block.tool_use_id, block)
    }
  }
  const first = calls.values().next().value
  assert.equal(first?.name, 'read')
  assert(JSON.stringify(first.input).includes(missingPath))
  assert.equal(results.get(first.id)?.is_error, true, 'Missing-file failure must reach the model as a tool error')
  for (const name of ['read', 'edit', 'bash', 'write']) assert([...calls.values()].some(call => call.name === name), `Actual Pi ${name} tool must run`)
  const shell = [...calls.values()].find(call => call.name === 'bash')
  assert(JSON.stringify(results.get(shell.id)?.content).includes(`${receipt}:21`), 'Computed receipt must return through the shell tool result')
  assert.equal(results.size, calls.size, 'Every observed tool call must receive its correlated result')
  assert(observed.every(body => body.stream === true), 'Actual Pi must use streaming')
  report.requests = observed.length
  report.tools = [...calls.values()].map(call => ({ name: call.name, isError: results.get(call.id)?.is_error === true }))
  report.passed.push('actual Pi read/edit/bash/write coding loop', 'missing-file tool-error recovery', 'exact source edit', 'Unicode paths and exact Unicode output with trailing newline', 'streaming correlated tool results')
  assert.equal(version(executable), report.cli, 'CLI version changed during verification')
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  await writeFile(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await proxy?.close()
  if (relay) { relay.closeAllConnections(); await new Promise(resolve => relay.close(resolve)) }
}
