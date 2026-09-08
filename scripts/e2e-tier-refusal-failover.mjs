#!/usr/bin/env bun
// Actual proxy + real Claude Max fallback: does the credits-era per-tier
// refusal whose suffix is PROSE fail over to a healthy profile?
//
// `REACHED_YOUR_TIER_LIMIT` accepted the banner only when the line ended at
// `limit.` or continued with a slash command. A Claude Max pool receives a
// fourth shape and it is the only one that arrives there:
//
//   Claude Code returned an error result: You've reached your Fable limit.
//   Switch to another model to continue.
//
// The prefix was already anticipated; the suffix is prose, so the refusal fell
// through to `500 api_error`, `isAccountFailoverError` never saw it, and a pool
// with three other profiles holding Fable window went unused (#962, reported by
// @justprosh with a live 1.66.0 capture).
//
// Unit tests pin the regex. What they cannot show is the consequence: that the
// classification actually reaches priority routing and that the next profile
// really answers. This drives the whole path with a real Claude Max second leg.
//
// The refusal itself is a local fixture upstream, deliberately: producing this
// banner for real means exhausting a real Fable tier on a real account, which
// is not something a gate can do on demand. The FALLBACK leg is real — a live
// Claude Max profile answering a live prompt — so what is stubbed is the thing
// we cannot cause, not the thing under test.
//
// Run before releases touching error classification or priority failover.
//
//   bun scripts/e2e-tier-refusal-failover.mjs [--stream]
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-tier-refusal-')))
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
})

// The exact string captured live on 1.66.0. Kept verbatim — the whole defect is
// that its suffix is prose rather than a slash command, so paraphrasing it here
// would silently stop testing the reported shape.
const TIER_REFUSAL = "You've reached your Fable limit. Switch to another model to continue."

let refusedCalls = 0
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 100 })
    refusedCalls++
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: TIER_REFUSAL } },
      { status: 400, headers: { 'x-should-retry': 'false', 'request-id': 'fixture-tier-refusal' } },
    )
  },
})

const { startProxyServer } = await import(pathToFileURL(join(repo, 'src/proxy/server.ts')).href)
const { telemetryStore } = await import(pathToFileURL(join(repo, 'src/telemetry/index.ts')).href)
const { rateLimitStore } = await import(pathToFileURL(join(repo, 'src/proxy/rateLimitStore.ts')).href)
const { classifyError, isAccountFailoverError } = await import(pathToFileURL(join(repo, 'src/proxy/errors.ts')).href)

// Cheap pre-flight so a classifier regression is named as such rather than
// showing up as a confusing routing failure further down.
const classified = classifyError(`Claude Code returned an error result: ${TIER_REFUSAL}`)
console.log(JSON.stringify({ step: 'classify', status: classified.status, type: classified.type }))
assert.equal(classified.type, 'rate_limit_error', 'the prose-suffix banner must classify as a rate limit')
assert(isAccountFailoverError(classified.type), 'that classification must be a failover trigger')

const start = () => startProxyServer({
  port: 0, host: '127.0.0.1', silent: true,
  profiles: [
    { id: 'refused', type: 'api', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${upstream.port}` },
    { id: 'working', type: 'claude-max' },
  ],
  defaultProfile: 'refused',
})

const cases = process.argv.includes('--stream') ? ['failover-stream'] : ['failover', 'failover-stream']
let proxy = await start()
try {
  for (const mode of cases) {
    // A fresh proxy per case, so the previous case's expected account cooldown
    // cannot let this one skip straight to the fallback without a refusal.
    if (mode !== cases[0]) { await proxy.close(); proxy = await start() }
    const port = proxy.server.address().port
    rateLimitStore.clear()
    const requestId = crypto.randomUUID()
    const receipt = `TIERFAILOVER_${crypto.randomUUID()}`
    const stream = mode.endsWith('-stream')
    const callsBefore = refusedCalls

    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': requestId, 'x-opencode-session': requestId },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001', max_tokens: 128, stream,
        messages: [{ role: 'user', content: `Reply with exactly ${receipt}.` }],
      }),
      signal: AbortSignal.timeout(180000),
    })
    const body = await response.text()
    const rows = telemetryStore.getRecent({ limit: 100 }).filter(row => row.requestId === requestId)
    const failures = rows.filter(row => row.error !== null)
    const served = rows.filter(row => row.error === null)

    let reply = ''
    if (stream) {
      for (const line of body.split('\n')) {
        if (!line.startsWith('data:')) continue
        const event = JSON.parse(line.slice(5))
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') reply += event.delta.text
      }
    } else {
      reply = (JSON.parse(body).content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
    }

    console.log(JSON.stringify({
      mode, status: response.status, refusedCalls,
      rows: rows.map(r => ({ profile: r.profileId, status: r.status, error: r.error })),
      answered: reply.includes(receipt),
    }))

    assert(refusedCalls > callsBefore, 'the real CLI must reach the local refusal upstream for this case')
    assert.equal(failures.length, 1, 'exactly one attempt should have been refused')
    assert.equal(failures[0].profileId, 'refused')
    // The point of the fix: the refusal is recorded as a rate limit, not a 500.
    assert.equal(failures[0].status, 429, 'the prose-suffix refusal must be recorded as 429, not 500')
    // And the consequence: a healthy profile actually served the request.
    assert.equal(response.status, 200)
    assert.equal(served.length, 1)
    assert.equal(served[0].profileId, 'working')
    assert(reply.includes(receipt), 'the real Claude Max fallback must answer the prompt')
  }
  console.log(JSON.stringify({ result: 'PASS', root, refusedCalls, cases }))
} finally {
  await proxy.close()
  upstream.stop(true)
}
