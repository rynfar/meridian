// Official subscription CLI acceptance gate: warm reuse and OpenAI wire formats.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { startProxyServer } from '../dist/server.js'
const root = await mkdtemp(join(tmpdir(), 'meridian-agy-expansion-'))
console.log(`Artifacts: ${root}`)
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const report = { model, platform: process.platform, node: process.version, passed: [] }
let proxy
try {
  proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { allowToolBridge: true, maxConcurrent: 2 } })
  if (!proxy.server.listening) await once(proxy.server, 'listening')
  const url = `http://127.0.0.1:${proxy.server.address().port}`
  const send = async (path, body) => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, ...body }), signal: AbortSignal.timeout(90000) })
    const text = await response.text()
    assert.equal(response.status, 200, text)
    return body.stream ? text : JSON.parse(text)
  }
  const receipt = `NATIVE_${randomUUID()}`
  const messages = [{ role: 'user', content: `Remember this exact receipt: ${receipt}. Reply only SAVED. No tools.` }]
  const first = await send('/v1/messages', { messages })
  messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: 'Return the exact receipt from the previous turn. No tools.' })
  const second = await send('/v1/messages', { messages })
  assert(JSON.stringify(second.content).includes(receipt))
  const health = await (await fetch(url + '/health')).json()
  assert.equal(health.reused, 1)
  assert.equal(health.processes, 1)
  await writeFile(join(root, 'native.json'), JSON.stringify({ first, second, health }, null, 2))
  report.passed.push('Native live-process continuation, exact receipt recall, one process')
  console.log('PASS native reuse')
  for (const path of ['/v1/chat/completions', '/v1/responses']) {
    for (const stream of [false, true]) {
      const marker = `WIRE_${randomUUID().replaceAll('-', '')}`
      const prompt = `Return exactly ${marker}. No tools.`
      const input = path.endsWith('responses') ? { input: prompt } : { messages: [{ role: 'user', content: prompt }] }
      const answer = await send(path, { ...input, stream })
      const text = typeof answer === 'string' ? answer : JSON.stringify(answer)
      const decoded = stream ? text.split("\n").filter(line => line.startsWith("data: ") && line !== "data: [DONE]").map(line => JSON.parse(line.slice(6))).map(event => path.endsWith("responses") ? event.type === "response.output_text.delta" ? event.delta : "" : event.choices?.[0]?.delta?.content ?? "").join("") : text
      assert(decoded.includes(marker), text)
      if (stream) assert(text.includes(path.endsWith('responses') ? 'response.completed' : '[DONE]'), text)
      await writeFile(join(root, `${path.split('/').at(-1)}-${stream}.txt`), text)
      report.passed.push(`${path} ${stream ? 'SSE' : 'JSON'}`)
      console.log(`PASS ${path} ${stream}`)
    }
  }
  const request = { tools: [{ name: 'receipt', description: 'Read independent client receipts. Call twice concurrently with keys a and b.', input_schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false } }], messages: [{ role: 'user', content: 'Call receipt for a and b concurrently in the same parallel batch, then return both exact results. Both calls are independent. Do not repeat either call.' }] }
  const receipts = { a: randomUUID(), b: randomUUID() }
  let history = request.messages
  const calls = []
  let largestBatch = 0
  for (let turn = 0; turn < 4; turn++) {
    const answer = await send('/v1/messages', { ...request, messages: history })
    const batch = answer.content.filter(block => block.type === 'tool_use')
    if (!batch.length) {
      assert(JSON.stringify(answer.content).includes(receipts.a) && JSON.stringify(answer.content).includes(receipts.b))
      break
    }
    largestBatch = Math.max(largestBatch, batch.length)
    const results = batch.map(call => {
      assert(['a', 'b'].includes(call.input.key))
      assert(!calls.includes(call.input.key), 'Repeated tool')
      calls.push(call.input.key)
      return { type: 'tool_result', tool_use_id: call.id, content: receipts[call.input.key] }
    }).reverse()
    history = [...history, { role: 'assistant', content: answer.content }, { role: 'user', content: results }]
  }
  assert.equal(calls.length, 2)
  report.largestNativeToolBatch = largestBatch
  assert.equal(largestBatch, 2, 'CLI did not deliver a parallel batch; retain this evidence')
  report.passed.push('Parallel real CLI calls delivered in one client response, reverse-order receipts')
} catch (error) { report.error = String(error); throw error }
finally {
  await proxy?.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
