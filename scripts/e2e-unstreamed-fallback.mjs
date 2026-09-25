#!/usr/bin/env bun
// Real Agent SDK/Claude Code fallback against a local Anthropic API fixture.
// The fixture creates the upstream refusal; no model quota is consumed.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repo = resolve(process.env.E2E_MERIDIAN_ROOT ?? '.')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-unstreamed-fallback-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_PASSTHROUGH: '1', MERIDIAN_PASSTHROUGH_MAX_TURNS: '4',
  MERIDIAN_TELEMETRY_PERSIST: '0',
})

const requested = process.argv.find(arg => arg.startsWith('--case='))?.slice(7)
const cases = requested ? [requested] : ['text', 'tool', 'control']
assert(cases.every(value => ['text', 'tool', 'control'].includes(value)))
let mode = 'text'
let upstreamStreamed = 0
let upstreamNonstreamed = 0
let upstreamErrors = []
const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  try {
    if (!new URL(request.url).pathname.endsWith('/messages')) return Response.json({ input_tokens: 10 })
    const body = await request.json()
    const usage = { input_tokens: 10, output_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (body.stream) {
      upstreamStreamed++
      if (mode !== 'control') {
        const error = { type: 'error', error: { details: null, type: 'rate_limit_error', message: 'Rate limited' } }
        return new Response(`event: error\ndata: ${JSON.stringify(error)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      const events = [
        { type: 'message_start', message: { id: 'msg_control', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'MOCK_STREAMED_TEXT' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }
    upstreamNonstreamed++
    const tool = body.tools?.find(candidate => candidate.name.endsWith('get_weather'))
    const afterTool = body.messages?.some(message => Array.isArray(message.content)
      && message.content.some(block => block.type === 'tool_result'))
    const content = [{ type: 'text', text: 'MOCK_FALLBACK_TEXT' }]
    if (mode === 'tool' && tool && !afterTool) content.push({ type: 'tool_use', id: 'toolu_fallback_weather', name: tool.name, input: { city: 'Paris' } })
    return Response.json({ id: `msg_fallback_${upstreamNonstreamed}`, type: 'message', role: 'assistant', model: body.model,
      content, stop_reason: content.length > 1 ? 'tool_use' : 'end_turn', stop_sequence: null, usage })
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
const proxyPort = proxy.server.address().port
const tool = { name: 'get_weather', description: 'Get weather in a city.',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }
try {
  for (const selected of cases) {
    mode = selected
    const beforeStreamed = upstreamStreamed
    const beforeNonstreamed = upstreamNonstreamed
    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-meridian-agent': 'pi', 'x-session-affinity': crypto.randomUUID() },
      body: JSON.stringify({ model: 'haiku', max_tokens: 512, stream: true, tools: [tool],
        messages: [{ role: 'user', content: selected === 'tool' ? 'Call get_weather for Paris.' : 'Reply with the fixture answer.' }] }),
      signal: AbortSignal.timeout(120_000),
    })
    const raw = await response.text()
    assert.equal(response.status, 200, raw.slice(0, 2000))
    const events = raw.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    assert(!events.some(event => event.type === 'error'), raw.slice(0, 2000))
    assert.equal(events.filter(event => event.type === 'message_start').length, 1, raw.slice(0, 2000))
    assert.equal(events.filter(event => event.type === 'message_stop').length, 1, raw.slice(0, 2000))
    const text = events.filter(event => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
      .map(event => event.delta.text).join('')
    assert(text.includes(selected === 'control' ? 'MOCK_STREAMED_TEXT' : 'MOCK_FALLBACK_TEXT'), raw.slice(0, 2000))
    const tools = events.filter(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
    assert.equal(tools.length, selected === 'tool' ? 1 : 0, raw.slice(0, 2000))
    if (selected === 'tool') assert.equal(tools[0].content_block.name, 'get_weather')
    const stop = events.findLast(event => event.type === 'message_delta')?.delta.stop_reason
    assert.equal(stop, selected === 'tool' ? 'tool_use' : 'end_turn', raw.slice(0, 2000))
    assert(upstreamStreamed > beforeStreamed, 'CLI did not request streaming')
    if (selected === 'control') assert.equal(upstreamNonstreamed - beforeNonstreamed, 0)
    else assert(upstreamNonstreamed > beforeNonstreamed, 'CLI did not take the nonstreaming fallback path')
    console.log(JSON.stringify({ case: selected, result: 'PASS', streamCalls: upstreamStreamed - beforeStreamed,
      nonstreamCalls: upstreamNonstreamed - beforeNonstreamed, text, stop }))
  }
  assert.deepEqual(upstreamErrors, [])
} finally {
  await proxy.close()
  upstream.stop(true)
}
