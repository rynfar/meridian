#!/usr/bin/env bun
// Real SDK/CLI, local model API: a bare Pi tool name rejected before PreToolUse.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-rejected-tool-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_TELEMETRY_PERSIST: '0',
})
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'rejected'
assert(['rejected', 'registered'].includes(selected))
const upstreamCalls = []
const upstreamErrors = []
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const body = await request.json()
    upstreamCalls.push({ stream: body.stream, tools: body.tools?.map(tool => tool.name) ?? [], messages: body.messages })
    const registered = body.tools?.find(tool => tool.name.endsWith('read'))?.name
    const name = selected === 'rejected' ? 'read' : registered
    assert(registered, 'SDK did not register the client read tool')
    const usage = { input_tokens: 10, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const events = [
      { type: 'message_start', message: { id: 'msg_fixture_rejected', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_fixture_read', name, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/fixture.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 16 } },
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
try {
  const response = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-meridian-agent': 'pi', 'x-session-affinity': crypto.randomUUID() },
    body: JSON.stringify({ model: 'haiku', max_tokens: 512, stream: true,
      tools: [{ name: 'read', description: 'Read a file.',
        input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
      messages: [{ role: 'user', content: 'Read /fixture.txt using the read tool.' }] }),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  const events = raw.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert.equal(response.status, 200, raw.slice(0, 3000))
  assert(!events.some(event => event.type === 'error'), raw.slice(0, 3000))
  assert.equal(events.filter(event => event.type === 'message_start').length, 1, raw.slice(0, 3000))
  assert.equal(events.filter(event => event.type === 'message_stop').length, 1, raw.slice(0, 3000))
  const starts = events.filter(event => event.type === 'content_block_start')
  const stops = events.filter(event => event.type === 'content_block_stop')
  for (const start of starts) assert(stops.some(stop => stop.index === start.index), `open block ${start.index}`)
  const tools = starts.filter(event => event.content_block?.type === 'tool_use')
  assert.equal(tools.length, 1, raw.slice(0, 3000))
  assert.equal(tools[0].content_block.name, 'read')
  assert.equal(tools[0].content_block.id, 'toolu_fixture_read')
  assert.equal(events.findLast(event => event.type === 'message_delta')?.delta.stop_reason, 'tool_use', raw.slice(0, 3000))
  assert(upstreamCalls.some(call => call.stream && call.tools.some(name => name.endsWith('read'))))
  assert.deepEqual(upstreamErrors, [])
  console.log(JSON.stringify({ case: selected, result: 'PASS', upstreamCalls: upstreamCalls.length,
    registered: upstreamCalls.find(call => call.tools.some(name => name.endsWith('read')))?.tools,
    delivered: tools[0].content_block.name, stop: 'tool_use' }))
} finally {
  await proxy.close()
  upstream.stop(true)
}
