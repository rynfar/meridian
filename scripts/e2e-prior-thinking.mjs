// Opt-in: npm run build && node scripts/e2e-prior-thinking.mjs
// Isolated state/auth copy, actual SDK + Opus 5.5, Pi-shaped streaming HTTP.
// Only numeric/field-name evidence is emitted or persisted. No raw transcripts.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, copyFile, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { once } from 'node:events'
import { createServer } from 'node:http'

const root = await mkdtemp('/tmp/meridian-prior-thinking-')
const credentials = process.env.E2E_CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const reportPath = process.env.E2E_REPORT_PATH
for (const key of Object.keys(process.env)) {
  if (/^(MERIDIAN_|CLAUDE_PROXY_|ANTHROPIC_|CLAUDE_CODE_EXTRA_BODY|CLAUDE_CONFIG_DIR)/.test(key)) delete process.env[key]
}
await mkdir(join(root, 'auth'), { mode: 0o700 })
await copyFile(join(credentials, '.credentials.json'), join(root, 'auth', '.credentials.json'))
await mkdir(join(root, 'work'))
await mkdir(join(root, 'config'))
let setting = 'off'
const upstream = []
const relay = createServer(async (request, response) => {
  try {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    let body
    try { body = JSON.parse(bytes) } catch { /* Non-Messages endpoint. */ }
    let row
    if (Array.isArray(body?.messages)) {
      const assistants = body.messages.filter(message => message.role === 'assistant')
      const thinking = assistants.map(message => message.content.filter(block => ['thinking', 'redacted_thinking'].includes(block.type)).length)
      // Index (among assistants) of the first assistant after the last plain
      // user prompt: the open turn. Thinking before it is prior-turn thinking.
      let openTurnStart = 0
      body.messages.forEach(message => {
        const plain = message.role === 'user' && (typeof message.content === 'string' || !message.content.some(block => block.type === 'tool_result'))
        if (plain) openTurnStart = body.messages.slice(0, body.messages.indexOf(message)).filter(m => m.role === 'assistant').length
      })
      row = { setting, thinkingType: body.thinking?.type, assistantMessages: assistants.length, openTurnStart, thinkingBlocks: thinking.reduce((a, b) => a + b, 0), thinkingMessageIndices: thinking.flatMap((count, index) => count ? [index] : []), contextKeep: body.context_management?.edits?.find(edit => edit.type === 'clear_thinking_20251015')?.keep }
      upstream.push(row)
    }
    const headers = { ...request.headers }
    for (const key of ['host', 'content-length', 'connection', 'accept-encoding']) delete headers[key]
    const result = await fetch('https://api.anthropic.com' + request.url, { method: request.method, headers, body: bytes.length ? bytes : undefined })
    response.writeHead(result.status, Object.fromEntries([...result.headers].filter(([key]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(key))))
    if (row) row.status = result.status
    let upstreamText = ''
    if (result.body) for await (const chunk of result.body) {
      response.write(chunk)
      if (row) upstreamText += Buffer.from(chunk).toString()
    }
    response.end()
    if (row) {
      for (const line of upstreamText.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          const event = JSON.parse(line.slice(6))
          if (event.message?.usage) row.usage = { ...row.usage, ...event.message.usage }
          if (event.usage) row.usage = { ...row.usage, ...event.usage }
          if (event.error) row.errorType = event.error.type
        } catch { /* A non-SSE error body has no usage. */ }
      }
    }
  } catch (error) {
    if (!response.headersSent) response.writeHead(502)
    response.end()
    console.error(JSON.stringify({ relayError: error.name }))
  }
})
relay.listen(0, '127.0.0.1')
await once(relay, 'listening')
Object.assign(process.env, {
  MERIDIAN_CONFIG_DIR: join(root, 'config'), MERIDIAN_SESSION_DIR: join(root, 'sessions'),
  MERIDIAN_WORKDIR: join(root, 'work'), MERIDIAN_PASSTHROUGH: '1', MERIDIAN_NO_FILE_CHANGES: '1',
  MERIDIAN_NO_UPDATE_CHECK: '1', MERIDIAN_CREDENTIALS_READONLY: '1', CLAUDE_CONFIG_DIR: join(root, 'auth'),
  MERIDIAN_PLUGIN_DIR: join(root, 'plugins'), MERIDIAN_PLUGIN_CONFIG: join(root, 'plugins.json'),
  MERIDIAN_SILENT: '1', MERIDIAN_QUIET: '1',
})
const { startProxyServer } = await import('../dist/server.js')
const proxy = await startProxyServer({ port: 0, host: '127.0.0.1', silent: true,
  profiles: [{ id: 'e2e', type: 'api', baseUrl: `http://127.0.0.1:${relay.address().port}` }],
})
if (!proxy.server.listening) await once(proxy.server, 'listening')
assert.notEqual(proxy.server.address().port, 3456)
const report = { platform: process.platform, node: process.version, sdk: JSON.parse(await readFile(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url))).version, cli: JSON.parse(await readFile(new URL('../node_modules/@anthropic-ai/claude-code/package.json', import.meta.url))).version, model: 'claude-opus-5-5', client: 'Pi-shaped HTTP', rows: [], upstream }
const tool = { name: 'read', description: 'Read the outcome of the specified weighing.', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
try {
  for (setting of ['off', 'on']) {
    process.env.MERIDIAN_DROP_PRIOR_THINKING = setting === 'on' ? '1' : '0'
    const messages = []
    let count = 0
    async function send() {
      const start = upstream.length
      const result = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-meridian-agent': 'pi', 'x-session-affinity': `thinking-${setting}` },
        body: JSON.stringify({ model: report.model, max_tokens: 4096, stream: true, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
          system: 'You are a helpful assistant. Use only the supplied client read tool when requested. Think carefully before each call: each reading changes the solution, so reason about it before requesting the next reading.', tools: [tool], messages }),
        signal: AbortSignal.timeout(240000),
      })
      assert.equal(result.status, 200)
      const content = []
      let usage = {}, stopReason, thinkingDeltas = 0, signatureDeltas = 0
      const text = await result.text()
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const event = JSON.parse(line.slice(6))
        if (event.type === 'error') {
          report.errorType = event.error?.type
          console.error(JSON.stringify({ clientErrorType: report.errorType }))
        }
        assert.notEqual(event.type, 'error')
        if (event.type === 'message_start') usage = { ...usage, ...event.message.usage }
        if (event.type === 'message_delta') { usage = { ...usage, ...event.usage }; stopReason = event.delta.stop_reason }
        if (event.type === 'content_block_start') content[event.index] = { ...event.content_block }
        if (event.type === 'content_block_delta') {
          const block = content[event.index]
          if (event.delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + event.delta.thinking; thinkingDeltas++ }
          if (event.delta.type === 'signature_delta') { block.signature = (block.signature || '') + event.delta.signature; signatureDeltas++ }
          if (event.delta.type === 'text_delta') block.text = (block.text || '') + event.delta.text
          if (event.delta.type === 'input_json_delta') block.partial = (block.partial || '') + event.delta.partial_json
        }
      }
      assert(stopReason)
      for (const block of content) if (block.type === 'tool_use') { block.input = JSON.parse(block.partial || '{}'); delete block.partial }
      const visibleChars = content.reduce((sum, block) => sum + (block.thinking?.length || block.text?.length || (block.type === 'tool_use' ? JSON.stringify({ name: block.name, input: block.input }).length : 0)), 0)
      const row = { setting, request: ++count, input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens || 0, cacheWrite: usage.cache_creation_input_tokens || 0, output: usage.output_tokens, visibleTokensEstimate: Math.round(visibleChars / 4), signatureTokensEstimate: Math.round(content.reduce((sum, block) => sum + (block.signature?.length || 0), 0) / 4), thinkingDeltas, signatureDeltas, toolCalls: content.filter(block => block.type === 'tool_use').length, upstreamRequests: upstream.length - start }
      row.billedUpstreamOutput = upstream.slice(start).reduce((sum, request) => sum + (request.usage?.output_tokens || 0), 0)
      row.prompt = row.input + row.cacheRead + row.cacheWrite
      const previous = report.rows.filter(entry => entry.setting === setting).at(-1)
      if (previous) row.promptGrowth = row.prompt - previous.prompt
      report.rows.push(row)
      console.log(JSON.stringify(row))
      const requests = upstream.slice(start)
      assert(requests.length >= 1)
      // Meridian may spend its existing silent-turn recovery query when the
      // model returns thinking without an answer. Record, don't hide, that work.
      for (const request of requests) {
        assert.equal(request.status, 200)
        if (count > 1) assert(request.assistantMessages > 0, 'History replayed instead of resumed')
        // Only the newest assistant API message may carry thinking: earlier steps
        // of the same open tool loop must arrive without it, and be accepted.
        if (setting === 'on') assert(request.thinkingMessageIndices.every(index => index === request.assistantMessages - 1), 'Thinking older than the newest assistant message reached the API')
      }
      messages.push({ role: 'assistant', content })
      return content
    }
    messages.push({ role: 'user', content: 'Find and prove the optimal number of weighings to identify a single counterfeit among 13 coins when it can be lighter or heavier and a separate known genuine coin is available. Derive the information lower bound and a feasible adaptive strategy. Be rigorous but keep the final answer concise. Do not use tools.' })
    await send()
    messages.push({ role: 'user', content: 'Check the result for 14 coins instead, rigorously and briefly.' })
    await send()
    messages.push({ role: 'user', content: 'Use three sequential read tool calls to collect measurement 1, measurement 2, and measurement 3, using one call per request and waiting for each result. Think about what each result implies before asking for the next. After the third result, give a short textual summary. Do not solve the counterfeit problem here.' })
    let calls = 0
    for (let attempt = 0; attempt < 6; attempt++) {
      const content = await send()
      const tools = content.filter(block => block.type === 'tool_use')
      if (!tools.length) break
      calls += tools.length
      messages.push({ role: 'user', content: tools.map(block => ({ type: 'tool_result', tool_use_id: block.id, content: 'The measured result is 17. Confirm it and request the next measurement if fewer than three have been read; after three, summarize.' })) })
    }
    assert(calls >= 3, 'Multi-step tool loop was not exercised')
    assert.equal(messages.at(-1).role, 'assistant')
    messages.push({ role: 'user', content: 'Check optimality for 15 coins instead, rigorously and briefly, no tools.' })
    await send()
    messages.push({ role: 'user', content: 'And for 16 coins, rigorously and briefly, no tools.' })
    await send()
    assert(report.rows.filter(row => row.setting === setting).some(row => row.thinkingDeltas > 0 && row.signatureDeltas > 0), 'Thinking was not streamed')
  }
  // Manual (budget) thinking probe: record whether this model/SDK path accepts it.
  setting = 'budget-probe'
  process.env.MERIDIAN_DROP_PRIOR_THINKING = '1'
  const probeStart = upstream.length
  const probe = await fetch(`http://127.0.0.1:${proxy.server.address().port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-meridian-agent': 'pi', 'x-session-affinity': 'thinking-budget-probe' },
    body: JSON.stringify({ model: report.model, max_tokens: 4096, stream: true, thinking: { type: 'enabled', budget_tokens: 2048 },
      messages: [{ role: 'user', content: 'In one sentence, why is 13 coins the maximum for three weighings with a reference coin?' }] }),
    signal: AbortSignal.timeout(240000),
  })
  const probeText = await probe.text()
  report.budgetProbe = { httpStatus: probe.status, clientError: /"type":"error"/.test(probeText),
    thinkingDeltas: (probeText.match(/thinking_delta/g) || []).length,
    upstream: upstream.slice(probeStart).map(row => ({ status: row.status, thinkingType: row.thinkingType, errorType: row.errorType })) }
  console.log(JSON.stringify({ budgetProbe: report.budgetProbe }))
  report.passed = true
} finally {
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
  await proxy.close()
  relay.closeAllConnections()
  await new Promise(resolve => relay.close(resolve))
  await rm(root, { recursive: true, force: true })
}
