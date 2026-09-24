import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { spyOn } from 'bun:test'

const meridianRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginPath = process.env.E2E_PLUGIN_PATH
assert(pluginPath, 'Set E2E_PLUGIN_PATH to an installed OpenCode scrub plugin entrypoint')
const model = process.env.E2E_MODEL ?? 'claude-haiku-4-5'
const expectScrub = process.env.E2E_EXPECT_SCRUB !== '0'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'opencode-scrub-live-')))
console.log(JSON.stringify({ artifact: root }))
const clientConfig = join(root, 'opencode-config')
const meridianConfig = join(root, 'meridian-config')
const project = join(root, 'client-project')
for (const path of [clientConfig, meridianConfig, project]) mkdirSync(path)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: meridianConfig,
  MERIDIAN_SESSION_DIR: join(root, 'meridian-sessions'),
  MERIDIAN_TELEMETRY_PERSIST: '0',
})
globalThis.__opencodeScrubPre = []
globalThis.__opencodeScrubPost = []
const probePath = join(root, 'before.js')
writeFileSync(probePath, `export default { name: 'before-opencode-scrub', onRequest(ctx) { globalThis.__opencodeScrubPre.push({ adapter: ctx.adapter, hasPowered: (ctx.systemContext || '').includes('You are powered by the model named'), hasEnvPreamble: (ctx.systemContext || '').includes('Here is some useful information about the environment you are running in:') }); return ctx } }`)
const postProbePath = join(root, 'after.js')
writeFileSync(postProbePath, `export default { name: 'after-opencode-scrub', onRequest(ctx) { globalThis.__opencodeScrubPost.push({ adapter: ctx.adapter, hasPowered: (ctx.systemContext || '').includes('You are powered by the model named'), hasEnvPreamble: (ctx.systemContext || '').includes('Here is some useful information about the environment you are running in:'), hasWorkingDirectory: (ctx.systemContext || '').includes('Working directory:') }); return ctx } }`)
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [
  { path: probePath, enabled: true },
  { path: pluginPath, enabled: true },
  { path: postProbePath, enabled: true },
] }))
const require = createRequire(join(meridianRoot, 'package.json'))
const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const originalQuery = sdk.query
const observed = []
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  const system = input.options.systemPrompt
  const append = typeof system === 'string' ? system : (system?.append ?? '')
  observed.push({
    hasPowered: append.includes('You are powered by the model named'),
    hasEnvPreamble: append.includes('Here is some useful information about the environment you are running in:'),
    hasClientCwd: append.includes(project),
  })
  return originalQuery(input)
})

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitReady(url, child) {
  const until = Date.now() + 45000
  while (Date.now() < until) {
    if (child.exitCode !== null) throw Error(`LiteLLM exited ${child.exitCode}`)
    try { const response = await fetch(url, { signal: AbortSignal.timeout(1000) }); if (response.ok) return } catch {}
    await new Promise(resolve => setTimeout(resolve, 350))
  }
  throw Error('LiteLLM did not become ready')
}

const { startProxyServer } = await import(pathToFileURL(join(meridianRoot, 'dist/server.js')).href)
let proxy, litellm
let litellmStdout = '', litellmStderr = ''
try {
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, pluginConfigPath, pluginDir: join(root, 'plugins') })
  const meridianPort = proxy.server.address().port
  const list = await (await fetch(`http://127.0.0.1:${meridianPort}/plugins/list`)).json()
  const loadedPlugin = list.plugins.find(p => p.name === 'opencode-scrub')
  assert.equal(loadedPlugin?.status, 'active')
  if (process.env.E2E_EXPECT_VERSION) assert.equal(loadedPlugin.version, process.env.E2E_EXPECT_VERSION)
  const litellmPort = await freePort()
  const litellmConfig = join(root, 'litellm.yaml')
  writeFileSync(litellmConfig, `model_list:\n  - model_name: ${model}\n    litellm_params:\n      model: anthropic/${model}\n      api_base: http://127.0.0.1:${meridianPort}\n      api_key: local-fixture\ngeneral_settings:\n  master_key: sk-local-gate\n`)
  const liteEnv = { ...process.env, LITELLM_TELEMETRY: 'False' }
  for (const key of Object.keys(liteEnv)) if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete liteEnv[key]
  litellm = spawn(process.env.E2E_LITELLM_BIN ?? 'litellm', ['--config', litellmConfig, '--host', '127.0.0.1', '--port', String(litellmPort), '--num_workers', '1', '--telemetry', 'False'], { cwd: root, env: liteEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  litellm.stdout.setEncoding('utf8'); litellm.stderr.setEncoding('utf8')
  litellm.stdout.on('data', chunk => { litellmStdout += chunk })
  litellm.stderr.on('data', chunk => { litellmStderr += chunk })
  await waitReady(`http://127.0.0.1:${litellmPort}/health/liveliness`, litellm)
  writeFileSync(join(clientConfig, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: `litellm/${model}`,
    small_model: `litellm/${model}`,
    enabled_providers: ['litellm'],
    share: 'disabled',
    permission: 'allow',
    provider: { litellm: { npm: '@ai-sdk/anthropic', name: 'LiteLLM', options: { baseURL: `http://127.0.0.1:${litellmPort}/v1`, apiKey: 'sk-local-gate' }, models: { [model]: { name: model, limit: { context: 200000, output: 512 }, modalities: { input: ['text'], output: ['text'] }, temperature: false, reasoning: false, tool_call: true } } } },
  }))
  const clientEnv = { ...process.env, OPENCODE_CONFIG_DIR: clientConfig, OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) clientEnv[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
  for (const key of Object.keys(clientEnv)) if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete clientEnv[key]
  const opencode = spawn('opencode', ['run', '--pure', '--format', 'json', '--model', `litellm/${model}`, 'Reply briefly with READY. Do not use tools.'], { cwd: project, env: clientEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  opencode.stdout.setEncoding('utf8'); opencode.stderr.setEncoding('utf8')
  opencode.stdout.on('data', chunk => { stdout += chunk })
  opencode.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => opencode.kill('SIGTERM'), 180000)
  const exit = await new Promise((resolve, reject) => { opencode.once('error', reject); opencode.once('exit', resolve) }).finally(() => clearTimeout(timeout))
  writeFileSync(join(root, 'opencode.stdout'), stdout)
  writeFileSync(join(root, 'opencode.stderr'), stderr)
  if (expectScrub) {
    assert.equal(exit, 0, `OpenCode exited ${exit}; see ${root}/opencode.stderr`)
    assert(stdout.includes('READY'), `No READY response; see ${root}/opencode.stdout`)
  } else {
    assert.equal(exit, 1, `Expected a rejected baseline request; see ${root}/opencode.stdout`)
    assert(/billing_error|extra usage/.test(stdout), `Expected the reported billing gate; see ${root}/opencode.stdout`)
  }
  assert(globalThis.__opencodeScrubPre.some(entry => entry.adapter === 'passthrough' && entry.hasPowered && entry.hasEnvPreamble), JSON.stringify(globalThis.__opencodeScrubPre))
  assert(globalThis.__opencodeScrubPost.length > 0)
  assert(observed.length > 0)
  if (expectScrub) {
    assert(globalThis.__opencodeScrubPost.every(entry => !entry.hasPowered && !entry.hasEnvPreamble), JSON.stringify(globalThis.__opencodeScrubPost))
    assert(globalThis.__opencodeScrubPost.some(entry => entry.hasWorkingDirectory), JSON.stringify(globalThis.__opencodeScrubPost))
  }
  else assert(globalThis.__opencodeScrubPost.some(entry => entry.hasPowered && entry.hasEnvPreamble), JSON.stringify(globalThis.__opencodeScrubPost))
  console.log(JSON.stringify({ result: 'PASS', root, expectedOutcome: expectScrub ? 'model response' : 'billing gate', versions: { opencode: '1.18.32', litellm: '1.81.10', meridian: '1.76.3' }, model, before: globalThis.__opencodeScrubPre, after: globalThis.__opencodeScrubPost, sdkQueries: observed }))
} finally {
  if (litellm) {
    litellm.kill('SIGTERM')
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  writeFileSync(join(root, 'litellm.stdout'), litellmStdout)
  writeFileSync(join(root, 'litellm.stderr'), litellmStderr)
  if (proxy) await proxy.close()
  observer.mockRestore()
}
