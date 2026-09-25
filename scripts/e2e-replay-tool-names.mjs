#!/usr/bin/env bun
/** Real SDK/model gate for #1107's fresh Pi replay name mapping. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spyOn } from 'bun:test'
import * as sdk from '@anthropic-ai/claude-agent-sdk'

const stream = process.argv.includes('--stream')
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-replay-names-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_PASSTHROUGH: '1',
})

const originalQuery = sdk.query
const prompts = []
const observer = spyOn(sdk, 'query').mockImplementation(input => {
  prompts.push(input.prompt)
  return originalQuery(input)
})
const { startProxyServer } = await import('../src/proxy/server.ts')
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
const address = proxy.server.address()
assert(address && typeof address === 'object')
const url = `http://127.0.0.1:${address.port}/v1/messages`

const messages = [{ role: 'user', content: 'Inspect the working directory.' }]
for (let index = 0; index < 12; index++) {
  const id = `old-bash-${index}`
  messages.push(
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: { command: `printf old-${index}` } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `old-${index}` }] },
  )
}
messages.push({ role: 'user', content: 'Use the bash tool to run printf READY. This turn needs a new tool call; do not infer the result from earlier calls.' })
const tool = {
  name: 'bash', description: 'Run a shell command on the client computer.',
  input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}

try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-meridian-agent': 'pi', 'x-session-affinity': randomUUID() },
    body: JSON.stringify({ model, max_tokens: 512, stream, tools: [tool], messages }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  assert.equal(response.status, 200, raw.slice(0, 2000))
  const prompt = prompts.find(value => typeof value === 'string' && value.includes('Previously called tool:'))
  assert.equal(typeof prompt, 'string', 'real SDK query lacked fresh replay text')
  const rendered = [...prompt.matchAll(/Previously called tool: ({[^\n]+})/g)].map(match => JSON.parse(match[1]))
  assert.equal(rendered.length, 12)
  for (const call of rendered) assert.equal(call.name, 'mcp__oc__bash')
  assert(!prompt.includes('"name":"bash"'), 'bare client name leaked into model-facing replay calls')

  let calls
  if (stream) {
    const events = raw.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    assert(!events.some(event => event.type === 'error'), raw.slice(0, 2000))
    assert.equal(events.filter(event => event.type === 'message_stop').length, 1)
    calls = events.filter(event => event.type === 'content_block_start' && event.content_block?.type === 'tool_use')
      .map(event => event.content_block)
  } else {
    const body = JSON.parse(raw)
    calls = body.content.filter(block => block.type === 'tool_use')
  }
  assert(calls.length > 0, 'real model did not request the client tool')
  for (const call of calls) assert.equal(call.name, 'bash')
  console.log(JSON.stringify({ result: 'PASS', model, stream, oldCalls: rendered.length,
    sdkName: rendered[0]?.name, clientCalls: calls.length, clientName: calls[0]?.name, root }))
} finally {
  observer.mockRestore()
  await proxy.close()
}
