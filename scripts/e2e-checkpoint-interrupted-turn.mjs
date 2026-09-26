#!/usr/bin/env bun
// Live: does a keyed tool round still resume after the client kept a partial
// assistant turn, or does it fall back to replaying the whole history?
//
// A dropped connection (upstream_idle, 504) ends a turn after its first
// streamed block. OpenCode keeps that partial assistant message, so the next
// request's delta after the stored tool-use checkpoint is
//   [complete tool_result, partial assistant, new user turn]
// The checkpoint coalescer rejects that shape, and for a header-keyed client
// Meridian replayed the entire conversation as a fresh prompt. On a long
// session the replay exceeds the context window and the CLI reports "prompt
// is too long", which surfaces as a 400 that no retry can clear.
//
// Assertions:
//   1. The interrupted round is served (200) by RESUMING the stored session.
//   2. Negative control: an unknown tool result is still a real mismatch and
//      still takes the fresh replay.
//
// Needs Claude Max and costs a few cents of real tokens. Run before releases
// touching the passthrough early-stop checkpoint or checkpoint replay.
//
//   bun scripts/e2e-checkpoint-interrupted-turn.mjs
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mckptint-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))
process.env.MERIDIAN_PASSTHROUGH = '1'

const FILE = join(WORKDIR, 'alpha.txt')
const CONTENT = 'ALPHA-VALUE'
writeFileSync(FILE, CONTENT + '\n')

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3559)
const MODEL = process.env.PROBE_MODEL ?? 'claude-opus-5-5'

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug', 'warn']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const TOOL = {
  name: 'read',
  description: 'Read a file from disk.',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Absolute path' } },
    required: ['file_path'],
  },
}

async function post(key, messages) {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-meridian-agent': 'opencode', 'x-opencode-session': key },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: false, tools: [TOOL], messages }),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

/** Newest telemetry row: requests are sequential, so it belongs to the last post. */
async function lastRow() {
  const res = await fetch(`http://127.0.0.1:${PORT}/telemetry/requests?limit=20`)
  const data = await res.json()
  const rows = Array.isArray(data) ? data : Object.values(data).find(Array.isArray) ?? []
  return rows.reduce((a, b) => (b.timestamp > (a?.timestamp ?? -1) ? b : a), undefined)
}

/** One keyed tool round, then the follow-up the client sends after an interruption. */
async function scenario(label, toolResultFor) {
  const key = `ckptint-${label}-${process.pid}`
  const first = [{ role: 'user', content: `Use the read tool on ${FILE}, then tell me its content.` }]
  const turn1 = await post(key, first)
  const call = (turn1.body?.content ?? []).find(b => b.type === 'tool_use')
  if (!call) return { label, setup: false, turn1Status: turn1.status }
  const messages = [
    ...first,
    { role: 'assistant', content: turn1.body.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolResultFor(call), content: CONTENT }] },
    // What a dropped stream leaves behind: an unfinished assistant turn.
    { role: 'assistant', content: [{ type: 'text', text: 'The file contains' }] },
    { role: 'user', content: 'You were cut off. Reply with the file content only.' },
  ]
  const turn2 = await post(key, messages)
  const row = await lastRow()
  const text = (turn2.body?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return {
    label,
    setup: true,
    status: turn2.status,
    isResume: row?.isResume,
    lineage: row?.lineageType,
    cacheRead: row?.cacheReadInputTokens ?? 0,
    answered: text.includes(CONTENT),
  }
}

say(`\n=== interrupted checkpoint follow-up (model=${MODEL}) ===`)
const settled = await scenario('settled', call => call.id)
const unknown = await scenario('unknown', () => 'toolu_not_a_real_call')
for (const r of [settled, unknown]) say(`  ${r.label.padEnd(8)} ${JSON.stringify(r)}`)
say('')

check(settled.setup && unknown.setup, 'first turns produced a client tool call')
check(settled.status === 200, 'interrupted follow-up is served', `status=${settled.status}`)
// THE ASSERTION. Before the fix this was a fresh replay (isResume=false).
check(settled.isResume === true, 'interrupted follow-up resumes the stored session',
  `isResume=${settled.isResume} lineage=${settled.lineage} cacheRead=${settled.cacheRead}`)
check(settled.answered, 'the resumed turn still sees the tool result')
// Negative control: a result for a call Meridian never forwarded stays a mismatch.
check(unknown.status === 200 && unknown.isResume === false, 'unknown tool result still takes the fresh replay',
  `status=${unknown.status} isResume=${unknown.isResume}`)

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l.slice(0, 200)}`)
} else {
  say('  PASS: a settled checkpoint followed by an interrupted turn resumes; a real mismatch still replays')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
