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
import { verifyPiSession } from './lib-antigravity-pi-rpc.mjs'
import { startProxyServer } from '../dist/server.js'

const client = process.env.E2E_CLIENT || 'pi'
assert(['pi', 'opencode'].includes(client))
const root = await mkdtemp(join(tmpdir(), `meridian-agy-${client}-`))
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
const pi = client === 'pi' ? process.env.E2E_PI_BIN || 'pi' : process.env.E2E_OPENCODE_BIN || 'opencode'
const report = { model, cli: version(executable), client, clientVersion: version(pi), platform: process.platform, node: process.version, passed: [] }
let proxy, relay
const observed = []
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const address = proxy.server.address()
  assert(address && typeof address !== 'string')
  let url = `http://127.0.0.1:${address.port}`
  let restarted = false
  relay = createServer(async (req, res) => {
    const abort = new AbortController()
    res.once('close', () => { if (!res.writableFinished) abort.abort() })
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw) observed.push(JSON.parse(raw))
      const body = raw ? JSON.parse(raw) : undefined
      const returned = body?.messages?.at(-1)?.content
      if (process.env.E2E_AGY_RECOVERY === '1' && !restarted && Array.isArray(returned) && returned.some(block => block.type === 'tool_result' && !block.is_error)) {
        restarted = true
        await proxy.close()
        proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true } })
        if (!proxy.server.listening) await once(proxy.server, 'listening')
        const replacement = proxy.server.address()
        assert(replacement && typeof replacement !== 'string')
        url = `http://127.0.0.1:${replacement.port}`
        report.restartedBeforeRequest = observed.length
        report.recoveredToolIds = returned.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)
        console.log('Restarted backend before forwarding completed client tool result')
      }
      await writeFile(join(root, 'requests.json'), JSON.stringify(observed, null, 2))
      const response = await fetch(url + req.url, { method: req.method, headers: { 'content-type': 'application/json' }, body: raw || undefined, signal: abort.signal })
      if (response.status >= 400) console.log('HTTP', response.status, await response.clone().text())
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
  await writeFile(join(config, 'settings.json'), JSON.stringify({ compaction: { enabled: false, reserveTokens: 2048, keepRecentTokens: 512 }, retry: { enabled: false } }))
  const receipt = `工具_🧪_${randomUUID()}`
  const sourcePath = join(project, 'café-🧪.cjs'), missingPath = join(project, 'missing.cjs'), outputPath = join(project, 'résultat-你好.txt')
  const source = `const count = 2;\nconsole.log(${JSON.stringify(receipt)} + ':' + (count * 7));\n`
  await writeFile(sourcePath, source)
  const prompt = `Complete this coding task using only your client's read, edit, bash and write tools. First try reading ${missingPath}. That file deliberately does not exist: recover from the read error by reading ${sourcePath}. Edit that actual file with your edit tool, changing only "const count = 2;" to "const count = 3;". Use bash to execute the edited file with node. Write the exact stdout, including its trailing newline, to ${outputPath} with your write tool. Then use bash with a Node assertion to compare the output file byte-for-byte against executing the source; if verification fails, correct it with write and verify again. A newline is a real newline, not literal backslash-n. Finally report the program output. Do not create the missing file, guess the receipt, or use built-in Antigravity tools.`
  const env = { ...process.env, PI_CODING_AGENT_DIR: config, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|GEMINI_API_KEY|GOOGLE_API_KEY)/.test(key)) delete env[key]
  let args = ['--provider', 'meridian-agy', '--model', model, '--thinking', 'off', '--tools', 'read,edit,bash,write,grep,find,ls', '--session', join(root, 'pi-session.jsonl'), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--system-prompt', 'Complete the coding task using the client tools. Treat expected tool errors as recoverable. Preserve Unicode and exact file content.', '-p', prompt]
  if (client === 'opencode') {
    for (const key of Object.keys(env)) if (/^(OPENCODE_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete env[key]
    for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
    env.HOME = join(root, 'client-home')
    await mkdir(env.HOME)
    env.OPENCODE_CONFIG_DIR = config
    env.OPENCODE_DISABLE_AUTOUPDATE = '1'
    const settings = { $schema: 'https://opencode.ai/config.json', model: `meridian-agy/${model}`, small_model: `meridian-agy/${model}`, enabled_providers: ['meridian-agy'], share: 'disabled', permission: 'allow', provider: { 'meridian-agy': { npm: '@ai-sdk/anthropic', name: 'Antigravity through Meridian', options: { baseURL: `http://127.0.0.1:${relayAddress.port}/v1`, apiKey: 'local-fixture' }, models: { [model]: { name: model, limit: { context: 128000, output: 4096 }, modalities: { input: ['text'], output: ['text'] }, temperature: false, reasoning: false, tool_call: true } } } } }
    if (process.env.E2E_AGY_EFFORT_MODEL) settings.provider['meridian-agy'].models[process.env.E2E_AGY_EFFORT_MODEL] = { ...settings.provider['meridian-agy'].models[model], options: { thinking: { type: 'adaptive' }, effort: 'high' } }
    await writeFile(join(config, 'opencode.json'), JSON.stringify(settings))
    args = ['run', '--pure', '--format', 'json', '--model', `meridian-agy/${model}`, prompt]
  }
  async function run(runArgs, label) {
    const child = spawn(pi, runArgs, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
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
    await writeFile(join(root, `${client}-${label}.stdout`), stdout); await writeFile(join(root, `${client}-${label}.stderr`), stderr)
    assert.equal(code, 0, stderr)
    return stdout
  }
  const stdout = await run(args, "coding")
  assert.equal(await readFile(sourcePath, 'utf8'), source.replace('const count = 2;', 'const count = 3;'))
  assert.equal(await readFile(outputPath, 'utf8'), `${receipt}:21\n`)
  assert(stdout.includes(`${receipt}:21`), stdout)
  const calls = new Map(), results = new Map()
  for (const body of observed) for (const message of body.messages) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.set(block.id, block)
      if (block.type === 'tool_result') results.set(block.tool_use_id, block)
    }
  }
  const first = [...calls.values()].find(call => call.name === 'read' && JSON.stringify(call.input).includes(missingPath))
  assert.equal(first?.name, 'read')
  assert(JSON.stringify(first.input).includes(missingPath))
  assert.equal(results.get(first.id)?.is_error, true, 'Missing-file failure must reach the model as a tool error')
  for (const name of ['read', 'edit', 'bash', 'write']) assert([...calls.values()].some(call => call.name === name), `Actual ${client} ${name} tool must run`)
  const shell = [...calls.values()].find(call => call.name === 'bash')
  assert(JSON.stringify(results.get(shell.id)?.content).includes(`${receipt}:21`), 'Computed receipt must return through the shell tool result')
  assert.equal(results.size, calls.size, 'Every observed tool call must receive its correlated result')
  assert(observed.every(body => body.stream === true), `Actual ${client} must use streaming`)
  if (process.env.E2E_AGY_RECOVERY === '1') {
    assert(restarted, 'Recovery mode must replace the backend before a completed tool result')
    // The completed successful read must not be emitted again after restart.
    const recoveredCall = calls.get(report.recoveredToolIds[0])
    assert(recoveredCall)
    assert.equal([...calls.values()].filter(call => call.name === recoveredCall.name && JSON.stringify(call.input) === JSON.stringify(recoveredCall.input)).length, 1, 'Recovery must not repeat the already completed tool')
    report.passed.push('backend restart between client tool execution and result delivery; no repeated completed tool')
  }
  report.requests = observed.length
  report.tools = [...calls.values()].map(call => ({ name: call.name, isError: results.get(call.id)?.is_error === true }))
  report.passed.push(`actual ${client} read/edit/bash/write coding loop`, 'missing-file tool-error recovery', 'exact source edit', 'Unicode paths and exact Unicode output with trailing newline', 'streaming correlated tool results')
  const followupPrompt = 'Without using any tools, repeat the exact program output you just obtained, including the numeric suffix.'
  let followupArgs, forkArgs
  if (client === 'pi') {
    followupArgs = [...args.slice(0, -1), followupPrompt]
    forkArgs = [...followupArgs]
    forkArgs[forkArgs.indexOf('--session')] = '--fork'
  } else {
    const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
    const session = events.find(event => event.sessionID)?.sessionID
    assert(session, 'OpenCode must save a session')
    followupArgs = [...args.slice(0, -1), '--session', session, followupPrompt]
    forkArgs = [...followupArgs.slice(0, -1), '--fork', followupPrompt]
  }
  const resumed = await run(followupArgs, 'resume')
  assert(resumed.includes(`${receipt}:21`), resumed)
  report.passed.push('saved client session continuation with completed tool history')
  const forked = await run(forkArgs, 'fork')
  assert(forked.includes(`${receipt}:21`), forked)
  report.passed.push('client session fork retains completed tool context')
  const searchTools = client === 'pi' ? ['ls', 'find', 'grep'] : ['glob', 'grep', 'task']
  const searchPrompt = client === 'pi'
    ? `Use ls to list ${project}, then find to locate *.cjs there, then grep to find the line containing "const count" in the source file. Report that line. Use each of those three tools; do not edit any files.`
    : `Use glob to locate *.cjs in ${project}, then grep to find "const count" in that source file. Then use your client-owned task tool with subagent_type general to read ${outputPath} and report its exact contents. Do not write or edit anything. Return the count line and the receipt reported by that subagent.`
  const searchStart = observed.length
  const searchResult = await run([...followupArgs.slice(0, -1), searchPrompt], 'search')
  assert(searchResult.includes('const count'), searchResult)
  const searchCalls = observed.slice(searchStart).flatMap(body => body.messages).flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_use')
  for (const name of searchTools) assert(searchCalls.some(call => call.name === name), `Expected actual ${client} ${name} tool`)
  if (client === 'opencode') {
    assert(searchResult.includes(`${receipt}:21`), searchResult)
    const task = searchCalls.find(call => call.name === 'task')
    const returned = observed.slice(searchStart).flatMap(body => body.messages).flatMap(message => Array.isArray(message.content) ? message.content : []).find(block => block.type === 'tool_result' && block.tool_use_id === task.id)
    assert(returned && !returned.is_error && JSON.stringify(returned.content).includes(`${receipt}:21`), 'Subagent receipt must return through the actual task result')
  }
  report.passed.push(`actual ${client} ${searchTools.join('/')} tools${client === 'opencode' ? ' including a client-owned subagent' : ''}`)
  if (client === 'opencode' && process.env.E2E_AGY_EFFORT_MODEL) {
    const effortArgs = ['run', '--pure', '--format', 'json', '--model', `meridian-agy/${process.env.E2E_AGY_EFFORT_MODEL}`, 'Reply with exactly EFFORT_READY. Do not use tools.']
    const effortStart = observed.length
    const answer = await run(effortArgs, 'effort')
    assert(answer.includes('EFFORT_READY'), answer)
    assert(observed.slice(effortStart).some(body => body.output_config?.effort === 'high'), 'OpenCode must send native effort')
    report.passed.push('actual OpenCode high effort on the matching Gemini high model variant')
  }
  report.totalRequests = observed.length
  if (client === 'pi') await verifyPiSession({ binary: pi, args, env, project, root, url, report })
  assert.equal(version(executable), report.cli, 'CLI version changed during verification')
  report.totalRequests = observed.length
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
