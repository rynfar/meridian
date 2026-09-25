#!/usr/bin/env bun
// Real SDK/CLI with a local model API: a shortened client head must replay its summary.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const legacy = process.argv.includes('--legacy')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-compaction-summary-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_TELEMETRY_PERSIST: '0',
  ...(legacy ? { MERIDIAN_COMPACTION_SURVIVAL: '1' } : {}),
})
const OLD_HEAD = `OLD_HEAD_${crypto.randomUUID()}`
const SUMMARY = `SUMMARY_${crypto.randomUUID()}`
const upstreamCalls = []
const upstreamErrors = []
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const body = await request.json()
    upstreamCalls.push(body)
    const usage = { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const events = [
      { type: 'message_start', message: { id: `msg_compaction_${upstreamCalls.length}`, type: 'message', role: 'assistant',
        model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ACK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } })
  } catch (error) {
    upstreamErrors.push(String(error))
    return new Response(String(error), { status: 500 })
  }
} })
const { startProxyServer } = await import(pathToFileURL(join(repo, 'src/proxy/server.ts')).href)
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true,
  profiles: [{ id: 'fixture', type: 'api', apiKey: 'local-fixture-key', baseUrl: `http://127.0.0.1:${upstream.port}` }],
  defaultProfile: 'fixture',
})
const session = crypto.randomUUID()
async function turn(messages) {
  const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-meridian-agent': 'opencode',
      'x-opencode-session': session, 'x-session-affinity': session },
    body: JSON.stringify({ model: 'haiku', max_tokens: 128, stream: false, messages }),
    signal: AbortSignal.timeout(120_000),
  })
  const body = await response.text()
  assert.equal(response.status, 200, body.slice(0, 2500))
  assert(body.includes('ACK'), body.slice(0, 2500))
}
try {
  const stored = [
    { role: 'user', content: OLD_HEAD },
    { role: 'assistant', content: 'old answer A' },
    { role: 'user', content: 'old question B' },
    { role: 'assistant', content: 'old answer B' },
    { role: 'user', content: 'old question C' },
    { role: 'assistant', content: 'old answer C' },
    { role: 'user', content: 'tail question D' },
    { role: 'assistant', content: 'tail answer D' },
    { role: 'user', content: 'tail question E' },
  ]
  await turn(stored)
  const before = upstreamCalls.length
  await turn([
    { role: 'user', content: SUMMARY },
    ...stored.slice(-4),
    { role: 'assistant', content: 'tail answer E' },
    { role: 'user', content: 'new turn after summary' },
  ])
  const delivered = upstreamCalls.slice(before).map(call => JSON.stringify(call.messages ?? []))
  assert(delivered.length > 0, 'No model-bound compaction request')
  if (!legacy) {
    assert(delivered.some(text => text.includes(SUMMARY)), 'Client summary did not reach the model')
    assert(delivered.every(text => !text.includes(OLD_HEAD)), 'Removed head leaked into the new SDK session')
  } else {
    assert(delivered.every(text => !text.includes(SUMMARY)), 'Legacy resume unexpectedly included the summary')
  }
  assert.deepEqual(upstreamErrors, [])
  console.log(JSON.stringify({ result: 'PASS', legacy, seedCalls: before,
    compactionCalls: delivered.length, summaryDelivered: delivered.some(text => text.includes(SUMMARY)),
    removedHeadRetained: delivered.some(text => text.includes(OLD_HEAD)) }))
} finally {
  await proxy.close()
  upstream.stop(true)
}
