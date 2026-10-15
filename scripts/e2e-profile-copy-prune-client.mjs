#!/usr/bin/env bun
// Actual OpenCode -> SDK/model, isolated two-profile stores. Both profile
// aliases use the same access-only grant: this tests lifecycle, not account
// failover or distinct subscriptions. Never inspect private SDK transcripts.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { spyOn } from 'bun:test'
import Database from 'libsql'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { observeSdkModels } from './lib/observe-sdk-models.mjs'
const auth = JSON.parse(readFileSync(process.env.E2E_AUTH_FILE, 'utf8'))
assert(typeof auth.accessToken === 'string' && auth.expiresAt > Date.now() && !('refreshToken' in auth))
const scrub = realpathSync(process.env.E2E_PLUGIN_PATH), client = process.env.E2E_OPENCODE_BIN ?? 'opencode'
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5', enabled = process.env.E2E_PRUNE_ENABLED !== '0'
const version = spawnSync(client, ['--version'], { encoding: 'utf8' }); assert.equal(version.status, 0)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-profile-copy-client-')))
for (const dir of ['config', 'project', 'client', 'plugins']) mkdirSync(join(root, dir), { mode: 0o700 })
const project = join(root, 'project'), clientConfig = join(root, 'client'), store = join(root, 'sessions')
const receipt = 'COPY-RECEIPT-' + randomUUID()
writeFileSync(join(project, 'receipt.txt'), receipt, { mode: 0o600 })
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: store,
  MERIDIAN_WORKDIR: project, MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_NO_UPDATE_CHECK: '1',
  MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_PASSTHROUGH: '1', MERIDIAN_ROUTING: 'manual',
  ...(process.env.E2E_CLAUDE_BIN ? { MERIDIAN_CLAUDE_PATH: realpathSync(process.env.E2E_CLAUDE_BIN) } : {}),
  MERIDIAN_SESSION_PROFILE_COPY_PRUNE: enabled ? '1' : '0', MERIDIAN_SESSION_GC_GRACE_MS: '0', MERIDIAN_SESSION_GC_INTERVAL_MS: '100' })
let phase = '', url, proxy
const queries = [], models = new Set(), realQuery = sdk.query
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  queries.push({ phase, resume: input.options?.resume ?? null, sessionId: input.options?.sessionId ?? null,
    executable: input.options?.pathToClaudeCodeExecutable, configDir: input.options?.env?.CLAUDE_CONFIG_DIR, grantMatched: input.options?.env?.CLAUDE_CODE_OAUTH_TOKEN === auth.accessToken })
  return observeSdkModels(realQuery(input), models)
})
const { startProxyServer } = await import('../src/proxy/server.ts')
const { readSessionStoreSnapshot, setSessionStoreDir } = await import('../src/proxy/sessionStore.ts')
const pluginConfigPath = join(root, 'plugins.json')
writeFileSync(pluginConfigPath, JSON.stringify({ plugins: [{ path: scrub, enabled: true }] }), { mode: 0o600 })
async function run(label, profile, prompt, session) {
  phase = label
  writeFileSync(join(clientConfig, 'opencode.json'), JSON.stringify({ $schema: 'https://opencode.ai/config.json',
    plugin: [resolve('dist/meridian')], model: `anthropic/${model}`, small_model: `anthropic/${model}`,
    share: 'disabled', permission: 'allow', provider: { anthropic: { options: { apiKey: 'local-copy-gate', baseURL: url,
      headers: { 'x-meridian-profile': profile } }, models: { [model]: { name: model, limit: { context: 200000, output: 1024 },
      reasoning: false, tool_call: true, modalities: { input: ['text'], output: ['text'] } } } } } }), { mode: 0o600 })
  const env = { ...process.env, OPENCODE_CONFIG_DIR: clientConfig, OPENCODE_DISABLE_AUTOUPDATE: '1' }
  for (const kind of ['CONFIG', 'DATA', 'CACHE', 'STATE']) env['XDG_' + kind + '_HOME'] = join(root, kind.toLowerCase())
  for (const key of Object.keys(env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|CLAUDE_|ANTHROPIC_|OPENAI_|OPENCODE_CLAUDE_PROVIDER_)/.test(key)) delete env[key]
  const child = spawn(client, ['run', '--format', 'json', ...(session ? ['--session', session] : []), prompt], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data)
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180000)
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept) }).finally(() => clearTimeout(timeout))
  writeFileSync(join(root, label + '.stdout'), stdout, { mode: 0o600 }); writeFileSync(join(root, label + '.stderr'), stderr, { mode: 0o600 })
  const events = stdout.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line))
  writeFileSync(join(root, 'query-facts.json'), JSON.stringify(queries), { mode: 0o600 })
  assert.equal(exit, 0, label + ' client failed; private artifacts: ' + root)
  assert.equal(events.filter(e => e.type === 'error').length, 0, label + ' client emitted an error')
  return { session: events.find(e => typeof e.sessionID === 'string')?.sessionID,
    text: events.filter(e => e.type === 'text').map(e => e.part?.text ?? '').join(''), tools: events.filter(e => e.type === 'tool_use').length }
}
const mapping = (profile, session) => readSessionStoreSnapshot()[`${profile}:${session}`]
const digest = messages => createHash('sha256').update(JSON.stringify(messages)).digest('hex')
async function sdkMessages(stored) {
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = stored.currentTranscript.configDir
  try { return await sdk.getSessionMessages(stored.claudeSessionId, { dir: stored.currentTranscript.projectDir }) }
  finally { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous }
}
try {
  proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true, pluginConfigPath, pluginDir: join(root, 'plugins'),
    profiles: ['personal', 'work'].map(id => ({ id, type: 'oauth-token', oauthToken: auth.accessToken })), defaultProfile: 'personal' })
  if (!proxy.server.listening) await new Promise(resolve => proxy.server.once('listening', resolve))
  url = `http://127.0.0.1:${proxy.server.address().port}`
  const plugins = await (await fetch(url + '/plugins/list')).json()
  assert(plugins.plugins.some(p => p.name === 'opencode-scrub' && p.status === 'active'))
  const first = await run('first', 'personal', `Use read to read ${join(project, 'receipt.txt')} and repeat its exact contents.`)
  assert(first.session && first.tools > 0 && first.text.includes(receipt))
  const id = first.session, personalBefore = mapping('personal', id)
  assert(personalBefore?.currentTranscript)
  const initialMessages = await sdkMessages(personalBefore)
  assert(initialMessages.length > 0, "Supported SDK history lookup found no source messages")
  const sourceBefore = digest(initialMessages)
  const recall = 'Without tools, repeat the exact receipt from the previous turns.'
  const switched = await run('switch-work', 'work', recall, id); assert(switched.text.includes(receipt))
  const returned = await run('return-before-prune', 'personal', recall, id); assert(returned.text.includes(receipt))
  assert(queries.some(q => q.phase === 'return-before-prune' && q.resume === personalBefore.claudeSessionId), 'Return within grace did not natively resume personal')
  assert.equal(digest(await sdkMessages(personalBefore)), sourceBefore, 'Native source history changed during a fork')
  const back = await run('switch-work-again', 'work', recall, id); assert(back.text.includes(receipt))
  const personal = mapping('personal', id), work = mapping('work', id)
  assert(personal?.currentTranscript && work?.currentTranscript)
  const workMessages = await sdkMessages(work)
  assert(workMessages.length > 0, "Supported SDK history lookup found no newest messages")
  const workBefore = digest(workMessages)
  const unrelated = await run('unrelated', 'personal', 'Reply with a short acknowledgement. Do not use tools.')
  assert(unrelated.session && unrelated.session !== id)
  // Age only Meridian's own isolated mappings, never SDK transcript files.
  // Committed as another process would, so the proxy's cache picks the rows up by sequence number.
  const database = new Database(join(store, 'sessions.db'))
  try {
    database.exec('PRAGMA busy_timeout = 10000')
    database.exec('BEGIN IMMEDIATE')
    const seq = database.prepare('SELECT seq FROM store_info WHERE id = 1').get().seq + 1
    for (const key of [`personal:${id}`, `personal:${unrelated.session}`]) {
      const entry = JSON.parse(database.prepare('SELECT entry FROM sessions WHERE key = ?').get(key).entry)
      entry.lastUsedAt = Date.now() - 25 * 60 * 60_000
      database.prepare('UPDATE sessions SET seq = ?, entry = ? WHERE key = ?').run(seq, JSON.stringify(entry), key)
    }
    database.prepare('UPDATE store_info SET seq = ? WHERE id = 1').run(seq)
    database.exec('COMMIT')
  } finally {
    database.close()
  }
  setSessionStoreDir(store)
  const deadline = Date.now() + 10000
  while (enabled && mapping('personal', id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  await new Promise(resolve => setTimeout(resolve, 1000))
  assert.equal(!!mapping('personal', id), !enabled, 'Unexpected prune policy')
  assert(mapping('personal', unrelated.session), 'Unrelated single-profile conversation was pruned')
  assert.equal(mapping('work', id).claudeSessionId, work.claudeSessionId)
  assert.equal(digest(await sdkMessages(work)), workBefore, 'Newest profile transcript changed during GC')
  if (enabled) assert.equal((await sdkMessages(personal)).length, 0, 'Retired personal transcript was not deleted via SDK')
  const final = await run('return-after-prune', 'personal', recall, id); assert(final.text.includes(receipt))
  assert(queries.some(q => q.phase === 'return-after-prune' && (enabled ? !q.resume : q.resume === personal.claudeSessionId)), 'Return did not use the expected replay/resume path')
  assert.equal(mapping('personal', id).claudeSessionId === personal.claudeSessionId, false, 'Return should publish its own new fork or replay')
  assert(queries.every(q => q.grantMatched && q.configDir.startsWith(join(root, 'config', 'profiles'))))
  assert(models.size > 0 && [...models].every(value => value === model || value.startsWith(model + '-')))
  const summary = { result: 'PASS', platform: `${process.platform}/${process.arch}`, bun: Bun.version, opencode: version.stdout.trim(), model,
    sdk: JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url))).version,
    claudeCode: spawnSync(queries[0].executable, ['--version'], { encoding: 'utf8' }).stdout.trim(),
    enabled, profileAliasesShareGrant: true, withinGraceNativeResume: true, sourceImmutable: true,
    staleMappingPruned: enabled, sdkDeletionVerified: enabled, unrelatedRetained: true, newestUnchanged: true,
    finalReceipt: true, finalMode: enabled ? 'replay' : 'resume', servedModels: [...models], realSdkQueries: queries.length, privateArtifacts: root }
  writeFileSync(join(root, 'summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600 }); console.log(JSON.stringify(summary))
} finally { await proxy?.close(); observer.mockRestore() }
