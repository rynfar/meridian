// Real official CLI: expiry and capacity recovery, with complete client-owned results.
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { startProxyServer } from '../dist/server.js'

const root = await mkdtemp(join(tmpdir(), 'meridian-agy-recovery-'))
console.log(`Artifacts: ${root}`)
const model = process.env.E2E_AGY_MODEL || 'gemini-3.8-flash-low'
const executable = process.env.MERIDIAN_AGY_PATH || 'agy'
const version = () => {
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const report = { model, cli: version(), platform: process.platform, node: process.version, passed: [] }
let proxy
try {
  for (const mode of ['expiry', 'capacity']) {
    proxy = await startProxyServer({ backend: 'antigravity', port: 0, silent: true, antigravity: { executable, allowToolBridge: true, maxConcurrent: 1, pendingToolTimeoutMs: mode === 'expiry' ? 1000 : 60000 } })
    if (!proxy.server.listening) await once(proxy.server, 'listening')
    const address = proxy.server.address()
    assert(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const send = async body => {
      const response = await fetch(url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 512, ...body }), signal: AbortSignal.timeout(90000) })
      const result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      return result
    }
    const request = { tools: [{ name: 'receipt', description: 'Read a client receipt exactly once', input_schema: { type: 'object', properties: {}, additionalProperties: false } }], tool_choice: { type: 'tool', name: 'receipt' }, messages: [{ role: 'user', content: 'Call receipt once, then report the exact receipt returned by the client. Never repeat a completed call.' }] }
    const first = await send(request)
    const call = first.content.find(block => block.type === 'tool_use')
    assert.equal(call?.name, 'receipt')
    if (mode === 'expiry') {
      const deadline = Date.now() + 15000
      while ((await (await fetch(url + '/health')).json()).processes !== 0) {
        assert(Date.now() < deadline, 'Expired tool process must exit')
        await delay(250)
      }
    } else {
      const independent = await send({ messages: [{ role: 'user', content: 'Reply with exactly CAPACITY_READY. Do not use tools.' }] })
      assert(JSON.stringify(independent.content).includes('CAPACITY_READY'))
      assert.equal((await (await fetch(url + '/health')).json()).reclaimed, 1)
    }
    const receipt = `RECOVERED_${randomUUID()}`
    const response = await send({ ...request, tool_choice: { type: 'none' }, messages: [...request.messages, { role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: receipt }] }] })
    assert.equal(response.stop_reason, 'end_turn')
    assert(JSON.stringify(response.content).includes(receipt))
    report.passed.push(`${mode}: completed result recovered without another tool call`)
    await writeFile(join(root, `${mode}.json`), JSON.stringify({ first, response }, null, 2))
    await proxy.close()
    proxy = undefined
    console.log(`PASS ${mode}`)
  }
  assert.equal(version(), report.cli)
} catch (error) {
  report.error = String(error)
  throw error
} finally {
  await proxy?.close()
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
