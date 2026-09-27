#!/usr/bin/env bun
// Actual OpenCode V2 server → built Meridian → real SDK/model.
// Invokes a user skill with no typed text, the way `/name` does in the V2 TUI.
// The random receipt exists only inside the skill body, so it can reach the
// SDK prompt and the reply only if Meridian keeps <skill_content>.
//
//   E2E_OPENCODE_BIN=/path/to/opencode E2E_PLUGIN_PATH=/path/to/opencode-scrub/dist/index.js \
//     bun scripts/e2e-opencode-skill-content.mjs
//   E2E_MERIDIAN_ROOT=/path/to/baseline ... bun scripts/e2e-opencode-skill-content.mjs --baseline
//
// --baseline asserts the pre-fix failure instead (skill body dropped).
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const client = process.env.E2E_OPENCODE_BIN
assert(client, 'Set E2E_OPENCODE_BIN to the OpenCode V2 executable')
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const baseline = process.argv.includes('--baseline')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-skill-content-')))
const config = join(root, 'config', 'opencode')
const clientHome = join(root, 'client-home')
const work = join(root, 'work')
const sdkLog = join(root, 'sdk-events.jsonl')
const skill = 'e2e-skill-receipt'
const receipt = `SKILL_RECEIPT_${crypto.randomUUID().slice(0, 8)}`
const skillDir = join(work, '.opencode', 'skills', skill)
for (const dir of [config, clientHome, skillDir]) mkdirSync(dir, { recursive: true })
writeFileSync(sdkLog, '')
writeFileSync(join(skillDir, 'SKILL.md'), [
  '---',
  `name: ${skill}`,
  'description: Meridian E2E fixture. Only for explicit invocation.',
  '---',
  '',
  `When this skill is invoked, reply with exactly ${receipt} and nothing else. Do not use tools.`,
  '',
].join('\n'))

const scrub = process.env.E2E_PLUGIN_PATH
assert(scrub, 'Set E2E_PLUGIN_PATH to an independently installed OpenCode scrub entrypoint')
const pluginConfig = join(root, 'plugins.json')
mkdirSync(join(root, 'plugins'))
writeFileSync(pluginConfig, JSON.stringify({ plugins: [{ path: scrub, enabled: true }] }))
const proxyEnv = { ...process.env }
for (const key of Object.keys(proxyEnv)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete proxyEnv[key]
Object.assign(proxyEnv, {
  MERIDIAN_CONFIG_DIR: join(root, 'meridian'), MERIDIAN_SESSION_DIR: join(root, 'sessions'), MERIDIAN_WORKDIR: work,
  MERIDIAN_PASSTHROUGH: '1', MERIDIAN_TELEMETRY_PERSIST: '0',
  E2E_SDK_LOG: sdkLog, E2E_SKILL_RECEIPT: receipt, E2E_PLUGIN_CONFIG: pluginConfig, E2E_PLUGIN_DIR: join(root, 'plugins'), E2E_PROXY_MODULE: pathToFileURL(join(repo, 'dist/server.js')).href,
})
let resolvePort, rejectPort
const readiness = new Promise((yes, no) => { resolvePort = yes; rejectPort = no })
const proxy = Bun.spawn([process.execPath, join(import.meta.dir, 'e2e-opencode-skill-content-host.mjs')], {
  cwd: root, env: proxyEnv, stdout: 'pipe', stderr: 'pipe', ipc(message) { if (message.port) resolvePort(message.port) },
})
const proxyOutput = Promise.all([new Response(proxy.stdout).text(), new Response(proxy.stderr).text()])
proxy.exited.then(code => rejectPort(new Error(`Proxy exited ${code}`)))

// Client isolation: private config, data, cache and home; never the user's service.
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('OPENCODE_') || key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete env[key]
for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase())
const password = crypto.randomUUID()
Object.assign(env, {
  HOME: clientHome, USERPROFILE: clientHome, PWD: work, OPENCODE_CONFIG_DIR: config,
  OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_SERVER_PASSWORD: password,
})
const auth = { authorization: 'Basic ' + btoa(`opencode:${password}`), 'content-type': 'application/json' }
let server
const report = { result: 'FAIL', baseline, model, root }
try {
  const port = await Promise.race([readiness, Bun.sleep(30000).then(() => { throw new Error('Proxy readiness timed out') })])
  const pluginState = await (await fetch(`http://127.0.0.1:${port}/plugins/list`)).json()
  const scrubState = pluginState.plugins.find(plugin => plugin.name === 'opencode-scrub')
  assert.equal(scrubState?.status, 'active', 'Independent OpenCode scrub is inactive')
  report.scrubVersion = scrubState.version
  report.meridianCommit = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repo }).stdout.toString().trim()
  writeFileSync(join(config, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    model: `anthropic/${model}`,
    providers: { anthropic: { settings: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-fixture-key' } } },
  }, null, 2))
  report.clientVersion = (await new Response(Bun.spawn([client, '--version'], { env, stdout: 'pipe' }).stdout).text()).trim()
  server = Bun.spawn([client, 'serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: work, env, stdout: 'pipe', stderr: 'pipe' })
  const url = await readListenUrl(server)
  const api = async (method, path, body) => {
    const response = await fetch(new URL(path, url), { method, headers: auth, body: body && JSON.stringify(body) })
    const text = await response.text()
    assert(response.ok, `${method} ${path} -> ${response.status} ${text.slice(0, 500)}`)
    return text ? JSON.parse(text) : undefined
  }
  const where = `?directory=${encodeURIComponent(work)}`
  // Skill discovery completes asynchronously after the location first loads.
  let skills
  for (let attempt = 0; attempt < 30; attempt++) {
    skills = await api('GET', `/api/skill${where}`)
    if (JSON.stringify(skills).includes(skill)) break
    await Bun.sleep(1000)
  }
  assert(JSON.stringify(skills).includes(skill), `Fixture skill was not discovered: ${JSON.stringify(skills).slice(0, 1000)}`)
  const session = (await api('POST', '/api/session', {
    location: { directory: work }, model: { providerID: 'anthropic', id: model },
  })).data
  report.sessionID = session.id
  // Same admission the V2 composer sends for `/e2e-skill-receipt` with nothing typed.
  await api('POST', `/api/session/${session.id}/prompt${where}`, { text: '', skills: [{ id: skill, name: skill }] })
  await api('POST', `/api/experimental/session/${session.id}/wait${where}`)
  const messages = (await api('GET', `/api/session/${session.id}/message${where}`)).data
  const user = messages.find(message => message.type === 'user')
  report.userMessage = { text: user?.text, skillWrapped: user?.skills?.[0]?.text?.startsWith(`<skill_content name="${skill}">`) }
  const reply = messages.filter(message => message.type === 'assistant')
    .flatMap(message => message.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n')
  report.reply = reply
  report.assistantErrors = messages.filter(message => message.type === 'assistant' && message.error).map(message => message.error)
  report.sdkEvents = readFileSync(sdkLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  assert.equal(report.userMessage.text, '', 'The client did not send an empty typed text')
  assert(report.userMessage.skillWrapped, 'The client did not wrap the skill in <skill_content>')
  const primary = report.sdkEvents.at(-1)
  assert(primary, 'No SDK query was observed')
  if (baseline) {
    assert.equal(primary.hasReceipt, false, 'Baseline unexpectedly delivered the skill body')
    assert(!reply.includes(receipt), 'Baseline reply unexpectedly contains the receipt')
  } else {
    assert.equal(primary.hasReceipt, true, 'The skill body did not reach the SDK prompt')
    assert.equal(primary.hasSkillWrapper, true, 'The <skill_content> wrapper did not reach the SDK prompt')
    assert(reply.includes(receipt), 'The model reply does not follow the skill instructions')
  }
  report.result = 'PASS'
} finally {
  report.receipt = receipt
  console.log(JSON.stringify(report, null, 2))
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  server?.kill()
  proxy.kill()
  await Promise.all([server?.exited, proxy.exited])
  const [, stderr] = await proxyOutput
  if (report.result !== 'PASS' && stderr) console.error(stderr.slice(-4000))
}

async function readListenUrl(child) {
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    text += decoder.decode(value)
    const match = text.match(/server listening on (\S+)/)
    if (match) { reader.releaseLock(); return match[1] }
  }
  throw new Error(`OpenCode server did not start: ${text.slice(-2000)}`)
}
