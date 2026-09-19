// Opt-in real subscription-backed CLI capability gate. Run after npm run build.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { createImageFixture } from './lib-antigravity-image-checks.mjs'
import { startProxyServer } from '../dist/server.js'
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-capabilities-'))
console.log(`Artifacts: ${root}`)
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const report = { model, platform: process.platform, node: process.version, cli: spawnSync(process.env.MERIDIAN_AGY_PATH || 'agy', ['--version'], { encoding: 'utf8' }).stdout.trim(), passed: [] }
const exchanges = []
const proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { allowToolBridge: true, executable: process.env.MERIDIAN_AGY_PATH } })
try {
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const base = `http://127.0.0.1:${proxy.server.address().port}`
  async function send(body) {
    const response = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 2048, ...body }), signal: AbortSignal.timeout(180000) })
    const text = await response.text()
    exchanges.push({ body, status: response.status, response: text })
    assert.equal(response.status, 200, text)
    return body.stream ? text : JSON.parse(text)
  }
  if (process.env.E2E_CAPABILITIES_LARGE_IMAGE_ONLY !== '1') {
  const receipt = randomUUID()
  const format = { type: 'json_schema', schema: { type: 'object', properties: { receipt: { type: 'string', enum: [receipt] }, count: { type: 'integer' } }, required: ['receipt', 'count'], additionalProperties: false } }
  for (const stream of [false, true]) {
    const result = await send({ messages: [{ role: 'user', content: `Return receipt ${receipt} and count 7, matching the schema.` }], output_config: { format }, stream })
    const text = stream ? result.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).filter(event => event.type === 'content_block_delta').map(event => event.delta.text || '').join('') : result.content.map(block => block.text).join('')
    assert.deepEqual(JSON.parse(text), { receipt, count: 7 })
    report.passed.push(`native structured output ${stream ? 'SSE' : 'JSON'}`)
    console.log('PASS', report.passed.at(-1))
  }
  for (const stream of [false, true]) {
    const result = await send({ messages: [{ role: 'user', content: 'Reply with exactly this text, without quotes or formatting: PREFIX<HALT>TAIL' }], stop_sequences: ['<HALT>'], stream })
    if (stream) {
      const events = result.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
      assert.equal(events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text || '').join(''), 'PREFIX')
      assert(events.some(event => event.type === 'message_delta' && event.delta.stop_reason === 'stop_sequence' && event.delta.stop_sequence === '<HALT>'))
    } else {
      assert.equal(result.content.map(block => block.text).join(''), 'PREFIX')
      assert.equal(result.stop_reason, 'stop_sequence'); assert.equal(result.stop_sequence, '<HALT>')
    }
    const health = await (await fetch(base + '/health')).json()
    assert.equal(health.processes, 0)
    report.passed.push(`text stop sequence ${stream ? 'SSE' : 'JSON'} and process cleanup`)
    console.log('PASS', report.passed.at(-1))
  }
  for (const choice of [{ type: 'any' }, { type: 'tool', name: 'lookup_receipt' }]) {
    const tools = [{ name: 'lookup_receipt', description: 'Get the receipt for a key.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }]
    const messages = [{ role: 'user', content: 'Get the receipt for key probe and report it.' }]
    const output_config = choice.type === 'tool' ? { format: { type: 'json_schema', schema: { type: 'object', properties: { receipt: { type: 'string' } }, required: ['receipt'], additionalProperties: false } } } : undefined
    const first = await send({ messages, tools, tool_choice: choice, output_config })
    assert.equal(first.stop_reason, 'tool_use'); assert.equal(first.content.length, 1)
    const call = first.content[0]; assert.equal(call.name, 'lookup_receipt'); assert.equal(call.input.key, 'probe')
    const secret = randomUUID()
    const result = await send({ messages: [...messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: secret }] }], tools, tool_choice: { type: 'auto' }, output_config })
    assert.equal(result.stop_reason, 'end_turn'); assert(JSON.stringify(result.content).includes(secret))
    if (output_config) assert.deepEqual(JSON.parse(result.content.map(b => b.text).join('')), { receipt: secret })
    report.passed.push(`forced ${choice.type} tool followed by automatic continuation${output_config ? ' with native schema output' : ''}`)
    console.log('PASS', report.passed.at(-1))
  }
  }
  const image = await createImageFixture(root, 'large-image', { large: true })
  assert(image.data.length > 5 * 1024 * 1024, 'Fixture must exercise multi-megabyte Node parsing')
  const result = await send({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Return only the six characters visibly printed in this image.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image.data } }] }] })
  assert(result.content.map(b => b.text || '').join('').includes(image.expected), JSON.stringify(result))
  report.passed.push('multi-megabyte image through production Node and actual CLI vision')
  console.log('PASS', report.passed.at(-1))
  report.cliAtEnd = spawnSync(process.env.MERIDIAN_AGY_PATH || 'agy', ['--version'], { encoding: 'utf8' }).stdout.trim()
  assert.equal(report.cliAtEnd, report.cli)
} catch (error) { report.error = String(error); throw error }
finally {
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  await writeFile(join(root, 'exchanges.json'), JSON.stringify(exchanges, null, 2))
  await proxy.close()
}
