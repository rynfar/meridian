import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const client = '/opt/e71/client287/node_modules/@anthropic-ai/claude-code/bin/claude.exe'
const expected = 'alpha-1\nalpha-2'
const parentId = 'tool_parent_01', handbackId = 'tool_handback_01'
const scratch = mkdtempSync(join(tmpdir(), 'meridian-handback-client-'))
for (const name of ['home', 'config', 'project', 'data', 'cache', 'state']) mkdirSync(join(scratch, name), { mode: 0o700 })
const proof = { kind: 'scripted-provider-real-client-handback-control', clientVersion: '2.1.287', actualModels: 0, realGrants: 0, apiRequests: 0, rootAgentDeclared: false, childHandbackDeclared: false, rootAgentSent: false, childHandbackSent: false, parentResultObserved: false, clientJoined: false, runtimeRemoved: false, failures: [] }
let actor, output = '', errors = '', joined = false
const stopOwnedClient = () => {
  try { process.kill(-actor.pid, 'SIGKILL') }
  catch (error) { if (error.code !== 'ESRCH') proof.failures.push('Owned client signal failed') }
}
const scalarText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(x => x?.type === 'text' && typeof x.text === 'string').map(x => x.text).join('\n') : ''
const server = http.createServer(async (request, response) => {
  try {
    let text = ''
    for await (const part of request) { text += part; assert(text.length <= 4194304, 'Request bound') }
    const body = text ? JSON.parse(text) : {}
    if (request.url.includes('count_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"input_tokens":50}'); return }
    if (request.url.split('?')[0] !== '/v1/messages') { proof.nonMessageRequests = (proof.nonMessageRequests ?? 0) + 1; response.writeHead(200, { 'content-type': 'application/json' }); response.end('{}'); return }
    assert(++proof.apiRequests <= 10, 'Request bound')
    const tools = new Set((body.tools ?? []).map(x => x.name))
    const isChild = typeof request.headers['x-claude-code-agent-id'] === 'string'
    if (isChild) assert(/^[A-Za-z0-9_-]{1,128}$/.test(request.headers['x-claude-code-agent-id']), 'Invalid public actor header')
    ;(proof.requestShapes ??= []).push({ number: proof.apiRequests, child: isChild, stream: body.stream === true, tools: tools.size, agent: tools.has('Agent'), bash: tools.has('Bash'), handback: tools.has('SubagentHandback'), noTools: tools.size === 0 })
    const results = (isChild ? [] : body.messages ?? []).flatMap(x => Array.isArray(x.content) ? x.content.filter(y => y.type === 'tool_result' && y.tool_use_id === parentId) : [])
    if (results.length) {
      const result = results.at(-1), value = scalarText(result.content)
      proof.parentResultObserved = true
      proof.parentResultIsError = result.is_error === true
      proof.parentContentKind = typeof result.content === 'string' ? 'string' : Array.isArray(result.content) ? 'blocks' : 'other'
      proof.parentContentBlocks = Array.isArray(result.content) ? result.content.length : null
      proof.parentCharacters = value.length
      // This is a zero-grant, zero-model scripted fixture's own public tool output.
      // No native/SDK transcript files or provider/system prompts are read.
      proof.scriptedFixtureParentOutput = value.slice(0, 2048).replaceAll(scratch, '<owned-runtime>').replace(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/gi, '<fixture-id>')
      proof.parentContainsExactReport = value.includes(expected)
      proof.parentContainsEscapedReport = value.includes(expected.replaceAll('\n', '\\n'))
      proof.parentContainsQuotedReport = value.includes(JSON.stringify(expected))
      proof.parentContainsFirstLine = value.includes('alpha-1')
      proof.parentContainsSecondLine = value.includes('alpha-2')
      proof.parentLineFeeds = (value.match(/\n/g) ?? []).length
      const first = value.indexOf('alpha-1'), second = value.indexOf('alpha-2', first + 7)
      proof.fixtureLineGapCharacters = first >= 0 && second >= 0 ? second - first - 7 : null
      proof.parentContainsStructuredReportField = value.includes('handbackReport')
      proof.parentContainsCompletionWithoutReport = /completed.*(?:no|without).*output/i.test(value)
    }
    let block
    if (isChild && proof.rootAgentSent && !proof.parentResultObserved && (proof.childBashCalls ?? 0) < 2 && tools.has('Bash')) {
      proof.childBashCalls = (proof.childBashCalls ?? 0) + 1
      block = { type: 'tool_use', id: 'tool_bash_' + proof.childBashCalls, name: 'Bash', input: { command: `printf 'alpha-${proof.childBashCalls}\\n'` } }
    } else if (isChild && tools.has('SubagentHandback') && !proof.childHandbackSent) {
      proof.childHandbackDeclared = true; proof.childHandbackSent = true
      block = { type: 'tool_use', id: handbackId, name: 'SubagentHandback', input: { message: expected } }
    } else if (!isChild && tools.has('Agent') && !proof.rootAgentSent) {
      proof.rootAgentDeclared = true; proof.rootAgentSent = true
      block = { type: 'tool_use', id: parentId, name: 'Agent', input: { description: 'Owned handback control', subagent_type: 'general-purpose', run_in_background: false, prompt: 'Run exactly two Bash commands, printf alpha-1 and printf alpha-2, then call SubagentHandback once with the complete two-line output alpha-1 followed by a newline followed by alpha-2. The handback is your final call.' } }
    } else {
      if (isChild && !proof.parentResultObserved && proof.childBashCalls === 2 && !tools.has('SubagentHandback')) { proof.childOrdinaryReportSent = true; block = { type: 'text', text: expected } }
      else {
      assert(proof.parentResultObserved, 'No correlated parent result; fixture cannot advance')
      block = { type: 'text', text: 'DONE' }
      }
    }
    const reason = block.type === 'tool_use' ? 'tool_use' : 'end_turn'
    const message = { id: 'msg_control_' + proof.apiRequests, type: 'message', role: 'assistant', model: body.model, content: [block], stop_reason: reason, stop_sequence: null, usage: { input_tokens: 50, output_tokens: 10 } }
    if (!body.stream) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(message)); return }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const event = (type, data) => response.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n')
    event('message_start', { message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 50, output_tokens: 0 } } })
    event('content_block_start', { index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } })
    event('content_block_delta', { index: 0, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } })
    event('content_block_stop', { index: 0 })
    event('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 10 } })
    event('message_stop', {})
    response.end()
  } catch (error) {
    proof.failures.push(error instanceof assert.AssertionError ? error.message : error.name)
    if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
    response.end('{"error":{"type":"api_error","message":"Bounded scripted control failure"}}')
  }
})
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const env = { PATH: process.env.PATH, HOME: join(scratch, 'home'), CLAUDE_CONFIG_DIR: join(scratch, 'config'), ANTHROPIC_AUTH_TOKEN: 'synthetic-owned-control', ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + server.address().port, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', XDG_CONFIG_HOME: join(scratch, 'config'), XDG_DATA_HOME: join(scratch, 'data'), XDG_CACHE_HOME: join(scratch, 'cache'), XDG_STATE_HOME: join(scratch, 'state') }
  const version = spawnSync(client, ['--version'], { env, cwd: scratch, encoding: 'utf8', timeout: 10000 })
  proof.clientVersionVerified = version.status === 0 && /^2\.1\.287\b/.test(version.stdout)
  assert(proof.clientVersionVerified, 'Pinned client version mismatch')
  actor = spawn(client, ['-p', 'Use one general-purpose Agent for the owned handback control, then reply DONE.', '--model', 'claude-sonnet-5-5', '--permission-mode', 'default', '--allowedTools', 'Agent', 'Bash(printf:*)'], { env, cwd: join(scratch, 'project'), detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  actor.stdout.on('data', chunk => { output += chunk; if (output.length > 1048576) { proof.failures.push('Client output bound'); stopOwnedClient() } })
  actor.stderr.on('data', chunk => { errors += chunk; if (errors.length > 1048576) { proof.failures.push('Client output bound'); stopOwnedClient() } })
  const timeout = setTimeout(() => { proof.failures.push('Owned client deadline'); stopOwnedClient() }, 60000)
  proof.clientExit = await new Promise((resolve, reject) => { actor.once('error', reject); actor.once('close', resolve) })
  clearTimeout(timeout); joined = true; proof.clientJoined = true
  proof.clientAnswered = /\bDONE\b/.test(output)
  proof.clientApiError = /API Error/.test(output + errors)
} catch (error) { proof.failures.push(error.name) }
finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  if (joined || !actor) { rmSync(scratch, { recursive: true }); proof.runtimeRemoved = true }
  proof.qualifiedFixture = proof.rootAgentSent && proof.childHandbackSent && proof.parentResultObserved && proof.clientExit === 0 && joined && proof.runtimeRemoved && !proof.failures.length
  proof.ordinaryAgentReportControlQualified = proof.childOrdinaryReportSent === true && proof.childBashCalls === 2 && proof.parentResultObserved && proof.parentContainsExactReport === true && proof.clientExit === 0 && joined && proof.runtimeRemoved && !proof.failures.length
  proof.strictReportDelivery = proof.qualifiedFixture && proof.parentContainsExactReport === true
  writeFileSync('/proof/RESULT.json', JSON.stringify(proof, null, 2) + '\n')
  console.log(JSON.stringify(proof))
}
process.exitCode = proof.qualifiedFixture ? 0 : 2
