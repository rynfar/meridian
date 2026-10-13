#!/usr/bin/env bun
// Live: does a Responses-API client that records each tool output right after
// its own call still resume the passthrough checkpoint? (#1201)
//
// After a parallel tool batch, a client may return the history either grouped
//
//   function_call A, function_call B, function_call_output A, function_call_output B
//
// or one pair per call
//
//   function_call A, function_call_output A, function_call B, function_call_output B
//
// Both settle the same batch. The second reaches Meridian as
// [assistant A, user A, assistant B, user B], which the checkpoint matcher
// rejected, so the turn fell back to a full uncached replay.
//
// The same real batch is answered both ways on separate conversations. Grouped
// is the control and must resume on any build. Per-call must resume with the
// fix and replays without it. A per-call history with one output missing must
// not resume on any build. Assertions are on the resume flag and HTTP status,
// never on the model's wording.
//
// Costs a few cents of real tokens and needs a logged-in Claude subscription.
//
//   bun scripts/e2e-responses-per-call-results.mjs
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'meridian-per-call-results-')))
for (const key of Object.keys(process.env)) {
  if (key.startsWith('MERIDIAN_') || key.startsWith('CLAUDE_PROXY_')) delete process.env[key]
}
Object.assign(process.env, { MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: root, MERIDIAN_TELEMETRY_PERSIST: '0', MERIDIAN_PASSTHROUGH: '1' })
const { startProxyServer } = await import('../src/proxy/server.ts')
const { telemetryStore } = await import('../src/telemetry/index.ts')
const instance = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true })
const address = instance.server.address()
assert(address && typeof address === 'object')
const model = process.env.E2E_MODEL ?? 'claude-opus-5-5'
const tools = ['get_alpha', 'get_beta'].map(name => ({ type: 'function', name,
  description: `Return the ${name.slice(4)} fixture value.`,
  parameters: { type: 'object', properties: {}, additionalProperties: false } }))
const opening = { role: 'user', content: [{ type: 'input_text', text:
  'Test this tool transport: call get_alpha and get_beta, both in the SAME response, before waiting for any result. '
  + 'When both results arrive, reply with the two values and nothing else. Do not call any tool again.' }] }

async function post(cacheKey, input) {
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-meridian-agent': 'codex' },
    body: JSON.stringify({ model, stream: false, prompt_cache_key: cacheKey, tools, input }),
    signal: AbortSignal.timeout(180_000),
  })
  const raw = await response.text()
  const metric = telemetryStore.getRecent({ limit: 1 })[0]
  let output = []
  try { output = JSON.parse(raw).output ?? [] } catch { /* reported through the status below */ }
  return { status: response.status, raw, output, resumed: metric?.isResume === true,
    cacheRead: metric?.cacheReadInputTokens ?? 0, lineage: metric?.lineageType }
}

const report = { result: 'RUNNING', model, platform: `${process.platform}/${process.arch}`, arms: {}, checks: [] }
const check = (ok, label, detail) => {
  report.checks.push({ ok: Boolean(ok), label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const orderings = {
  grouped: (calls, outputs) => [...calls, ...outputs],
  'per-call': (calls, outputs) => calls.flatMap((call, index) => [call, outputs[index]]),
  'per-call-missing-output': (calls, outputs) => [calls[0], outputs[0], calls[1]],
}
try {
  for (const [name, order] of Object.entries(orderings)) {
    const cacheKey = randomUUID()
    const first = await post(cacheKey, [opening])
    assert.equal(first.status, 200, first.raw)
    const calls = first.output.filter(item => item.type === 'function_call')
    assert.equal(calls.length, 2, `Fixture precondition: the model must emit both calls in one response (${name}): ${first.raw.slice(0, 400)}`)
    const callItems = calls.map(call => ({ type: 'function_call', call_id: call.call_id, name: call.name, arguments: call.arguments }))
    const outputItems = calls.map(call => ({ type: 'function_call_output', call_id: call.call_id, output: `${call.name}_${randomUUID()}` }))
    const second = await post(cacheKey, [opening, ...order(callItems, outputItems)])
    report.arms[name] = { status: second.status, resumed: second.resumed, lineage: second.lineage, cacheRead: second.cacheRead,
      calledAgain: second.output.some(item => item.type === 'function_call') }
  }
  const { grouped, 'per-call': perCall, 'per-call-missing-output': missing } = report.arms
  console.log(`\n=== per-call tool results (model=${model}, ${report.platform}) ===`)
  check(grouped.status === 200 && grouped.resumed, 'control: grouped results resume the checkpoint', JSON.stringify(grouped))
  check(perCall.status === 200 && perCall.resumed, 'one echo/result pair per call resumes the checkpoint', JSON.stringify(perCall))
  check(!missing.resumed, 'a per-call history with an output missing does not resume', JSON.stringify(missing))
  report.result = report.checks.every(row => row.ok) ? 'PASS' : 'FAIL'
} catch (error) {
  report.result = 'FAIL'
  report.failure = String(error?.stack ?? error)
} finally {
  await instance.close()
  console.log(JSON.stringify(report))
  process.exitCode = report.result === 'PASS' ? 0 : 1
}
