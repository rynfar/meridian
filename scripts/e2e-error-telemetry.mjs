#!/usr/bin/env bun
// Actual proxy + SDK + CLI: local API billing refusal, then real Claude Max.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-error-telemetry-')))
for (const key of Object.keys(process.env)) if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'), MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_ROUTING: 'priority', MERIDIAN_PROFILE_ORDER: 'refused,working' })
let refusedCalls = 0
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 100 })
  refusedCalls++
  return Response.json({ type: 'error', error: { type: 'billing_error', message: 'Credit balance is too low to access the Anthropic API.' } },
    { status: 400, headers: { 'x-should-retry': 'false', 'request-id': 'fixture-billing-refusal' } })
} })
const { startProxyServer } = await import(pathToFileURL(join(repo, 'src/proxy/server.ts')).href)
const { telemetryStore } = await import(pathToFileURL(join(repo, 'src/telemetry/index.ts')).href)
const { rateLimitStore } = await import(pathToFileURL(join(repo, 'src/proxy/rateLimitStore.ts')).href)
const start = () => startProxyServer({ port: 0, host: '127.0.0.1', silent: true, profiles: [
  { id: 'refused', type: 'api', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${upstream.port}` },
  { id: 'working', type: 'claude-max' },
], defaultProfile: 'refused' })
let proxy = await start()
const cases = process.argv.includes('--failover-only') ? ['failover'] : ['pinned', 'pinned-stream', 'failover', 'failover-stream']
try {
  for (const mode of cases) {
    // Each mode must exercise a fresh refusal, not reuse the preceding case's
    // expected account-exhaustion cooldown and skip directly to the fallback.
    if (mode !== cases[0]) { await proxy.close(); proxy = await start() }
    const port = proxy.server.address().port
    rateLimitStore.clear()
    const requestId = crypto.randomUUID()
    const receipt = `RECOVERED_${crypto.randomUUID()}`
    const isFailover = mode.startsWith('failover')
    const stream = mode.endsWith('-stream')
    const callsBefore = refusedCalls
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'x-opencode-session': requestId,
        ...(!isFailover ? { 'x-meridian-profile': 'refused' } : {}) },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 128, stream,
        messages: [{ role: 'user', content: `Reply with exactly ${receipt}.` }] }),
      signal: AbortSignal.timeout(120000),
    })
    const body = await response.text()
    const rows = telemetryStore.getRecent({ limit: 100 }).filter(row => row.requestId === requestId)
    const failures = rows.filter(row => row.error !== null)
    let reply = ''
    if (stream) {
      for (const line of body.split('\n')) if (line.startsWith('data:')) {
        const event = JSON.parse(line.slice(5))
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') reply += event.delta.text
      }
    } else {
      reply = (JSON.parse(body).content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
    }
    console.log(JSON.stringify({ mode, status: response.status, refusedCalls, rows: rows.map(row => ({ profile: row.profileId, model: row.model, requestModel: row.requestModel, status: row.status, error: row.error })), reply }))
    assert(refusedCalls > callsBefore, 'The real CLI must reach the local refusal API for this case')
    assert.equal(failures.length, 1)
    assert.equal(failures[0].profileId, 'refused')
    assert.notEqual(failures[0].model, 'unknown')
    assert.equal(failures[0].requestModel, 'claude-haiku-4-5-20251001')
    if (isFailover) {
      assert.equal(response.status, 200)
      assert(reply.includes(receipt), 'Real Claude Max fallback must answer the prompt with visible text')
      const served = rows.filter(row => row.error === null)
      assert.equal(served.length, 1)
      assert.equal(served[0].profileId, 'working')
    } else {
      assert(body.includes('billing_error'))
      assert.equal(rows.length, 1)
    }
  }
  console.log(JSON.stringify({ result: 'PASS', root, refusedCalls, cases }))
} finally {
  await proxy.close()
  upstream.stop(true)
}
