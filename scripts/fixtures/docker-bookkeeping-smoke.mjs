// Actual runtime-image storage/maintenance gate. No credentials or model requests.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const packageRoot = resolve(process.argv[2] || '/app')
const directory = mkdtempSync(join(tmpdir(), 'meridian-docker-bookkeeping-'))
for (const key of Object.keys(process.env)) if (/^(MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_|CLAUDE_)/.test(key)) delete process.env[key]
Object.assign(process.env, { MERIDIAN_SESSION_DIR: directory, MERIDIAN_BOOKKEEPING: 'sqlite',
  MERIDIAN_CREDENTIALS_READONLY: '1', MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_TELEMETRY_PERSIST: '0' })
const cli = join(packageRoot, 'dist/session-bookkeeping.js')
function command(name, ...flags) {
  const child = spawnSync(process.execPath, [cli, name, '--session-dir', directory, '--json', ...flags],
    { encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL' })
  assert.equal(child.error, undefined, `${name} did not join: ${child.error?.code}`)
  assert.equal(child.status, 0, `${name}: ${child.stderr}`)
  return JSON.parse(child.stdout)
}
let handle
try {
  writeFileSync(join(directory, 'sessions.json'), JSON.stringify({ smoke: {
    claudeSessionId: 'smoke-session', createdAt: 1, lastUsedAt: 2, messageCount: 0 } }), { mode: 0o600 })
  const migrated = command('migrate', '--writers-stopped')
  assert.equal(migrated.phase, 'ready')
  assert.equal(migrated.mappings, 1)
  const api = await import(pathToFileURL(join(packageRoot, 'dist/server.js')).href)
  handle = await api.initializeProxyBookkeeping()
  assert.deepEqual(Object.keys(handle), ['close'])
  const completion = api.clearSessionCache()
  assert(completion instanceof Promise)
  await completion
  await handle.close()
  handle = undefined
  command('export-json')
  const exported = JSON.parse(readFileSync(join(directory, 'sessions.json'), 'utf8'))
  assert.equal(Object.values(exported).filter(value => value?.claudeSessionId).length, 0)
  console.log(JSON.stringify({ result: 'PASS', node: process.version, platform: process.platform,
    arch: process.arch, qualifiedBuiltinSQLite: true, migratedMappings: 1,
    awaitedClear: true, latestStateExport: true, modelRequests: 0 }))
} finally {
  await handle?.close()
  rmSync(directory, { recursive: true, force: true })
}
