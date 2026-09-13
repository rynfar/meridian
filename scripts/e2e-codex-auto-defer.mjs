#!/usr/bin/env bun
// Live: does a Codex request past the auto-defer threshold still defer every
// tool, and does `exec_command` stay loaded rather than needing discovery?
//
// `codexTransforms` runs after the shared OpenCode transform and used to
// inherit its `coreToolNames` (`read, write, edit, bash, glob, grep`). Codex
// sends none of those names, so once a session crosses the threshold — trivial
// for Codex, which inlines every MCP namespace's tool definitions — the core
// set matched nothing and EVERY tool was deferred, `exec_command` included.
//
// The expensive part is not the deferral itself. `computePassthroughMaxTurns`
// only returns the single-turn cap when `singleTurnHandoff` holds, and that
// requires `!hasDeferredTools` — so switching deferral on silently lifted the
// cap from 1 to 4 and every tool-calling turn also generated the SDK's
// discarded digest turn on the full context. @justprosh measured 2-3x cache
// reads per turn on a 680k-token session (#963), with no `ToolSearch` call
// anywhere in the transcripts: the extra reads were digest turns, not
// discovery. Meridian was paying for a feature it never used.
//
// What this asserts, against a real proxy and a real SDK:
//
//   1. A 40-tool Codex request reports NO deferral. The `deferred=` diagnostic
//      is the observable for `hasDeferredTools`, which is what moves the cap.
//   2. `exec_command` is loaded rather than discovered via ToolSearch. Pre-fix
//      the diagnostic reads `discovered=1 (exec_command)` — Codex's primary
//      tool cost a discovery round trip before it could be used.
//   3. Codex still gets its tool call, named as it declared it. A cheaper
//      prompt that stops driving Codex would not be a fix.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching the codex transform, auto-defer, or `computePassthroughMaxTurns`.
//
//   bun scripts/e2e-codex-auto-defer.mjs
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mcodex-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))
writeFileSync(join(WORKDIR, 'target.txt'), 'codex-auto-defer-probe\n')

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3544)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'
// Above DEFAULT_DEFER_THRESHOLD (15) so auto-defer is genuinely in play.
const TOOL_COUNT = Number(process.env.PROBE_TOOLS ?? 40)

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

// Codex's real shape: its own built-ins plus a large MCP namespace, none of
// whose names appear in OpenCode's core list.
const tools = [
  {
    type: 'function', name: 'exec_command',
    description: 'Run a shell command and return its output',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  ...Array.from({ length: TOOL_COUNT - 1 }, (_, i) => ({
    type: 'function', name: `mcp__iskron_bridge__tool_${i}`,
    description: `Namespaced bridge tool ${i}`,
    parameters: { type: 'object', properties: { arg: { type: 'string' } } },
  })),
]

const res = await fetch(`http://127.0.0.1:${PORT}/v1/responses`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-meridian-agent': 'codex' },
  body: JSON.stringify({
    model: MODEL, stream: false, tools,
    input: [{ role: 'user', content: [{ type: 'input_text',
      text: `Use the exec_command tool to run: cat ${join(WORKDIR, 'target.txt')}. Call the tool now.` }] }],
  }),
})
const body = await res.text()
let parsed
try { parsed = JSON.parse(body) } catch { parsed = null }

const requestLine = proxyLog.find(l => l.includes('[PROXY]') && l.includes('adapter=codex'))
const deferLine = proxyLog.find(l => l.includes('deferred='))
const calls = (parsed?.output ?? []).filter(o => o?.type === 'function_call')

say(`\n=== codex auto-defer (tools=${TOOL_COUNT}, model=${MODEL}) ===`)
say(`  request: ${requestLine?.replace(/^.*\[PROXY\]\s*\S+\s*/, '') ?? '(none)'}`)

// 1. No deferral. This is the observable for hasDeferredTools.
check(!deferLine, 'auto-defer is off for a Codex request', deferLine ?? 'no deferred= diagnostic emitted')

// 2. exec_command is LOADED, not discovered. Deferring it forced a ToolSearch
// round trip before Codex's own primary tool could be called; the diagnostic
// says `discovered=1 (exec_command)` pre-fix. This discriminates as reliably
// as the deferral line and is the concrete consequence for Codex.
const discoveredLine = proxyLog.find(l => l.includes('discovered='))
check(!discoveredLine, 'exec_command was loaded directly, not found via ToolSearch',
  discoveredLine?.replace(/^.*\[PROXY\]\s*\S+\s*/, '') ?? 'no discovered= diagnostic emitted')

// Reported, not asserted. The digest-turn cost is real but scale-dependent:
// #963 measured 2-3x cache reads per turn on a 680k-token session, and a
// 40-tool probe on a short prompt does not reliably provoke the extra turn —
// it passed both before and after the fix. Asserting it here would be a check
// that looks meaningful and discriminates nothing.
const assistantTurns = proxyLog.filter(l => l.includes('usage:') && l.includes('[PROXY]')).length
say(`  note  model calls this turn: ${assistantTurns} (cap is 1 with deferral off, 4 with it on;`
  + ` the digest cost shows up at real session size, not here)`)

// 3. Codex still gets a usable tool call under its own name.
check(res.status === 200, 'request succeeded', `http=${res.status}`)
check(calls.length >= 1, 'a function_call was returned', `calls=${calls.length}`)
if (calls.length) {
  check(calls.some(c => c.name === 'exec_command'),
    'exec_command survived in the prompt and was callable',
    `named: ${calls.map(c => c.name).join(',')}`)
}

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l}`)
  if (!parsed) say(`  raw body: ${body.slice(0, 400)}`)
} else {
  say('  PASS: no deferral, no ToolSearch discovery, exec_command callable')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
