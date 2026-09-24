import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { spyOn } from 'bun:test'

const meridianRoot = fileURLToPath(new URL('..', import.meta.url))
const pluginPath = process.env.E2E_PLUGIN_PATH
assert(pluginPath, 'Set E2E_PLUGIN_PATH to an installed Hermes scrub plugin entrypoint')
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hermes-scrub-live-')))
console.log(JSON.stringify({ artifact: root }))
const hermesHome = join(root, 'hermes-home')
const meridianConfig = join(root, 'meridian-config')
const project = join(root, 'client-project')
for (const path of [hermesHome, meridianConfig, project]) mkdirSync(path)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: meridianConfig,
  MERIDIAN_SESSION_DIR: join(root, 'meridian-sessions'),
  MERIDIAN_TELEMETRY_PERSIST: '0',
})
globalThis.__hermesScrubPre = []
globalThis.__hermesScrubPost = []
const snapshot = `(ctx) => ({ adapter: ctx.adapter, hasFingerprint: /\\b(?:session_search|session_dump|skill_manage|skill_view|skill_create|skill_search|skills_list|memory_search)\\b/.test(ctx.systemContext || ''), hasFinishingJob: (ctx.systemContext || '').includes('# Finishing the job'), hasNeutralSkillView: (ctx.systemContext || '').includes('skill view') })`
const beforePath = join(root, 'before.js')
const afterPath = join(root, 'after.js')
writeFileSync(beforePath, `const snapshot = ${snapshot}; export default { name: 'before-hermes-scrub', onRequest(ctx) { globalThis.__hermesScrubPre.push(snapshot(ctx)); return ctx } }`)
writeFileSync(afterPath, `const snapshot = ${snapshot}; export default { name: 'after-hermes-scrub', onRequest(ctx) { globalThis.__hermesScrubPost.push(snapshot(ctx)); return ctx } }`)
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [
  { path: beforePath, enabled: true },
  { path: pluginPath, enabled: true },
  { path: afterPath, enabled: true },
] }))
const require = createRequire(join(meridianRoot, 'package.json'))
const sdk = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href)
const originalQuery = sdk.query
let sdkQueries = 0
const observer = spyOn(sdk, 'query').mockImplementation(input => { sdkQueries++; return originalQuery(input) })
const { startProxyServer } = await import(pathToFileURL(join(meridianRoot, 'dist/server.js')).href)
let proxy, relay
try {
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, pluginConfigPath, pluginDir: join(root, 'plugins') })
  const port = proxy.server.address().port
  const list = await (await fetch(`http://127.0.0.1:${port}/plugins/list`)).json()
  const loadedPlugin = list.plugins.find(p => p.name === 'hermes-scrub')
  assert.equal(loadedPlugin?.status, 'active')
  console.log(JSON.stringify({ loadedPlugin: { name: loadedPlugin.name, version: loadedPlugin.version, status: loadedPlugin.status } }))
  if (process.env.E2E_PLUGIN_VERSION) assert.equal(loadedPlugin.version, process.env.E2E_PLUGIN_VERSION)
  const incoming = []
  relay = createServer(async (req, res) => {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const raw = Buffer.concat(chunks)
      const body = raw.length ? JSON.parse(raw.toString('utf8')) : {}
      const system = typeof body.system === 'string' ? body.system : Array.isArray(body.system) ? body.system.map(block => block.text ?? '').join('') : ''
      incoming.push({ systemLength: system.length, hasSessionSearch: /\bsession_search\b/.test(system), hasSkillManage: /\bskill_manage\b/.test(system), hasFinishingJob: system.includes('# Finishing the job'), hasChatHistoryLookup: system.includes('chat_history_lookup'), hasContextNotes: system.includes('context_notes'), toolNames: (body.tools ?? []).map(tool => tool.name), messages: body.messages?.length })
      const headers = { ...req.headers }
      delete headers.host; delete headers['content-length']
      const upstream = await fetch(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers, body: raw.length ? raw : undefined, signal: AbortSignal.timeout(120000) })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      Readable.fromWeb(upstream.body).pipe(res)
    } catch (error) { res.writeHead(502); res.end(String(error)) }
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = relay.address().port
  writeFileSync(join(hermesHome, 'config.yaml'), `model:\n  provider: custom\n  base_url: http://127.0.0.1:${relayPort}\n  api_mode: anthropic_messages\n  default: ${model}\n  api_key: local-fixture\nagent:\n  max_turns: 1\n`)
  const env = { ...process.env, HERMES_HOME: hermesHome }
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete env[key]
  const args = ['chat', '-q', 'Reply briefly with READY. Do not use tools.', '--oneshot', '-Q', '-m', model, '--provider', 'custom', '-t', 'session_search,skills,memory', '--ignore-rules', '--run-budget', '60']
  const child = spawn('hermes', args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120000)
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) }).finally(() => clearTimeout(timeout))
  writeFileSync(join(root, 'hermes.stdout'), stdout)
  writeFileSync(join(root, 'hermes.stderr'), stderr)
  console.log(JSON.stringify({ incoming, before: globalThis.__hermesScrubPre, after: globalThis.__hermesScrubPost, sdkQueries }))
  assert.equal(exit, 0, `Hermes exited ${exit}; see ${root}/hermes.stderr`)
  assert(stdout.includes('READY'), `No READY response; see ${root}/hermes.stdout`)
  assert(globalThis.__hermesScrubPre.some(entry => entry.hasFingerprint), JSON.stringify(globalThis.__hermesScrubPre))
  assert(globalThis.__hermesScrubPost.length > 0)
  assert(globalThis.__hermesScrubPost.every(entry => !entry.hasFingerprint), JSON.stringify(globalThis.__hermesScrubPost))
  assert(globalThis.__hermesScrubPost.some(entry => entry.hasNeutralSkillView))
  assert(globalThis.__hermesScrubPost.every((entry, i) => entry.hasFinishingJob === globalThis.__hermesScrubPre[i]?.hasFinishingJob))
  assert(sdkQueries > 0)
  console.log(JSON.stringify({ result: 'PASS', root, versions: { hermes: '0.21.4', meridian: '1.76.3' }, model, before: globalThis.__hermesScrubPre, after: globalThis.__hermesScrubPost, sdkQueries }))
} finally {
  if (relay) await new Promise(resolve => relay.close(resolve))
  if (proxy) await proxy.close()
  observer.mockRestore()
}
