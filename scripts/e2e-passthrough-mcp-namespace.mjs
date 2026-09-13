#!/usr/bin/env bun
// Live: does an adapter's declared passthrough namespace actually reach the
// model, and is OpenCode's left exactly where it was?
//
// In passthrough mode the client's tools are nested inside an SDK MCP server,
// so the model reads them as `mcp__<namespace>__<tool>`. That namespace was the
// module constant `oc` on EVERY adapter, including the LiteLLM/`passthrough`
// adapter — whose own file has documented `mcp__litellm__*` since it was
// written, and whose `getMcpServerName()` was computed and then discarded on
// exactly the path where client tools get registered (#893).
//
// @groundnuty found this by asking the model to state its own tool name, which
// is the only place the effect is visible — `stripMcpPrefix` maps the name back
// before the client ever sees it, so nothing errors. This gate uses the same
// method, because it is the only thing that actually proves what the model read.
//
// Two claims, and the second is the one that protects everyone else:
//
//   1. A LiteLLM-pinned request shows the model `mcp__litellm__<tool>`.
//   2. An OpenCode request STILL shows `mcp__oc__<tool>`. Reusing
//      `getMcpServerName()` would have renamed it to `mcp__opencode__<tool>`,
//      moving the model-visible prompt — and the prompt cache — for the entire
//      existing user base, and colliding with the `mcp__opencode__*` names
//      `passthroughEarlyStop` excludes precisely because they are internal.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching passthrough tool registration or adapter tool config.
//
//   bun scripts/e2e-passthrough-mcp-namespace.mjs
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mns3-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))
process.env.MERIDIAN_PASSTHROUGH = '1'

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3554)
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

const TOOL = {
  name: 'sparql_select',
  description: 'Run a SPARQL SELECT query',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
}

/** Ask the model to state its own tool name — the only place this is visible. */
async function nameSeenBy(agentHeader) {
  const headers = { 'content-type': 'application/json', 'x-opencode-session': `ns-${agentHeader ?? 'default'}-${process.pid}` }
  if (agentHeader) headers['x-meridian-agent'] = agentHeader
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST', headers,
    body: JSON.stringify({
      model: MODEL, max_tokens: 300, stream: false, tools: [TOOL],
      messages: [{ role: 'user', content: 'State the exact name of the tool you have available, verbatim, and nothing else. Do not call it.' }],
    }),
  })
  const body = await res.json().catch(() => null)
  const text = (body?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  const match = /mcp__[A-Za-z0-9_]*__sparql_select/.exec(text)
  say(`  agent=${String(agentHeader ?? '(default/opencode)').padEnd(22)} http=${res.status} model said: ${match?.[0] ?? (text.trim().slice(0, 60) || '(no name)')}`)
  return { status: res.status, seen: match?.[0], text }
}

say(`\n=== passthrough MCP namespace (model=${MODEL}) ===`)

// 1. The reported case: a LiteLLM-pinned model must see its own namespace.
const litellm = await nameSeenBy('passthrough')
check(litellm.status === 200, 'the LiteLLM-pinned request succeeded', `http=${litellm.status}`)
check(litellm.seen === 'mcp__litellm__sparql_select',
  'a LiteLLM-pinned model reads its tools as mcp__litellm__*',
  `saw ${litellm.seen ?? '(none)'}`)

// 2. THE REGRESSION GUARD. OpenCode's model-visible names must not move.
const opencode = await nameSeenBy(undefined)
check(opencode.status === 200, 'the OpenCode request succeeded', `http=${opencode.status}`)
check(opencode.seen === 'mcp__oc__sparql_select',
  'an OpenCode model still reads its tools as mcp__oc__* (prompt cache unmoved)',
  `saw ${opencode.seen ?? '(none)'}`)
check(opencode.seen !== 'mcp__opencode__sparql_select',
  'OpenCode did NOT inherit getMcpServerName()',
  'renaming it would cold-cache every existing session')

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-8)) say(`    ${l}`)
} else {
  say('  PASS: declared namespaces reach the model, OpenCode unchanged')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
