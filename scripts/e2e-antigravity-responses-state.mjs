// Actual subscription-backed Responses state acceptance. Run after npm run build.
import assert from 'node:assert/strict'
import { startProxyServer } from '../dist/server.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'

const root = await mkdtemp(join(tmpdir(), 'meridian-agy-responses-state-'))
console.log(root)
const passed = []
const proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { allowToolBridge: true } })
if (!proxy.server.listening) await once(proxy.server, 'listening')
const url = 'http://127.0.0.1:' + proxy.server.address().port
const model = 'gemini-3.8-flash-low'
const instructions = 'Follow the user precisely. Do not use native tools.'
const text = value => value.output.filter(item => item.type === 'message').flatMap(item => item.content).filter(part => part.type === 'output_text').map(part => part.text).join('').trim()
const mark = name => { passed.push(name); console.log('PASS', name) }
async function post(body) {
  const result = await fetch(url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, instructions, ...body }), signal: AbortSignal.timeout(90000) })
  const wire = await result.text()
  await writeFile(join(root, 'request-' + randomUUID() + '.json'), JSON.stringify({ body, status: result.status, wire }, null, 2))
  assert.equal(result.status, 200, wire)
  if (!body.stream) return JSON.parse(wire)
  const events = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  assert(!events.some(event => event.type === 'error'), wire)
  const completed = events.find(event => event.type === 'response.completed')
  assert(completed, wire)
  assert.equal(events.find(event => event.type === 'response.created').response.id, completed.response.id)
  return completed.response
}
try {
  const receipt = 'STATE_' + randomUUID()
  const first = await post({ input: 'Remember this receipt and reply with exactly it: ' + receipt, metadata: { gate: 'state' } })
  assert.equal(text(first), receipt)
  assert.equal(first.store, true)
  assert.deepEqual(await (await fetch(url + '/v1/responses/' + first.id)).json(), first)
  mark('stored JSON retrieval')
  const second = await post({ input: 'Reply with exactly the receipt from my preceding message.', previous_response_id: first.id, stream: true })
  assert.equal(text(second), receipt)
  assert.equal(second.previous_response_id, first.id)
  assert.deepEqual(await (await fetch(url + '/v1/responses/' + second.id)).json(), second)
  const health = await (await fetch(url + '/health')).json()
  assert(health.reused >= 1, JSON.stringify(health))
  mark('streamed ID continuation with native warm reuse')
  const fork = await post({ input: 'Reply with exactly the receipt from my first message.', previous_response_id: first.id, instructions: 'Only output the requested receipt.', store: false })
  assert.equal(text(fork), receipt)
  assert.equal((await fetch(url + '/v1/responses/' + fork.id)).status, 404)
  mark('fork with replacement instructions and store false')
  const tools = [{ type: 'function', name: 'receipt', description: 'Get the receipt', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
  const toolTurn = await post({ input: 'Call receipt once. Then reply with exactly its returned text.', tools, tool_choice: 'required', stream: true })
  const call = toolTurn.output.find(item => item.type === 'function_call')
  assert(call)
  const toolReceipt = 'TOOL_' + randomUUID()
  const continued = await post({ previous_response_id: toolTurn.id, input: [{ type: 'function_call_output', call_id: call.call_id, output: toolReceipt }], tools })
  assert.equal(text(continued), toolReceipt)
  mark('streamed tool call continued by ID with JSON result')
  const deleted = await fetch(url + '/v1/responses/' + toolTurn.id, { method: 'DELETE' })
  assert.deepEqual(await deleted.json(), { id: toolTurn.id, object: 'response', deleted: true })
  assert.equal((await fetch(url + '/v1/responses/' + toolTurn.id)).status, 404)
  assert.equal((await fetch(url + '/v1/responses/' + continued.id)).status, 200)
  const missing = await fetch(url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input: 'hello', previous_response_id: toolTurn.id }) })
  assert.equal(missing.status, 404)
  mark('deletion rejects future lookup while completed descendants survive')
} finally {
  await proxy.close()
  await writeFile(join(root, 'report.json'), JSON.stringify({ model, platform: process.platform, passed }, null, 2))
}
