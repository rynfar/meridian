/**
 * Manual live gate for lifecycle admission with the actual OpenCode client.
 * Requires OpenCode, Claude credentials for Meridian, and the OpenCode scrub plugin.
 * Keeps all request bodies and client output in a private temporary directory.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const meridianRoot = fileURLToPath(new URL('..', import.meta.url))
const expectBillingError = process.env.E2E_EXPECT_BILLING_ERROR === '1'
const scrubPath = process.env.E2E_PLUGIN_PATH
if (!expectBillingError) assert(scrubPath, 'Set E2E_PLUGIN_PATH to the installed OpenCode scrub plugin entrypoint')
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const clientBin = process.env.E2E_OPENCODE_BIN ?? 'opencode'
const concurrency = Number(process.env.E2E_CONCURRENCY ?? 1)
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 8)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-opencode-admission-')))
console.log(JSON.stringify({ artifact: root }))
const meridianConfig = join(root, 'meridian-config')
for (const path of [meridianConfig, join(root, 'plugins')]) mkdirSync(path)
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: meridianConfig,
  MERIDIAN_SESSION_DIR: join(root, 'meridian-sessions'),
  MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_PASSTHROUGH: '1',
})
const before = []
const after = []
globalThis.__opencodeAdmissionBefore = before
globalThis.__opencodeAdmissionAfter = after
const probe = (name, target) => `export default { name: ${JSON.stringify(name)}, onRequest(ctx) { globalThis.${target}.push({ adapter: ctx.adapter, hasPowered: (ctx.systemContext || '').includes('You are powered by the model named'), hasEnvPreamble: (ctx.systemContext || '').includes('Here is some useful information about the environment you are running in:'), hasWorkingDirectory: (ctx.systemContext || '').includes('Working directory:') }); return ctx } }`
const beforePath = join(root, 'before.js')
const afterPath = join(root, 'after.js')
writeFileSync(beforePath, probe('before-opencode-admission', '__opencodeAdmissionBefore'))
writeFileSync(afterPath, probe('after-opencode-admission', '__opencodeAdmissionAfter'))
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [
  { path: beforePath, enabled: true },
  ...(!expectBillingError ? [{ path: scrubPath, enabled: true }] : []),
  { path: afterPath, enabled: true },
] }))
const clientVersion = spawnSync(clientBin, ['--version'], { encoding: 'utf8' })
assert.equal(clientVersion.status, 0, `OpenCode version command failed: ${clientVersion.error?.message ?? clientVersion.stderr}`)

async function runClient(index, url) {
  const clientRoot = join(root, `client-${index}`)
  const project = join(clientRoot, 'project')
  const config = join(clientRoot, 'config')
  for (const path of [clientRoot, project, config]) mkdirSync(path)
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    plugin: [join(meridianRoot, 'dist', 'meridian')],
    model: `anthropic/${model}`,
    small_model: `anthropic/${model}`,
    share: 'disabled',
    permission: 'deny',
    provider: { anthropic: { options: { apiKey: 'local-fixture', baseURL: url },
      models: { [model]: { name: model, limit: { context: 200000, output: 1024 },
        modalities: { input: ['text'], output: ['text'] }, temperature: false,
        reasoning: false, tool_call: true } } } },
  }))
  const env = { ...process.env, OPENCODE_CONFIG_DIR: config, OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(clientRoot, kind.toLowerCase())
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_|OPENAI_|MERIDIAN_|CLAUDE_PROXY_)/.test(key)) delete env[key]
  }
  async function invoke(args, name) {
    const child = spawn(clientBin, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => child.kill('SIGTERM'), 180000)
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', resolve)
    }).finally(() => clearTimeout(timeout))
    writeFileSync(join(clientRoot, `${name}.stdout`), stdout)
    writeFileSync(join(clientRoot, `${name}.stderr`), stderr)
    const events = stdout.split('\n').filter(line => line.startsWith('{')).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
    return { exit, textEvents: events.filter(event => event.type === 'text' && event.part?.text).length,
      errorEvents: events.filter(event => event.type === 'error').length,
      billingErrors: events.filter(event => event.type === 'error' && JSON.stringify(event).includes('billing_error')).length,
      eventTypes: [...new Set(events.map(event => event.type))],
      sessionId: events.find(event => typeof event.sessionID === 'string')?.sessionID }
  }
  const first = await invoke(['run', '--format', 'json', '--model', `anthropic/${model}`,
    'Reply with a short acknowledgement. Do not use tools.'], 'first')
  const continued = !expectBillingError && first.exit === 0 && first.sessionId
    ? await invoke(['run', '--session', first.sessionId, '--format', 'json', '--model', `anthropic/${model}`,
      'Reply with another short acknowledgement. Do not use tools.'], 'continued')
    : undefined
  const publicTurn = ({ sessionId: _sessionId, ...turn }) => ({ ...turn, sessionCaptured: Boolean(_sessionId) })
  return { index, ...publicTurn(first), continuation: continued ? publicTurn(continued) : null,
    continuationSameSession: continued ? continued.sessionId === first.sessionId : false,
    artifact: clientRoot }
}

const { startProxyServer } = await import(pathToFileURL(join(meridianRoot, 'dist/server.js')).href)
let proxy
try {
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true,
    pluginConfigPath, pluginDir: join(root, 'plugins') })
  const url = `http://127.0.0.1:${proxy.server.address().port}`
  const initial = await (await fetch(`${url}/plugins/list`)).json()
  const scrub = initial.plugins.find(plugin => plugin.name === 'opencode-scrub')
  if (!expectBillingError) {
    assert.equal(scrub?.status, 'active', 'OpenCode scrub plugin did not load')
    if (process.env.E2E_EXPECT_VERSION) assert.equal(scrub.version, process.env.E2E_EXPECT_VERSION)
  }
  const clients = await Promise.all(Array.from({ length: concurrency }, (_, index) => runClient(index, url)))
  const final = await (await fetch(`${url}/plugins/list`)).json()
  const scrubStats = final.plugins.find(plugin => plugin.name === 'opencode-scrub')?.stats?.hooks?.onRequest
  const summary = { result: 'pending', artifact: root, meridian: JSON.parse(readFileSync(join(meridianRoot, 'package.json'))).version,
    opencode: clientVersion.stdout.trim(), model, plugin: scrub ? { version: scrub.version, onRequest: scrubStats } : null,
    clients, before, after }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  assert(before.length >= concurrency && before.every(entry => entry.adapter === 'opencode'),
    `The OpenCode client plugin did not identify requests; see ${root}/summary.json`)
  assert(before.some(entry => entry.hasPowered && entry.hasEnvPreamble),
    `The reported OpenCode system fingerprint was absent; see ${root}/summary.json`)
  assert(after.length >= concurrency && after.every(entry => entry.adapter === 'opencode'),
    `The scrub plugin changed request identity; see ${root}/summary.json`)
  if (expectBillingError) {
    assert(clients.every(client => client.billingErrors > 0 && client.textEvents === 0),
      `Expected the unscreened billing gate; see ${root}/summary.json and client logs`)
    assert(after.some(entry => entry.hasPowered && entry.hasEnvPreamble),
      `The unscreened OpenCode system fingerprint was absent; see ${root}/summary.json`)
  } else {
    assert(clients.every(client => client.exit === 0 && client.textEvents > 0 && client.errorEvents === 0
      && client.sessionCaptured && client.continuationSameSession && client.continuation?.exit === 0
      && client.continuation.textEvents > 0 && client.continuation.errorEvents === 0),
      `OpenCode did not complete; see ${root}/summary.json and client logs`)
    assert(scrubStats?.invocations >= concurrency * 2 && scrubStats.errors === 0,
      `The OpenCode scrub plugin did not process every request; see ${root}/summary.json`)
    assert(after.every(entry => !entry.hasPowered && !entry.hasEnvPreamble),
      `The metering fingerprint remained after scrubbing; see ${root}/summary.json`)
    assert(after.some(entry => entry.hasWorkingDirectory),
      `The scrub plugin removed OpenCode's working-directory context; see ${root}/summary.json`)
  }
  summary.result = 'PASS'
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(JSON.stringify(summary))
} finally {
  if (proxy) await proxy.close()
}
