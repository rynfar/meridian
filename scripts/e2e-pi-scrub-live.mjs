import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { spyOn } from 'bun:test'

const meridianRoot = fileURLToPath(new URL('..', import.meta.url))
const meridianVersion = JSON.parse(readFileSync(join(meridianRoot, 'package.json'), 'utf8')).version
if (process.env.E2E_EXPECT_MERIDIAN_VERSION) assert.equal(meridianVersion, process.env.E2E_EXPECT_MERIDIAN_VERSION)
const pluginPath = process.env.E2E_PLUGIN_PATH
assert(pluginPath, 'Set E2E_PLUGIN_PATH to an installed Pi scrub plugin entrypoint')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'pi-scrub-live-')))
const clientConfig = join(root, 'pi-config')
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
globalThis.__piScrubPre = []
const probePath = join(root, 'before.js')
writeFileSync(probePath, `export default { name: 'before-pi-scrub', onRequest(ctx) { globalThis.__piScrubPre.push({ hasPiIdentity: (ctx.systemContext || '').includes('operating inside pi, a coding agent harness'), hasPiDocs: (ctx.systemContext || '').includes('Pi documentation') }); return ctx } }`)
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [
  { path: probePath, enabled: true },
  { path: pluginPath, enabled: true },
] }))

const require = createRequire(join(meridianRoot, 'package.json'))
const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const originalQuery = sdk.query
const observed = []
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  const system = input.options.systemPrompt
  const append = typeof system === 'string' ? system : (system?.append ?? '')
  observed.push({
    hasPiIdentity: append.includes('operating inside pi, a coding agent harness'),
    hasPiDocs: append.includes('Pi documentation'),
    hasGenericIdentity: append.includes('You are an expert coding assistant.'),
  })
  return originalQuery(input)
})

const { startProxyServer } = await import(pathToFileURL(join(meridianRoot, 'dist/server.js')).href)
let proxy
try {
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, pluginConfigPath, pluginDir: join(root, 'plugins') })
  const port = proxy.server.address().port
  const pluginsResponse = await fetch(`http://127.0.0.1:${port}/plugins/list`)
  assert.equal(pluginsResponse.status, 200)
  const list = await pluginsResponse.json()
  const loadedPlugin = list.plugins.find(p => p.name === 'pi-scrub')
  assert.equal(loadedPlugin?.status, 'active')
  if (process.env.E2E_EXPECT_VERSION) assert.equal(loadedPlugin.version, process.env.E2E_EXPECT_VERSION)
  writeFileSync(join(clientConfig, 'models.json'), JSON.stringify({ providers: {
    'meridian-local': { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'local-fixture', api: 'anthropic-messages', models: [
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ] },
  } }))
  writeFileSync(join(clientConfig, 'settings.json'), JSON.stringify({ retry: { enabled: false } }))
  const env = { ...process.env, PI_CODING_AGENT_DIR: clientConfig, PI_OFFLINE: '1', PI_TELEMETRY: '0' }
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete env[key]
  }
  const args = ['--provider', 'meridian-local', '--model', 'claude-haiku-4-5', '--thinking', 'off', '--no-builtin-tools', '--session', join(root, 'pi-session.jsonl'), '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '-p', 'Reply briefly with READY.']
  const child = spawn('pi', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000)
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }).finally(() => clearTimeout(timeout))
  writeFileSync(join(root, 'pi.stdout'), stdout)
  writeFileSync(join(root, 'pi.stderr'), stderr)
  assert.equal(exit, 0, stderr)
  assert(stdout.trim().length > 0)
  assert(globalThis.__piScrubPre.some(entry => entry.hasPiIdentity && entry.hasPiDocs), JSON.stringify(globalThis.__piScrubPre))
  assert(observed.length > 0)
  assert(observed.every(entry => !entry.hasPiIdentity && !entry.hasPiDocs && entry.hasGenericIdentity), JSON.stringify(observed))
  console.log(JSON.stringify({ result: 'PASS', root, piVersion: '0.72.1', meridianVersion, model: 'claude-haiku-4-5', before: globalThis.__piScrubPre, after: observed, responseLength: stdout.length }))
} finally {
  if (proxy) await proxy.close()
  observer.mockRestore()
}
