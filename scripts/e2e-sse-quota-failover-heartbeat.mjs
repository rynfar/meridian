#!/usr/bin/env node
// Packaged-path gate for SSE quota failover across heartbeats.
//
// Assert headers/keepalive before a delayed local refusal, suppression of that
// refusal, exactly one answering account in HTTP telemetry, and non-stream parity.
// The fallback uses Claude Max by default; E2E_SSE_WORKING_FIXTURE=1 replaces it
// with a local fixture and does not establish live subscription behavior.
//
// Run against the INSTALLED package (needs real Max credentials
// for the fallback leg):
//
//   E2E_MERIDIAN_PKG=/path/to/installed/node_modules/@rynfar/meridian \
//     node scripts/e2e-sse-quota-failover-heartbeat.mjs
//
// Knobs (harness only, never server config):
//   E2E_MERIDIAN_PKG                 package root containing dist/server.js (default .)
//   E2E_SSE_MODEL                    model for both legs (default haiku; Fable/Opus as needed)
//   E2E_SSE_WORKING_CLAUDE_CONFIG_DIR  credential dir for the working claude-max profile
//   E2E_SSE_REFUSAL_DELAY_MS         fixture refusal delay (default 16000; must exceed the 15s heartbeat)
//   E2E_SSE_WORKING_FIXTURE=1        use a local Anthropic answer fixture
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

async function serveFixture(fetchResponse) {
  const server = createServer((request, response) => {
    request.resume()
    void Promise.resolve(fetchResponse(request)).then(async result => {
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(Buffer.from(await result.arrayBuffer()))
    }).catch(error => {
      response.writeHead(500)
      response.end(String(error))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  return {
    port: address.port,
    stop: () => new Promise(resolve => {
      server.close(resolve)
      server.closeAllConnections()
    }),
  }
}

const pkgRoot = resolve(process.env.E2E_MERIDIAN_PKG ?? '.')
const serverModule = join(pkgRoot, 'dist/server.js')
const REFUSAL_DELAY_MS = Number(process.env.E2E_SSE_REFUSAL_DELAY_MS ?? 16_000)
assert(Number.isFinite(REFUSAL_DELAY_MS) && REFUSAL_DELAY_MS > 15_000, 'the fixture refusal must be delayed past the 15s heartbeat for this gate to mean anything')
const MODEL = process.env.E2E_SSE_MODEL ?? 'claude-haiku-4-5-20251001'
const WORKING_FIXTURE = process.env.E2E_SSE_WORKING_FIXTURE === '1'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-sse-quota-failover-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'),
  MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root,
  MERIDIAN_TELEMETRY_PERSIST: '0',
  MERIDIAN_ROUTING: 'priority',
  MERIDIAN_PROFILE_ORDER: 'refused,working',
  MERIDIAN_CREDENTIALS_READONLY: '1',
  MERIDIAN_NO_UPDATE_CHECK: '1',
})

// Quota refusal with both the wire type and the prose the proxy classifier
// keys on — whichever layer classifies, it must read as a spent account.
let refusedCalls = 0
let firstRefusalAt = 0
const upstream = await serveFixture(async request => {
    if (!new URL(request.url, 'http://localhost').pathname.endsWith('/v1/messages')) {
      return Response.json({ input_tokens: 100 })
    }
    refusedCalls++
    await delay(REFUSAL_DELAY_MS)
    firstRefusalAt ||= Date.now()
    return Response.json(
      { type: 'error', error: { type: 'rate_limit_error', message: "You've hit your usage limit. Your quota resets later today." } },
      { status: 429, headers: { 'x-should-retry': 'false', 'request-id': 'fixture-sse-quota-refusal' } },
    )
})

// Offline mode only: a canned Anthropic answer so the working leg needs no
// credentials. The delivery assertions are identical either way.
const workingFixture = await serveFixture(async request => {
    if (!new URL(request.url, 'http://localhost').pathname.endsWith('/v1/messages')) {
      return Response.json({ input_tokens: 100 })
    }
    await delay(50)
    return Response.json({
      id: 'msg_fixture_working',
      type: 'message',
      role: 'assistant',
      model: MODEL,
      content: [{ type: 'text', text: `fixture working answer ${receipt}` }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 20 },
    })
})

const { startProxyServer } = await import(pathToFileURL(serverModule).href)

const workingProfile = WORKING_FIXTURE
  ? { id: 'working', type: 'api', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${workingFixture.port}` }
  : { id: 'working', type: 'claude-max' }
if (!WORKING_FIXTURE && process.env.E2E_SSE_WORKING_CLAUDE_CONFIG_DIR) {
  workingProfile.claudeConfigDir = process.env.E2E_SSE_WORKING_CLAUDE_CONFIG_DIR
}

const start = async () => {
  const instance = await startProxyServer({
  port: 0, host: '127.0.0.1', silent: true,
  profiles: [
    { id: 'refused', type: 'api', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${upstream.port}` },
    workingProfile,
  ],
  defaultProfile: 'refused',
  })
  if (!instance.server.listening) await once(instance.server, 'listening')
  return instance
}

async function telemetryRows(port, requestId) {
  // The HTTP endpoint splits views: plain rows hide priority hop attempts,
  // ?hops=1 returns exactly those — and both include the final row, so
  // merge then dedupe per (profile, attempt, outcome).
  const [plain, hops] = await Promise.all([
    fetch(`http://127.0.0.1:${port}/telemetry/requests`).then(res => res.json()),
    fetch(`http://127.0.0.1:${port}/telemetry/requests?hops=1`).then(res => res.json()),
  ])
  const seen = new Set()
  const rows = []
  for (const row of [...hops, ...plain]) {
    if (row.requestId !== requestId) continue
    const key = `${row.profileId}:${row.status}:${row.error}:${row.routeAttempt ?? 0}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  return rows
}

const receipt = `SSEOK${crypto.randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`
const cases = ['failover', 'failover-stream']
let proxy = await start()
try {
  for (const mode of cases) {
    // A fresh proxy per case, so the previous case's expected account cooldown
    // cannot let this one skip straight to the fallback without a refusal.
    if (mode !== cases[0]) { await proxy.close(); proxy = await start() }
    const port = proxy.server.address().port
    firstRefusalAt = 0
    const callsBefore = refusedCalls
    const requestId = crypto.randomUUID()
    const stream = mode.endsWith('-stream')

    const startedAt = performance.now()
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'x-opencode-session': requestId },
      body: JSON.stringify({
        model: MODEL, max_tokens: 128, stream,
        messages: [{ role: 'user', content: `Reply with exactly this and nothing else: ${receipt}` }],
      }),
      signal: AbortSignal.timeout(240000),
    })
    const headerAt = Date.now()
    const headerMs = performance.now() - startedAt
    if (stream) assert(headerMs < 100, `SSE headers took ${headerMs.toFixed(1)}ms; expected less than 100ms`)

    let body
    let firstChunkText = null
    if (stream) {
      // The delivery defect under test: the FIRST wire bytes must arrive
      // before the delayed refusal, and they must be content-free liveness.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const first = await reader.read()
      firstChunkText = decoder.decode(first.value ?? new Uint8Array())
      const firstChunkAt = Date.now()
      body = firstChunkText
      while (true) {
        const next = await reader.read()
        if (next.done) break
        body += decoder.decode(next.value)
      }
      assert(headerAt <= firstChunkAt, 'headers must not arrive after body bytes')
      assert(firstRefusalAt > 0, 'the refusal fixture must have answered this case')
      assert(headerAt < firstRefusalAt, 'headers must arrive before the first refusal, not merely before a later retry')
      assert(firstChunkAt < firstRefusalAt, `first wire bytes (${firstChunkAt}) must precede the FIRST delayed refusal (${firstRefusalAt})`)
      assert(
        /(^|\n): ping\r?\n\r?\n/.test(firstChunkText) || firstChunkText.startsWith('event: ping'),
        `the first wire bytes must be a content-free heartbeat, got: ${JSON.stringify(firstChunkText.slice(0, 80))}`,
      )
      assert(!body.includes('rate_limit_error'), 'the suppressed refusal must not reach the client')
      assert.equal(body.split('event: message_start').length - 1, 1, 'the healthy account must serve exactly one stream')
    } else {
      body = await response.text()
    }

    const rows = await telemetryRows(port, requestId)
    const failures = rows.filter(row => row.error !== null)
    const served = rows.filter(row => row.error === null)
    let reply = ''
    if (stream) {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue
        try {
          const event = JSON.parse(line.slice(5))
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') reply += event.delta.text
        } catch { /* keepalive comments have no data line worth parsing */ }
      }
    } else {
      const parsed = JSON.parse(body)
      assert.equal(response.status, 200, 'non-stream failover keeps its status contract')
      reply = (parsed.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    }

    console.log(JSON.stringify({
      mode, status: response.status, refusedCalls, headerMs,
      rows: rows.map(r => ({ profile: r.profileId, status: r.status, error: r.error })),
      firstChunk: stream ? firstChunkText.slice(0, 40) : undefined,
      answered: reply.trim().length > 0,
    }))

    assert(refusedCalls > callsBefore, 'the real CLI must reach the local delayed-refusal upstream in every case')
    assert.equal(failures.length, 1, 'exactly one attempt should have been refused')
    assert.equal(failures[0].profileId, 'refused')
    assert.equal(failures[0].status, 429)
    assert.equal(failures[0].error, 'rate_limit_error')
    assert.equal(served.length, 1, 'exactly one healthy attempt may serve')
    assert.equal(served[0].profileId, 'working')
    assert.equal(response.status, 200)
    assert(reply.trim().length > 0, 'the real Claude Max fallback must produce visible text')
  }
  console.log(JSON.stringify({ result: 'PASS', pkgRoot, serverModule, refusedCalls, model: MODEL, refusalDelayMs: REFUSAL_DELAY_MS, workingLeg: WORKING_FIXTURE ? 'local-fixture' : 'real-claude-max' }))
} catch (error) {
  console.error('[e2e-sse-quota-failover] assertion/runtime failure:', error)
  throw error
} finally {
  await proxy.close()
  await upstream.stop()
  await workingFixture.stop()
}
