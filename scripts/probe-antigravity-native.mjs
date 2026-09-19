// Official CLI capability probe. Records public stream envelopes, never private transcripts.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { startProxyServer } from '../dist/server.js'
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-native-probe-'))
console.log(`Artifacts: ${root}`)
const proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true })
try {
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const health = await fetch(`http://127.0.0.1:${proxy.server.address().port}/health`)
  assert.equal(health.status, 200, await health.text())
} finally { await proxy.close() }
await mkdir(join(root, '.agents'))
const policy = join(root, 'deny.cjs')
await writeFile(policy, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({decision:'deny',reason:'Read-only Meridian capability probe'})));`)
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
await writeFile(join(root, '.agents/hooks.json'), JSON.stringify({ meridian_probe: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `${quote(process.execPath)} ${quote(policy)}`, timeout: 5 }] }] } }))
const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_GENAI_USE_.*|GOOGLE_GEMINI_BASE_URL|ANTHROPIC_.*|MERIDIAN_API_KEY)$/.test(key)) delete env[key]
for (const [name, prompt] of [['tools', 'Reply exactly CAPABILITIES_READY without using tools.'], ['browser', '/browser']]) {
  const child = spawn(process.env.MERIDIAN_AGY_PATH || 'agy', ['--new-project', '--add-dir', root, '-p', prompt, '--model', 'gemini-3.8-flash-low', '--output-format', 'stream-json', '--print-timeout', '30s', '--sandbox'], { cwd: root, env })
  let out = '', err = ''
  child.stdout.on('data', chunk => { out += chunk }); child.stderr.on('data', chunk => { err += chunk })
  const [code] = await once(child, 'close')
  await writeFile(join(root, name + '.json'), JSON.stringify({ code, out, err }, null, 2))
  const events = out.trim().split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
  console.log(JSON.stringify({ name, code, init: events.find(event => event.event === 'init'), result: events.find(event => event.event === 'result'), error: err.slice(-1000) }))
}
