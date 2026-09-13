#!/usr/bin/env bun
// Live A/B: does crossing the auto-defer threshold mid-session still cost the
// whole conversation's prompt cache?
//
// The decision was taken from the LIVE tool count, so one tool added or removed
// flipped deferral for every non-core tool at once. Tools render at position 0
// of the prompt, so the `anthropic/alwaysLoad` marker moving re-renders the tool
// block and invalidates the tools, system AND message cache tiers — a full cold
// replay. It also flips `maxTurns`, silently re-enabling the billed digest turn
// (#861). OpenCode switching agents, an MCP server connecting or dropping, or a
// plugin toggling a tool all trigger it.
//
// Two conversations, three turns each, same prompts. Only one crosses the
// threshold on its third turn:
//
//   A (control)  15 -> 15 -> 15 tools
//   B (crossing) 15 -> 15 -> 16 tools
//
// What the pin does and does NOT do, because an earlier draft of this gate
// asserted the wrong thing and failed honestly:
//
// Adding a tool changes the tool block, and the tool block is prompt position
// 0, so the prompt cache is invalidated whatever the pin does. That cost is
// inherent to changing the tool set — measured here at cache=0% on turn 3 for
// the crossing conversation even WITH the pin.
//
// The bug was the AMPLIFICATION on top of that: the flip also re-marked
// `alwaysLoad` on every other tool and flipped `maxTurns`, silently
// re-enabling the billed digest turn. Those are what the pin removes, and what
// this gate asserts. Cache numbers are reported as context, not asserted.
//
// Costs a few cents of real tokens and needs Claude Max. Run before releases
// touching auto-defer, tool registration, or prompt assembly.
//
//   bun scripts/e2e-defer-pin.mjs
import { mkdtempSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { setSessionStoreDir } from '../src/proxy/sessionStore.ts'
import { getAutoDeferThreshold } from '../src/proxy/passthroughTools.ts'

const WORKDIR = realpathSync(mkdtempSync('/tmp/mdefer-'))
process.env.MERIDIAN_WORKDIR = WORKDIR
setSessionStoreDir(join(WORKDIR, 'store'))
process.env.MERIDIAN_PASSTHROUGH = '1'

const { startProxyServer } = await import('../src/proxy/server.ts')
const { telemetryStore } = await import('../src/telemetry/index.ts')

const PORT = Number(process.env.PROBE_PORT ?? 3556)
const MODEL = process.env.PROBE_MODEL ?? 'claude-haiku-4-5-20251001'
const T = getAutoDeferThreshold()

const say = console.log.bind(console)
const proxyLog = []
for (const k of ['log', 'error', 'debug']) console[k] = (...a) => { proxyLog.push(a.map(String).join(' ')) }
const inst = await startProxyServer({ port: PORT, host: '127.0.0.1' })

const failures = []
const check = (ok, label, detail) => {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

const CORE = ['read', 'write', 'edit', 'bash', 'glob', 'grep']
// Descriptions carry real mass so the tool block is worth caching.
const mkTools = (n) => Array.from({ length: n }, (_, i) => ({
  name: i < CORE.length ? CORE[i] : `bridge_tool_${i}`,
  description: `Tool ${i}. ` + 'Filler so the tool block has enough mass that re-rendering it is visible in the token counts rather than lost in noise. '.repeat(4),
  input_schema: { type: 'object', properties: { arg: { type: 'string' } }, required: [] },
}))

async function turn(session, tools, messages) {
  const before = proxyLog.length
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': session },
    body: JSON.stringify({ model: MODEL, max_tokens: 512, stream: false, tools, messages }),
  })
  const body = await res.json().catch(() => null)
  const line = proxyLog.slice(before).find(l => l.includes('[PROXY]') && l.includes('adapter=')) ?? ''
  const requestId = /\[PROXY\]\s+(\S+)/.exec(line)?.[1]
  const row = telemetryStore.getRecent({ limit: 300 }).find(r => r.requestId === requestId)
  const text = (body?.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('')
  return {
    status: res.status,
    write: row?.cacheCreationInputTokens ?? 0,
    read: row?.cacheReadInputTokens ?? 0,
    deferred: proxyLog.slice(before).some(l => l.includes('deferred=')),
    assistant: text,
  }
}

async function run(label, session, crossOnThird) {
  const msgs = [{ role: 'user', content: 'Reply with the single word ONE.' }]
  const t1 = await turn(session, mkTools(T), msgs)
  msgs.push({ role: 'assistant', content: t1.assistant || 'ONE' })
  msgs.push({ role: 'user', content: 'Reply with the single word TWO.' })
  const t2 = await turn(session, mkTools(T), msgs)
  msgs.push({ role: 'assistant', content: t2.assistant || 'TWO' })
  msgs.push({ role: 'user', content: 'Reply with the single word THREE.' })
  // The only difference: one extra tool, crossing the threshold.
  const t3 = await turn(session, mkTools(crossOnThird ? T + 1 : T), msgs)
  say(`  ${label.padEnd(13)} turn3 cache_write=${String(t3.write).padStart(6)} cache_read=${String(t3.read).padStart(6)} deferred=${t3.deferred}`)
  return { t1, t2, t3 }
}

say(`\n=== auto-defer pin (threshold=${T}, model=${MODEL}) ===`)
const A = await run('A control', `defer-a-${process.pid}`, false)
const B = await run('B crossing', `defer-b-${process.pid}`, true)

check(A.t3.status === 200 && B.t3.status === 200, 'both conversations completed',
  `http=${A.t3.status},${B.t3.status}`)

// Reported, not asserted. Changing the tool set invalidates the tools prefix
// regardless of the pin, so a ratio here would fail for a reason the pin is not
// responsible for — and asserting it would make the gate lie about its subject.
const ratio = A.t3.write > 0 ? B.t3.write / A.t3.write : (B.t3.write > 0 ? Infinity : 1)
say(`  note  turn-3 cache_write B/A = ${ratio.toFixed(1)}x (${B.t3.write} vs ${A.t3.write}) —`
  + ` changing the tool set re-renders prompt position 0 either way; not asserted`)

// THE CLAIM. maxTurns must not flip under a live session, which `deferred=`
// reports directly.
check(A.t3.deferred === B.t3.deferred,
  'deferral state is identical on turn 3, so maxTurns did not flip mid-session',
  `control=${A.t3.deferred} crossing=${B.t3.deferred}`)

// The suppression should be visible, not silent.
const suppressed = proxyLog.some(l => l.includes('defer_flip suppressed'))
check(suppressed, 'the suppressed flip is logged rather than hidden',
  suppressed ? 'defer_flip suppressed present' : 'no defer_flip line found')

say(`\n=== verdict ===`)
if (failures.length) {
  say(`  FAIL: ${failures.length} check(s)`)
  for (const f of failures) say(`    - ${f}`)
  for (const l of proxyLog.filter(l => l.includes('[PROXY]')).slice(-10)) say(`    ${l}`)
} else {
  say('  PASS: a threshold crossing no longer flips deferral or the turn budget')
}
await inst.close()
process.exit(failures.length ? 1 : 0)
