#!/usr/bin/env bun
// Live: do Codex's namespaced (MCP) tools reach Claude, come back as calls
// Codex can route, and survive a second turn carrying their results?
//
// Codex 0.15x stopped sending MCP tools as flat `function` entries. Each server
// arrives as one `{type:"namespace", name:"mcp__<server>", tools:[...]}` with
// the definitions nested inside. `translateResponsesToAnthropic` kept only
// `type:"function"`, so every namespace was dropped silently (#964).
//
// Verified against a real capture from codex-cli 0.153.4 driving an actual
// stdio MCP server: 13 top-level entries, 2 of them namespaces holding 7 tools.
// Pre-fix, 10 tools reached Claude and all 7 namespaced ones vanished — and not
// only the user's MCP server: Codex's own `multi_agent_v1` namespace
// (spawn_agent, wait_agent, ...) went with it, so sub-agents were unavailable.
//
// The fixture below reproduces those shapes rather than embedding the capture,
// which carried local paths. Shapes asserted here were taken from that capture,
// not from the API docs.
//
// Three claims, and the third is the one that made this urgent:
//
//   1. Namespaced tools reach Claude, under deterministic aliases.
//   2. A call comes back as `function_call` carrying `namespace`, because
//      Codex's router resolves `ToolName::new(namespace, name)` — a flattened
//      name never matches and the call is silently unroutable.
//   3. A follow-up turn replaying `function_call_output` whose `output` is an
//      ARRAY of content items succeeds. MCP tools return arrays, and passed
//      verbatim they reach Anthropic as `tool_result.content[0].type =
//      "input_text"` → HTTP 400, killing every turn after an MCP call.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching the Responses translator or Codex tool handling.
//
//   bun scripts/e2e-codex-namespace-tools.mjs [--stream]
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mcodexns-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))

const { startProxyServer } = await import('../src/proxy/server.ts')

const STREAM = process.argv.includes('--stream')
const PORT = Number(process.env.PROBE_PORT ?? 3546)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const REALM = 'realm-fixture-zeta'

// Codex 0.153.4's real shape: flat built-ins, namespaces with nested tools,
// and a server-side kind that has no client-side counterpart.
const tools = [
  { type: 'function', name: 'exec_command', description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { type: 'namespace', name: 'mcp__iskron', description: 'Tools in the mcp__iskron namespace.', tools: [
    { type: 'function', name: 'realm_lookup', description: 'Look up a realm by id',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { type: 'function', name: 'realm_list', description: 'List all realms',
      parameters: { type: 'object', properties: {} } },
  ] },
  { type: 'namespace', name: 'multi_agent_v1', description: 'Tools for spawning and managing sub-agents.', tools: [
    { type: 'function', name: 'spawn_agent', description: 'Spawn a sub-agent',
      parameters: { type: 'object', properties: { task: { type: 'string' } } } },
  ] },
  { type: 'web_search' },
]

async function post(input) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-meridian-agent': 'codex' },
    body: JSON.stringify({ model: MODEL, stream: STREAM, tools, input }),
  })
  const text = await res.text()
  if (!STREAM) {
    let body = null
    try { body = JSON.parse(text) } catch { /* reported by the caller */ }
    return { status: res.status, output: body?.output ?? [], raw: text }
  }
  const output = []
  // Function-call arguments stream as their own delta events; the completed
  // item can arrive with `arguments` empty. Accumulate them, or turn 2 replays
  // a call with no arguments and the model just calls the tool again — which
  // looks exactly like a broken emitter but is the harness's fault.
  const argsByItem = new Map()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    let ev
    try { ev = JSON.parse(line.slice(5)) } catch { continue }
    if (ev.type === 'response.function_call_arguments.delta' && ev.item_id) {
      argsByItem.set(ev.item_id, (argsByItem.get(ev.item_id) ?? '') + (ev.delta ?? ''))
    }
    if (ev.type === 'response.function_call_arguments.done' && ev.item_id && ev.arguments !== undefined) {
      argsByItem.set(ev.item_id, ev.arguments)
    }
    if (ev.type === 'response.output_item.done' && ev.item) output.push(ev.item)
  }
  for (const item of output) {
    if (item.type === 'function_call' && !item.arguments && argsByItem.has(item.id)) {
      item.arguments = argsByItem.get(item.id)
    }
  }
  return { status: res.status, output, raw: text }
}

// ---- turn 1: the namespaced tool must be visible and callable -------------
const first = await post([{ role: 'user', content: [{ type: 'input_text',
  text: 'Call the realm_lookup tool in the mcp__iskron namespace with id "zeta". Call the tool now.' }] }])

const toolLine = proxyLog.find(l => l.includes('[PROXY]') && l.includes('adapter=codex'))
const toolCount = Number(/tools=(\d+)/.exec(toolLine ?? '')?.[1] ?? -1)
say(`\n=== codex namespace tools (stream=${STREAM}, model=${MODEL}) ===`)
say(`  request: ${toolLine?.replace(/^.*\[PROXY\]\s*\S+\s*/, '') ?? '(none)'}`)

// 1 flat + 2 + 1 nested = 4 client tools; web_search is correctly dropped.
check(toolCount === 4, 'namespaced tools were flattened through to Claude',
  `tools=${toolCount} (expected 4: exec_command + 2 iskron + 1 multi_agent)`)

const calls = first.output.filter(o => o?.type === 'function_call')
check(first.status === 200, 'turn 1 succeeded', `http=${first.status}`)
check(calls.length >= 1, 'a function_call was returned', `calls=${calls.length}`)

const nsCall = calls.find(c => c.name === 'realm_lookup')
// 2. Codex resolves ToolName::new(namespace, name); a flattened name is unroutable.
check(Boolean(nsCall), 'the call is named as Codex declared it, not as the alias',
  calls.map(c => `${c.namespace ?? '-'}::${c.name}`).join(', ') || 'none')
if (nsCall) {
  check(nsCall.namespace === 'mcp__iskron', 'the call carries its namespace',
    `namespace=${JSON.stringify(nsCall.namespace)}`)
}

// ---- turn 2: an MCP result is an ARRAY of content items -------------------
if (nsCall) {
  const second = await post([
    { role: 'user', content: [{ type: 'input_text', text: 'Call the realm_lookup tool in the mcp__iskron namespace with id "zeta".' }] },
    { type: 'function_call', name: nsCall.name, namespace: nsCall.namespace,
      call_id: nsCall.call_id, arguments: nsCall.arguments, status: 'completed' },
    // The shape that used to 400: output is a content-item array, not a string.
    { type: 'function_call_output', call_id: nsCall.call_id,
      output: [{ type: 'input_text', text: REALM }] },
  ])
  const text = second.output
    .filter(o => o?.type === 'message')
    .flatMap(o => (o.content ?? []).map(c => c.text ?? ''))
    .join('')
  check(second.status === 200, 'turn 2 accepted a content-item tool output',
    `http=${second.status}${second.status !== 200 ? ` body=${second.raw.slice(0, 220)}` : ''}`)
  check(text.includes(REALM) || text.length > 0, 'the model answered from the MCP result',
    text ? `quoted=${text.includes(REALM)}` : 'no assistant text')
}

say(`\n=== verdict (stream=${STREAM}) ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l}`)
} else {
  say('  PASS: namespaces reach Claude, calls carry their namespace, content-item results round-trip')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
