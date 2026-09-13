#!/usr/bin/env bun
// Live: does a client-driven tool round resume on EVERY adapter, or only on the
// ones whose client tools happen to sit in the default namespace?
//
// #983 gave each adapter its own passthrough client-tool namespace, so the
// LiteLLM adapter registers client tools as `mcp__litellm__*`. The early-stop
// tracker is what freezes the resume checkpoint, and it arms by matching those
// names — but `noteAssistantMessage` called `noteAssistantContent` with the
// DEFAULT prefix. On that adapter nothing was ever added to `expected`: no
// checkpoint UUID, no stored `passthroughToolCallIds`, and so every tool round
// started a fresh SDK session (#996).
//
// `isClientForwardedToolUse` is strict about foreign `mcp__*` names on purpose,
// which is exactly what made the missed prefix silent rather than noisy. It
// cost a bisect to find:
//
//   15529b12 (pre-#983)  passthrough resumed 3/3 tool rounds
//   96dc5605 (main)      passthrough resumed 0/3
//
// This gate is the A/B that found it, kept as a gate because nothing in a
// single-adapter run would have shown it. Every adapter with an explicit
// session key must resume its tool rounds; an adapter-specific namespace is
// exactly the kind of change that can silently take that away again.
//
// Needs Claude Max and costs a few cents of real tokens. Run before releases
// touching the passthrough namespace, the early-stop tracker, or checkpoint
// storage.
//
//   bun scripts/e2e-passthrough-namespace-resume.mjs
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'

const WORKDIR = realpathSync(mkdtempSync(join(tmpdir(), 'mnsresume-')))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))
process.env.MERIDIAN_PASSTHROUGH = '1'

const FILES = { 'alpha.txt': 'ALPHA-VALUE', 'bravo.txt': 'BRAVO-VALUE', 'charlie.txt': 'CHARLIE-VALUE' }
for (const [name, body] of Object.entries(FILES)) writeFileSync(join(WORKDIR, name), body + '\n')

const { startProxyServer } = await import('../src/proxy/server.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3558)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'

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
  description: 'Read a file from disk. Read exactly one file per call.',
  input_schema: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Absolute path' } },
    required: ['file_path'],
  },
}
const PROMPT = 'Read these three files ONE AT A TIME, waiting for each result before the next call: '
  + Object.keys(FILES).map(f => join(WORKDIR, f)).join(', ')
  + '. After the third, reply with the three contents separated by commas.'

/** Drive a client-side tool loop with an explicit session key. */
async function loop(agent, headerName) {
  const key = `nsresume-${agent}-${process.pid}`
  const messages = [{ role: 'user', content: PROMPT }]
  const rounds = []
  for (let round = 1; round <= 4; round++) {
    const before = proxyLog.length
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-meridian-agent': agent, [headerName]: key },
      body: JSON.stringify({ model: MODEL, max_tokens: 1024, stream: false, tools: [TOOL], messages }),
    })
    const body = await res.json().catch(() => null)
    const line = proxyLog.slice(before).find(l => l.includes('adapter=') && l.includes('msgCount=')) ?? ''
    const lastIsToolResult = Array.isArray(messages.at(-1)?.content)
      && messages.at(-1).content.some(b => b?.type === 'tool_result')
    rounds.push({
      round,
      status: res.status,
      msgCount: Number(/msgCount=(\d+)/.exec(line)?.[1] ?? 0),
      lineage: /lineage=(\S+)/.exec(line)?.[1] ?? '?',
      lastIsToolResult,
    })
    const blocks = body?.content ?? []
    const calls = blocks.filter(b => b.type === 'tool_use')
    if (!calls.length) break
    messages.push({ role: 'assistant', content: blocks })
    messages.push({
      role: 'user',
      content: calls.map(c => ({
        type: 'tool_result',
        tool_use_id: c.id,
        content: FILES[String(c.input?.file_path ?? '').split('/').pop()] ?? 'NOT FOUND',
      })),
    })
  }
  say(`  ${agent.padEnd(12)} (${headerName.padEnd(20)}) -> `
    + rounds.map(r => `${String(r.msgCount).padStart(2)}:${r.lineage}`).join('  '))
  return rounds
}

say(`\n=== client-driven tool rounds resume on every adapter (model=${MODEL}) ===`)

// The three adapters that read an explicit session key and run passthrough
// tool loops. `passthrough` is the one that regressed; the other two are the
// controls that made the regression visible as an asymmetry.
const CASES = [
  ['pi', 'x-session-affinity'],
  ['passthrough', 'x-litellm-session-id'],
  ['opencode', 'x-opencode-session'],
]

const results = []
for (const [agent, header] of CASES) results.push([agent, await loop(agent, header)])

say('')
check(results.every(([, rounds]) => rounds.every(r => r.status === 200)), 'every loop completed',
  results.map(([a, r]) => `${a}=${r.map(x => x.status).join(',')}`).join(' '))

for (const [agent, rounds] of results) {
  const toolRounds = rounds.filter(r => r.lastIsToolResult)
  check(toolRounds.length >= 2, `${agent}: ran real tool rounds`,
    `${toolRounds.length} of ${rounds.length} carried a tool_result`)
  // THE ASSERTION. A keyed tool round must resume; the checkpoint is only
  // frozen if the early-stop tracker armed on this adapter's namespace.
  check(toolRounds.length > 0 && toolRounds.every(r => r.lineage === 'continuation'),
    `${agent}: every keyed tool round resumes`,
    toolRounds.map(r => `${r.msgCount}:${r.lineage}`).join(' '))
}

// Stated as an invariant, not per adapter: the point is that no adapter is
// allowed to differ. Measured on main before the fix: pi and opencode all
// `continuation`, passthrough all `new`.
const shapes = new Set(results.map(([, rounds]) =>
  rounds.filter(r => r.lastIsToolResult).map(r => r.lineage).join(',')))
check(shapes.size === 1, 'all adapters agree on the tool-round shape',
  [...shapes].map(s => `[${s}]`).join(' vs '))

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  say('\n  recent proxy diagnostics:')
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l.slice(0, 200)}`)
} else {
  say('  PASS: a keyed tool round resumes on every adapter, whatever its namespace')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
