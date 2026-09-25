#!/usr/bin/env bun
// Real SDK/CLI with a local API fixture for the legacy same-tool abort path.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-single-step-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_PASSTHROUGH_EARLY_STOP: '0',
  MERIDIAN_PASSTHROUGH_MAX_TURNS: '4', MERIDIAN_TELEMETRY_PERSIST: '0',
})
const selected = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'repeat'
assert(['repeat', 'single'].includes(selected))
const upstreamCalls = []
const upstreamErrors = []
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const body = await request.json()
    upstreamCalls.push({ stream: body.stream, tools: body.tools?.map(tool => tool.name) ?? [] })
    const model = body.model
    const usage = { input_tokens: 10, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    const toolName = body.tools?.find(tool => tool.name.endsWith('get_weather'))?.name
    const afterTool = body.messages?.some(message => Array.isArray(message.content)
      && message.content.some(block => block.type === 'tool_result'))
    const blocks = afterTool || !toolName
      ? [{ type: 'text', text: 'Fixture finished.' }]
      : [
          { type: 'tool_use', id: 'toolu_fixture_paris', name: toolName, input: { city: 'Paris' } },
          ...(selected === 'repeat' ? [{ type: 'tool_use', id: 'toolu_fixture_london', name: toolName, input: { city: 'London' } }] : []),
        ]
    if (!body.stream) return Response.json({ id: `msg_fixture_${upstreamCalls.length}`, type: 'message', role: 'assistant', model,
      content: blocks, stop_reason: blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage })
    const events = [{ type: 'message_start', message: { id: `msg_fixture_${upstreamCalls.length}`, type: 'message', role: 'assistant', model,
      content: [], stop_reason: null, stop_sequence: null, usage } }]
    for (const [index, block] of blocks.entries()) {
      if (block.type === 'tool_use') {
        events.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } },
          { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } },
          { type: 'content_block_stop', index })
      } else {
        events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
          { type: 'content_block_stop', index })
      }
    }
    events.push({ type: 'message_delta', delta: { stop_reason: blocks[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 16 } }, { type: 'message_stop' })
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
      tools: [{ name: 'get_weather', description: 'Get weather in a city.',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
      messages: [{ role: 'user', content: selected === 'repeat' ? 'Call get_weather for Paris and London.' : 'Call get_weather for Paris.' }] }),
    signal: AbortSignal.timeout(120_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw.slice(0, 2000))
  const events = raw.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
  assert(!events.some(event => event.type === 'error'), raw.slice(0, 2000))
  assert.equal(events.filter(event => event.type === 'message_start').length, 1, raw.slice(0, 2000))
  assert.equal(events.filter(event => event.type === 'message_stop').length, 1, raw.slice(0, 2000))
  const starts = events.filter(event => event.type === 'content_block_start')
  const stops = events.filter(event => event.type === 'content_block_stop')
  for (const start of starts) assert(stops.some(stop => stop.index === start.index), `open block ${start.index}`)
  const tools = starts.filter(event => event.content_block?.type === 'tool_use')
  assert(tools.length >= 1, raw.slice(0, 2000))
  assert(tools.every(event => event.content_block.name === 'get_weather'))
  assert.equal(events.findLast(event => event.type === 'message_delta')?.delta.stop_reason, 'tool_use', raw.slice(0, 2000))
  assert(upstreamCalls.some(call => call.stream && call.tools.some(name => name.endsWith('get_weather'))))
  assert.deepEqual(upstreamErrors, [])
  console.log(JSON.stringify({ case: selected, result: 'PASS', upstreamCalls: upstreamCalls.length,
    deliveredToolIds: tools.map(event => event.content_block.id), stop: 'tool_use' }))
} finally {
  await proxy.close()
  upstream.stop(true)
}
